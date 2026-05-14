import axios, { type AxiosInstance, AxiosError } from 'axios';
import https from 'node:https';
import type {
	UnifiDeviceRaw,
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
					log(`webhook response [${r.config.method?.toUpperCase()} ${r.config.url}] status=${r.status} body=${JSON.stringify(r.data)}`);
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

	async listUsers(): Promise<UnifiUserRaw[]> {
		const r = await this.client.get<{ data: UnifiUserRaw[] }>('/api/v1/developer/users');
		return r.data?.data ?? [];
	}

	/**
	 * Pulse-unlock a door. Endpoint accepts only actor_id/actor_name/extra; no duration.
	 *
	 * @param doorId UniFi door identifier
	 */
	async unlockDoor(doorId: string): Promise<void> {
		await this.client.put(`/api/v1/developer/doors/${encodeURIComponent(doorId)}/unlock`, {});
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
	 * @param path Relative resource path from the event payload
	 */
	async getStaticResource(path: string): Promise<Buffer> {
		const cleaned = path.replace(/^\/+/, '');
		const r = await this.client.get<ArrayBuffer>(`/api/v1/developer/system/static/${cleaned}`, {
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
