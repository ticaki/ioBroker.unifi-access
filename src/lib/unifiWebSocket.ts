import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { UnifiWebSocketMessage } from './types';

export interface UnifiWebSocketOptions {
	host: string;
	port: number;
	token: string;
	verifyTLS?: boolean;
	caCert?: string;
	reconnectDelaySeconds: number;
	logger?: { debug: (msg: string) => void; warn: (msg: string) => void; info: (msg: string) => void };
}

type ListenerMap = {
	open: () => void;
	close: () => void;
	error: (err: Error) => void;
	event: (msg: UnifiWebSocketMessage) => void;
};

/**
 * Persistent WebSocket connection to /api/v1/developer/devices/notifications.
 * Documented event types on this socket: access.remote_view (doorbell ringing,
 * carries WebRTC channel/token), access.remote_view.change (status change with
 * reason_code: 105 timeout, 106 admin reject, 107 admin unlock, 108 visitor cancel,
 * 400 answered elsewhere), access.data.device.remote_unlock (admin remote unlock).
 * Other access.* events are delivered via the webhook channel, not this socket.
 *
 * Reconnects on close/error with exponential back-off (capped at reconnectDelaySeconds).
 * Heartbeat ping every 30s to detect dead connections that don't surface a 'close' event.
 */
export class UnifiWebSocket extends EventEmitter {
	private readonly options: UnifiWebSocketOptions;
	private socket: WebSocket | null = null;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private heartbeatTimer: NodeJS.Timeout | null = null;
	private retryAttempt = 0;
	private stopped = false;

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

	start(): void {
		this.stopped = false;
		this.connect();
	}

	stop(): void {
		this.stopped = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		if (this.socket) {
			try {
				this.socket.terminate();
			} catch {
				/* ignore */
			}
			this.socket = null;
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

		ws.on('open', () => {
			this.retryAttempt = 0;
			this.startHeartbeat();
			this.emit('open');
		});

		ws.on('message', (data: WebSocket.RawData) => {
			try {
				let text: string;
				if (typeof data === 'string') {
					text = data;
				} else if (Buffer.isBuffer(data)) {
					text = data.toString('utf8');
				} else if (data instanceof ArrayBuffer) {
					text = Buffer.from(data).toString('utf8');
				} else if (Array.isArray(data)) {
					text = Buffer.concat(data).toString('utf8');
				} else {
					text = '';
				}
				const parsed = JSON.parse(text) as UnifiWebSocketMessage;
				this.emit('event', parsed);
			} catch (err) {
				logger?.warn(`WebSocket parse error: ${(err as Error).message}`);
			}
		});

		ws.on('close', () => {
			this.cleanupSocket();
			this.emit('close');
			this.scheduleReconnect();
		});

		ws.on('error', (err: Error) => {
			logger?.warn(`WebSocket error: ${err.message}`);
			this.emit('error', err);
		});
	}

	private startHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
		}
		this.heartbeatTimer = setInterval(() => {
			if (this.socket?.readyState === WebSocket.OPEN) {
				try {
					this.socket.ping();
				} catch {
					/* ignore */
				}
			}
		}, 30_000);
	}

	private cleanupSocket(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		this.socket = null;
	}

	private scheduleReconnect(): void {
		if (this.stopped) {
			return;
		}
		this.retryAttempt += 1;
		// Exponential back-off up to reconnectDelaySeconds.
		const cap = this.options.reconnectDelaySeconds;
		const wait = Math.min(cap, 2 ** Math.min(this.retryAttempt, 6));
		this.options.logger?.info(`WebSocket reconnect in ${wait}s (attempt ${this.retryAttempt})`);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (!this.stopped) {
				this.connect();
			}
		}, wait * 1000);
	}
}
