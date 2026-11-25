import axios, { type AxiosInstance, AxiosError } from 'axios';
import https from 'node:https';
import { sanitizeStaticPath } from './pathSafety';
import type {
	UnifiDeviceRaw,
	UnifiDoorLockRule,
	UnifiDoorRaw,
	UnifiEmergencyStatus,
	UnifiEmergencyStatusPayload,
	UnifiLockRulePayload,
	UnifiUserRaw,
	UnifiWebhookEndpoint,
	UnifiWebhookEndpointCreate,
} from './types';

export interface UnifiHttpOptions {
	host: string;
	port: number;
	token: string;
	verifyTLS?: boolean;
	caCert?: string;
	debugLog?: (msg: string) => void;
}

const STATIC_PREFIX = '/api/v1/developer/system/static/';

/** Thrown by {@link UnifiHttp.getStaticResource} for a path that is not a plain static-resource path. */
export class InvalidStaticPathError extends Error {
	constructor() {
		super('invalid static resource path');
		this.name = 'InvalidStaticPathError';
	}
}

const REDACTED_KEYS = /secret|token|password|authorization|cookie/i;

/**
 * Deep copy of a value for logging with every credential-like property masked
 * (webhook signing secrets, tokens, passwords, authorization headers).
 *
 * @param value Any JSON-like value
 * @param depth Recursion guard
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
	if (value === null || typeof value !== 'object') {
		return value;
	}
	if (depth > 8) {
		return '[…]';
	}
	if (Array.isArray(value)) {
		return value.map(entry => redactSecrets(entry, depth + 1));
	}
	const copy: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		copy[key] =
			REDACTED_KEYS.test(key) && entry !== null && entry !== undefined ? '***' : redactSecrets(entry, depth + 1);
	}
	return copy;
}

export class UnifiHttp {
	private readonly client: AxiosInstance;
	private readonly baseUrl: string;

	constructor(options: UnifiHttpOptions) {
		this.baseUrl = `https://${options.host}:${options.port}`;
		this.client = axios.create({
			baseURL: this.baseUrl,
			timeout: 10_000,
			headers: {
				Authorization: `Bearer ${options.token}`,
				Accept: 'application/json',
			},
			httpsAgent: new https.Agent({
				rejectUnauthorized: options.verifyTLS === true,
				ca: options.caCert ? options.caCert : undefined,
			}),
		});
		if (options.debugLog) {
			const log = options.debugLog;
			this.client.interceptors.response.use(r => {
				if (r.config.url?.includes('webhooks')) {
					// The body lists the HMAC signing secret of every endpoint — never log it in clear text.
					log(
						`webhook response [${r.config.method?.toUpperCase()} ${r.config.url}] status=${r.status} body=${JSON.stringify(redactSecrets(r.data))}`,
					);
				}
				return r;
			});
		}
	}

	get url(): string {
		return this.baseUrl;
	}

	/** Lightweight connectivity + token check — lists devices (read-only). */
	async verify(): Promise<void> {
		await this.client.get('/api/v1/developer/devices');
	}

	async listDevices(): Promise<UnifiDeviceRaw[]> {
		// refresh=true asks the controller for live state; without it the documented response
		// only contains id/name/type/alias and the `online` flag is omitted, so devices would
		// always appear offline until a webhook/WS event fires.
		const r = await this.client.get<{ data: UnifiDeviceRaw[] | UnifiDeviceRaw[][] }>(
			'/api/v1/developer/devices?refresh=true',
		);
		const data = r.data?.data;
		if (!Array.isArray(data)) {
			return [];
		}
		// API returns nested arrays grouped by hub/controller — flatten one level.
		const first = data[0];
		if (Array.isArray(first)) {
			return (data as UnifiDeviceRaw[][]).flat();
		}
		return data as UnifiDeviceRaw[];
	}

	async listDoors(): Promise<UnifiDoorRaw[]> {
		const r = await this.client.get<{ data: UnifiDoorRaw[] }>('/api/v1/developer/doors');
		return r.data?.data ?? [];
	}

	/**
	 * Fetch a single door (API reference 7.7) — the current lock relay and position status.
	 *
	 * @param doorId UniFi door identifier
	 * @returns The door, or `null` when the response carries no door object
	 */
	async getDoor(doorId: string): Promise<UnifiDoorRaw | null> {
		const r = await this.client.get<{ data?: UnifiDoorRaw }>(
			`/api/v1/developer/doors/${encodeURIComponent(doorId)}`,
		);
		const door = r.data?.data;
		return door && typeof door === 'object' && typeof door.id === 'string' ? door : null;
	}

	/**
	 * Fetch the temporary locking rule of a door (API reference 7.11, UniFi Access 1.24.6 or later).
	 *
	 * @param doorId UniFi door identifier
	 * @returns The rule, or `null` when the response carries no rule object
	 */
	async getDoorLockRule(doorId: string): Promise<UnifiDoorLockRule | null> {
		const r = await this.client.get<{ data?: UnifiDoorLockRule }>(
			`/api/v1/developer/doors/${encodeURIComponent(doorId)}/lock_rule`,
		);
		const rule = r.data?.data;
		return rule && typeof rule === 'object' && !Array.isArray(rule) ? rule : null;
	}

	async listUsers(): Promise<UnifiUserRaw[]> {
		const r = await this.client.get<{ data: UnifiUserRaw[] }>('/api/v1/developer/users');
		return r.data?.data ?? [];
	}

	/**
	 * Pulse-unlock a door. Optionally pass actor to customize what appears in UniFi Access logs.
	 * Both actor.id and actor.name must be provided together (API requirement).
	 *
	 * @param doorId UniFi door identifier
	 * @param actor  Optional actor identity shown in system logs and webhooks
	 * @param actor.id
	 * @param actor.name
	 */
	async unlockDoor(doorId: string, actor?: { id: string; name: string }): Promise<void> {
		const body: Record<string, string> = {};
		if (actor?.id && actor?.name) {
			body.actor_id = actor.id;
			body.actor_name = actor.name;
		}
		await this.client.put(`/api/v1/developer/doors/${encodeURIComponent(doorId)}/unlock`, body);
	}

	/**
	 * Set a door lock rule. Use type='custom' with interval (in MINUTES) for a timed unlock,
	 * keep_lock/keep_unlock for indefinite states, reset/lock_early/lock_now to revert.
	 *
	 * @param doorId  UniFi door identifier
	 * @param payload Lock-rule payload (type and optional interval in minutes)
	 */
	async setDoorLockRule(doorId: string, payload: UnifiLockRulePayload): Promise<void> {
		await this.client.put(`/api/v1/developer/doors/${encodeURIComponent(doorId)}/lock_rule`, payload);
	}

	/**
	 * Fetch a static resource (avatar, preview, capture thumbnail). The path is the
	 * relative string returned in event payloads, e.g. /preview/reader_xxx.jpg.
	 *
	 * The path comes from outside (event payloads, a state). It is validated strictly and the request
	 * can never leave `/system/static/`: anything with dot segments, encoded characters, a query, a
	 * scheme or host is refused with {@link InvalidStaticPathError} before a request is sent.
	 *
	 * @param path Relative resource path from the event payload
	 */
	async getStaticResource(path: string): Promise<Buffer> {
		const cleaned = sanitizeStaticPath(path);
		if (cleaned === null) {
			throw new InvalidStaticPathError();
		}
		const target = `${STATIC_PREFIX}${cleaned}`;
		// Defence in depth: what the HTTP client will actually request must still be below the prefix.
		const resolved = new URL(target, this.baseUrl);
		if (
			resolved.origin !== new URL(this.baseUrl).origin ||
			resolved.pathname !== target ||
			resolved.search !== ''
		) {
			throw new InvalidStaticPathError();
		}
		const r = await this.client.get<ArrayBuffer>(target, {
			responseType: 'arraybuffer',
		});
		return Buffer.from(r.data);
	}

	async getEmergencyStatus(): Promise<UnifiEmergencyStatus> {
		const r = await this.client.get<{ data: UnifiEmergencyStatus }>('/api/v1/developer/doors/settings/emergency');
		return r.data?.data ?? { lockdown: false, evacuation: false };
	}

	async setEmergencyStatus(payload: UnifiEmergencyStatusPayload): Promise<void> {
		await this.client.put('/api/v1/developer/doors/settings/emergency', payload);
	}

	async listWebhookEndpoints(): Promise<UnifiWebhookEndpoint[]> {
		const r = await this.client.get<{ data: UnifiWebhookEndpoint[] }>('/api/v1/developer/webhooks/endpoints');
		return r.data?.data ?? [];
	}

	async createWebhookEndpoint(
		payload: UnifiWebhookEndpointCreate,
	): Promise<{ code: string; endpoint?: UnifiWebhookEndpoint & { secret?: string } }> {
		const r = await this.client.post<{ code?: string; data?: UnifiWebhookEndpoint & { secret?: string } }>(
			'/api/v1/developer/webhooks/endpoints',
			payload,
		);
		return { code: r.data?.code ?? 'SUCCESS', endpoint: r.data?.data };
	}

	async deleteWebhookEndpoint(id: string): Promise<void> {
		await this.client.delete(`/api/v1/developer/webhooks/endpoints/${encodeURIComponent(id)}`);
	}

	async fetchSystemLogsRaw(topic: string, since: number, until: number): Promise<unknown> {
		const r = await this.client.post('/api/v1/developer/system/logs', { topic, since, until });
		return r.data;
	}
}

/**
 * Classify an HTTP/network error so callers can keep their decision logic simple.
 *
 * @param err Error thrown by axios or the underlying socket
 */
export function classifyError(err: unknown): 'unauthorized' | 'network' {
	if (err instanceof AxiosError) {
		if (err.response?.status === 401 || err.response?.status === 403) {
			return 'unauthorized';
		}
	}
	return 'network';
}
