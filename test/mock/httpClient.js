'use strict';

/**
 * Tiny promise wrapper around node:http / node:https for tests.
 * Unlike fetch/axios it can send a request target verbatim (`rawPath`), which is needed
 * to probe servers with path-traversal attempts that a URL parser would normalise away.
 */

const http = require('node:http');
const https = require('node:https');

/**
 * Perform one HTTP(S) request. Never throws on HTTP status codes; rejects on network errors.
 *
 * @param {object} options Request description
 * @param {string} options.url Target URL (scheme, host, port; path unless `rawPath` is given)
 * @param {string} [options.method] HTTP method (default GET)
 * @param {Record<string, string>} [options.headers] Request headers
 * @param {string | Buffer} [options.body] Request body
 * @param {string} [options.rawPath] Request target sent verbatim instead of the URL's path
 * @param {number} [options.timeoutMs] Socket timeout (default 5000)
 * @param {string} [options.ca] Trusted CA certificate (PEM); without it TLS certificates are not verified
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: Buffer, text: string }>}
 *   The response
 */
function httpRequest(options) {
	const target = new URL(options.url);
	const isHttps = target.protocol === 'https:';
	const transport = isHttps ? https : http;
	const body = options.body === undefined ? undefined : Buffer.from(options.body);
	const headers = { ...options.headers };
	if (body && headers['Content-Length'] === undefined && headers['content-length'] === undefined) {
		headers['Content-Length'] = String(body.length);
	}
	return new Promise((resolve, reject) => {
		const req = transport.request(
			{
				protocol: target.protocol,
				hostname: target.hostname.replace(/^\[|\]$/g, ''),
				port: target.port || (isHttps ? 443 : 80),
				path: options.rawPath ?? `${target.pathname}${target.search}`,
				method: options.method ?? 'GET',
				headers,
				agent: false,
				timeout: options.timeoutMs ?? 5000,
				...(isHttps ? { rejectUnauthorized: options.ca !== undefined, ca: options.ca } : {}),
			},
			res => {
				const chunks = [];
				res.on('data', chunk => chunks.push(chunk));
				res.on('end', () => {
					const buffer = Buffer.concat(chunks);
					resolve({
						status: res.statusCode ?? 0,
						headers: res.headers,
						body: buffer,
						text: buffer.toString('utf8'),
					});
				});
				res.on('error', reject);
			},
		);
		req.on('timeout', () => req.destroy(new Error('request timed out')));
		req.on('error', reject);
		req.end(body);
	});
}

module.exports = { httpRequest };
