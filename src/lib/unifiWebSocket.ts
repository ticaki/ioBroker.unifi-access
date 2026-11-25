import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { TimerHost } from './timerHost';
import type { UnifiWebSocketMessage } from './types';

export interface UnifiWebSocketOptions {
	host: string;
	port: number;
	token: string;
	verifyTLS?: boolean;
	caCert?: string;
	reconnectDelaySeconds: number;
	/** Timer functions of the adapter (tracked and cleared by js-controller on unload). */
	timers: TimerHost;
	/** Heartbeat period in milliseconds (default 30 s). A connection that misses one pong is dropped. */
	heartbeatIntervalMs?: number;
	logger?: { debug: (msg: string) => void; warn: (msg: string) => void; info: (msg: string) => void };
}

type ListenerMap = {
	open: () => void;
	close: () => void;
	error: (err: Error) => void;
	event: (msg: UnifiWebSocketMessage) => void;
};

const DEFAULT_HEARTBEAT_MS = 30_000;

/**
 * Persistent WebSocket connection to /api/v1/developer/devices/notifications.
 * Documented event types on this socket: access.remote_view (doorbell ringing,
 * carries WebRTC channel/token), access.remote_view.change (status change with
 * reason_code: 105 timeout, 106 admin reject, 107 admin unlock, 108 visitor cancel,
 * 400 answered elsewhere), access.data.device.remote_unlock (admin remote unlock).
 * Other access.* events are delivered via the webhook channel, not this socket.
 *
 * Reconnects on close with exponential back-off (capped at reconnectDelaySeconds).
 * Heartbeat: a ping every 30 s; when neither the pong nor any other frame has arrived by the
 * next tick the connection is considered dead (half-open TCP connection) and terminated,
 * which triggers the normal reconnect.
 *
 * Only frames that are JSON objects with a string `event` are emitted; anything else
 * (keep-alive text, `null`, arrays, …) is ignored.
 */
export class UnifiWebSocket extends EventEmitter {
	private readonly options: UnifiWebSocketOptions;
	private socket: WebSocket | null = null;
	private reconnectTimer: unknown;
	private heartbeatTimer: unknown;
	private awaitingPong = false;
	private retryAttempt = 0;
	private stopped = true;

	constructor(options: UnifiWebSocketOptions) {
		super();
		this.options = options;
	}

	override on<K extends keyof ListenerMap>(event: K, listener: ListenerMap[K]): this {
		return super.on(event, listener as (...args: unknown[]) => void);
	}

	override emit<K extends keyof ListenerMap>(event: K, ...args: Parameters<ListenerMap[K]>): boolean {
		return super.emit(event, ...args);
	}

	/** Whether the connection is currently established. */
	get isOpen(): boolean {
		return this.socket?.readyState === WebSocket.OPEN;
	}

	start(): void {
		// start() on a running instance must not open a second connection
		this.dropConnection();
		this.stopped = false;
		this.retryAttempt = 0;
		this.connect();
	}

	stop(): void {
		this.stopped = true;
		this.dropConnection();
	}

	/** Cancel timers and terminate the current socket without scheduling a reconnect. */
	private dropConnection(): void {
		if (this.reconnectTimer !== undefined) {
			this.options.timers.clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		this.stopHeartbeat();
		const ws = this.socket;
		this.socket = null;
		if (ws) {
			try {
				ws.terminate();
			} catch {
				/* ignore */
			}
		}
	}

	private connect(): void {
		const { host, port, token, verifyTLS, caCert, logger } = this.options;
		const url = `wss://${host}:${port}/api/v1/developer/devices/notifications`;
		logger?.debug(`opening WebSocket: ${url}`);

		const ws = new WebSocket(url, {
			rejectUnauthorized: verifyTLS === true,
			ca: caCert ? caCert : undefined,
			headers: { Authorization: `Bearer ${token}` },
			handshakeTimeout: 10_000,
		});
		this.socket = ws;
		// Every handler checks that it still belongs to the current socket: events of a socket that
		// was replaced (stop() + start()) or dropped must not touch the state of its successor.
		const isCurrent = (): boolean => this.socket === ws;

		ws.on('open', () => {
			if (!isCurrent()) {
				return;
			}
			this.retryAttempt = 0;
			this.startHeartbeat(ws);
			this.emit('open');
		});

		ws.on('pong', () => {
			if (isCurrent()) {
				this.awaitingPong = false;
			}
		});

		ws.on('message', (data: WebSocket.RawData) => {
			if (!isCurrent()) {
				return;
			}
			// Any frame proves the peer is alive — a controller that keeps the connection up with its own
			// keep-alive frames but does not answer pings must not be dropped every minute.
			this.awaitingPong = false;
			let parsed: unknown;
			try {
				parsed = JSON.parse(rawDataToString(data));
			} catch (err) {
				// not an event (the controller may send plain keep-alive text) — nothing to act on
				logger?.debug(`WebSocket frame ignored (not JSON): ${(err as Error).message}`);
				return;
			}
			if (
				!parsed ||
				typeof parsed !== 'object' ||
				Array.isArray(parsed) ||
				typeof (parsed as { event?: unknown }).event !== 'string'
			) {
				logger?.debug('WebSocket frame ignored (not an event object).');
				return;
			}
			try {
				this.emit('event', parsed as UnifiWebSocketMessage);
			} catch (err) {
				logger?.warn(`WebSocket event listener failed: ${(err as Error).message}`);
			}
		});

		ws.on('close', () => {
			if (!isCurrent()) {
				return;
			}
			this.stopHeartbeat();
			this.socket = null;
			this.emit('close');
			this.scheduleReconnect();
		});

		ws.on('error', (err: Error) => {
			if (!isCurrent()) {
				return;
			}
			// 'error' is always followed by 'close', which schedules the reconnect
			if (this.listenerCount('error') > 0) {
				this.emit('error', err);
			} else {
				logger?.debug(`WebSocket error: ${err.message}`);
			}
		});
	}

	private startHeartbeat(ws: WebSocket): void {
		this.stopHeartbeat();
		this.awaitingPong = false;
		const period = this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
		this.heartbeatTimer = this.options.timers.setInterval(() => {
			if (this.socket !== ws || ws.readyState !== WebSocket.OPEN) {
				return;
			}
			if (this.awaitingPong) {
				// The previous ping was never answered: the peer is gone without closing the connection.
				this.options.logger?.info(
					`WebSocket heartbeat: no answer within ${Math.round(period / 1000)} s — dropping the connection.`,
				);
				try {
					ws.terminate();
				} catch {
					/* ignore */
				}
				return;
			}
			this.awaitingPong = true;
			try {
				ws.ping();
			} catch {
				/* a failing ping is caught by the pong check of the next tick */
			}
		}, period);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer !== undefined) {
			this.options.timers.clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
		this.awaitingPong = false;
	}

	private scheduleReconnect(): void {
		if (this.stopped) {
			return;
		}
		this.retryAttempt += 1;
		// Exponential back-off up to reconnectDelaySeconds.
		const cap = this.options.reconnectDelaySeconds;
		const delaySeconds = Math.min(cap, 2 ** Math.min(this.retryAttempt, 6));
		const text = `WebSocket reconnect in ${delaySeconds}s (attempt ${this.retryAttempt})`;
		// one visible line per outage; the repeats of a longer outage only at debug level
		if (this.retryAttempt === 1) {
			this.options.logger?.info(text);
		} else {
			this.options.logger?.debug(text);
		}
		this.reconnectTimer = this.options.timers.setTimeout(() => {
			this.reconnectTimer = undefined;
			if (!this.stopped) {
				this.connect();
			}
		}, delaySeconds * 1000);
	}
}

function rawDataToString(data: WebSocket.RawData | string): string {
	if (typeof data === 'string') {
		return data;
	}
	if (Buffer.isBuffer(data)) {
		return data.toString('utf8');
	}
	if (data instanceof ArrayBuffer) {
		return Buffer.from(data).toString('utf8');
	}
	if (Array.isArray(data)) {
		return Buffer.concat(data).toString('utf8');
	}
	return '';
}
