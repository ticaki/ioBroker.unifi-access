import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { RequestHandler } from '../webserver/sharedHttpServer';

export type GenericWebhookAuthMode = 'none' | 'basic' | 'bearer';

export interface GenericWebhookHandlerOptions {
	path: string;
	auth: GenericWebhookAuthMode;
	username?: string;
	password?: string;
	token?: string;
	logger: {
		debug: (msg: string) => void;
		info: (msg: string) => void;
		warn: (msg: string) => void;
	};
	onRequest: (data: {
		body: Buffer;
		headers: Record<string, string | string[] | undefined>;
		method: string;
		url: string;
	}) => Promise<void> | void;
}

const MAX_BODY_BYTES = 1_000_000;

export class GenericWebhookHandler {
	readonly options: GenericWebhookHandlerOptions;

	constructor(options: GenericWebhookHandlerOptions) {
		this.options = options;
	}

	matches = (req: IncomingMessage): boolean => {
		return (req.url?.split('?')[0] ?? '/') === this.options.path;
	};

	handle: RequestHandler = async (req, res) => {
		if (!this.checkAuth(req)) {
			// challenge with the scheme that is actually configured (RFC 7617 / RFC 6750)
			res.setHeader(
				'WWW-Authenticate',
				this.options.auth === 'basic' ? 'Basic realm="webhook", charset="UTF-8"' : 'Bearer realm="webhook"',
			);
			res.statusCode = 401;
			res.end('Unauthorized');
			return true;
		}

		let body: Buffer;
		try {
			body = await readBody(req);
		} catch (err) {
			this.options.logger.warn(`Generic webhook body read failed: ${(err as Error).message}`);
			res.statusCode = 400;
			res.end();
			return true;
		}

		const headers: Record<string, string | string[] | undefined> = {};
		for (const [k, v] of Object.entries(req.headers)) {
			headers[k] = v;
		}

		// the body is logged once, by the consumer, at debug level — not here as well
		this.options.logger.debug(`Generic webhook: ${req.method} ${req.url} (${body.length} bytes)`);
		await this.options.onRequest({ body, headers, method: req.method ?? 'POST', url: req.url ?? '/' });

		res.statusCode = 200;
		res.end('OK');
		return true;
	};

	/**
	 * Whether the handler can authenticate anybody at all: `basic` needs user name and password,
	 * `bearer` needs a token. Without them every request is refused — an empty configuration must
	 * never match empty credentials.
	 */
	get credentialsConfigured(): boolean {
		const { auth, username, password, token } = this.options;
		if (auth === 'none') {
			return true;
		}
		if (auth === 'basic') {
			return !!username && !!password;
		}
		return auth === 'bearer' && !!token;
	}

	private checkAuth(req: IncomingMessage): boolean {
		const { auth, username, password, token } = this.options;
		if (auth === 'none') {
			return true;
		}
		if (!this.credentialsConfigured) {
			return false;
		}
		const authHeader = req.headers.authorization;
		if (!authHeader) {
			return false;
		}
		if (auth === 'basic') {
			if (!authHeader.startsWith('Basic ')) {
				return false;
			}
			const decoded = Buffer.from(authHeader.slice('Basic '.length), 'base64').toString('utf8');
			const colonIdx = decoded.indexOf(':');
			const u = colonIdx >= 0 ? decoded.slice(0, colonIdx) : decoded;
			const p = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : '';
			// evaluate both comparisons, so the timing does not tell which of the two was wrong
			const userOk = safeEqual(u, username ?? '');
			const passwordOk = safeEqual(p, password ?? '');
			return userOk && passwordOk;
		}
		if (auth === 'bearer') {
			if (!authHeader.startsWith('Bearer ')) {
				return false;
			}
			return safeEqual(authHeader.slice('Bearer '.length), token ?? '');
		}
		return false;
	}
}

/**
 * Compare two strings in constant time (over their SHA-256 digests, so the length does not leak either).
 *
 * @param provided Value from the request
 * @param expected Configured value
 */
function safeEqual(provided: string, expected: string): boolean {
	const a = createHash('sha256').update(provided, 'utf8').digest();
	const b = createHash('sha256').update(expected, 'utf8').digest();
	return timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		req.on('data', (chunk: Buffer) => {
			total += chunk.length;
			if (total > MAX_BODY_BYTES) {
				req.destroy();
				reject(new Error('payload too large'));
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}
