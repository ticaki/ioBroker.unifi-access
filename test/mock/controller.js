'use strict';

/**
 * Mock of the UniFi Access Developer API server (HTTPS + WebSocket), modelled after
 * `.doc/api_reference.md`. It implements every endpoint the adapter talks to, records
 * all incoming API requests for assertions and lets tests (or a developer via the
 * `/__mock/...` control routes) trigger WebSocket notifications and signed webhooks.
 *
 * Where the documentation is silent the mock makes an explicit, documented choice —
 * see test/mock/README.md ("Annahmen").
 */

const { EventEmitter } = require('node:events');
const https = require('node:https');
const { randomUUID, randomBytes } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const { createSelfSignedCert } = require('./selfSignedCert');
const { sendWebhook } = require('./webhookSender');
const fixtures = require('./fixtures');

// Captured at load time so the mock keeps working while a test has fake timers installed.
const setTimeout = globalThis.setTimeout;
const clearTimeout = globalThis.clearTimeout;

const API_PREFIX = '/api/v1/developer';
const WS_PATH = `${API_PREFIX}/devices/notifications`;
const CONTROL_PREFIX = '/__mock';
const MAX_BODY_BYTES = 5_000_000;

/** HTTP status used for a documented error code when the docs do not pin one down. */
const DEFAULT_ERROR_STATUS = {
	CODE_PARAMS_INVALID: 400,
	CODE_AUTH_FAILED: 401,
	CODE_ACCESS_TOKEN_INVALID: 401,
	CODE_UNAUTHORIZED: 403,
	CODE_OPERATION_FORBIDDEN: 403,
	CODE_NOT_EXISTS: 400,
	CODE_RESOURCE_NOT_FOUND: 404,
	CODE_SYSTEM_ERROR: 500,
	CODE_DEVICE_WEBHOOK_ENDPOINT_DUPLICATED: 200,
};

const ERROR_MESSAGES = {
	CODE_PARAMS_INVALID: 'Invalid parameters.',
	CODE_AUTH_FAILED: 'Authentication failed.',
	CODE_ACCESS_TOKEN_INVALID: 'The provided access token is invalid.',
	CODE_UNAUTHORIZED: 'You not are allowed to perform this action.',
	CODE_OPERATION_FORBIDDEN: 'The requested operation is not allowed.',
	CODE_NOT_EXISTS: 'The requested item does not exist.',
	CODE_RESOURCE_NOT_FOUND: 'The requested resource was not found.',
	CODE_SYSTEM_ERROR: "An error occurred on the server's end.",
	CODE_DEVICE_WEBHOOK_ENDPOINT_DUPLICATED: 'The provided endpoint already exists.',
};

class MockUnifiController extends EventEmitter {
	/**
	 * @param {object} [options] Mock configuration
	 * @param {string} [options.token] Accepted API token (default `test-token`)
	 * @param {string} [options.host] Interface to bind (default `127.0.0.1`)
	 * @param {number} [options.port] Port to bind, 0 = let the OS pick (default 0)
	 * @param {object[][] | object[]} [options.devices] Devices for GET /devices (default: fixtures)
	 * @param {object[]} [options.doors] Doors for GET /doors (default: fixtures)
	 * @param {object[]} [options.users] Users for GET /users (default: fixtures)
	 * @param {{ key: string, cert: string }} [options.tls] TLS key/cert (default: generated at start)
	 * @param {string[]} [options.altNames] subjectAltName entries for the generated certificate
	 * @param {boolean} [options.autoPong] Answer WebSocket pings (default true)
	 * @param {boolean} [options.autoEvents] Deliver an `access.door.unlock` webhook after PUT /unlock (default false)
	 * @param {boolean} [options.serveAnyStatic] Serve a tiny JPEG for unknown /system/static paths (default false)
	 * @param {number} [options.duplicateEndpointHttpStatus] HTTP status for CODE_DEVICE_WEBHOOK_ENDPOINT_DUPLICATED (default 200)
	 * @param {(message: string) => void} [options.log] Log sink (default: silent)
	 */
	constructor(options = {}) {
		super();
		this.token = options.token ?? 'test-token';
		this.host = options.host ?? '127.0.0.1';
		this.requestedPort = options.port ?? 0;
		this.tls = options.tls ?? null;
		this.altNames = options.altNames;
		this.autoPong = options.autoPong !== false;
		this.autoEvents = options.autoEvents === true;
		this.serveAnyStatic = options.serveAnyStatic === true;
		this.duplicateEndpointHttpStatus = options.duplicateEndpointHttpStatus ?? 200;
		this.log = options.log ?? (() => undefined);

		this.initial = {
			devices: fixtures.clone(options.devices ?? fixtures.DEFAULT_DEVICES),
			doors: fixtures.clone(options.doors ?? fixtures.DEFAULT_DOORS),
			users: fixtures.clone(options.users ?? fixtures.DEFAULT_USERS),
		};

		/** @type {import('node:https').Server | null} */
		this.server = null;
		/** @type {import('ws').WebSocketServer | null} */
		this.wss = null;
		this.port = 0;

		this.reset();
	}

	// ---------------------------------------------------------------- lifecycle

	/**
	 * Start listening.
	 *
	 * @param {{ port?: number }} [options] Override the port (used to come back on the same port after stop())
	 * @returns {Promise<this>} Resolves once the server accepts connections
	 */
	async start(options = {}) {
		if (this.server) {
			throw new Error('mock controller already started');
		}
		if (!this.tls) {
			this.tls = createSelfSignedCert({ altNames: this.altNames });
		}
		const server = https.createServer({ key: this.tls.key, cert: this.tls.cert }, (req, res) => {
			this.handleHttp(req, res).catch(err => {
				this.log(`mock handler error: ${err.stack ?? err}`);
				if (!res.headersSent) {
					res.statusCode = 500;
				}
				res.end();
			});
		});
		// pings are answered in handleWsConnection, so that `autoPong` can be switched at runtime
		const wss = new WebSocketServer({ noServer: true, autoPong: false });
		server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
		wss.on('connection', (ws, req) => this.handleWsConnection(ws, req));

		await new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen(options.port ?? this.requestedPort, this.host, () => {
				server.removeListener('error', reject);
				resolve(undefined);
			});
		});
		this.server = server;
		this.wss = wss;
		const address = server.address();
		this.port = typeof address === 'object' && address ? address.port : 0;
		this.log(`mock UniFi Access controller listening on ${this.url}`);
		return this;
	}

	/**
	 * Stop listening and drop every open connection (HTTP keep-alive and WebSocket).
	 * Recorded requests and state (webhook endpoints, …) are kept; `start()` can be called again.
	 *
	 * @returns {Promise<void>}
	 */
	async stop() {
		const server = this.server;
		const wss = this.wss;
		if (!server || !wss) {
			return;
		}
		this.server = null;
		this.wss = null;
		for (const client of this.wsClients) {
			client.terminate();
		}
		this.wsClients.clear();
		await new Promise(resolve => wss.close(() => resolve(undefined)));
		await new Promise(resolve => {
			server.close(() => resolve(undefined));
			server.closeAllConnections();
		});
	}

	/** Stop and start again on the same port (simulates a controller restart). */
	async restart() {
		const port = this.port;
		await this.stop();
		await this.start({ port });
	}

	/** Restore fixtures, forget webhook endpoints, recorded requests, faults and counters. */
	reset() {
		this.devices = fixtures.clone(this.initial.devices);
		this.doors = fixtures.clone(this.initial.doors);
		this.users = fixtures.clone(this.initial.users);
		this.emergency = { lockdown: false, evacuation: false };
		/** @type {{ id: string, name: string, endpoint: string, events: string[], secret: string, headers?: Record<string, string> }[]} */
		this.webhookEndpoints = [];
		/** @type {Map<string, { type: string, ended_time: number }>} */
		this.lockRules = new Map();
		/** @type {Map<string, { body: Buffer, contentType: string }>} */
		this.staticResources = new Map();
		this.systemLogHits = [];
		/** List responses omit the `secret` field when true (older firmware behaviour the adapter guards against). */
		this.omitSecretInList = false;
		/** When false the WebSocket endpoint answers 503 instead of upgrading. */
		this.wsAccepting = true;

		this.requests = [];
		this.unlocks = [];
		this.faults = [];
		this.wsHandshakes = [];
		this.wsPingCount = 0;
		this.wsConnectionCount = 0;
		this.deliveredWebhooks = [];
		if (!this.wsClients) {
			/** @type {Set<import('ws').WebSocket>} */
			this.wsClients = new Set();
		}
		this.requestSeq = 0;
	}

	get url() {
		return `https://${this.host.includes(':') ? `[${this.host}]` : this.host}:${this.port}`;
	}

	get wsUrl() {
		return `${this.url.replace(/^https/, 'wss')}${WS_PATH}`;
	}

	/** PEM certificate of the mock — pass it as `caCert` to test `verifyTLS: true`. */
	get cert() {
		if (!this.tls) {
			throw new Error('mock controller not started yet');
		}
		return this.tls.cert;
	}

	// ------------------------------------------------------------ test helpers

	clearRequests() {
		this.requests.length = 0;
	}

	/**
	 * Recorded API requests matching the filter.
	 *
	 * @param {{ method?: string, path?: string | RegExp }} [filter] `path` is compared against the URL path below `/api/v1/developer` (string: exact match, RegExp: test)
	 */
	findRequests(filter = {}) {
		return this.requests.filter(request => matchesFilter(request, filter));
	}

	/**
	 * Resolve with the first recorded request matching the filter; waits for one to arrive if necessary.
	 *
	 * @param {{ method?: string, path?: string | RegExp }} filter Request filter, see findRequests()
	 * @param {{ timeoutMs?: number, fromIndex?: number }} [options] `fromIndex` skips requests recorded earlier
	 */
	waitForRequest(filter, options = {}) {
		const fromIndex = options.fromIndex ?? 0;
		const timeoutMs = options.timeoutMs ?? 2000;
		const existing = this.requests.slice(fromIndex).find(request => matchesFilter(request, filter));
		if (existing) {
			return Promise.resolve(existing);
		}
		return new Promise((resolve, reject) => {
			const onRequest = request => {
				if (this.requests.indexOf(request) >= fromIndex && matchesFilter(request, filter)) {
					clearTimeout(timer);
					this.removeListener('request', onRequest);
					resolve(request);
				}
			};
			const timer = setTimeout(() => {
				this.removeListener('request', onRequest);
				reject(
					new Error(
						`mock controller: no request matching ${JSON.stringify({ ...filter, path: String(filter.path) })} within ${timeoutMs} ms`,
					),
				);
			}, timeoutMs);
			this.on('request', onRequest);
		});
	}

	/**
	 * Make upcoming API requests fail.
	 *
	 * @param {object} fault Fault description
	 * @param {string} [fault.method] Only for this HTTP method
	 * @param {string | RegExp} [fault.path] Only for this path below `/api/v1/developer` (string: exact, RegExp: test)
	 * @param {number} [fault.status] HTTP status (default: mapped from `code`, else 500)
	 * @param {string} [fault.code] Documented error code for the response envelope (default CODE_SYSTEM_ERROR)
	 * @param {string} [fault.msg] Message for the response envelope
	 * @param {unknown} [fault.body] Send exactly this body instead of an error envelope (objects as JSON)
	 * @param {boolean} [fault.hangUp] Destroy the socket without answering (network error)
	 * @param {number} [fault.delayMs] Wait this long before answering (alone: the regular answer comes late)
	 * @param {number} [fault.times] How many requests to fail (default 1, Infinity = until reset)
	 */
	failNext(fault) {
		this.faults.push({ ...fault, remaining: fault.times ?? 1 });
	}

	clearFaults() {
		this.faults.length = 0;
	}

	/**
	 * Register content for GET /system/static/<path>.
	 *
	 * @param {string} path Resource path as it appears in event payloads, e.g. `/preview/reader_x.jpg`
	 * @param {Buffer} [body] Content (default: tiny JPEG)
	 * @param {string} [contentType] Content type (default image/jpeg)
	 */
	addStaticResource(path, body = fixtures.TINY_JPEG, contentType = 'image/jpeg') {
		this.staticResources.set(path.replace(/^\/+/, ''), { body, contentType });
	}

	/**
	 * Add a webhook endpoint directly (as if it had been registered earlier).
	 *
	 * @param {{ endpoint: string, name?: string, events?: string[], secret?: string, id?: string, headers?: Record<string, string> }} endpoint Endpoint data
	 */
	addWebhookEndpoint(endpoint) {
		const entry = {
			id: endpoint.id ?? randomUUID(),
			name: endpoint.name ?? 'subscription events',
			endpoint: endpoint.endpoint,
			events: endpoint.events ?? [...fixtures.WEBHOOK_EVENTS],
			secret: endpoint.secret ?? randomBytes(8).toString('hex'),
			...(endpoint.headers ? { headers: endpoint.headers } : {}),
		};
		this.webhookEndpoints.push(entry);
		return entry;
	}

	/** Flat list of all devices regardless of grouping. */
	get flatDevices() {
		return this.devices.flat();
	}

	findDoor(id) {
		return this.doors.find(door => door.id === id);
	}

	findDevice(id) {
		return this.flatDevices.find(device => device.id === id);
	}

	// ---------------------------------------------------------------- websocket

	/**
	 * Push a notification to every connected WebSocket client.
	 *
	 * @param {object} envelope Event envelope (`{ event, event_object_id, data, ... }`)
	 * @returns {number} Number of clients the frame was sent to
	 */
	emitEvent(envelope) {
		return this.sendRaw(JSON.stringify(envelope));
	}

	/**
	 * Send an arbitrary text frame (e.g. non-JSON keep-alive text) to every client.
	 *
	 * @param {string} text Frame content
	 * @returns {number} Number of clients the frame was sent to
	 */
	sendRaw(text) {
		let sent = 0;
		for (const client of this.wsClients) {
			if (client.readyState === WebSocket.OPEN) {
				client.send(text);
				sent += 1;
			}
		}
		return sent;
	}

	/**
	 * `access.remote_view` — doorbell rings.
	 *
	 * @param {{ eventObjectId?: string, data?: object }} [options] Overrides
	 */
	emitRemoteView(options) {
		const envelope = fixtures.websocketEvents.remoteView(options);
		this.emitEvent(envelope);
		return envelope;
	}

	/**
	 * `access.remote_view.change` — doorbell status change.
	 *
	 * @param {number} reasonCode 105 | 106 | 107 | 108 | 400
	 * @param {{ eventObjectId?: string, data?: object }} [options] Overrides
	 */
	emitRemoteViewChange(reasonCode, options) {
		const envelope = fixtures.websocketEvents.remoteViewChange(reasonCode, options);
		this.emitEvent(envelope);
		return envelope;
	}

	/**
	 * `access.data.device.remote_unlock` — admin unlocked a door remotely.
	 *
	 * @param {string} [doorId] Door id (default: first door)
	 * @param {{ eventObjectId?: string, data?: object }} [options] Overrides
	 */
	emitRemoteUnlock(doorId, options) {
		const door = (doorId ? this.findDoor(doorId) : this.doors[0]) ?? { id: doorId ?? randomUUID() };
		const envelope = fixtures.websocketEvents.remoteUnlock(door, options);
		this.emitEvent(envelope);
		return envelope;
	}

	/**
	 * Drop all WebSocket connections.
	 *
	 * @param {{ graceful?: boolean, code?: number }} [options] `graceful: true` sends a close frame (default: hard terminate, like a network cut)
	 * @returns {number} Number of dropped connections
	 */
	dropWsConnections(options = {}) {
		let dropped = 0;
		for (const client of [...this.wsClients]) {
			if (options.graceful) {
				client.close(options.code ?? 1012);
			} else {
				client.terminate();
			}
			dropped += 1;
		}
		return dropped;
	}

	/**
	 * Resolve once at least `count` WebSocket clients are connected.
	 *
	 * @param {number} [count] Required number of simultaneously connected clients (default 1)
	 * @param {number} [timeoutMs] Give up after this time (default 2000)
	 */
	waitForWsClients(count = 1, timeoutMs = 2000) {
		return this.waitUntil(() => this.wsClients.size >= count, timeoutMs, `${count} WebSocket client(s)`);
	}

	/**
	 * Resolve once the total number of accepted WebSocket connections reaches `total`.
	 *
	 * @param {number} total Required value of wsConnectionCount
	 * @param {number} [timeoutMs] Give up after this time (default 2000)
	 */
	waitForWsConnectionCount(total, timeoutMs = 2000) {
		return this.waitUntil(
			() => this.wsConnectionCount >= total,
			timeoutMs,
			`${total} WebSocket connection(s) in total`,
		);
	}

	/**
	 * Poll-free wait: re-evaluates `condition` whenever the mock emits an event.
	 *
	 * @param {() => boolean} condition Condition to wait for
	 * @param {number} timeoutMs Give up after this time
	 * @param {string} description Used in the timeout error message
	 * @returns {Promise<void>}
	 */
	waitUntil(condition, timeoutMs, description) {
		if (condition()) {
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			const events = ['request', 'ws-connection', 'ws-close', 'ws-ping', 'ws-handshake', 'webhook-delivered'];
			const cleanup = () => {
				clearTimeout(timer);
				for (const name of events) {
					this.removeListener(name, check);
				}
			};
			const check = () => {
				if (condition()) {
					cleanup();
					resolve();
				}
			};
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error(`mock controller: timed out after ${timeoutMs} ms waiting for ${description}`));
			}, timeoutMs);
			for (const name of events) {
				this.on(name, check);
			}
		});
	}

	// ----------------------------------------------------------------- webhooks

	/**
	 * Deliver an event to the registered webhook endpoints, signed with each endpoint's secret.
	 *
	 * @param {object} envelope Event envelope (`{ event, event_object_id, data }`)
	 * @param {object} [options] Delivery options
	 * @param {'valid' | 'invalid' | 'tampered' | 'expired' | 'future' | 'missing' | 'malformed'} [options.signature] Signature mode, see webhookSender
	 * @param {boolean} [options.force] Also deliver to endpoints not subscribed to this event
	 * @param {string} [options.endpointId] Deliver only to this endpoint
	 * @param {number} [options.timestamp] Explicit signature timestamp (unix seconds)
	 * @returns {Promise<{ endpointId: string, url: string, status?: number, body?: string, error?: string }[]>} One result per endpoint
	 */
	async deliverWebhook(envelope, options = {}) {
		const targets = this.webhookEndpoints.filter(
			endpoint =>
				(!options.endpointId || endpoint.id === options.endpointId) &&
				(options.force || endpoint.events.includes(envelope.event)),
		);
		const results = await Promise.all(
			targets.map(async endpoint => {
				try {
					const response = await sendWebhook({
						url: endpoint.endpoint,
						secret: endpoint.secret,
						body: envelope,
						signature: options.signature,
						timestamp: options.timestamp,
						headers: endpoint.headers,
					});
					return {
						endpointId: endpoint.id,
						url: endpoint.endpoint,
						status: response.status,
						body: response.body,
					};
				} catch (err) {
					return { endpointId: endpoint.id, url: endpoint.endpoint, error: err.message };
				}
			}),
		);
		this.deliveredWebhooks.push({ envelope, results });
		this.emit('webhook-delivered', envelope, results);
		return results;
	}

	// --------------------------------------------------------------- internals

	isAuthorized(req) {
		const header = req.headers.authorization;
		if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
			return { ok: false, code: 'CODE_AUTH_FAILED' };
		}
		if (header.slice('Bearer '.length) !== this.token) {
			return { ok: false, code: 'CODE_ACCESS_TOKEN_INVALID' };
		}
		return { ok: true, code: 'SUCCESS' };
	}

	async handleHttp(req, res) {
		const url = new URL(req.url ?? '/', 'https://mock.invalid');
		let rawBody;
		try {
			rawBody = await readBody(req);
		} catch {
			res.statusCode = 413;
			res.end();
			return;
		}

		if (url.pathname === CONTROL_PREFIX || url.pathname.startsWith(`${CONTROL_PREFIX}/`)) {
			await this.handleControl(req, res, url, rawBody);
			return;
		}

		const auth = this.isAuthorized(req);
		const record = {
			id: ++this.requestSeq,
			time: Date.now(),
			method: req.method ?? 'GET',
			url: req.url ?? '/',
			path: url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) : url.pathname,
			query: Object.fromEntries(url.searchParams.entries()),
			headers: { ...req.headers },
			rawBody: rawBody.toString('utf8'),
			body: parseJson(rawBody),
			authorized: auth.ok,
			status: 0,
			response: undefined,
		};

		const respond = (status, body, headers = {}) => {
			record.status = status;
			record.response = body;
			let payload;
			if (Buffer.isBuffer(body)) {
				payload = body;
			} else {
				payload = Buffer.from(JSON.stringify(body), 'utf8');
				headers = { 'Content-Type': 'application/json', ...headers };
			}
			res.writeHead(status, { ...headers, 'Content-Length': payload.length });
			res.end(payload);
			this.requests.push(record);
			this.log(`${record.method} ${record.url} -> ${status}`);
			this.emit('request', record);
		};
		const ok = data => respond(200, { code: 'SUCCESS', msg: 'success', data });
		const fail = (code, status, msg) =>
			respond(status ?? DEFAULT_ERROR_STATUS[code] ?? 400, { code, msg: msg ?? ERROR_MESSAGES[code] ?? code });

		const fault = this.takeFault(record);
		if (fault?.delayMs) {
			// a controller that "hangs": answer late (or never, if the client gave up in the meantime)
			await new Promise(resolve => setTimeout(resolve, fault.delayMs));
			if (req.socket.destroyed || res.destroyed) {
				record.status = -2;
				this.requests.push(record);
				this.log(`${record.method} ${record.url} -> client gave up after ${fault.delayMs} ms (fault)`);
				this.emit('request', record);
				return;
			}
		}
		// a fault that only delays lets the request through afterwards
		const delayOnly =
			fault?.delayMs && !fault.hangUp && fault.body === undefined && fault.status === undefined && !fault.code;
		if (fault && !delayOnly) {
			if (fault.hangUp) {
				record.status = -1;
				this.requests.push(record);
				this.log(`${record.method} ${record.url} -> socket destroyed (fault)`);
				this.emit('request', record);
				req.socket.destroy();
				return;
			}
			if (fault.body !== undefined) {
				respond(fault.status ?? 200, fault.body);
				return;
			}
			const code = fault.code ?? 'CODE_SYSTEM_ERROR';
			fail(code, fault.status ?? DEFAULT_ERROR_STATUS[code] ?? 500, fault.msg);
			return;
		}

		if (!url.pathname.startsWith(`${API_PREFIX}/`)) {
			fail('CODE_RESOURCE_NOT_FOUND');
			return;
		}
		if (!auth.ok) {
			fail(auth.code);
			return;
		}

		await this.route(record, { ok, fail, respond });
	}

	takeFault(record) {
		const index = this.faults.findIndex(fault => matchesFilter(record, fault));
		if (index === -1) {
			return undefined;
		}
		const fault = this.faults[index];
		fault.remaining -= 1;
		if (fault.remaining <= 0) {
			this.faults.splice(index, 1);
		}
		return fault;
	}

	async route(record, { ok, fail, respond }) {
		const { method, path } = record;
		const body = record.body;
		const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
		let match;

		// 8.1 Fetch Devices
		if (path === '/devices' && method === 'GET') {
			ok(this.devices);
			return;
		}

		// 7.12 / 7.13 Door emergency status (must be matched before /doors/:id)
		if (path === '/doors/settings/emergency') {
			if (method === 'GET') {
				ok({ ...this.emergency });
				return;
			}
			if (method === 'PUT') {
				if (
					!isObject(body) ||
					(body.lockdown !== undefined && typeof body.lockdown !== 'boolean') ||
					(body.evacuation !== undefined && typeof body.evacuation !== 'boolean')
				) {
					fail('CODE_PARAMS_INVALID');
					return;
				}
				if (typeof body.lockdown === 'boolean') {
					this.emergency.lockdown = body.lockdown;
				}
				if (typeof body.evacuation === 'boolean') {
					this.emergency.evacuation = body.evacuation;
				}
				ok('success');
				return;
			}
		}

		// 7.8 Fetch All Doors
		if (path === '/doors' && method === 'GET') {
			ok(this.doors);
			return;
		}

		// 7.9 Remote Door Unlocking
		if ((match = /^\/doors\/([^/]+)\/unlock$/.exec(path)) && method === 'PUT') {
			const door = this.findDoor(decodeURIComponent(match[1]));
			if (!door) {
				fail('CODE_NOT_EXISTS');
				return;
			}
			const payload = body === undefined && record.rawBody === '' ? {} : body;
			if (!isObject(payload)) {
				fail('CODE_PARAMS_INVALID');
				return;
			}
			const hasId = payload.actor_id !== undefined;
			const hasName = payload.actor_name !== undefined;
			if (
				hasId !== hasName || // "If either actor_id or actor_name is provided, both must be included."
				(hasId && typeof payload.actor_id !== 'string') ||
				(hasName && typeof payload.actor_name !== 'string') ||
				(payload.extra !== undefined && !isObject(payload.extra))
			) {
				fail('CODE_PARAMS_INVALID');
				return;
			}
			const unlock = {
				doorId: door.id,
				actor_id: payload.actor_id,
				actor_name: payload.actor_name,
				extra: payload.extra,
				query: record.query,
			};
			this.unlocks.push(unlock);
			ok('success');
			this.emit('unlock', unlock);
			if (this.autoEvents) {
				const hub = this.findDevice(fixtures.IDS.DEVICE_HUB) ?? this.flatDevices[0];
				if (hub) {
					void this.deliverWebhook(
						fixtures.webhookEvents.doorUnlock({
							door,
							device: hub,
							actor: hasId ? { id: payload.actor_id, name: payload.actor_name, type: 'user' } : undefined,
							object: { authentication_type: 'API' },
						}),
					);
				}
			}
			return;
		}

		// 7.10 / 7.11 Temporary door locking rule
		if ((match = /^\/doors\/([^/]+)\/lock_rule$/.exec(path))) {
			const door = this.findDoor(decodeURIComponent(match[1]));
			if (!door) {
				fail('CODE_NOT_EXISTS');
				return;
			}
			if (method === 'GET') {
				ok(this.lockRules.get(door.id) ?? { type: 'schedule', ended_time: 0 });
				return;
			}
			if (method === 'PUT') {
				if (!isObject(body) || !fixtures.LOCK_RULE_TYPES.includes(body.type)) {
					fail('CODE_PARAMS_INVALID');
					return;
				}
				if (body.interval !== undefined && !Number.isInteger(body.interval)) {
					fail('CODE_PARAMS_INVALID');
					return;
				}
				if (body.type === 'custom' && !(body.interval > 0)) {
					fail('CODE_PARAMS_INVALID');
					return;
				}
				const now = Math.floor(Date.now() / 1000);
				if (body.type === 'reset' || body.type === 'lock_now') {
					this.lockRules.delete(door.id);
				} else {
					this.lockRules.set(door.id, {
						type: body.type,
						ended_time: body.type === 'custom' ? now + body.interval * 60 : now + 60 * 60 * 24 * 365,
					});
				}
				door.door_lock_relay_status = body.type === 'custom' || body.type === 'keep_unlock' ? 'unlock' : 'lock';
				ok('success');
				return;
			}
		}

		// 7.7 Fetch Door
		if ((match = /^\/doors\/([^/]+)$/.exec(path)) && method === 'GET') {
			const door = this.findDoor(decodeURIComponent(match[1]));
			if (!door) {
				fail('CODE_NOT_EXISTS');
				return;
			}
			ok(door);
			return;
		}

		// 3.5 Fetch All Users
		if (path === '/users' && method === 'GET') {
			const pageNum = Number.parseInt(record.query.page_num ?? '1', 10) || 1;
			const pageSize = Number.parseInt(record.query.page_size ?? String(this.users.length || 25), 10) || 25;
			const start = (pageNum - 1) * pageSize;
			respond(200, {
				code: 'SUCCESS',
				msg: 'success',
				data: this.users.slice(start, start + pageSize),
				pagination: { page_num: pageNum, page_size: pageSize, total: this.users.length },
			});
			return;
		}

		// 9.2 Fetch System Logs
		if (path === '/system/logs' && method === 'POST') {
			// `all` is not part of the documented topic enum but is what the adapter sends; accepted on purpose.
			if (!isObject(body) || ![...fixtures.SYSTEM_LOG_TOPICS, 'all'].includes(body.topic)) {
				fail('CODE_PARAMS_INVALID');
				return;
			}
			respond(200, {
				code: 'SUCCESS',
				msg: 'success',
				data: { hits: this.systemLogHits },
				page: 1,
				total: this.systemLogHits.length,
			});
			return;
		}

		// 9.5 Fetch Static Resources in System Logs
		if (path.startsWith('/system/static/') && method === 'GET') {
			const resourcePath = path.slice('/system/static/'.length);
			const resource =
				this.staticResources.get(resourcePath) ??
				(this.serveAnyStatic ? { body: fixtures.TINY_JPEG, contentType: 'image/jpeg' } : undefined);
			if (!resource) {
				fail('CODE_RESOURCE_NOT_FOUND');
				return;
			}
			respond(200, resource.body, { 'Content-Type': resource.contentType });
			return;
		}

		// 11.3 / 11.4 Webhook endpoints
		if (path === '/webhooks/endpoints') {
			if (method === 'GET') {
				ok(
					this.webhookEndpoints.map(endpoint => {
						const copy = { ...endpoint };
						if (this.omitSecretInList) {
							delete copy.secret;
						}
						return copy;
					}),
				);
				return;
			}
			if (method === 'POST') {
				if (!this.validEndpointPayload(body)) {
					fail('CODE_PARAMS_INVALID');
					return;
				}
				if (this.webhookEndpoints.some(endpoint => endpoint.endpoint === body.endpoint)) {
					fail('CODE_DEVICE_WEBHOOK_ENDPOINT_DUPLICATED', this.duplicateEndpointHttpStatus);
					return;
				}
				ok(this.addWebhookEndpoint(body));
				return;
			}
		}

		// 11.5 / 11.6 Update / delete webhook endpoint
		if ((match = /^\/webhooks\/endpoints\/([^/]+)$/.exec(path))) {
			const id = decodeURIComponent(match[1]);
			const index = this.webhookEndpoints.findIndex(endpoint => endpoint.id === id);
			if (method === 'DELETE' || method === 'PUT') {
				if (index === -1) {
					fail('CODE_NOT_EXISTS');
					return;
				}
				if (method === 'DELETE') {
					this.webhookEndpoints.splice(index, 1);
					ok(null);
					return;
				}
				if (!this.validEndpointPayload(body)) {
					fail('CODE_PARAMS_INVALID');
					return;
				}
				const current = this.webhookEndpoints[index];
				current.name = body.name;
				current.endpoint = body.endpoint;
				current.events = [...body.events];
				if (body.headers) {
					current.headers = body.headers;
				}
				ok({ ...current });
				return;
			}
		}

		fail('CODE_RESOURCE_NOT_FOUND');
	}

	validEndpointPayload(body) {
		return (
			typeof body === 'object' &&
			body !== null &&
			typeof body.endpoint === 'string' &&
			body.endpoint !== '' &&
			typeof body.name === 'string' &&
			body.name !== '' &&
			Array.isArray(body.events) &&
			body.events.every(event => typeof event === 'string')
		);
	}

	handleUpgrade(req, socket, head) {
		const url = new URL(req.url ?? '/', 'https://mock.invalid');
		const auth = this.isAuthorized(req);
		const handshake = {
			time: Date.now(),
			url: req.url ?? '/',
			headers: { ...req.headers },
			authorized: auth.ok,
			accepted: false,
		};
		this.wsHandshakes.push(handshake);
		const reject = (status, text) => {
			socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
			socket.destroy();
			this.log(`WS ${req.url} -> ${status}`);
			this.emit('ws-handshake', handshake);
		};
		if (url.pathname !== WS_PATH) {
			reject(404, 'Not Found');
			return;
		}
		if (!auth.ok) {
			reject(401, 'Unauthorized');
			return;
		}
		if (!this.wsAccepting || !this.wss) {
			reject(503, 'Service Unavailable');
			return;
		}
		handshake.accepted = true;
		this.emit('ws-handshake', handshake);
		const wss = this.wss;
		wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
	}

	handleWsConnection(ws, req) {
		this.wsClients.add(ws);
		this.wsConnectionCount += 1;
		this.log(`WS client connected (${this.wsClients.size} open)`);
		ws.on('ping', data => {
			this.wsPingCount += 1;
			if (this.autoPong) {
				ws.pong(data, false, () => undefined);
			}
			this.emit('ws-ping');
		});
		ws.on('error', () => undefined);
		ws.on('close', () => {
			this.wsClients.delete(ws);
			this.log(`WS client disconnected (${this.wsClients.size} open)`);
			this.emit('ws-close');
		});
		this.emit('ws-connection', ws, req);
	}

	// ------------------------------------------------------------ control API

	async handleControl(req, res, url, rawBody) {
		const send = (status, body) => {
			const payload = Buffer.from(JSON.stringify(body, null, 2), 'utf8');
			res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
			res.end(payload);
		};
		const route = `${req.method} ${url.pathname.slice(CONTROL_PREFIX.length) || '/'}`;
		const body = parseJson(rawBody) ?? {};

		switch (route) {
			case 'GET /':
			case 'GET /help':
				send(200, { routes: CONTROL_ROUTES });
				return;

			case 'GET /state':
				send(200, {
					url: this.url,
					token: this.token,
					devices: this.devices,
					doors: this.doors,
					users: this.users,
					emergency: this.emergency,
					webhookEndpoints: this.webhookEndpoints,
					lockRules: Object.fromEntries(this.lockRules),
					unlocks: this.unlocks,
					wsClients: this.wsClients.size,
					wsConnectionCount: this.wsConnectionCount,
					wsPingCount: this.wsPingCount,
					recordedRequests: this.requests.length,
				});
				return;

			case 'GET /requests':
				send(200, this.requests);
				return;

			case 'DELETE /requests':
				this.clearRequests();
				send(200, { ok: true });
				return;

			case 'POST /reset':
				this.reset();
				send(200, { ok: true });
				return;

			case 'POST /fail':
				this.failNext(body);
				send(200, { ok: true, faults: this.faults.length });
				return;

			case 'POST /data': {
				// replace fixture data at runtime (devices may be given flat or grouped as the API returns them)
				if (Array.isArray(body.devices)) {
					this.devices = body.devices.every(Array.isArray) ? body.devices : [body.devices];
				}
				if (Array.isArray(body.doors)) {
					this.doors = body.doors;
				}
				if (Array.isArray(body.users)) {
					this.users = body.users;
				}
				if (body.emergency && typeof body.emergency === 'object') {
					this.emergency = { ...this.emergency, ...body.emergency };
				}
				if (Array.isArray(body.systemLogHits)) {
					this.systemLogHits = body.systemLogHits;
				}
				if (body.door && typeof body.door.id === 'string') {
					const door = this.findDoor(body.door.id);
					if (!door) {
						send(404, { error: `unknown door: ${body.door.id}` });
						return;
					}
					Object.assign(door, body.door);
				}
				send(200, {
					ok: true,
					devices: this.flatDevices.length,
					doors: this.doors.length,
					users: this.users.length,
				});
				return;
			}

			case 'POST /static': {
				if (typeof body.path !== 'string' || !body.path) {
					send(400, { error: 'body must contain "path" (and optional "base64", "contentType")' });
					return;
				}
				this.addStaticResource(
					body.path,
					typeof body.base64 === 'string' ? Buffer.from(body.base64, 'base64') : undefined,
					typeof body.contentType === 'string' ? body.contentType : undefined,
				);
				send(200, { ok: true, resources: this.staticResources.size });
				return;
			}

			case 'POST /options':
				for (const key of ['wsAccepting', 'omitSecretInList', 'autoEvents', 'serveAnyStatic', 'autoPong']) {
					if (typeof body[key] === 'boolean') {
						this[key] = body[key];
					}
				}
				send(200, {
					wsAccepting: this.wsAccepting,
					omitSecretInList: this.omitSecretInList,
					autoEvents: this.autoEvents,
					serveAnyStatic: this.serveAnyStatic,
					autoPong: this.autoPong,
				});
				return;

			case 'POST /restart': {
				// answered first: the restart drops this connection as well
				const downMs = Number.isFinite(Number(body.downMs)) ? Math.max(0, Number(body.downMs)) : 0;
				send(200, { ok: true, downMs });
				const port = this.port;
				setTimeout(() => {
					this.stop()
						.then(() => new Promise(resolve => setTimeout(resolve, downMs)))
						.then(() => this.start({ port }))
						.catch(err => this.log(`mock restart failed: ${err.stack ?? err}`));
				}, 20);
				return;
			}

			case 'POST /ws/drop':
				send(200, { dropped: this.dropWsConnections({ graceful: body.graceful === true }) });
				return;

			case 'POST /ws/raw':
				send(200, { sent: this.sendRaw(String(body.text ?? '')) });
				return;

			case 'POST /ws/event': {
				let envelope;
				try {
					envelope = this.buildWsEnvelope(body);
				} catch (err) {
					send(400, { error: err.message });
					return;
				}
				send(200, { sent: this.emitEvent(envelope), envelope });
				return;
			}

			case 'POST /webhook': {
				let envelope;
				try {
					envelope = this.buildWebhookEnvelope(body);
				} catch (err) {
					send(400, { error: err.message });
					return;
				}
				const results = await this.deliverWebhook(envelope, {
					signature: body.signature,
					force: body.force === true,
				});
				send(200, { results, envelope });
				return;
			}

			default:
				send(404, { error: `unknown control route: ${route}`, routes: CONTROL_ROUTES });
		}
	}

	buildWsEnvelope(body) {
		if (typeof body.event === 'string') {
			return body;
		}
		const options = { eventObjectId: body.eventObjectId, data: body.data };
		switch (body.type) {
			case 'remote_view':
				return fixtures.websocketEvents.remoteView(options);
			case 'remote_view_change':
				return fixtures.websocketEvents.remoteViewChange(Number(body.reasonCode ?? 108), options);
			case 'remote_unlock': {
				const door = (body.doorId ? this.findDoor(body.doorId) : this.doors[0]) ?? { id: body.doorId };
				if (!door.id) {
					throw new Error('no door available for remote_unlock');
				}
				return fixtures.websocketEvents.remoteUnlock(door, options);
			}
			default:
				throw new Error(
					'body must be an event envelope ({"event": ...}) or {"type": "remote_view" | "remote_view_change" | "remote_unlock"}',
				);
		}
	}

	buildWebhookEnvelope(body) {
		if (body.envelope && typeof body.envelope.event === 'string') {
			return body.envelope;
		}
		if (typeof body.event === 'string' && body.data) {
			return { event: body.event, event_object_id: body.event_object_id ?? randomUUID(), data: body.data };
		}
		const door = (body.doorId ? this.findDoor(body.doorId) : this.doors[0]) ?? { id: body.doorId ?? randomUUID() };
		const device = (body.deviceId ? this.findDevice(body.deviceId) : this.flatDevices[0]) ?? {
			id: body.deviceId ?? '000000000000',
		};
		switch (body.type) {
			case 'door_unlock':
				return fixtures.webhookEvents.doorUnlock({ door, device, readerId: body.readerId });
			case 'doorbell_incoming':
				return fixtures.webhookEvents.doorbellIncoming({ door, device });
			case 'doorbell_completed':
				return fixtures.webhookEvents.doorbellCompleted({ door, device, reasonCode: body.reasonCode });
			case 'doorbell_incoming_ren':
				return fixtures.webhookEvents.doorbellIncomingRen({ door, readerId: body.readerId });
			case 'dps_status':
				return fixtures.webhookEvents.dpsStatus({ door, device, status: body.status ?? 'open' });
			case 'emergency_status':
				return fixtures.webhookEvents.emergencyStatus({
					device,
					mode: body.mode ?? 'lockdown',
					value: body.value !== false,
				});
			default:
				if (typeof body.event === 'string') {
					return fixtures.webhookEvents.generic(body.event, { door, device });
				}
				throw new Error(
					'body must contain "envelope", "event" (+ optional "data") or "type": door_unlock | doorbell_incoming | doorbell_completed | doorbell_incoming_ren | dps_status | emergency_status',
				);
		}
	}
}

const CONTROL_ROUTES = {
	'GET /__mock/help': 'this list',
	'GET /__mock/state': 'devices, doors, registered webhook endpoints (incl. secrets), counters',
	'GET /__mock/requests': 'all recorded API requests',
	'DELETE /__mock/requests': 'forget recorded requests',
	'POST /__mock/reset': 'restore fixtures, forget endpoints/requests/faults',
	'POST /__mock/fail':
		'make upcoming API requests fail: {method?, path?, status?, code?, msg?, times?, hangUp?, delayMs?} (delayMs alone: answer late)',
	'POST /__mock/data':
		'replace data at runtime: {devices?: Device[] | Device[][], doors?: Door[], users?: User[], emergency?: {...}, systemLogHits?: object[], door?: {id, ...fields to change}}',
	'POST /__mock/static':
		'content for GET /system/static/<path>: {"path": "...", "base64"?: "...", "contentType"?: "image/jpeg"}',
	'POST /__mock/options':
		'switches: {wsAccepting?, omitSecretInList?, autoEvents?, serveAnyStatic?, autoPong?} (answers the current values)',
	'POST /__mock/restart': 'stop and start again on the same port, state is kept: {"downMs"?: 0}',
	'POST /__mock/ws/event':
		'push a WebSocket notification: {"type":"remote_view"|"remote_view_change"|"remote_unlock", reasonCode?, doorId?, data?} or a full envelope {"event":...}',
	'POST /__mock/ws/raw': 'push an arbitrary text frame: {"text": "..."}',
	'POST /__mock/ws/drop': 'drop all WebSocket connections: {"graceful"?: true}',
	'POST /__mock/webhook':
		'deliver a signed webhook to the registered endpoints: {"type":"door_unlock"|"doorbell_incoming"|"doorbell_completed"|"doorbell_incoming_ren"|"dps_status"|"emergency_status", doorId?, deviceId?, readerId?, status?, reasonCode?, mode?, value?, signature?: "valid"|"invalid"|"tampered"|"expired"|"future"|"missing"|"malformed", force?} or {"envelope": {...}}',
};

function matchesFilter(request, filter) {
	if (filter.method && filter.method.toUpperCase() !== request.method) {
		return false;
	}
	if (filter.path instanceof RegExp) {
		return filter.path.test(request.path);
	}
	if (typeof filter.path === 'string') {
		return filter.path === request.path;
	}
	return true;
}

function parseJson(buffer) {
	if (!buffer.length) {
		return undefined;
	}
	try {
		return JSON.parse(buffer.toString('utf8'));
	} catch {
		return undefined;
	}
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;
		req.on('data', chunk => {
			total += chunk.length;
			if (total > MAX_BODY_BYTES) {
				reject(new Error('payload too large'));
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}

module.exports = { MockUnifiController, API_PREFIX, WS_PATH, CONTROL_ROUTES };
