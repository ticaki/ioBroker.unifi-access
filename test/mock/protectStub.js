'use strict';

/**
 * Minimal stand-in for a UniFi OS console with UniFi Protect.
 *
 * NOT part of the documented UniFi Access developer API: the Protect integration of the adapter
 * talks to the private UniFi OS / Protect API (cookie login with CSRF token, snapshot, event
 * metadata, clip download). This stub models exactly what `src/lib/protectHttp.ts` uses, so the
 * adapter's Protect wiring in `src/main.ts` can be tested — it proves nothing about a real console.
 */

const https = require('node:https');

const { createSelfSignedCert } = require('./selfSignedCert');

class ProtectStub {
	/**
	 * @param {object} [options] Stub configuration
	 * @param {string} [options.username] Accepted user name (default `viewer`)
	 * @param {string} [options.password] Accepted password (default `protect-secret`)
	 * @param {string[]} [options.altNames] subjectAltName entries of the generated certificate
	 * @param {number} [options.port] Port to listen on (default 0 = let the OS pick)
	 */
	constructor(options = {}) {
		this.username = options.username ?? 'viewer';
		this.password = options.password ?? 'protect-secret';
		this.altNames = options.altNames;
		this.requestedPort = options.port ?? 0;
		/** @type {{ method: string, url: string, headers: import('node:http').IncomingHttpHeaders, body: string, status: number }[]} */
		this.requests = [];
		/** @type {{ username?: string, password?: string, status: number }[]} every login attempt */
		this.logins = [];
		/** HTTP status forced for the next N logins: `{ status, times }` */
		this.loginFault = null;
		/**
		 * Called when a login request has arrived, before it is answered (e.g. to stop the adapter
		 * while its login is in flight).
		 *
		 * @type {(() => void) | null}
		 */
		this.onLoginReceived = null;
		this.snapshot = Buffer.from([0xff, 0xd8, 0x50, 0x52, 0x4f, 0x54, 0xff, 0xd9]);
		this.clip = Buffer.from('protect-clip-bytes');
		/** @type {Record<string, Record<string, unknown>>} event id → event metadata */
		this.events = {};
		this.sessions = 0;
		/** sessions with a number up to this one are no longer accepted (see expireSessions) */
		this.expiredUpTo = 0;
		this.port = 0;
		/** @type {import('node:https').Server | null} */
		this.server = null;
		/** @type {{ key: string, cert: string } | null} */
		this.tls = null;
	}

	/** PEM certificate of the stub (usable as `caCert`). */
	get cert() {
		if (!this.tls) {
			throw new Error('protect stub not started yet');
		}
		return this.tls.cert;
	}

	async start() {
		// A name of its own: with two self-signed certificates of the same name in one CA setting,
		// OpenSSL can only match the issuer by name and may pick the wrong one (order differs by platform).
		this.tls = createSelfSignedCert({ commonName: 'unifi-protect-stub', altNames: this.altNames });
		const server = https.createServer({ key: this.tls.key, cert: this.tls.cert }, (req, res) => {
			const chunks = [];
			req.on('data', chunk => chunks.push(chunk));
			req.on('end', () => this.handle(req, res, Buffer.concat(chunks).toString('utf8')));
		});
		await new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen(this.requestedPort, '127.0.0.1', () => {
				server.removeListener('error', reject);
				resolve(undefined);
			});
		});
		this.server = server;
		const address = server.address();
		this.port = typeof address === 'object' && address ? address.port : 0;
		return this;
	}

	async stop() {
		const server = this.server;
		if (!server) {
			return;
		}
		this.server = null;
		await new Promise(resolve => {
			server.close(() => resolve(undefined));
			server.closeAllConnections();
		});
	}

	/**
	 * Answer the next `times` login attempts with the given HTTP status.
	 *
	 * @param {number} status HTTP status
	 * @param {number} [times] Number of attempts (default 1)
	 */
	failLogins(status, times = 1) {
		this.loginFault = { status, times };
	}

	/** Invalidate every session handed out so far (the console was restarted, the session timed out). */
	expireSessions() {
		this.expiredUpTo = this.sessions;
	}

	handle(req, res, body) {
		const url = req.url ?? '/';
		const record = { method: req.method ?? 'GET', url, headers: req.headers, body, status: 0 };
		this.requests.push(record);
		const send = (status, payload, headers = {}) => {
			record.status = status;
			const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload === undefined ? '' : JSON.stringify(payload));
			res.writeHead(status, { 'Content-Length': data.length, ...headers });
			res.end(data);
		};
		const path = url.split('?')[0];

		if (req.method === 'GET' && path === '/') {
			send(200, undefined, { 'x-csrf-token': 'initial-csrf' });
			return;
		}
		if (req.method === 'POST' && path === '/api/auth/login') {
			let credentials = {};
			try {
				credentials = JSON.parse(body);
			} catch {
				// handled as wrong credentials below
			}
			let status = credentials.username === this.username && credentials.password === this.password ? 200 : 401;
			if (this.loginFault && this.loginFault.times > 0) {
				status = this.loginFault.status;
				this.loginFault.times -= 1;
			}
			this.logins.push({ username: credentials.username, password: credentials.password, status });
			this.onLoginReceived?.();
			if (status !== 200) {
				send(status, { error: 'login failed' });
				return;
			}
			this.sessions += 1;
			send(200, { ok: true }, { 'set-cookie': [`TOKEN=session-${this.sessions}; Path=/; HttpOnly`], 'x-updated-csrf-token': 'csrf-1' });
			return;
		}
		const session = /TOKEN=session-(\d+)/.exec(req.headers.cookie ?? '');
		if (!session || Number(session[1]) <= this.expiredUpTo) {
			send(401, { error: 'unauthorized' });
			return;
		}
		let match;
		if ((match = /^\/proxy\/protect\/api\/cameras\/([^/]+)\/snapshot$/.exec(path))) {
			send(200, this.snapshot, { 'Content-Type': 'image/jpeg' });
			return;
		}
		if ((match = /^\/proxy\/protect\/api\/events\/([^/]+)$/.exec(path))) {
			const event = this.events[decodeURIComponent(match[1])];
			if (!event) {
				send(404, { error: 'not found' });
				return;
			}
			send(200, event, { 'Content-Type': 'application/json' });
			return;
		}
		if (path.startsWith('/proxy/protect/api/video/')) {
			send(200, this.clip, { 'Content-Type': 'video/mp4' });
			return;
		}
		send(404, { error: 'not found' });
	}
}

module.exports = { ProtectStub };
