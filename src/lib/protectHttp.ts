import axios, { type AxiosInstance, AxiosError } from 'axios';
import https from 'node:https';
import type { Readable } from 'node:stream';
import { isSafeProtectId, sanitizeProtectClipPath } from './pathSafety';
import { tlsCertificateErrorCode } from './tlsErrors';
import { trustedCertificates } from './caCert';
import { throwIfStopped } from './stopSignal';

export interface ProtectHttpOptions {
	/** Host name or address of the UniFi OS console (a `host:port` value is used as it is). */
	host: string;
	/** HTTPS port, appended to `host` unless it is 443 or not given. */
	port?: number;
	username: string;
	password: string;
	/** Verify the console's TLS certificate (against `caCert` when given, else the system CAs). */
	verifyTLS?: boolean;
	/** PEM certificate (chain) to trust in addition to the system CAs. */
	caCert?: string;
	/**
	 * Minimum distance between two logins that media requests trigger by themselves (default 30 s).
	 * Media URLs are fetched by dashboards without any rate limit; every one of them must not become
	 * a login attempt with the real credentials while the console refuses logins (rate limit).
	 */
	reloginIntervalMs?: number;
	/** Clock (tests). */
	now?: () => number;
	/** Stop signal of the adapter: once it is true, every new request is refused with `StoppedError`. */
	isStopped?: () => boolean;
}

/** Default for {@link ProtectHttpOptions.reloginIntervalMs}. */
export const DEFAULT_RELOGIN_INTERVAL_MS = 30_000;

/** Upper bound for a camera snapshot held in memory (a JPEG still is far smaller). */
export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
/** Upper bound for a clip that is buffered instead of streamed. */
export const MAX_BUFFERED_CLIP_BYTES = 64 * 1024 * 1024;

export interface ProtectClipStream {
	/** The clip bytes as they arrive from Protect — nothing is buffered. */
	stream: Readable;
	/** Size announced by Protect, if any. */
	contentLength?: number;
}

export type ProtectLoginFailure = 'credentials' | 'rate-limited' | 'http' | 'no-session';

/** Login was answered by the console but did not produce a session. */
export class ProtectLoginError extends Error {
	readonly kind: ProtectLoginFailure;
	readonly status?: number;

	constructor(kind: ProtectLoginFailure, message: string, status?: number) {
		super(message);
		this.name = 'ProtectLoginError';
		this.kind = kind;
		this.status = status;
	}
}

export class ProtectHttp {
	private readonly client: AxiosInstance;
	private readonly username: string;
	private readonly password: string;

	private sessionCookie = '';
	private csrfToken = '';
	private _loggedIn = false;
	/** The login that is running — every caller waits for the same one (single flight). */
	private loginInFlight: Promise<void> | null = null;
	/** When the last login attempt failed (ms, own clock); 0 = the last attempt succeeded or none was made. */
	private lastLoginFailureAt = 0;
	private readonly reloginIntervalMs: number;
	private readonly now: () => number;

	constructor(options: ProtectHttpOptions) {
		this.username = options.username;
		this.password = options.password;
		this.reloginIntervalMs = options.reloginIntervalMs ?? DEFAULT_RELOGIN_INTERVAL_MS;
		this.now = options.now ?? Date.now;
		const port = options.port && options.port !== 443 ? `:${options.port}` : '';
		this.client = axios.create({
			baseURL: `https://${options.host}${port}`,
			timeout: 15_000,
			httpsAgent: new https.Agent({
				rejectUnauthorized: options.verifyTLS === true,
				// in addition to the system CAs (Node's `ca` alone would replace them)
				ca: trustedCertificates(options.caCert),
			}),
		});
		// after the stop nothing more is sent to the console (login, snapshot, clip)
		this.client.interceptors.request.use(config => {
			throwIfStopped(options.isStopped);
			return config;
		});
	}

	isLoggedIn(): boolean {
		return this._loggedIn;
	}

	/**
	 * Log in. Concurrent calls share one attempt. This is the explicit login of the adapter (start and
	 * its own retry with back-off); logins that media requests need go through {@link relogin}.
	 */
	login(): Promise<void> {
		if (!this.loginInFlight) {
			this.loginInFlight = this.performLogin().then(
				() => {
					this.lastLoginFailureAt = 0;
					this.loginInFlight = null;
				},
				(err: unknown) => {
					this.lastLoginFailureAt = this.now();
					this.loginInFlight = null;
					throw err;
				},
			);
		}
		return this.loginInFlight;
	}

	/**
	 * Login on behalf of a media request (session missing or expired). Joins a running login; refuses
	 * without contacting the console when the last attempt failed less than `reloginIntervalMs` ago
	 * (rate limit, console not reachable — another attempt right away would only prolong it).
	 */
	private relogin(): Promise<void> {
		if (this.loginInFlight) {
			return this.loginInFlight;
		}
		const waitMs = this.lastLoginFailureAt + this.reloginIntervalMs - this.now();
		if (this.lastLoginFailureAt > 0 && waitMs > 0) {
			return Promise.reject(
				new ProtectLoginError(
					'no-session',
					`Protect session not available — next login attempt possible in ${Math.ceil(waitMs / 1000)} s`,
				),
			);
		}
		return this.login();
	}

	/** Before a media request: without a session, log in first (or fail fast while logins are on hold). */
	private async ensureSession(): Promise<void> {
		if (!this._loggedIn) {
			await this.relogin();
		}
	}

	private async performLogin(): Promise<void> {
		// Step 1: fetch initial CSRF token from root
		let initialCsrf = '';
		try {
			const r = await this.client.get<unknown>('/', { validateStatus: () => true, maxRedirects: 0 });
			const raw = r.headers['x-csrf-token'];
			initialCsrf = typeof raw === 'string' ? raw : '';
		} catch {
			// host may return nothing on /, ignore
		}

		// Step 2: POST /api/auth/login
		const loginHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
		if (initialCsrf) {
			loginHeaders['x-csrf-token'] = initialCsrf;
		}

		const r = await this.client.post<unknown>(
			'/api/auth/login',
			{ username: this.username, password: this.password, rememberMe: true, token: '' },
			{ headers: loginHeaders, validateStatus: s => s < 500 },
		);

		if (r.status === 401 || r.status === 403) {
			this._loggedIn = false;
			throw new ProtectLoginError('credentials', 'Protect login failed: credentials rejected', r.status);
		}
		if (r.status >= 400) {
			this._loggedIn = false;
			throw new ProtectLoginError(
				r.status === 429 ? 'rate-limited' : 'http',
				`Protect login failed: HTTP ${r.status}`,
				r.status,
			);
		}

		this.extractSession(r.headers);

		if (!this.sessionCookie) {
			this._loggedIn = false;
			throw new ProtectLoginError('no-session', 'Protect login failed: no session cookie in response');
		}

		this._loggedIn = true;
	}

	async getSnapshot(cameraId: string): Promise<Buffer> {
		if (!isSafeProtectId(cameraId)) {
			// ids come from system-log entries / request URLs; never let them shape the request path
			throw new Error('Protect camera id rejected');
		}
		await this.ensureSession();
		return this.withRetry(async retry => {
			const r = await this.client.get<ArrayBuffer>(
				`/proxy/protect/api/cameras/${encodeURIComponent(cameraId)}/snapshot`,
				{
					headers: this.authHeaders(),
					responseType: 'arraybuffer',
					maxContentLength: MAX_SNAPSHOT_BYTES,
					validateStatus: s => s < 500,
				},
			);
			this.extractSession(r.headers);
			if ((r.status === 401 || r.status === 403) && !retry) {
				return null; // trigger retry
			}
			if (r.status !== 200) {
				throw new Error(`Protect snapshot HTTP ${r.status}`);
			}
			return Buffer.from(r.data);
		});
	}

	async getEventMeta(eventId: string): Promise<{ clipUrl?: string } | null> {
		if (!isSafeProtectId(eventId)) {
			return null;
		}
		try {
			await this.ensureSession();
			const r = await this.client.get<Record<string, unknown>>(
				`/proxy/protect/api/events/${encodeURIComponent(eventId)}`,
				{ headers: this.authHeaders(), validateStatus: s => s < 500 },
			);
			this.extractSession(r.headers);
			if (r.status === 401 || r.status === 403) {
				this._loggedIn = false;
				await this.relogin();
				const r2 = await this.client.get<Record<string, unknown>>(
					`/proxy/protect/api/events/${encodeURIComponent(eventId)}`,
					{ headers: this.authHeaders(), validateStatus: s => s < 500 },
				);
				if (r2.status !== 200) {
					return null;
				}
				return { clipUrl: (r2.data?.clipUrl ?? r2.data?.clip) as string | undefined };
			}
			if (r.status !== 200) {
				return null;
			}
			return { clipUrl: (r.data?.clipUrl ?? r.data?.clip) as string | undefined };
		} catch {
			return null;
		}
	}

	/**
	 * Fetch a clip into memory. Limited to {@link MAX_BUFFERED_CLIP_BYTES}; prefer
	 * {@link getClipStream} for serving clips.
	 *
	 * @param clipPath Clip location reported by Protect
	 */
	async getClipBuffer(clipPath: string): Promise<Buffer> {
		const r = await this.client.get<ArrayBuffer>(this.clipRequestPath(clipPath), {
			headers: this.authHeaders(),
			responseType: 'arraybuffer',
			maxContentLength: MAX_BUFFERED_CLIP_BYTES,
			validateStatus: s => s < 500,
		});
		this.extractSession(r.headers);
		if (r.status !== 200) {
			throw new Error(`Protect clip HTTP ${r.status}`);
		}
		return Buffer.from(r.data);
	}

	/**
	 * Open a clip as a stream: the bytes are passed on as they arrive instead of holding a whole
	 * video in memory.
	 *
	 * @param clipPath Clip location reported by Protect
	 */
	async getClipStream(clipPath: string): Promise<ProtectClipStream> {
		const path = this.clipRequestPath(clipPath);
		await this.ensureSession();
		const r = await this.client.get<Readable>(path, {
			headers: this.authHeaders(),
			responseType: 'stream',
			validateStatus: s => s < 500,
		});
		this.extractSession(r.headers);
		if (r.status !== 200) {
			r.data.destroy();
			throw new Error(`Protect clip HTTP ${r.status}`);
		}
		const length = Number(r.headers['content-length']);
		return { stream: r.data, contentLength: Number.isFinite(length) && length >= 0 ? length : undefined };
	}

	/**
	 * The clip location is taken from a Protect response and requested with the session cookie
	 * attached: it must stay a path below /proxy/protect/api/ on this host.
	 *
	 * @param clipPath Clip location reported by Protect
	 */
	private clipRequestPath(clipPath: string): string {
		const path = sanitizeProtectClipPath(clipPath);
		if (path === null) {
			throw new Error('Protect clip location rejected');
		}
		return path;
	}

	private authHeaders(): Record<string, string> {
		const h: Record<string, string> = { Cookie: this.sessionCookie };
		if (this.csrfToken) {
			h['x-csrf-token'] = this.csrfToken;
		}
		return h;
	}

	private extractSession(headers: Record<string, unknown>): void {
		const updatedCsrf = headers['x-updated-csrf-token'];
		if (typeof updatedCsrf === 'string' && updatedCsrf) {
			this.csrfToken = updatedCsrf;
		}
		const setCookie = headers['set-cookie'];
		if (Array.isArray(setCookie)) {
			this.sessionCookie = (setCookie as string[]).map(c => c.split(';')[0]).join('; ');
		} else if (typeof setCookie === 'string') {
			this.sessionCookie = setCookie.split(';')[0];
		}
	}

	private async withRetry(fn: (retry: boolean) => Promise<Buffer | null>): Promise<Buffer> {
		const result = await fn(false);
		if (result !== null) {
			return result;
		}
		// null signals auth failure → re-login (shared, rate-limited) + retry
		this._loggedIn = false;
		await this.relogin();
		const retried = await fn(true);
		if (retried === null) {
			throw new Error('Protect auth failed after re-login');
		}
		return retried;
	}
}

/**
 * Classify a failed {@link ProtectHttp.login} so the caller can decide between "fix the
 * configuration" (`credentials`, `tls`) and "try again later" (`rate-limited`, `network`).
 *
 * @param err Error thrown by login()
 */
export function classifyProtectError(err: unknown): 'credentials' | 'tls' | 'rate-limited' | 'network' {
	if (err instanceof ProtectLoginError) {
		if (err.kind === 'credentials') {
			return 'credentials';
		}
		return err.kind === 'rate-limited' ? 'rate-limited' : 'network';
	}
	if (tlsCertificateErrorCode(err) !== undefined) {
		return 'tls';
	}
	if (err instanceof AxiosError) {
		if (err.response?.status === 401 || err.response?.status === 403) {
			return 'credentials';
		}
		if (err.response?.status === 429) {
			return 'rate-limited';
		}
	}
	return 'network';
}
