import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { UnifiAccessEventEnvelope } from '../lib/types';
import type { RequestHandler } from '../webserver/sharedHttpServer';

export interface WebhookHandlerOptions {
	path: string;
	secret: () => string | null;
	logger: { debug: (msg: string) => void; info: (msg: string) => void; warn: (msg: string) => void };
	onEvent: (event: UnifiAccessEventEnvelope) => Promise<void> | void;
}

const MAX_BODY_BYTES = 1_000_000;
const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

/**
 * Lightweight handler for UniFi Access webhook events. Designed to be mounted on
 * the SharedHttpServer. The user is expected to expose this endpoint via a
 * TLS-terminating reverse proxy or via the adapter's built-in TLS option. Each
 * request carries `Signature: t=<unix>,v1=<hex>`; we validate via HMAC-SHA256
 * over `<t>.<rawBody>` using the secret returned at endpoint registration time.
 */
export class WebhookHandler {
	readonly options: WebhookHandlerOptions;

	constructor(options: WebhookHandlerOptions) {
		this.options = options;
	}

	matches = (req: IncomingMessage): boolean => {
		return req.url?.split('?')[0] === this.options.path;
	};

	handle: RequestHandler = async (req, res) => {
		if (req.method !== 'POST') {
			res.statusCode = 405;
			res.end();
			return true;
		}

		let body: Buffer;
		try {
			body = await readBody(req);
		} catch (err) {
			this.options.logger.warn(`Webhook body read failed: ${(err as Error).message}`);
			res.statusCode = 400;
			res.end();
			return true;
		}

		const secret = this.options.secret();
		if (!secret) {
			this.options.logger.warn('Webhook received but no secret configured — rejecting.');
			res.statusCode = 401;
			res.end();
			return true;
		}

		const sigHeader = req.headers.signature;
		const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
		if (!sig || !verifySignature(body, sig, secret)) {
			this.options.logger.warn('Webhook signature verification failed.');
			res.statusCode = 401;
			res.end();
			return true;
		}

		let parsed: UnifiAccessEventEnvelope;
		try {
			parsed = JSON.parse(body.toString('utf8')) as UnifiAccessEventEnvelope;
		} catch (err) {
			this.options.logger.warn(`Webhook JSON parse failed: ${(err as Error).message}`);
			res.statusCode = 400;
			res.end();
			return true;
		}

		try {
			await this.options.onEvent(parsed);
		} catch (err) {
			this.options.logger.warn(`Webhook handler error: ${(err as Error).message}`);
		}

		res.statusCode = 200;
		res.end('OK');
		return true;
	};
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

function verifySignature(payload: Buffer, header: string, secret: string): boolean {
	let timestampStr: string | null = null;
	let signatureHex: string | null = null;
	for (const pair of header.split(',')) {
		const idx = pair.indexOf('=');
		if (idx === -1) {
			continue;
		}
		const key = pair.slice(0, idx).trim();
		const value = pair.slice(idx + 1).trim();
		if (key === 't') {
			timestampStr = value;
		} else if (key === 'v1') {
			signatureHex = value;
		}
	}
	if (!timestampStr || !signatureHex) {
		return false;
	}
	const timestamp = Number.parseInt(timestampStr, 10);
	if (!Number.isFinite(timestamp)) {
		return false;
	}
	const skew = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
	if (skew > MAX_TIMESTAMP_SKEW_SECONDS) {
		return false;
	}
	const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(payload).digest();
	let provided: Buffer;
	try {
		provided = Buffer.from(signatureHex, 'hex');
	} catch {
		return false;
	}
	if (provided.length !== expected.length) {
		return false;
	}
	return timingSafeEqual(provided, expected);
}
