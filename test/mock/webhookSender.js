'use strict';

/**
 * Sends webhook requests the way UniFi Access does (api_reference 11.7):
 * HTTP(S) POST with a JSON body and the header
 *     Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 over "<t>.<rawBody>" with the endpoint secret>
 *
 * Besides valid requests the helper can produce deliberately broken ones
 * (wrong secret, tampered body, expired timestamp, missing header) for negative tests.
 */

const crypto = require('node:crypto');

const { httpRequest } = require('./httpClient');

/**
 * Compute the `v1` signature for a webhook body.
 *
 * @param {string} secret Endpoint secret returned by POST /webhooks/endpoints
 * @param {string | Buffer} rawBody Exact bytes that are sent as request body
 * @param {number} timestamp Unix time in seconds
 * @returns {string} Lower-case hex HMAC-SHA256
 */
function computeSignature(secret, rawBody, timestamp) {
	return crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
}

/**
 * Build the value of the `Signature` header.
 *
 * @param {string} secret Endpoint secret
 * @param {string | Buffer} rawBody Exact request body
 * @param {number} [timestamp] Unix time in seconds (default: now)
 * @returns {string} `t=<unix>,v1=<hex>`
 */
function signatureHeader(secret, rawBody, timestamp = Math.floor(Date.now() / 1000)) {
	return `t=${timestamp},v1=${computeSignature(secret, rawBody, timestamp)}`;
}

/**
 * POST a webhook request.
 *
 * @param {object} options Request description
 * @param {string} options.url Target URL (http:// or https://)
 * @param {string} [options.secret] Endpoint secret used for signing
 * @param {object | string | Buffer} options.body Event envelope (objects are JSON-serialised)
 * @param {'valid' | 'invalid' | 'tampered' | 'expired' | 'future' | 'missing' | 'malformed'} [options.signature]
 *   Which kind of signature to send. `invalid` = signed with a wrong secret, `tampered` = body changed
 *   after signing, `expired`/`future` = correctly signed but 1 hour off, `missing` = no header,
 *   `malformed` = header without t/v1 pairs. Default `valid`.
 * @param {number} [options.timestamp] Explicit unix timestamp (seconds) to sign with
 * @param {string} [options.signatureHeader] Send exactly this header value (overrides `signature`)
 * @param {Record<string, string>} [options.headers] Additional request headers
 * @param {string} [options.method] HTTP method, default POST
 * @param {number} [options.timeoutMs] Request timeout, default 5000 ms (the controller's documented timeout)
 * @returns {Promise<{ status: number, body: string, headers: Record<string, string | string[] | undefined> }>}
 *   Response of the receiver. Network errors reject.
 */
async function sendWebhook(options) {
	const mode = options.signature ?? 'valid';
	const secret = options.secret ?? '';
	const raw = Buffer.isBuffer(options.body)
		? options.body
		: Buffer.from(typeof options.body === 'string' ? options.body : JSON.stringify(options.body), 'utf8');
	const now = Math.floor(Date.now() / 1000);

	let sentBody = raw;
	/** @type {string | undefined} */
	let header;
	switch (mode) {
		case 'valid':
			header = signatureHeader(secret, raw, options.timestamp ?? now);
			break;
		case 'invalid':
			header = signatureHeader(`${secret}-wrong`, raw, options.timestamp ?? now);
			break;
		case 'tampered':
			header = signatureHeader(secret, raw, options.timestamp ?? now);
			sentBody = Buffer.concat([raw, Buffer.from(' ')]);
			break;
		case 'expired':
			header = signatureHeader(secret, raw, options.timestamp ?? now - 3600);
			break;
		case 'future':
			header = signatureHeader(secret, raw, options.timestamp ?? now + 3600);
			break;
		case 'malformed':
			header = 'this-is-not-a-signature';
			break;
		case 'missing':
			header = undefined;
			break;
		default:
			throw new Error(`unknown signature mode: ${mode}`);
	}
	if (options.signatureHeader !== undefined) {
		header = options.signatureHeader;
	}

	/** @type {Record<string, string>} */
	const headers = { 'Content-Type': 'application/json', ...options.headers };
	if (header !== undefined) {
		headers.Signature = header;
	}

	// The receiver may use a self-signed certificate, exactly like the controller itself (no `ca` → not verified).
	const response = await httpRequest({
		url: options.url,
		method: options.method ?? 'POST',
		headers,
		body: sentBody,
		timeoutMs: options.timeoutMs ?? 5000,
	});
	return { status: response.status, body: response.text, headers: response.headers };
}

module.exports = { computeSignature, signatureHeader, sendWebhook };
