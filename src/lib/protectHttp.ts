import axios, { type AxiosInstance, AxiosError } from 'axios';
import https from 'node:https';

export interface ProtectHttpOptions {
	host: string;
	username: string;
	password: string;
	verifyTLS?: boolean;
}

export class ProtectHttp {
	private readonly client: AxiosInstance;
	private readonly username: string;
	private readonly password: string;

	private sessionCookie = '';
	private csrfToken = '';
	private _loggedIn = false;

	constructor(options: ProtectHttpOptions) {
		this.username = options.username;
		this.password = options.password;
		this.client = axios.create({
			baseURL: `https://${options.host}`,
			timeout: 15_000,
			httpsAgent: new https.Agent({
				rejectUnauthorized: options.verifyTLS === true,
			}),
		});
	}

	isLoggedIn(): boolean {
		return this._loggedIn;
	}

	async login(): Promise<void> {
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
			throw new Error('Protect login failed: credentials rejected');
		}
		if (r.status >= 400) {
			this._loggedIn = false;
			throw new Error(`Protect login failed: HTTP ${r.status}`);
		}

		this.extractSession(r.headers);

		if (!this.sessionCookie) {
			this._loggedIn = false;
			throw new Error('Protect login failed: no session cookie in response');
		}

		this._loggedIn = true;
	}

	async getSnapshot(cameraId: string): Promise<Buffer> {
		return this.withRetry(async retry => {
			const r = await this.client.get<ArrayBuffer>(
				`/proxy/protect/api/cameras/${encodeURIComponent(cameraId)}/snapshot`,
				{ headers: this.authHeaders(), responseType: 'arraybuffer', validateStatus: s => s < 500 },
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
		try {
			const r = await this.client.get<Record<string, unknown>>(
				`/proxy/protect/api/events/${encodeURIComponent(eventId)}`,
				{ headers: this.authHeaders(), validateStatus: s => s < 500 },
			);
			this.extractSession(r.headers);
			if (r.status === 401 || r.status === 403) {
				this._loggedIn = false;
				await this.login();
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

	async getClipBuffer(clipPath: string): Promise<Buffer> {
		const path = clipPath.startsWith('/') ? clipPath : `/proxy/protect/api/${clipPath}`;
		const r = await this.client.get<ArrayBuffer>(path, {
			headers: this.authHeaders(),
			responseType: 'arraybuffer',
			validateStatus: s => s < 500,
		});
		this.extractSession(r.headers);
		if (r.status !== 200) {
			throw new Error(`Protect clip HTTP ${r.status}`);
		}
		return Buffer.from(r.data);
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
		// null signals auth failure → re-login + retry
		this._loggedIn = false;
		await this.login();
		const retried = await fn(true);
		if (retried === null) {
			throw new Error('Protect auth failed after re-login');
		}
		return retried;
	}
}

export function classifyProtectError(err: unknown): 'unauthorized' | 'network' {
	if (err instanceof AxiosError) {
		if (err.response?.status === 401 || err.response?.status === 403) {
			return 'unauthorized';
		}
	}
	return 'network';
}
