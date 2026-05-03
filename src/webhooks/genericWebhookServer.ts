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
			res.setHeader('WWW-Authenticate', 'Bearer realm="webhook"');
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

		this.options.logger.info(
			`Generic webhook: ${req.method} ${req.url} — body: ${body.toString('utf8').slice(0, 2000)}`,
		);
		await this.options.onRequest({ body, headers, method: req.method ?? 'POST', url: req.url ?? '/' });

		res.statusCode = 200;
		res.end('OK');
		return true;
	};

	private checkAuth(req: IncomingMessage): boolean {
		const { auth, username, password, token } = this.options;
		if (auth === 'none') {
			return true;
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
			return u === (username ?? '') && p === (password ?? '');
		}
		if (auth === 'bearer') {
			if (!authHeader.startsWith('Bearer ')) {
				return false;
			}
			return authHeader.slice('Bearer '.length) === (token ?? '');
		}
		return false;
	}
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
