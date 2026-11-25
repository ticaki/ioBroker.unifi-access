'use strict';

/**
 * Self-test of the mock UniFi Access controller: response envelope / error codes as documented,
 * the `/__mock/...` control routes and the stand-alone CLI. The adapter-facing behaviour of the
 * mock is exercised by every other test; this file covers what only a developer (or a later
 * dev-server session) uses.
 */

const { expect } = require('chai');
const { spawn } = require('node:child_process');
const { X509Certificate } = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const WebSocket = require('ws');

const {
	MockUnifiController,
	createSelfSignedCert,
	computeSignature,
	httpRequest,
	waitFor,
	fixtures,
	API_PREFIX,
} = require('./index');

const TOKEN = 'mock-self-test-token';

describe('mock UniFi Access controller (self-test)', () => {
	let mock;

	const api = (apiPath, options = {}) =>
		httpRequest({
			url: `${mock.url}${API_PREFIX}${apiPath}`,
			...options,
			headers: { Authorization: `Bearer ${TOKEN}`, ...options.headers },
		});
	const control = async (method, route, body) => {
		const response = await httpRequest({
			url: `${mock.url}/__mock${route}`,
			method,
			headers: { 'Content-Type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: response.status, body: JSON.parse(response.text) };
	};

	beforeEach(async () => {
		mock = new MockUnifiController({ token: TOKEN });
		await mock.start();
	});

	afterEach(async () => {
		await mock.stop();
	});

	describe('certificate', () => {
		it('generates a fresh self-signed certificate for localhost / 127.0.0.1 / ::1', () => {
			const { key, cert } = createSelfSignedCert();
			const x509 = new X509Certificate(cert);
			expect(key).to.contain('BEGIN PRIVATE KEY');
			expect(x509.subject).to.equal('CN=unifi-access-mock');
			expect(x509.issuer).to.equal(x509.subject);
			expect(x509.checkHost('localhost')).to.equal('localhost');
			expect(x509.checkIP('127.0.0.1')).to.equal('127.0.0.1');
			expect(x509.checkIP('::1')).to.equal('::1');
			expect(x509.verify(x509.publicKey)).to.equal(true);
			expect(createSelfSignedCert().cert).to.not.equal(cert);
		});

		it('can be verified by a client that trusts mock.cert', async () => {
			const response = await httpRequest({
				url: `${mock.url}${API_PREFIX}/doors`,
				headers: { Authorization: `Bearer ${TOKEN}` },
				ca: mock.cert,
			});
			expect(response.status).to.equal(200);
		});
	});

	describe('documented envelope and error codes', () => {
		it('wraps successful answers in {code:"SUCCESS", msg:"success", data}', async () => {
			const response = await api('/doors');
			expect(response.status).to.equal(200);
			expect(response.headers['content-type']).to.equal('application/json');
			expect(JSON.parse(response.text)).to.deep.equal({
				code: 'SUCCESS',
				msg: 'success',
				data: fixtures.DEFAULT_DOORS,
			});
		});

		it('answers 401 without or with a wrong bearer token and records the attempt', async () => {
			const missing = await httpRequest({ url: `${mock.url}${API_PREFIX}/doors` });
			expect(missing.status).to.equal(401);
			expect(JSON.parse(missing.text).code).to.equal('CODE_AUTH_FAILED');

			const wrong = await api('/doors', { headers: { Authorization: 'Bearer nope' } });
			expect(wrong.status).to.equal(401);
			expect(JSON.parse(wrong.text)).to.deep.equal({
				code: 'CODE_ACCESS_TOKEN_INVALID',
				msg: 'The provided access token is invalid.',
			});
			expect(mock.requests.map(r => r.authorized)).to.deep.equal([false, false]);
		});

		it('answers unknown routes with 404 CODE_RESOURCE_NOT_FOUND', async () => {
			const response = await api('/does/not/exist');
			expect(response.status).to.equal(404);
			expect(JSON.parse(response.text).code).to.equal('CODE_RESOURCE_NOT_FOUND');
		});

		it('validates lock_rule payloads against the documented enum', async () => {
			const put = body =>
				api(`/doors/${fixtures.IDS.DOOR_A2}/lock_rule`, { method: 'PUT', body: JSON.stringify(body) });
			expect((await put({ type: 'custom', interval: 10 })).status).to.equal(200);
			expect((await put({ type: 'keep_lock' })).status).to.equal(200);
			for (const invalid of [{ type: 'nope' }, { type: 'custom' }, { type: 'custom', interval: 1.5 }, {}]) {
				const response = await put(invalid);
				expect(response.status, JSON.stringify(invalid)).to.equal(400);
				expect(JSON.parse(response.text).code).to.equal('CODE_PARAMS_INVALID');
			}
			const lockRule = await api(`/doors/${fixtures.IDS.DOOR_A2}/lock_rule`);
			expect(JSON.parse(lockRule.text).data.type).to.equal('keep_lock');
		});

		it('rejects the WebSocket upgrade without a valid token', async () => {
			const error = await new Promise(resolve => {
				const ws = new WebSocket(mock.wsUrl, { rejectUnauthorized: false });
				ws.on('error', resolve);
				ws.on('open', () => resolve(new Error('unexpectedly opened')));
			});
			expect(error.message).to.contain('401');
			expect(mock.wsHandshakes).to.have.length(1);
			expect(mock.wsHandshakes[0].accepted).to.equal(false);
		});
	});

	describe('control routes /__mock/...', () => {
		it('GET /__mock/help and /__mock/state work without a token and are not recorded', async () => {
			const help = await control('GET', '/help');
			expect(help.status).to.equal(200);
			expect(help.body.routes).to.have.property('POST /__mock/ws/event');

			const state = await control('GET', '/state');
			expect(state.body.token).to.equal(TOKEN);
			expect(state.body.doors).to.deep.equal(fixtures.DEFAULT_DOORS);
			expect(state.body.wsClients).to.equal(0);
			expect(mock.requests).to.deep.equal([]);
		});

		it('POST /__mock/ws/event pushes notifications (shorthand and full envelope) to WebSocket clients', async () => {
			const received = [];
			const ws = new WebSocket(mock.wsUrl, {
				rejectUnauthorized: false,
				headers: { Authorization: `Bearer ${TOKEN}` },
			});
			const rawFrames = [];
			ws.on('message', data => {
				const text = data.toString();
				if (text.startsWith('{')) {
					received.push(JSON.parse(text));
				} else {
					rawFrames.push(text);
				}
			});
			await mock.waitForWsClients(1);
			try {
				const ring = await control('POST', '/ws/event', { type: 'remote_view' });
				expect(ring.body.sent).to.equal(1);
				await control('POST', '/ws/event', { type: 'remote_view_change', reasonCode: 106 });
				await control('POST', '/ws/event', { type: 'remote_unlock', doorId: fixtures.IDS.DOOR_3855 });
				await control('POST', '/ws/event', { event: 'custom.event', data: { a: 1 } });
				await control('POST', '/ws/raw', { text: 'Hello' });
				await waitFor(() => received.length === 4 && rawFrames.length === 1, {
					description: 'four notifications and one raw frame',
				});
				expect(rawFrames).to.deep.equal(['Hello']);

				expect(received.map(e => e.event)).to.deep.equal([
					'access.remote_view',
					'access.remote_view.change',
					'access.data.device.remote_unlock',
					'custom.event',
				]);
				expect(received[0]).to.deep.equal(ring.body.envelope);
				expect(received[1].data.reason_code).to.equal(106);
				expect(received[2].data.unique_id).to.equal(fixtures.IDS.DOOR_3855);

				const bad = await control('POST', '/ws/event', { type: 'unknown' });
				expect(bad.status).to.equal(400);

				const drop = await control('POST', '/ws/drop', {});
				expect(drop.body.dropped).to.equal(1);
				await waitFor(() => mock.wsClients.size === 0, { description: 'client dropped' });
			} finally {
				ws.terminate();
			}
		});

		it('POST /__mock/webhook delivers correctly signed (or deliberately broken) requests to registered endpoints', async () => {
			const deliveries = [];
			const receiver = http.createServer((req, res) => {
				const chunks = [];
				req.on('data', chunk => chunks.push(chunk));
				req.on('end', () => {
					deliveries.push({ signature: req.headers.signature, body: Buffer.concat(chunks).toString('utf8') });
					res.end('OK');
				});
			});
			await new Promise(resolve => receiver.listen(0, '127.0.0.1', () => resolve(undefined)));
			try {
				const address = /** @type {import('node:net').AddressInfo} */ (receiver.address());
				const endpointUrl = `http://127.0.0.1:${address.port}/hook`;
				const created = await api('/webhooks/endpoints', {
					method: 'POST',
					body: JSON.stringify({ name: 'self-test', endpoint: endpointUrl, events: ['access.door.unlock'] }),
				});
				const { secret } = JSON.parse(created.text).data;

				const valid = await control('POST', '/webhook', { type: 'door_unlock', doorId: fixtures.IDS.DOOR_A2 });
				expect(valid.body.results).to.have.length(1);
				expect(valid.body.results[0].status).to.equal(200);
				const [t, v1] = deliveries[0].signature.split(',').map(pair => pair.split('=')[1]);
				expect(v1).to.equal(computeSignature(secret, deliveries[0].body, Number(t)));
				expect(JSON.parse(deliveries[0].body)).to.deep.equal(valid.body.envelope);
				expect(valid.body.envelope.data.location.id).to.equal(fixtures.IDS.DOOR_A2);

				await control('POST', '/webhook', { type: 'door_unlock', signature: 'invalid' });
				const [t2, v2] = deliveries[1].signature.split(',').map(pair => pair.split('=')[1]);
				expect(v2).to.not.equal(computeSignature(secret, deliveries[1].body, Number(t2)));

				await control('POST', '/webhook', { type: 'door_unlock', signature: 'missing' });
				expect(deliveries[2].signature).to.equal(undefined);

				// not subscribed → not delivered, unless forced
				const skipped = await control('POST', '/webhook', { type: 'dps_status', status: 'open' });
				expect(skipped.body.results).to.deep.equal([]);
				const forced = await control('POST', '/webhook', { type: 'dps_status', status: 'open', force: true });
				expect(forced.body.results).to.have.length(1);
				expect(JSON.parse(deliveries[3].body).data.object.status).to.equal('open');
			} finally {
				await new Promise(resolve => receiver.close(resolve));
			}
		});

		it('POST /__mock/fail, GET/DELETE /__mock/requests and POST /__mock/reset', async () => {
			await control('POST', '/fail', { path: '/doors', status: 503, code: 'CODE_SYSTEM_ERROR' });
			expect((await api('/doors')).status).to.equal(503);
			expect((await api('/doors')).status).to.equal(200);

			const recorded = await control('GET', '/requests');
			expect(recorded.body.map(r => `${r.method} ${r.path} ${r.status}`)).to.deep.equal([
				'GET /doors 503',
				'GET /doors 200',
			]);
			await control('DELETE', '/requests');
			expect(mock.requests).to.deep.equal([]);

			mock.doors.pop();
			mock.addWebhookEndpoint({ endpoint: 'http://192.0.2.1/hook' });
			await control('POST', '/reset');
			expect(mock.doors).to.deep.equal(fixtures.DEFAULT_DOORS);
			expect(mock.webhookEndpoints).to.deep.equal([]);

			expect((await control('GET', '/nope')).status).to.equal(404);
		});
	});

	describe('CLI', () => {
		it('node test/mock/cli.js starts a controller on the requested port and stops on SIGTERM', async function () {
			this.timeout(15_000);
			const child = spawn(
				process.execPath,
				[path.join(__dirname, 'cli.js'), '--port', '0', '--token', 'cli-token'],
				{
					stdio: ['ignore', 'pipe', 'pipe'],
				},
			);
			let output = '';
			child.stdout.on('data', chunk => (output += chunk));
			child.stderr.on('data', chunk => (output += chunk));
			const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
			try {
				const port = await waitFor(() => /https:\/\/127\.0\.0\.1:(\d+)\/api/.exec(output)?.[1], {
					timeoutMs: 10_000,
					description: 'CLI start-up banner',
				});
				expect(output).to.contain('API token:  cli-token');

				const doors = await httpRequest({
					url: `https://127.0.0.1:${port}${API_PREFIX}/doors`,
					headers: { Authorization: 'Bearer cli-token' },
				});
				expect(doors.status).to.equal(200);
				const state = await httpRequest({ url: `https://127.0.0.1:${port}/__mock/state` });
				expect(JSON.parse(state.text).recordedRequests).to.equal(1);
			} finally {
				child.kill('SIGTERM');
				await exited;
			}
		});

		it('rejects unknown options with exit code 2', async function () {
			this.timeout(15_000);
			const child = spawn(process.execPath, [path.join(__dirname, 'cli.js'), '--bogus'], { stdio: 'ignore' });
			const code = await new Promise(resolve => child.once('exit', resolve));
			expect(code).to.equal(2);
		});
	});
});
