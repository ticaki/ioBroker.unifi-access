import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { UnifiAccessEventEnvelope } from '../lib/types';
import type { RequestHandler } from '../webserver/sharedHttpServer';
import { LogThrottle } from '../lib/logThrottle';

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
	/** Rejected requests can come from anybody on the network: at most one warning per kind and minute. */
	private readonly rejections: LogThrottle;

	constructor(options: WebhookHandlerOptions) {
		this.options = options;
		this.rejections = new LogThrottle(options.logger);
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
			this.rejections.warn('body', `Webhook body read failed: ${(err as Error).message}`);
			res.statusCode = 400;
			res.end();
			return true;
		}

		const secret = this.options.secret();
		if (!secret) {
			this.rejections.warn('no-secret', 'Webhook received but no secret configured — rejecting.');
			res.statusCode = 401;
			res.end();
			return true;
		}

		const sigHeader = req.headers.signature;
		const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
		const verdict = sig ? verifySignature(body, sig, secret) : 'invalid';
		if (verdict !== 'ok') {
			if (typeof verdict === 'object') {
				// The signature may well be right — the request is refused because of the clocks. Say so:
				// otherwise every webhook fails with a misleading "signature" message.
				this.rejections.warn(
					'clock',
					`Webhook rejected: its timestamp differs by ${verdict.skewSeconds} s from the clock of this host (allowed: ${MAX_TIMESTAMP_SKEW_SECONDS} s). Check date and time of the UniFi console and of the ioBroker host.`,
				);
			} else {
				this.rejections.warn('signature', 'Webhook signature verification failed.');
			}
			res.statusCode = 401;
			res.end();
			return true;
		}

		let parsed: UnifiAccessEventEnvelope;
		try {
			parsed = JSON.parse(body.toString('utf8')) as UnifiAccessEventEnvelope;
		} catch (err) {
			this.rejections.warn('json', `Webhook JSON parse failed: ${(err as Error).message}`);
			res.statusCode = 400;
			res.end();
			return true;
		}

		// Acknowledge first, process afterwards: the controller waits at most 5 seconds for the answer
		// ("It is recommended to handle asynchronous processing logic", API reference 11.7).
		res.statusCode = 200;
		res.end('OK');

		const fail = (err: unknown): void => {
			this.options.logger.warn(`Webhook handler error: ${err instanceof Error ? err.message : String(err)}`);
		};
		try {
			const pending = this.options.onEvent(parsed);
			if (pending && typeof pending.then === 'function') {
				pending.then(undefined, fail);
			}
		} catch (err) {
			fail(err);
		}
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

/**
 * Verify the `Signature: t=<unix>,v1=<hex>` header (HMAC-SHA256 over `<t>.<rawBody>`).
 *
 * @param payload Raw request body
 * @param header Value of the Signature header
 * @param secret Signing secret of the endpoint
 * @returns `'ok'`, `'invalid'`, or the clock difference when the timestamp is outside the tolerance
 */
function verifySignature(payload: Buffer, header: string, secret: string): 'ok' | 'invalid' | { skewSeconds: number } {
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
		return 'invalid';
	}
	const timestamp = Number.parseInt(timestampStr, 10);
	if (!Number.isFinite(timestamp)) {
		return 'invalid';
	}
	const skew = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
	const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(payload).digest();
	let provided: Buffer;
	try {
		provided = Buffer.from(signatureHex, 'hex');
	} catch {
		return 'invalid';
	}
	if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
		return 'invalid';
	}
	// Only a correctly signed request is told about the clock difference.
	return skew > MAX_TIMESTAMP_SKEW_SECONDS ? { skewSeconds: skew } : 'ok';
}
