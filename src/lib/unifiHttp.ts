import axios, { type AxiosInstance, type AxiosResponse, AxiosError } from 'axios';
import https from 'node:https';
import { sanitizeStaticPath } from './pathSafety';
import { trustedCertificates } from './caCert';
import { throwIfStopped } from './stopSignal';
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
	/**
	 * Stop signal of the adapter: once it is true, every new request is refused with `StoppedError`
	 * before anything is sent. A request already on its way is answered as usual.
	 */
	isStopped?: () => boolean;
}

const STATIC_PREFIX = '/api/v1/developer/system/static/';

/** Thrown by {@link UnifiHttp.getStaticResource} for a path that is not a plain static-resource path. */
export class InvalidStaticPathError extends Error {
	constructor() {
		super('invalid static resource path');
		this.name = 'InvalidStaticPathError';
	}
}

/**
 * The controller answered with the documented response envelope and a `code` other than `SUCCESS`
 * although the HTTP status signalled success (API reference 2.8: "code: Represents the result of
 * request handling and indicates success or failure").
 */
export class UnifiApiError extends Error {
	/** Error code of the envelope, e.g. `CODE_DEVICE_DEVICE_OFFLINE`. */
	readonly code: string;
	/** `msg` of the envelope, if any. */
	readonly apiMessage?: string;
	readonly httpStatus: number;

	constructor(code: string, apiMessage: string | undefined, httpStatus: number, request: string) {
		super(`UniFi Access API error ${code}${apiMessage ? `: ${apiMessage}` : ''} [${request}]`);
		this.name = 'UnifiApiError';
		this.code = code;
		this.apiMessage = apiMessage;
		this.httpStatus = httpStatus;
	}
}

/**
 * A successful HTTP answer to a JSON request that does not carry the documented response envelope
 * (`code` / `msg` / `data`, API reference 2.8). Typical cause: host and port point to some other HTTPS
 * service (reverse-proxy default site, web interface, wrong port) that answers every path with 200.
 */
export class UnexpectedResponseError extends Error {
	readonly httpStatus: number;

	constructor(httpStatus: number, request: string, detail = 'without the UniFi Access response envelope') {
		super(
			`unexpected response ${detail} (HTTP ${httpStatus}) [${request}] — do host and port point to the UniFi Access API?`,
		);
		this.name = 'UnexpectedResponseError';
		this.httpStatus = httpStatus;
	}
}

const API_PREFIX = '/api/v1/developer';
const AUTH_ERROR_CODES = new Set(['CODE_AUTH_FAILED', 'CODE_ACCESS_TOKEN_INVALID', 'CODE_UNAUTHORIZED']);
const USERS_PAGE_SIZE = 100;
const USERS_MAX_PAGES = 50;

/**
 * Permission key an API token needs for a request (taken from the "Permission Key" of each
 * endpoint in the API reference) — used to make a 403 actionable.
 *
 * @param method HTTP method
 * @param path Request path below the API prefix
 */
export function requiredPermission(method: string, path: string): string | undefined {
	const write = method.toUpperCase() !== 'GET';
	if (path.startsWith('/devices')) {
		return write ? 'edit:device' : 'view:device';
	}
	if (path.startsWith('/doors')) {
		return write ? 'edit:space' : 'view:space';
	}
	if (path.startsWith('/users')) {
		return write ? 'edit:user' : 'view:user';
	}
	if (path.startsWith('/system/')) {
		return 'view:system_log';
	}
	if (path.startsWith('/webhooks')) {
		return write ? 'edit:webhook' : 'view:webhook';
	}
	return undefined;
}

/**
 * `code` / `msg` of a response body when it is (or contains, for binary requests) the documented envelope.
 *
 * @param data Response body as delivered by axios
 * @param contentType Content-Type header of the response
 */
function readEnvelope(data: unknown, contentType: unknown): { code?: string; msg?: string } {
	let body: unknown = data;
	if (data instanceof ArrayBuffer || Buffer.isBuffer(data)) {
		// binary request: only a response that declares itself as JSON can be an envelope
		if (typeof contentType !== 'string' || !contentType.toLowerCase().includes('json')) {
			return {};
		}
		const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
		if (bytes.length > 65_536) {
			return {};
		}
		try {
			body = JSON.parse(bytes.toString('utf8'));
		} catch {
			return {};
		}
	}
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		return {};
	}
	const { code, msg } = body as { code?: unknown; msg?: unknown };
	return {
		code: typeof code === 'string' && code !== '' ? code : undefined,
		msg: typeof msg === 'string' && msg !== '' ? msg : undefined,
	};
}

function describeRequest(config: { method?: string; url?: string } | undefined): string {
	const path = (config?.url ?? '').split('?')[0];
	return `${(config?.method ?? 'GET').toUpperCase()} ${path}`;
}

/**
 * The API error code carried by an error of {@link UnifiHttp}, whatever HTTP status it came with.
 *
 * @param err Error thrown by a UnifiHttp method
 */
export function apiErrorCode(err: unknown): string | undefined {
	if (err instanceof UnifiApiError) {
		return err.code;
	}
	if (err instanceof AxiosError) {
		return readEnvelope(err.response?.data, err.response?.headers?.['content-type']).code;
	}
	return undefined;
}

const REDACTED_KEYS = /secret|token|password|passwd|auth|cookie|key|credential|signature/i;

/**
 * Deep copy of a value for logging with every credential-like property masked
 * (webhook signing secrets, tokens, passwords, authorization headers). Every value below a key
 * `headers` is masked whatever its name: webhook endpoints of other integrations may carry custom
 * headers like `X-Api-Key` or `X-Hub-Token` — no name pattern can know them all.
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
		if (key.toLowerCase() === 'headers' && entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
			copy[key] = Object.fromEntries(Object.keys(entry).map(name => [name, '***']));
			continue;
		}
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
				// system CAs plus the configured certificate(s), repaired if the admin field mangled them
				ca: trustedCertificates(options.caCert),
			}),
		});
		// After the stop nothing more is sent to the controller, whichever path the request comes from.
		this.client.interceptors.request.use(config => {
			throwIfStopped(options.isStopped);
			return config;
		});
		// The response envelope is evaluated in one place for all calls: a `code` other than SUCCESS is an
		// error even with HTTP 2xx, and an HTTP error gets the API code, the endpoint and — for 403 — the
		// missing token permission added to its message. A JSON request answered without the envelope is
		// an error as well (not a UniFi Access API); binary downloads are exempt.
		this.client.interceptors.response.use(
			(r: AxiosResponse) => {
				const { code, msg } = readEnvelope(r.data, r.headers?.['content-type']);
				if (code !== undefined && code !== 'SUCCESS') {
					throw new UnifiApiError(code, msg, r.status, describeRequest(r.config));
				}
				const binary = r.config?.responseType === 'arraybuffer' || r.config?.responseType === 'stream';
				if (code === undefined && !binary) {
					throw new UnexpectedResponseError(r.status, describeRequest(r.config));
				}
				return r;
			},
			(err: unknown) => {
				if (err instanceof AxiosError && err.response) {
					const { code, msg } = readEnvelope(err.response.data, err.response.headers?.['content-type']);
					const request = describeRequest(err.config);
					let text = err.message;
					if (code) {
						text += ` (${code}${msg ? `: ${msg}` : ''})`;
					}
					text += ` [${request}]`;
					if (err.response.status === 403) {
						const path = request.split(' ')[1] ?? '';
						const permission = requiredPermission(
							request.split(' ')[0],
							path.startsWith(API_PREFIX) ? path.slice(API_PREFIX.length) : path,
						);
						if (permission) {
							text += ` — the API token needs the permission "${permission}"`;
						}
					}
					err.message = text;
				}
				return Promise.reject(err instanceof Error ? err : new Error(String(err)));
			},
		);
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

	async listDevices(): Promise<UnifiDeviceRaw[]> {
		// refresh=true "fetches real-time device info but may be slower" (API reference 8.1). The
		// documented response lists id, name, type and alias only; `online` and `firmware` are not
		// documented but sent by controllers in practice — callers must treat them as optional.
		const r = await this.client.get<{ data: UnifiDeviceRaw[] | UnifiDeviceRaw[][] }>(
			'/api/v1/developer/devices?refresh=true',
		);
		const data = r.data?.data;
		if (!Array.isArray(data)) {
			// an empty list here would make every known device look gone
			throw new UnexpectedResponseError(r.status, 'GET /api/v1/developer/devices', 'without a device list');
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
		const data = r.data?.data;
		if (!Array.isArray(data)) {
			// an empty list here would make every door unknown — control states would stop working
			throw new UnexpectedResponseError(r.status, 'GET /api/v1/developer/doors', 'without a door list');
		}
		return data;
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

	/**
	 * Fetch all users (API reference 3.5) page by page with the documented `page_num` / `page_size`
	 * parameters. The default page size without parameters is not documented, so relying on a single
	 * request could silently truncate the list.
	 *
	 * Stops when `pagination.total` is reached, a page is not full, a page brings nothing new, or after
	 * {@link USERS_MAX_PAGES} pages. Should the controller reject the parameters on the first request,
	 * the plain request of earlier versions is used.
	 */
	async listUsers(): Promise<UnifiUserRaw[]> {
		type Page = { data?: UnifiUserRaw[]; pagination?: { total?: unknown } };
		const users: UnifiUserRaw[] = [];
		const seen = new Set<string>();
		for (let page = 1; page <= USERS_MAX_PAGES; page++) {
			let body: Page | undefined;
			try {
				body = (
					await this.client.get<Page>('/api/v1/developer/users', {
						params: { page_num: page, page_size: USERS_PAGE_SIZE },
					})
				).data;
			} catch (err) {
				const status = err instanceof AxiosError ? err.response?.status : undefined;
				if (page === 1 && (status === 400 || apiErrorCode(err) === 'CODE_PARAMS_INVALID')) {
					const plain = await this.client.get<Page>('/api/v1/developer/users');
					return Array.isArray(plain.data?.data) ? plain.data.data : [];
				}
				throw err;
			}
			const items = Array.isArray(body?.data) ? body.data : [];
			let added = 0;
			for (const user of items) {
				const key = typeof user?.id === 'string' ? user.id : undefined;
				if (key !== undefined && seen.has(key)) {
					continue;
				}
				if (key !== undefined) {
					seen.add(key);
				}
				users.push(user);
				added += 1;
			}
			const total = body?.pagination?.total;
			if (typeof total === 'number' && Number.isFinite(total)) {
				if (users.length >= total || items.length === 0) {
					break;
				}
			} else if (items.length < USERS_PAGE_SIZE || added === 0) {
				// no pagination info: a short page is the last one, a page without new users means the
				// controller ignores the paging parameters
				break;
			}
		}
		return users;
	}

	/**
	 * Pulse-unlock a door. Optionally pass actor to customize what appears in UniFi Access logs.
	 * Both actor.id and actor.name must be provided together (API requirement).
	 *
	 * @param doorId UniFi door identifier
	 * @param actor  Optional actor identity shown in system logs and webhooks
	 * @param actor.id Id of the user the unlock is attributed to
	 * @param actor.name Display name of that user
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

	/**
	 * Read the emergency status for a read-modify-write: unlike {@link getEmergencyStatus} there is no
	 * default — when the response does not carry both flags as booleans the result is `null`, so the
	 * caller cannot send a guessed value back to the controller.
	 */
	async readEmergencyStatus(): Promise<UnifiEmergencyStatus | null> {
		const r = await this.client.get<{ data?: Partial<UnifiEmergencyStatus> }>(
			'/api/v1/developer/doors/settings/emergency',
		);
		const data = r.data?.data;
		if (!data || typeof data.lockdown !== 'boolean' || typeof data.evacuation !== 'boolean') {
			return null;
		}
		return { lockdown: data.lockdown, evacuation: data.evacuation };
	}

	async setEmergencyStatus(payload: UnifiEmergencyStatusPayload): Promise<void> {
		await this.client.put('/api/v1/developer/doors/settings/emergency', payload);
	}

	async listWebhookEndpoints(): Promise<UnifiWebhookEndpoint[]> {
		const r = await this.client.get<{ data: UnifiWebhookEndpoint[] }>('/api/v1/developer/webhooks/endpoints');
		return r.data?.data ?? [];
	}

	/**
	 * Register a webhook endpoint (API reference 11.4). A duplicate URL is reported as result
	 * `{ code: 'CODE_DEVICE_WEBHOOK_ENDPOINT_DUPLICATED' }` — whether the controller sends that code with
	 * HTTP 200 or with an error status — so the caller can adopt the existing endpoint.
	 *
	 * @param payload Name, URL and events of the endpoint
	 */
	async createWebhookEndpoint(
		payload: UnifiWebhookEndpointCreate,
	): Promise<{ code: string; endpoint?: UnifiWebhookEndpoint & { secret?: string } }> {
		try {
			const r = await this.client.post<{ code?: string; data?: UnifiWebhookEndpoint & { secret?: string } }>(
				'/api/v1/developer/webhooks/endpoints',
				payload,
			);
			return { code: r.data?.code ?? 'SUCCESS', endpoint: r.data?.data };
		} catch (err) {
			if (apiErrorCode(err) === 'CODE_DEVICE_WEBHOOK_ENDPOINT_DUPLICATED') {
				return { code: 'CODE_DEVICE_WEBHOOK_ENDPOINT_DUPLICATED', endpoint: undefined };
			}
			throw err;
		}
	}

	/**
	 * Update a webhook endpoint (API reference 11.5): name, URL, events and optional headers are
	 * replaced, id and secret are kept by the controller.
	 *
	 * @param id Endpoint id
	 * @param payload New name, URL, events (and headers)
	 * @returns The updated endpoint as reported by the controller, if the response carries one
	 */
	async updateWebhookEndpoint(
		id: string,
		payload: UnifiWebhookEndpointCreate,
	): Promise<(UnifiWebhookEndpoint & { secret?: string }) | undefined> {
		const r = await this.client.put<{ data?: UnifiWebhookEndpoint & { secret?: string } }>(
			`/api/v1/developer/webhooks/endpoints/${encodeURIComponent(id)}`,
			payload,
		);
		const data = r.data?.data;
		return data && typeof data === 'object' ? data : undefined;
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
	const code = apiErrorCode(err);
	if (code !== undefined && AUTH_ERROR_CODES.has(code)) {
		return 'unauthorized';
	}
	return 'network';
}
