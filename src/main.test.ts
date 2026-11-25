/**
 * Time-dependent behaviour of the adapter class (src/main.ts).
 *
 * The adapter runs in-process on a stand-in for `@iobroker/adapter-core` (test/mock/fakeAdapterCore.js)
 * and talks to the mock UniFi Access controller over real sockets, while sinon fake timers
 * control the adapter's long timers (4 s unlock de-duplication, 5 s / N min re-lock, 3 s system
 * log lookup, 30 s bootstrap retry). Everything that does not need fake timers is tested against
 * a real js-controller in test/functional/adapterTests.js (`npm run test:integration`).
 */

import { expect } from 'chai';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import sinon from 'sinon';

import {
	createAdapterWithFakeCore,
	createSelfSignedCert,
	delay,
	fixtures,
	getFreePort,
	httpRequest,
	isPortFree,
	MockUnifiController,
	ProtectStub,
	sendWebhook,
	waitFor,
	type FakeAdapter,
} from '../test/mock';
import { ProtectHttp } from './lib/protectHttp';
import { UnifiHttp } from './lib/unifiHttp';
import { SharedHttpServer } from './webserver/sharedHttpServer';

const TOKEN = 'main-test-token';
const MAIN = join(__dirname, 'main');
const NS = 'unifi-access.0';
const INSTANCE_OBJECT = `system.adapter.${NS}`;
/** Webhook endpoint name of this installation: instance and ioBroker host */
const ENDPOINT_NAME = `ioBroker.unifi-access (${NS}@test-host)`;
const { DOOR_A2, DOOR_3855, DEVICE_HUB, DEVICE_G2_PRO } = fixtures.IDS;

interface LoggedEvent {
	type: string;
	source: string;
	doorId?: string;
	deviceId?: string;
	ts: number;
	[key: string]: unknown;
}

/**
 * Keep the listen port of the adapter apart from a port a stub was given by the OS in the meantime.
 *
 * @param current Listen port picked before the stub started
 * @param taken Port the stub listens on
 */
async function portOtherThan(current: number, taken: number): Promise<number> {
	let port = current;
	while (port === taken) {
		port = await getFreePort();
	}
	return port;
}

/**
 * After a fake-time step: wait until the WebSocket heartbeat got its pong (real network time), instead of
 * sleeping a fixed time and hoping it was enough (T-05). Returns at once without an open socket.
 *
 * @param instance The adapter
 */
async function heartbeatAnswered(instance: FakeAdapter): Promise<void> {
	const ws = (instance as unknown as { ws?: { awaitingPong?: boolean } | null }).ws;
	await waitFor(() => !ws?.awaitingPong, { description: 'pong of the WebSocket heartbeat' });
}

describe('adapter main.ts (in-process, fake timers, mock controller)', () => {
	let mock: MockUnifiController;
	let clock: sinon.SinonFakeTimers;
	let adapter: FakeAdapter | undefined;
	let listenPort: number;

	const events = (): LoggedEvent[] => {
		const raw = adapter!.val('events.last');
		return typeof raw === 'string' && raw ? (JSON.parse(raw) as LoggedEvent[]) : [];
	};
	const hub = (): { id: string } => mock.findDevice(DEVICE_HUB)!;
	const door = (id: string): { id: string } => mock.findDoor(id)!;

	/**
	 * Create the adapter with the given config overrides and run its `ready` handler.
	 *
	 * @param overrides Values overriding the default test configuration
	 */
	async function start(overrides: Record<string, unknown> = {}): Promise<FakeAdapter> {
		adapter = createAdapterWithFakeCore(MAIN, {
			controllerHost: '127.0.0.1',
			controllerPort: mock.port,
			apiToken: TOKEN,
			verifyTLS: false,
			caCert: '',
			wsReconnectDelay: 0.05,
			defaultUnlockDuration: 0,
			listenPort,
			listenIp: '127.0.0.1',
			enableTls: false,
			enableWebhooks: true,
			enableThumbnailServer: false,
			enableGenericWebhook: false,
			webhookEndpointId: '',
			webhookSecret: '',
			forwardEvents: [],
			unlockActorId: '',
			...overrides,
		});
		await adapter.fireReady();
		return adapter;
	}

	async function startConnected(overrides: Record<string, unknown> = {}): Promise<FakeAdapter> {
		const instance = await start(overrides);
		await mock.waitForWsClients(1);
		// the client side of the WebSocket is open once the adapter logged it (heartbeat runs from then on)
		await waitFor(() => instance.log.of('info').includes('UniFi Access WebSocket open.'), {
			description: 'WebSocket open in the adapter',
		});
		return instance;
	}

	beforeEach(async () => {
		mock = new MockUnifiController({ token: TOKEN });
		await mock.start();
		// The adapter binds the configured port itself, so the test has to pick one beforehand. Stubs that
		// start later bind port 0 and could be handed the same port — see portOtherThan (T-05).
		listenPort = await getFreePort();
		clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
	});

	afterEach(async () => {
		try {
			await adapter?.fireUnload();
		} finally {
			adapter = undefined;
			clock.restore();
			await mock.stop();
		}
	});

	describe('startup', () => {
		it('connects, subscribes to its control states and registers the webhook', async () => {
			const instance = await startConnected();
			expect(instance.val('info.connection')).to.equal(true);
			expect(instance.subscriptions).to.deep.equal([
				'doors.*.unlock',
				'doors.*.unlock_duration',
				'doors.*.lock_rule',
				'doors.emergency.*',
				'admin.uiSettings',
			]);
			expect(instance.obj(`doors.${DOOR_A2}.unlock`)?.common.role).to.equal('button');
			expect(mock.webhookEndpoints).to.have.length(1);
			expect(instance.val('info.webhookRegistered')).to.equal(true);
		});

		it('persists new webhook credentials in the instance config, with the secret encrypted', async () => {
			const instance = await startConnected();
			const endpoint = mock.webhookEndpoints[0];
			expect(instance.objects.get(INSTANCE_OBJECT)?.native).to.deep.equal({
				webhookEndpointId: endpoint.id,
				webhookSecret: `encrypted(${endpoint.secret})`,
			});
			expect(instance.val('info.webhookEndpointId')).to.equal(endpoint.id);
		});

		it('does not touch the instance config when the stored webhook credentials are still valid (no restart loop)', async () => {
			const existing = mock.addWebhookEndpoint({
				endpoint: `http://127.0.0.1:${listenPort}/unifi-access-webhook`,
				name: ENDPOINT_NAME,
			});
			const instance = await startConnected({ webhookEndpointId: existing.id, webhookSecret: existing.secret });
			expect(instance.objects.has(INSTANCE_OBJECT)).to.equal(false);
			expect(mock.webhookEndpoints).to.deep.equal([existing]);
			expect(mock.requests.filter(r => r.path.startsWith('/webhooks') && r.method !== 'GET')).to.deep.equal([]);
			expect(instance.val('info.webhookRegistered')).to.equal(true);

			// and the stored secret is the one that verifies incoming webhooks
			const [result] = await mock.deliverWebhook(
				fixtures.webhookEvents.doorbellCompleted({ door: door(DOOR_A2), device: hub() }),
			);
			expect(result.status).to.equal(200);
		});

		it('does nothing but warn when host or token are missing', async () => {
			const instance = await start({ apiToken: '' });
			expect(instance.val('info.connection')).to.equal(false);
			expect(instance.log.of('warn')).to.deep.equal([
				'Controller host or API token missing — open the admin UI to configure.',
			]);
			expect(mock.requests).to.have.length(0);
			expect(instance.subscriptions).to.deep.equal([]);
			expect(clock.countTimers()).to.equal(0);
		});
	});

	describe('bootstrap retry', () => {
		it('retries the bootstrap 30 s after a failure and connects once the controller answers', async () => {
			mock.failNext({ status: 500, times: Number.POSITIVE_INFINITY });
			const instance = await start({ enableWebhooks: false });

			expect(instance.val('info.connection')).to.equal(false);
			expect(await instance.request('getConnectionStatus')).to.include({
				connected: false,
				lastError: 'network',
			});
			expect(mock.wsHandshakes).to.have.length(0);
			const attempts = mock.findRequests({ path: '/devices' }).length;
			expect(attempts).to.equal(1);

			mock.clearFaults();
			await clock.tickAsync(29_999);
			await delay(30);
			expect(mock.findRequests({ path: '/devices' }), 'no retry before 30 s').to.have.length(1);

			await clock.tickAsync(1);
			await waitFor(() => instance.val('info.connection') === true, { description: 'connection after retry' });
			await mock.waitForWsClients(1);
			expect(mock.findRequests({ path: '/devices' })).to.have.length(2);
			expect(instance.obj(`doors.${DOOR_A2}`)?.type).to.equal('channel');
			expect(await instance.request('getConnectionStatus')).to.include({ connected: true, lastError: null });
		});

		it('keeps retrying with growing distance while the controller stays down (30 s, 60 s, 120 s, 240 s, then every 5 min)', async () => {
			mock.failNext({ status: 500, times: Number.POSITIVE_INFINITY });
			const instance = await start({ enableWebhooks: false });
			let attempt = 1;
			for (const wait of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
				await clock.tickAsync(wait - 1);
				await delay(30);
				expect(mock.findRequests({ path: '/devices' }), `before ${wait} ms`).to.have.length(attempt);
				attempt += 1;
				await clock.tickAsync(1);
				await waitFor(() => mock.findRequests({ path: '/devices' }).length === attempt, {
					description: `bootstrap attempt ${attempt}`,
				});
				// let the failed attempt schedule its successor
				await waitFor(() => instance.timers.size === 1, { description: 'next retry scheduled' });
			}
		});

		it('warns once for a failure that repeats on every retry (no log flood) and again when the failure changes', async () => {
			mock.failNext({ status: 500, times: Number.POSITIVE_INFINITY });
			const instance = await start({ enableWebhooks: false });
			for (const wait of [30_000, 60_000, 120_000]) {
				const before = mock.findRequests({ path: '/devices' }).length;
				await clock.tickAsync(wait);
				await waitFor(() => mock.findRequests({ path: '/devices' }).length === before + 1, {
					description: 'retry',
				});
				await waitFor(() => instance.timers.size === 1, { description: 'next retry scheduled' });
			}
			expect(instance.log.of('warn')).to.have.length(1);
			expect(instance.log.of('warn')[0]).to.match(
				/^Bootstrap failed \(network\): Request failed with status code 500 \(CODE_SYSTEM_ERROR: .+\) \[GET \/api\/v1\/developer\//,
			);

			mock.clearFaults();
			mock.token = 'rotated-token';
			await clock.tickAsync(240_000);
			await waitFor(() => instance.log.of('warn').length === 2, { description: 'second warning' });
			expect(instance.log.of('warn')[1]).to.contain('Bootstrap failed (unauthorized)');
			expect(await instance.request('getConnectionStatus')).to.include({
				connected: false,
				lastError: 'unauthorized',
			});
		});

		it('a rejected token is retried only every 5 minutes', async () => {
			mock.token = 'another-token';
			const instance = await start({ enableWebhooks: false });
			expect(await instance.request('getConnectionStatus')).to.include({ lastError: 'unauthorized' });
			const attempts = mock.findRequests({ path: '/devices' }).length;
			await clock.tickAsync(5 * 60_000 - 1);
			await delay(30);
			expect(mock.findRequests({ path: '/devices' })).to.have.length(attempts);
			mock.token = TOKEN;
			await clock.tickAsync(1);
			await waitFor(() => instance.val('info.connection') === true, { description: 'connected' });
		});

		// A controller that is unreachable at adapter start (power failure: ioBroker is up before the UniFi
		// console) must not leave the webhooks off until the next manual restart.
		it('registers the webhook after the controller became reachable (R-10)', async () => {
			mock.failNext({ status: 500, times: Number.POSITIVE_INFINITY });
			const instance = await start({ enableWebhooks: true });
			expect(mock.webhookEndpoints).to.have.length(0);

			mock.clearFaults();
			await clock.tickAsync(30_000);
			await waitFor(() => instance.val('info.connection') === true, { description: 'connection after retry' });

			await waitFor(() => mock.webhookEndpoints.length === 1, { description: 'webhook registration' });
			await waitFor(() => instance.val('info.webhookRegistered') === true, { description: 'webhookRegistered' });
			const [result] = await mock.deliverWebhook(
				fixtures.webhookEvents.doorbellCompleted({ door: door(DOOR_A2), device: hub() }),
			);
			expect(result.status).to.equal(200);
		});
	});

	describe('webhook endpoint registration', () => {
		const webhookUrl = (): string => `http://127.0.0.1:${listenPort}/unifi-access-webhook`;
		const webhookWrites = (): string[] =>
			mock.requests
				.filter(r => r.path.startsWith('/webhooks') && r.method !== 'GET')
				.map(r => `${r.method} ${r.path}`);

		it('names its endpoint after instance and ioBroker host', async () => {
			await startConnected();
			expect(mock.webhookEndpoints.map(e => e.name)).to.deep.equal([ENDPOINT_NAME]);
		});

		it('reports the registration as failed (also via getConnectionStatus) while it could not be made, although credentials are stored', async () => {
			mock.failNext({ path: '/webhooks/endpoints', status: 500, times: Number.POSITIVE_INFINITY });
			const instance = await startConnected({ webhookEndpointId: 'stored-id', webhookSecret: 'stored-secret' });
			expect(instance.val('info.webhookRegistered')).to.equal(false);
			expect((await instance.request('getConnectionStatus')).webhookRegistered).to.equal(false);
			expect(instance.log.of('warn')).to.have.length(1);
			expect(instance.log.of('warn')[0]).to.match(
				/^Webhook registration failed: Request failed with status code 500 .*\[GET \/api\/v1\/developer\/webhooks\/endpoints\]$/,
			);
		});

		it('retries a failed registration by itself (60 s, then 2 min) without waiting for a reconnect', async () => {
			mock.failNext({ path: '/webhooks/endpoints', status: 500, times: 2 });
			const instance = await startConnected();
			expect(instance.val('info.webhookRegistered')).to.equal(false);
			const attempts = (): number => mock.findRequests({ method: 'GET', path: '/webhooks/endpoints' }).length;
			expect(attempts()).to.equal(1);

			await clock.tickAsync(59_999);
			await delay(30);
			expect(attempts()).to.equal(1);
			await clock.tickAsync(1);
			await waitFor(() => attempts() === 2, { description: 'second attempt after 60 s' });
			await waitFor(() => instance.timers.size >= 1, { description: 'next retry scheduled' });
			expect(instance.val('info.webhookRegistered')).to.equal(false);

			await clock.tickAsync(120_000);
			await waitFor(() => instance.val('info.webhookRegistered') === true, { description: 'registered' });
			expect(mock.webhookEndpoints).to.have.length(1);
			expect(instance.log.of('warn').filter(m => m.startsWith('Webhook registration failed'))).to.have.length(1);
		});

		it('a failed reregisterWebhook does not keep claiming the endpoint is registered and repairs itself', async () => {
			const instance = await startConnected();
			expect(instance.val('info.webhookRegistered')).to.equal(true);
			// the old endpoint gets deleted, creating the new one fails
			mock.failNext({ method: 'POST', path: '/webhooks/endpoints', status: 500 });
			const answer = await instance.request('reregisterWebhook');
			expect(answer.ok).to.equal(false);
			expect(mock.webhookEndpoints).to.deep.equal([]);
			expect(instance.val('info.webhookRegistered')).to.equal(false);
			expect((await instance.request('getConnectionStatus')).webhookRegistered).to.equal(false);

			await clock.tickAsync(60_000);
			await waitFor(() => instance.val('info.webhookRegistered') === true, { description: 'registered again' });
			expect(mock.webhookEndpoints).to.have.length(1);
			const [result] = await mock.deliverWebhook(
				fixtures.webhookEvents.doorbellCompleted({ door: door(DOOR_A2), device: hub() }),
			);
			expect(result.status).to.equal(200);
		});

		it('adds the start of the installation UUID to the endpoint name (two hosts with the same name and instance)', async () => {
			adapter = createAdapterWithFakeCore(MAIN, {
				controllerHost: '127.0.0.1',
				controllerPort: mock.port,
				apiToken: TOKEN,
				listenPort,
				listenIp: '127.0.0.1',
				enableWebhooks: true,
			});
			adapter.objects.set('system.meta.uuid', {
				_id: 'system.meta.uuid',
				type: 'meta',
				native: { uuid: '1a2b3c4d-5e6f-7a8b-9c0d-112233445566' },
			});
			// the endpoint of another installation that happens to use the same host name and instance number
			const twin = mock.addWebhookEndpoint({
				endpoint: 'http://192.0.2.99:8095/unifi-access-webhook',
				name: `ioBroker.unifi-access (${NS}@test-host#ffffffff)`,
			});
			await adapter.fireReady();
			await waitFor(() => adapter!.val('info.webhookRegistered') === true, { description: 'registered' });
			expect(mock.webhookEndpoints.map(e => e.name)).to.deep.equal([
				`ioBroker.unifi-access (${NS}@test-host#ffffffff)`,
				`ioBroker.unifi-access (${NS}@test-host#1a2b3c4d)`,
			]);
			expect(mock.webhookEndpoints[0]).to.deep.equal(twin);
		});

		it('info.webhookRegistered and info.protectConnected left over from an earlier run are reset at start', async () => {
			adapter = createAdapterWithFakeCore(MAIN, {
				controllerHost: '127.0.0.1',
				controllerPort: mock.port,
				apiToken: TOKEN,
				listenPort,
				listenIp: '127.0.0.1',
				enableWebhooks: false,
				enableProtect: false,
			});
			await adapter.setState('info.webhookRegistered', { val: true, ack: true });
			await adapter.setState('info.protectConnected', { val: true, ack: true });
			await adapter.fireReady();
			expect(adapter.val('info.webhookRegistered')).to.equal(false);
			expect(adapter.val('info.protectConnected')).to.equal(false);
		});

		it('makes up for a failed registration at the next reconnect and does not repeat the warning', async () => {
			mock.failNext({ path: '/webhooks/endpoints', status: 500, times: 2 });
			const instance = await startConnected();
			expect(instance.val('info.webhookRegistered')).to.equal(false);

			for (let i = 0; i < 2 && instance.val('info.webhookRegistered') !== true; i++) {
				mock.dropWsConnections();
				await waitFor(() => instance.val('info.connection') === false, { description: 'connection lost' });
				await clock.tickAsync(200);
				await waitFor(() => instance.val('info.connection') === true, { description: 'reconnected' });
				if (i > 0) {
					// a second reconnect within a minute reloads only when the minute is over (K-12)
					await clock.tickAsync(60_000);
				}
				await waitFor(() => mock.findRequests({ method: 'GET', path: '/webhooks/endpoints' }).length >= i + 2, {
					description: 'registration attempt',
				});
				await delay(50);
			}
			await waitFor(() => instance.val('info.webhookRegistered') === true, { description: 'registered' });
			expect(mock.webhookEndpoints).to.have.length(1);
			expect(instance.log.of('warn').filter(m => m.startsWith('Webhook registration failed'))).to.have.length(1);
			expect((await instance.request('getConnectionStatus')).webhookRegistered).to.equal(true);
		});

		// K-08: the endpoint may disappear at the controller without the WebSocket ever dropping
		describe('periodic check of the registration (every 15 minutes)', () => {
			// small steps: the WebSocket heartbeat needs real time for its pongs
			async function advance(ms: number): Promise<void> {
				for (let done = 0; done < ms; done += 20_000) {
					await clock.tickAsync(Math.min(20_000, ms - done));
					await heartbeatAnswered(adapter!);
				}
			}
			const listings = (): number => mock.findRequests({ method: 'GET', path: '/webhooks/endpoints' }).length;

			it('an endpoint that is still there: one GET per check, nothing written, no restart', async () => {
				const instance = await startConnected();
				const before = listings();
				const objectWrites = JSON.stringify(instance.objects.get(INSTANCE_OBJECT));
				await advance(15 * 60_000);
				await waitFor(() => listings() === before + 1, { description: 'check' });
				await delay(30);
				expect(mock.requests.filter(r => r.path.startsWith('/webhooks') && r.method !== 'GET')).to.have.length(
					1,
				);
				expect(JSON.stringify(instance.objects.get(INSTANCE_OBJECT)), 'instance object untouched').to.equal(
					objectWrites,
				);
				expect(instance.val('info.webhookRegistered')).to.equal(true);
			});

			it('"Re-register webhook" during a running check waits for it; the check cannot put the old secret back (RK U-2)', async () => {
				const instance = await startConnected();
				const old = { ...mock.webhookEndpoints[0] };
				// the check fetches the endpoint list and is held before it continues with it
				let release: () => void = () => undefined;
				const gate = new Promise<void>(resolve => (release = resolve));
				let held = false;
				const original = UnifiHttp.prototype.listWebhookEndpoints;
				const stub = sinon.stub(UnifiHttp.prototype, 'listWebhookEndpoints').callsFake(async function (
					this: UnifiHttp,
				) {
					const list = await original.call(this);
					if (!held) {
						held = true;
						await gate;
					}
					return list;
				});
				try {
					await advance(15 * 60_000);
					await waitFor(() => held, { description: 'check holds its endpoint list' });
					const answer = instance.request('reregisterWebhook', undefined, 5000);
					await delay(50);
					release();
					expect(await answer).to.include({ ok: true });
				} finally {
					stub.restore();
				}
				await delay(50);
				const current = mock.webhookEndpoints.find(e => e.name === ENDPOINT_NAME)!;
				expect(current.id).to.not.equal(old.id);
				expect(mock.webhookEndpoints.map(e => e.id)).to.not.include(old.id);
				const [result] = await mock.deliverWebhook(
					fixtures.webhookEvents.doorbellCompleted({ door: door(DOOR_A2), device: hub() }),
				);
				expect(result.status, 'webhook with the secret of the new endpoint').to.equal(200);
				expect(instance.val('info.webhookEndpointId')).to.equal(current.id);
			});

			it('an endpoint deleted at the controller is registered again at the next check', async () => {
				const instance = await startConnected();
				mock.webhookEndpoints.length = 0;
				await advance(15 * 60_000);
				await waitFor(() => mock.webhookEndpoints.length === 1, { description: 'registered again' });
				expect(instance.val('info.webhookRegistered')).to.equal(true);
				expect((await instance.request('getConnectionStatus')).webhookRegistered).to.equal(true);
			});

			it('no check while the connection is lost (the reconnect checks anyway); none without webhooks', async () => {
				const instance = await startConnected({ enableWebhooks: false });
				expect(instance.intervals.size, 'only the heartbeat').to.equal(1);
				await instance.fireUnload();
				adapter = undefined;
				const withHooks = await startConnected();
				expect(withHooks.intervals.size, 'heartbeat and registration check').to.equal(2);
				const before = listings();
				mock.wsAccepting = false;
				mock.dropWsConnections();
				await waitFor(() => withHooks.val('info.connection') === false, { description: 'connection lost' });
				await advance(15 * 60_000);
				expect(listings()).to.equal(before);
				await withHooks.fireUnload();
				expect(withHooks.intervals.size, 'cleared on unload').to.equal(0);
				adapter = undefined;
			});
		});

		// E2E finding E-01: a controller that came back without the endpoint (restored backup, reset, endpoint
		// deleted in the UniFi UI) stayed without webhooks until the adapter was restarted by hand, while
		// info.webhookRegistered kept saying "true".
		it('registers its endpoint again when the controller lost it while the connection was down', async () => {
			const instance = await startConnected();
			expect(mock.webhookEndpoints).to.have.length(1);
			const firstId = mock.webhookEndpoints[0].id;
			expect(instance.val('info.webhookRegistered')).to.equal(true);

			mock.webhookEndpoints.length = 0;
			mock.dropWsConnections();
			await waitFor(() => instance.val('info.connection') === false, { description: 'connection lost' });
			await clock.tickAsync(200);
			await waitFor(() => instance.val('info.connection') === true, { description: 'reconnected' });

			await waitFor(() => mock.webhookEndpoints.length === 1, { description: 'endpoint registered again' });
			const second = mock.webhookEndpoints[0];
			expect(second.id).to.not.equal(firstId);
			expect(second.name).to.equal(ENDPOINT_NAME);
			await waitFor(() => instance.objects.get(INSTANCE_OBJECT)?.native.webhookEndpointId === second.id, {
				description: 'new credentials stored',
			});
			expect(instance.val('info.webhookRegistered')).to.equal(true);
			expect(instance.val('info.webhookEndpointId')).to.equal(second.id);
			// the new secret is in use at once
			const [result] = await mock.deliverWebhook(
				fixtures.webhookEvents.doorbellCompleted({ door: door(DOOR_A2), device: hub() }),
			);
			expect(result.status).to.equal(200);
		});

		it('checks the registration after a reconnect without changing an endpoint that is still there', async () => {
			const instance = await startConnected();
			const { id, secret } = mock.webhookEndpoints[0];
			await waitFor(() => instance.objects.get(INSTANCE_OBJECT)?.native.webhookEndpointId === id, {
				description: 'credentials stored',
			});
			const stored = JSON.stringify(instance.objects.get(INSTANCE_OBJECT)?.native);
			const lists = (): number => mock.findRequests({ method: 'GET', path: '/webhooks/endpoints' }).length;
			expect(lists()).to.equal(1);

			mock.dropWsConnections();
			await waitFor(() => instance.val('info.connection') === false, { description: 'connection lost' });
			await clock.tickAsync(200);
			await waitFor(() => instance.val('info.connection') === true, { description: 'reconnected' });
			await waitFor(() => lists() === 2, { description: 'registration checked again' });
			await delay(50);

			expect(webhookWrites()).to.deep.equal(['POST /webhooks/endpoints']);
			expect(mock.webhookEndpoints.map(e => [e.id, e.secret])).to.deep.equal([[id, secret]]);
			expect(JSON.stringify(instance.objects.get(INSTANCE_OBJECT)?.native)).to.equal(stored);
			expect(instance.val('info.webhookRegistered')).to.equal(true);
			expect((await instance.request('getConnectionStatus')).webhookRegistered).to.equal(true);
			expect(instance.log.of('warn')).to.deep.equal([]);
		});

		it('keeps reporting the endpoint as registered while the check after a reconnect is running', async () => {
			const instance = await startConnected();
			await waitFor(() => instance.val('info.webhookRegistered') === true, { description: 'registered' });
			const lists = (): number => mock.findRequests({ method: 'GET', path: '/webhooks/endpoints' }).length;

			// the controller answers the list request of the check late (the mock delays in real time)
			mock.failNext({ method: 'GET', path: '/webhooks/endpoints', delayMs: 500 });
			mock.dropWsConnections();
			await waitFor(() => instance.val('info.connection') === false, { description: 'connection lost' });
			await clock.tickAsync(200);
			await waitFor(() => instance.val('info.connection') === true, { description: 'reconnected' });
			// the fault is taken when the list request of the check arrives
			await waitFor(() => mock.faults.length === 0, { description: 'list request of the check' });
			await delay(30);
			expect(lists(), 'the check is still waiting for its answer').to.equal(1);
			expect((await instance.request('getConnectionStatus')).webhookRegistered).to.equal(true);
			expect(instance.val('info.webhookRegistered')).to.equal(true);

			await waitFor(() => lists() === 2, { description: 'check finished', timeoutMs: 4000 });
			await delay(50);
			expect((await instance.request('getConnectionStatus')).webhookRegistered).to.equal(true);
		});

		it('reports the endpoint as not registered when the check after a reconnect fails', async () => {
			const instance = await startConnected();
			await waitFor(() => instance.val('info.webhookRegistered') === true, { description: 'registered' });

			mock.failNext({ method: 'GET', path: '/webhooks/endpoints', status: 500 });
			mock.dropWsConnections();
			await waitFor(() => instance.val('info.connection') === false, { description: 'connection lost' });
			await clock.tickAsync(200);
			await waitFor(() => instance.val('info.connection') === true, { description: 'reconnected' });
			await waitFor(() => instance.val('info.webhookRegistered') === false, { description: 'not registered' });
			expect((await instance.request('getConnectionStatus')).webhookRegistered).to.equal(false);

			// the retry (60 s later) finds the endpoint untouched
			await clock.tickAsync(60_000);
			await waitFor(() => instance.val('info.webhookRegistered') === true, { description: 'registered again' });
			expect(mock.webhookEndpoints).to.have.length(1);
		});

		it('brings an existing endpoint with fewer events in line via PUT: same secret, nothing stored, no restart (D-23)', async () => {
			const existing = mock.addWebhookEndpoint({
				endpoint: webhookUrl(),
				name: ENDPOINT_NAME,
				events: ['access.door.unlock'],
			});
			const { id, secret } = existing;
			const instance = await startConnected({ webhookEndpointId: id, webhookSecret: secret });

			expect(webhookWrites()).to.deep.equal([`PUT /webhooks/endpoints/${id}`]);
			expect(mock.webhookEndpoints).to.have.length(1);
			expect([...mock.webhookEndpoints[0].events].sort()).to.deep.equal([...fixtures.WEBHOOK_EVENTS].sort());
			expect(mock.webhookEndpoints[0].secret).to.equal(secret);
			expect(instance.objects.has(INSTANCE_OBJECT), 'instance config untouched').to.equal(false);

			// an event type that was not subscribed before is delivered and verified with the unchanged secret
			const [result] = await mock.deliverWebhook(
				fixtures.webhookEvents.dpsStatus({ door: door(DOOR_3855), device: hub(), status: 'open' }),
			);
			expect(result.status).to.equal(200);
			await waitFor(() => instance.val(`doors.${DOOR_3855}.position`) === 'open', {
				description: 'event processed',
			});
		});

		it('takes over the endpoint registered by an earlier version (old name scheme, stored id) without new credentials', async () => {
			const existing = mock.addWebhookEndpoint({ endpoint: webhookUrl(), name: `ioBroker.unifi-access (${NS})` });
			const { id, secret } = existing;
			const instance = await startConnected({ webhookEndpointId: id, webhookSecret: secret });
			expect(webhookWrites()).to.deep.equal([`PUT /webhooks/endpoints/${id}`]);
			expect(mock.webhookEndpoints.map(e => `${e.id} ${e.name} ${e.secret}`)).to.deep.equal([
				`${id} ${ENDPOINT_NAME} ${secret}`,
			]);
			expect(instance.objects.has(INSTANCE_OBJECT)).to.equal(false);
		});

		it('leaves the endpoint of a second installation at the same controller alone (R-18b)', async () => {
			// another ioBroker host running the same instance number, and one still using the old name scheme
			const otherHost = mock.addWebhookEndpoint({
				endpoint: 'http://192.0.2.77:8095/unifi-access-webhook',
				name: `ioBroker.unifi-access (${NS}@other-host)`,
			});
			const oldScheme = mock.addWebhookEndpoint({
				endpoint: 'http://192.0.2.78:8095/unifi-access-webhook',
				name: `ioBroker.unifi-access (${NS})`,
			});
			const snapshot = JSON.stringify([otherHost, oldScheme]);

			const instance = await startConnected();
			await instance.request('reregisterWebhook');

			expect(mock.findRequests({ method: 'DELETE' }).map(r => r.path)).to.not.include.members([
				`/webhooks/endpoints/${otherHost.id}`,
				`/webhooks/endpoints/${oldScheme.id}`,
			]);
			expect(JSON.stringify(mock.webhookEndpoints.slice(0, 2))).to.equal(snapshot);
			expect(mock.webhookEndpoints).to.have.length(3);
			expect(mock.webhookEndpoints[2]).to.include({ name: ENDPOINT_NAME, endpoint: webhookUrl() });
		});

		it('a controller that omits the secret in its endpoint list does not cause new credentials on every start (R-18a)', async () => {
			const existing = mock.addWebhookEndpoint({ endpoint: webhookUrl(), name: ENDPOINT_NAME });
			mock.omitSecretInList = true;
			const instance = await startConnected({ webhookEndpointId: existing.id, webhookSecret: existing.secret });
			expect(webhookWrites()).to.deep.equal([]);
			expect(instance.objects.has(INSTANCE_OBJECT), 'no write to the instance config → no restart').to.equal(
				false,
			);
			const [result] = await mock.deliverWebhook(
				fixtures.webhookEvents.doorbellCompleted({ door: door(DOOR_A2), device: hub() }),
			);
			expect(result.status).to.equal(200);
		});
	});

	describe('door state follows the controller instead of blind timers (R-01, D-20)', () => {
		const lockedOf = (id: string): unknown => adapter!.val(`doors.${id}.locked`);
		const doorReads = (id: string): number => mock.findRequests({ method: 'GET', path: `/doors/${id}` }).length;
		const setRelay = (id: string, status: 'lock' | 'unlock'): void => {
			mock.findDoor(id)!.door_lock_relay_status = status;
		};

		it('pulse unlock: locked=false immediately, then the door status is read back after 7 s', async () => {
			const instance = await startConnected();
			instance.fireStateChange(`doors.${DOOR_3855}.unlock`, true);
			await waitFor(() => lockedOf(DOOR_3855) === false, { description: 'locked=false' });
			expect(mock.unlocks.map(u => u.doorId)).to.deep.equal([DOOR_3855]);
			expect(instance.states.get(`${NS}.doors.${DOOR_3855}.unlock`)).to.include({ val: true, ack: true });

			await clock.tickAsync(6999);
			await delay(30);
			expect(lockedOf(DOOR_3855)).to.equal(false);
			expect(doorReads(DOOR_3855), 'no status request before 7 s').to.equal(0);
			await clock.tickAsync(1);
			await waitFor(() => lockedOf(DOOR_3855) === true, { description: 'locked=true read from the controller' });
			expect(doorReads(DOOR_3855)).to.equal(1);
		});

		it('pulse unlock: a door the controller still reports as unlocked stays unlocked', async () => {
			const instance = await startConnected();
			instance.fireStateChange(`doors.${DOOR_3855}.unlock`, true);
			await waitFor(() => lockedOf(DOOR_3855) === false, { description: 'locked=false' });
			setRelay(DOOR_3855, 'unlock'); // e.g. an unlock schedule became active in the meantime
			await clock.tickAsync(7000);
			await waitFor(() => doorReads(DOOR_3855) === 1, { description: 'status request' });
			await delay(30);
			expect(lockedOf(DOOR_3855), 'not blindly set to locked').to.equal(false);
		});

		it('timed unlock (defaultUnlockDuration = 2): status is verified after 2 s and read again when the time is up', async () => {
			const instance = await startConnected({ defaultUnlockDuration: 2 });
			instance.fireStateChange(`doors.${DOOR_3855}.unlock`, true);
			await waitFor(() => lockedOf(DOOR_3855) === false, { description: 'locked=false' });
			expect(
				mock.findRequests({ path: `/doors/${DOOR_3855}/lock_rule`, method: 'PUT' }).map(r => r.body),
			).to.deep.equal([{ type: 'custom', interval: 2 }]);

			await clock.tickAsync(2000);
			await waitFor(() => doorReads(DOOR_3855) === 1, { description: 'verification request' });
			await delay(30);
			expect(lockedOf(DOOR_3855)).to.equal(false);

			// the controller locks the door again when the two minutes are over
			await clock.tickAsync(2 * 60_000 - 2001);
			await delay(30);
			expect(doorReads(DOOR_3855), 'no polling in between').to.equal(1);
			setRelay(DOOR_3855, 'lock');
			await clock.tickAsync(2001);
			await waitFor(() => lockedOf(DOOR_3855) === true, { description: 'locked=true after expiry' });
			expect(doorReads(DOOR_3855)).to.equal(2);
		});

		it('an unlock event during a timed unlock does not cancel the check at the end of the time', async () => {
			const instance = await startConnected({ enableWebhooks: false });
			instance.fireStateChange(`doors.${DOOR_3855}.unlock_duration`, 1);
			await waitFor(() => lockedOf(DOOR_3855) === false, { description: 'locked=false' });
			await clock.tickAsync(2000);
			await waitFor(() => doorReads(DOOR_3855) === 1, { description: 'verification of the command' });

			// somebody uses the door: the controller reports the unlock, the adapter checks 7 s later
			const unlockedWrites = (): number =>
				instance.stateWrites.filter(w => w.id.endsWith(`doors.${DOOR_3855}.locked`) && w.val === false).length;
			const before = unlockedWrites();
			mock.emitRemoteUnlock(DOOR_3855);
			await waitFor(() => unlockedWrites() === before + 1, { description: 'unlock event processed' });
			await clock.tickAsync(7000);
			await waitFor(() => doorReads(DOOR_3855) === 2, { description: 'check after the event' });
			await delay(30);
			expect(lockedOf(DOOR_3855)).to.equal(false);

			// the minute is over and the controller locks the door — without webhooks only the check at the
			// end of the time tells (small steps: the WebSocket heartbeat needs real time for its pongs)
			setRelay(DOOR_3855, 'lock');
			for (const step of [22_000, 29_000]) {
				await clock.tickAsync(step);
				await heartbeatAnswered(instance);
			}
			expect(doorReads(DOOR_3855), 'no polling in between').to.equal(2);
			await clock.tickAsync(2100);
			await waitFor(() => lockedOf(DOOR_3855) === true, { description: 'locked=true at the end of the time' });
			expect(doorReads(DOOR_3855)).to.equal(3);
		});

		it('a later lock rule cancels the pending check of an earlier timed unlock (no blind re-lock)', async () => {
			const instance = await startConnected();
			const writesBefore = instance.stateWrites.length;
			instance.fireStateChange(`doors.${DOOR_3855}.unlock_duration`, 10);
			await waitFor(() => lockedOf(DOOR_3855) === false, { description: 'locked=false' });
			await clock.tickAsync(60_000);
			instance.fireStateChange(`doors.${DOOR_3855}.lock_rule`, 1); // keep_unlock
			await waitFor(() => instance.states.get(`${NS}.doors.${DOOR_3855}.lock_rule`)?.ack === true, {
				description: 'lock_rule ack',
			});
			// far beyond the 10 minutes of the first command: the door is still kept unlocked
			await clock.tickAsync(15 * 60_000);
			await delay(50);
			expect(lockedOf(DOOR_3855)).to.equal(false);
			expect(
				instance.stateWrites
					.slice(writesBefore)
					.filter(w => w.id.endsWith(`doors.${DOOR_3855}.locked`) && w.val === true),
			).to.deep.equal([]);
		});

		it('lock_rule reset does not claim the door is locked — the status is read from the controller (D-09)', async () => {
			const instance = await startConnected();
			// DOOR_A2 is unlocked by an unlock schedule; "reset" only clears a temporary rule
			expect(lockedOf(DOOR_A2)).to.equal(false);
			instance.fireStateChange(`doors.${DOOR_A2}.lock_rule`, 0);
			await waitFor(() => instance.states.get(`${NS}.doors.${DOOR_A2}.lock_rule`)?.ack === true, {
				description: 'lock_rule ack',
			});
			setRelay(DOOR_A2, 'unlock'); // the schedule still holds the door open
			await clock.tickAsync(2000);
			await waitFor(() => doorReads(DOOR_A2) === 1, { description: 'status request' });
			await delay(30);
			expect(lockedOf(DOOR_A2)).to.equal(false);
			expect(
				instance.stateWrites.filter(w => w.id.endsWith(`doors.${DOOR_A2}.locked`) && w.val === true),
			).to.deep.equal([]);
		});

		// T-03: whoever waits for the ack of the command must find `locked` already written
		for (const [index, locked] of [
			[1, false],
			[2, true],
			[3, true],
		] as const) {
			it(`lock_rule = ${index}: locked=${locked} is written before the command is acknowledged`, async () => {
				const instance = await startConnected();
				const from = instance.stateWrites.length;
				instance.fireStateChange(`doors.${DOOR_3855}.lock_rule`, index);
				await waitFor(() => instance.states.get(`${NS}.doors.${DOOR_3855}.lock_rule`)?.ack === true, {
					description: 'ack',
				});
				const writes = instance.stateWrites.slice(from);
				const lockedAt = writes.findIndex(w => w.id === `${NS}.doors.${DOOR_3855}.locked` && w.val === locked);
				const ackAt = writes.findIndex(w => w.id === `${NS}.doors.${DOOR_3855}.lock_rule` && w.ack);
				expect(lockedAt, 'locked written').to.be.greaterThan(-1);
				expect(lockedAt, 'locked before ack').to.be.lessThan(ackAt);
				expect(instance.timers.size, 'status check planned before the ack').to.be.greaterThan(0);
			});
		}

		it('lock_rule = 4 sends lock_early and reads the status back (D-22)', async () => {
			const instance = await startConnected();
			instance.fireStateChange(`doors.${DOOR_A2}.lock_rule`, 4);
			await waitFor(() => instance.states.get(`${NS}.doors.${DOOR_A2}.lock_rule`)?.ack === true, {
				description: 'lock_rule ack',
			});
			expect(
				mock.findRequests({ method: 'PUT', path: `/doors/${DOOR_A2}/lock_rule` }).map(r => r.body),
			).to.deep.equal([{ type: 'lock_early' }]);
			expect(instance.val(`doors.${DOOR_A2}.lock_rule`)).to.equal(4);
			await clock.tickAsync(2000);
			await waitFor(() => lockedOf(DOOR_A2) === true, { description: 'locked read back' });
		});

		it('an unlock reported by the controller (WebSocket) is followed by a status check instead of staying unlocked forever', async () => {
			await startConnected({ enableWebhooks: false });
			mock.emitRemoteUnlock(DOOR_3855);
			await waitFor(() => lockedOf(DOOR_3855) === false, { description: 'locked=false' });
			await clock.tickAsync(7000);
			await waitFor(() => lockedOf(DOOR_3855) === true, { description: 'locked=true read from the controller' });
			expect(doorReads(DOOR_3855)).to.equal(1);
		});

		it('an access.door.unlock webhook is followed by a status check as well', async () => {
			await startConnected();
			await mock.deliverWebhook(fixtures.webhookEvents.doorUnlock({ door: door(DOOR_3855), device: hub() }));
			await waitFor(() => lockedOf(DOOR_3855) === false, { description: 'locked=false' });
			await clock.tickAsync(7000);
			await waitFor(() => lockedOf(DOOR_3855) === true, { description: 'locked=true read from the controller' });
		});

		it('access.door.unlock with a denied result does not mark the door as unlocked (D-03)', async () => {
			const instance = await startConnected();
			for (const result of ['Access Denied', 'BLOCKED']) {
				await mock.deliverWebhook(
					fixtures.webhookEvents.doorUnlock({ door: door(DOOR_3855), device: hub(), object: { result } }),
				);
			}
			await waitFor(() => events().length === 2, { description: 'events logged' });
			expect(lockedOf(DOOR_3855)).to.equal(true);
			expect(
				instance.stateWrites.filter(w => w.id.endsWith(`doors.${DOOR_3855}.locked`) && w.val === false),
			).to.deep.equal([]);
			expect(events().map(e => e.subtype)).to.deep.equal(['BLOCKED', 'Access Denied']);
		});

		for (const name of [
			'access.temporary_unlock.start',
			'access.temporary_unlock.end',
			'access.unlock_schedule.activate',
			'access.unlock_schedule.deactivate',
		]) {
			it(`${name} refreshes all doors from the controller (debounced, one request for a burst of events) (D-24)`, async () => {
				await startConnected();
				const before = mock.findRequests({ method: 'GET', path: '/doors' }).length;
				setRelay(DOOR_3855, 'unlock');
				setRelay(DOOR_A2, 'lock');
				for (let i = 0; i < 3; i++) {
					await mock.deliverWebhook(
						fixtures.webhookEvents.generic(name, { door: door(DOOR_3855), device: hub() }),
					);
				}
				await waitFor(() => events().length === 3, { description: 'events logged' });
				await clock.tickAsync(1999);
				await delay(30);
				expect(mock.findRequests({ method: 'GET', path: '/doors' })).to.have.length(before);
				await clock.tickAsync(1);
				await waitFor(() => lockedOf(DOOR_3855) === false && lockedOf(DOOR_A2) === true, {
					description: 'door states from the controller',
				});
				expect(mock.findRequests({ method: 'GET', path: '/doors' })).to.have.length(before + 1);
			});
		}

		it('a failing status check is logged at debug level and does not disturb the adapter', async () => {
			const instance = await startConnected();
			instance.fireStateChange(`doors.${DOOR_3855}.unlock`, true);
			await waitFor(() => lockedOf(DOOR_3855) === false, { description: 'locked=false' });
			mock.failNext({ method: 'GET', path: `/doors/${DOOR_3855}`, status: 500 });
			await clock.tickAsync(7000);
			await waitFor(() => instance.log.of('debug').some(m => m.includes('Door status refresh')), {
				description: 'debug log',
			});
			expect(instance.log.of('warn')).to.deep.equal([]);
		});

		it('unload cancels pending status checks', async () => {
			const instance = await startConnected();
			instance.fireStateChange(`doors.${DOOR_3855}.unlock_duration`, 30);
			await waitFor(() => lockedOf(DOOR_3855) === false, { description: 'locked=false' });
			await mock.deliverWebhook(
				fixtures.webhookEvents.generic('access.temporary_unlock.start', { door: door(DOOR_A2), device: hub() }),
			);
			await waitFor(() => events().length === 1, { description: 'event' });
			await instance.fireUnload();
			expect(clock.countTimers()).to.equal(0);
		});
	});

	describe('device state from events (D-05)', () => {
		it('does not take "online" from the device block of a webhook (the documented samples always carry online=false)', async () => {
			const instance = await startConnected();
			expect(instance.val(`devices.${DEVICE_HUB}.online`)).to.equal(true);
			await mock.deliverWebhook(
				fixtures.webhookEvents.doorUnlock({
					door: door(DOOR_3855),
					device: hub(),
					deviceOverrides: { online: false, firmware: 'v9.9.9' },
				}),
			);
			await waitFor(() => instance.val(`devices.${DEVICE_HUB}.firmware`) === 'v9.9.9', {
				description: 'firmware',
			});
			expect(instance.val(`devices.${DEVICE_HUB}.online`)).to.equal(true);
			expect(instance.val(`devices.${DEVICE_HUB}.lastSeenAt`))
				.to.be.a('string')
				.with.length.greaterThan(0);
			const { devices } = await instance.request('listDevices');
			expect(devices.find((d: { id: string }) => d.id === DEVICE_HUB)).to.include({
				online: true,
				firmware: 'v9.9.9',
			});
		});
	});

	describe('doorbell call state (D-04, R-13)', () => {
		const active = (): unknown[] => [
			adapter!.val('doorbell.activeCallId'),
			adapter!.val('doorbell.activeFromDevice'),
			adapter!.val('doorbell.activeStartedAt'),
		];

		for (const code of [105, 106, 107, 108, 400]) {
			it(`access.remote_view.change with reason_code ${code} ends the active call`, async () => {
				const instance = await startConnected({ enableWebhooks: false });
				const ring = mock.emitRemoteView();
				await waitFor(() => instance.val('doorbell.activeCallId') === ring.event_object_id, {
					description: 'ring',
				});
				mock.emitRemoteViewChange(code);
				await waitFor(() => instance.val('doorbell.activeCallId') === null, { description: 'call ended' });
				expect(active()).to.deep.equal([null, null, null]);
			});
		}

		it('an unknown reason_code leaves the call active', async () => {
			const instance = await startConnected({ enableWebhooks: false });
			const ring = mock.emitRemoteView();
			await waitFor(() => instance.val('doorbell.activeCallId') === ring.event_object_id, {
				description: 'ring',
			});
			mock.emitRemoteViewChange(999);
			await waitFor(() => events().some(e => e.type === 'access.remote_view.change'), { description: 'event' });
			expect(instance.val('doorbell.activeCallId')).to.equal(ring.event_object_id);
		});

		for (const code of [105, 106, 107, 108, 400]) {
			it(`access.doorbell.completed (webhook, reason ${code}) ends the active call — also without WebSocket event`, async () => {
				const instance = await startConnected();
				const ring = mock.emitRemoteView();
				await waitFor(() => instance.val('doorbell.activeCallId') === ring.event_object_id, {
					description: 'ring',
				});
				await mock.deliverWebhook(
					fixtures.webhookEvents.doorbellCompleted({
						door: door(DOOR_3855),
						device: hub(),
						reasonCode: code,
						// the request id is shared by the WebSocket and the webhook events of one call
						requestId: String(ring.data.request_id),
					}),
				);
				await waitFor(() => instance.val('doorbell.activeCallId') === null, { description: 'call ended' });
				expect(active()).to.deep.equal([null, null, null]);
				const logged = events().find(e => e.type === 'access.doorbell.completed')!;
				expect(logged.subtype).to.equal(
					{
						105: 'timeout',
						106: 'admin_rejected',
						107: 'admin_unlocked',
						108: 'visitor_cancelled',
						400: 'answered_elsewhere',
					}[code],
				);
			});
		}

		it('access.doorbell.incoming (webhook) marks a call as active when the WebSocket did not report it', async () => {
			const instance = await startConnected();
			const incoming = fixtures.webhookEvents.doorbellIncoming({
				door: door(DOOR_3855),
				device: mock.findDevice(DEVICE_G2_PRO)!,
				requestId: 'request-4711',
			});
			await mock.deliverWebhook(incoming);
			await waitFor(() => instance.val('doorbell.activeCallId') === 'request-4711', {
				description: 'active call',
			});
			expect(instance.val('doorbell.activeFromDevice')).to.equal('Door 3855');
			expect(instance.val('doorbell.activeStartedAt')).to.be.a('number');

			await mock.deliverWebhook(
				fixtures.webhookEvents.doorbellCompleted({
					door: door(DOOR_3855),
					device: hub(),
					reasonCode: 108,
					requestId: 'request-4711',
				}),
			);
			await waitFor(() => instance.val('doorbell.activeCallId') === null, { description: 'call ended' });
		});

		it('the WebSocket event of a call the webhook already announced keeps the published call id', async () => {
			const instance = await startConnected();
			await mock.deliverWebhook(
				fixtures.webhookEvents.doorbellIncoming({
					door: door(DOOR_3855),
					device: mock.findDevice(DEVICE_G2_PRO)!,
					requestId: 'request-1',
				}),
			);
			await waitFor(() => instance.val('doorbell.activeCallId') === 'request-1', { description: 'active call' });
			mock.emitRemoteView({ data: { request_id: 'request-1' } });
			await waitFor(() => events().some(e => e.type === 'access.remote_view'), {
				description: 'ws event logged',
			});
			await delay(30);
			expect(instance.val('doorbell.activeCallId')).to.equal('request-1');

			// a new ring (other request id) on the WebSocket replaces it
			const next = mock.emitRemoteView({ data: { request_id: 'request-2' } });
			await waitFor(() => instance.val('doorbell.activeCallId') === next.event_object_id, {
				description: 'new call',
			});
		});

		it('a repeated WebSocket ring always updates the published call', async () => {
			const instance = await startConnected({ enableWebhooks: false });
			const first = mock.emitRemoteView();
			await waitFor(() => instance.val('doorbell.activeCallId') === first.event_object_id, {
				description: 'ring 1',
			});
			const second = mock.emitRemoteView();
			await waitFor(() => instance.val('doorbell.activeCallId') === second.event_object_id, {
				description: 'ring 2',
			});
		});

		// K-04 A: the end event of a call that rang while the adapter was stopped is lost
		it('a call left behind by an earlier run is cleared at start', async () => {
			adapter = createAdapterWithFakeCore(MAIN, {
				controllerHost: '127.0.0.1',
				controllerPort: mock.port,
				apiToken: TOKEN,
				listenPort,
				listenIp: '127.0.0.1',
				enableWebhooks: false,
			});
			const instance = adapter;
			await instance.setState('doorbell.activeCallId', { val: 'old-call', ack: true });
			await instance.setState('doorbell.activeFromDevice', { val: 'Door 3855', ack: true });
			await instance.setState('doorbell.activeStartedAt', { val: 1_700_000_000_000, ack: true });
			await instance.fireReady();
			expect(active()).to.deep.equal([null, null, null]);
		});

		// K-04: the end event may be missed (reconnect) — a call does not stay "ringing" forever
		it('a call without end event is cleared after 3 minutes', async () => {
			const instance = await startConnected({ enableWebhooks: false });
			const ring = mock.emitRemoteView();
			await waitFor(() => instance.val('doorbell.activeCallId') === ring.event_object_id, {
				description: 'ring',
			});
			await clock.tickAsync(3 * 60_000 - 1);
			expect(instance.val('doorbell.activeCallId')).to.equal(ring.event_object_id);
			await clock.tickAsync(1);
			await waitFor(() => instance.val('doorbell.activeCallId') === null, { description: 'expired' });
			expect(active()).to.deep.equal([null, null, null]);
		});

		it('a new ring restarts the time limit; a regular end of the call cancels it', async () => {
			// rings by webhook: the long fake-time steps may let the WebSocket heartbeat drop the connection
			const instance = await startConnected();
			const ring = (requestId: string): Promise<unknown> =>
				mock.deliverWebhook(
					fixtures.webhookEvents.doorbellIncoming({
						door: door(DOOR_3855),
						device: mock.findDevice(DEVICE_G2_PRO)!,
						requestId,
					}),
				);
			await ring('request-1');
			await waitFor(() => instance.val('doorbell.activeCallId') === 'request-1', { description: 'ring 1' });
			await clock.tickAsync(2 * 60_000);
			await ring('request-2');
			await waitFor(() => instance.val('doorbell.activeCallId') === 'request-2', { description: 'ring 2' });
			await clock.tickAsync(2 * 60_000);
			expect(instance.val('doorbell.activeCallId'), 'the limit counts from the new ring').to.equal('request-2');

			await mock.deliverWebhook(
				fixtures.webhookEvents.doorbellCompleted({
					door: door(DOOR_3855),
					device: hub(),
					reasonCode: 108,
					requestId: 'request-2',
				}),
			);
			await waitFor(() => instance.val('doorbell.activeCallId') === null, { description: 'call ended' });
			await clock.tickAsync(3 * 60_000);
			expect(instance.log.of('debug').filter(m => m.startsWith('Doorbell call without end event'))).to.deep.equal(
				[],
			);
		});

		// K-04 B: the end event of call 1 was missed, call 2 arrives by webhook only (WebSocket reconnecting)
		it('a webhook call with another request id replaces a call whose end event was missed', async () => {
			const instance = await startConnected();
			await mock.deliverWebhook(
				fixtures.webhookEvents.doorbellIncoming({
					door: door(DOOR_3855),
					device: mock.findDevice(DEVICE_G2_PRO)!,
					requestId: 'request-1',
				}),
			);
			await waitFor(() => instance.val('doorbell.activeCallId') === 'request-1', { description: 'call 1' });
			await mock.deliverWebhook(
				fixtures.webhookEvents.doorbellIncoming({
					door: door(DOOR_A2),
					device: mock.findDevice(DEVICE_G2_PRO)!,
					requestId: 'request-2',
				}),
			);
			await waitFor(() => instance.val('doorbell.activeCallId') === 'request-2', { description: 'call 2' });
		});

		describe('the end of an earlier call does not clear the call that is still ringing (RK-02)', () => {
			/**
			 * Call A rings at one reader, call B at another one right after it (B is published).
			 *
			 * @param instance The adapter
			 * @returns The published call id of B
			 */
			async function twoCalls(instance: FakeAdapter): Promise<string> {
				mock.emitRemoteView({ data: { request_id: 'CALL_A', device_id: DEVICE_G2_PRO } });
				await waitFor(() => events().filter(e => e.type === 'access.remote_view').length === 1, {
					description: 'ring A',
				});
				const b = mock.emitRemoteView({ data: { request_id: 'CALL_B', device_id: DEVICE_HUB } });
				await waitFor(() => instance.val('doorbell.activeCallId') === b.event_object_id, {
					description: 'ring B published',
				});
				return String(b.event_object_id);
			}

			it('WebSocket: access.remote_view.change of call A leaves call B active; the end of B clears it', async () => {
				const instance = await startConnected({ enableWebhooks: false });
				const callB = await twoCalls(instance);
				mock.emitRemoteViewChange(105, { data: { remote_call_request_id: 'CALL_A' } });
				await waitFor(() => events().some(e => e.type === 'access.remote_view.change'), {
					description: 'end of A logged',
				});
				await delay(30);
				expect(instance.val('doorbell.activeCallId')).to.equal(callB);
				expect(instance.log.of('debug').some(m => m.includes('for call CALL_A, but call CALL_B is published')))
					.to.be.true;

				mock.emitRemoteViewChange(400, { data: { remote_call_request_id: 'CALL_B' } });
				await waitFor(() => instance.val('doorbell.activeCallId') === null, { description: 'B ended' });
				expect(active()).to.deep.equal([null, null, null]);
			});

			it('webhook: access.doorbell.completed of call A leaves call B active', async () => {
				const instance = await startConnected();
				const callB = await twoCalls(instance);
				await mock.deliverWebhook(
					fixtures.webhookEvents.doorbellCompleted({
						door: door(DOOR_3855),
						device: hub(),
						reasonCode: 108,
						requestId: 'CALL_A',
					}),
				);
				await waitFor(() => events().some(e => e.type === 'access.doorbell.completed'), {
					description: 'end of A logged',
				});
				await delay(30);
				expect(instance.val('doorbell.activeCallId')).to.equal(callB);
			});

			it('an end event without request id cannot be told apart and clears the published call', async () => {
				const instance = await startConnected({ enableWebhooks: false });
				await twoCalls(instance);
				mock.emitRemoteViewChange(105, { data: { remote_call_request_id: undefined } });
				await waitFor(() => instance.val('doorbell.activeCallId') === null, { description: 'cleared' });
			});

			it('the time limit of call B still clears call B', async () => {
				const instance = await startConnected({ enableWebhooks: false });
				await twoCalls(instance);
				await clock.tickAsync(3 * 60_000);
				await waitFor(() => instance.val('doorbell.activeCallId') === null, { description: 'expired' });
			});
		});

		it('the webhook does not replace the call id already set by the WebSocket event of the same call', async () => {
			const instance = await startConnected();
			const ring = mock.emitRemoteView({ data: { request_id: 'request-0815' } });
			await waitFor(() => instance.val('doorbell.activeCallId') === ring.event_object_id, {
				description: 'ring',
			});
			const startedAt = instance.val('doorbell.activeStartedAt');
			await mock.deliverWebhook(
				fixtures.webhookEvents.doorbellIncoming({
					door: door(DOOR_3855),
					device: mock.findDevice(DEVICE_G2_PRO)!,
					requestId: 'request-0815',
				}),
			);
			await waitFor(() => events().some(e => e.type === 'access.doorbell.incoming'), {
				description: 'webhook logged',
			});
			expect(instance.val('doorbell.activeCallId')).to.equal(ring.event_object_id);
			expect(instance.val('doorbell.activeStartedAt')).to.equal(startedAt);
		});
	});

	describe('lock rule status (D-21, read-only)', () => {
		it('creates doors.<id>.lockRuleType / lockRuleEndsAt and fills them at start', async () => {
			mock.lockRules.set(DOOR_A2, { type: 'keep_unlock', ended_time: 3_602_128_562 });
			const instance = await startConnected();
			await waitFor(() => instance.val(`doors.${DOOR_A2}.lockRuleType`) === 'keep_unlock', {
				description: 'rule type',
			});
			expect(instance.val(`doors.${DOOR_A2}.lockRuleEndsAt`)).to.equal(3_602_128_562_000);
			expect(instance.obj(`doors.${DOOR_A2}.lockRuleType`)?.common).to.include({
				type: 'string',
				role: 'text',
				read: true,
				write: false,
			});
			expect(instance.obj(`doors.${DOOR_A2}.lockRuleEndsAt`)?.common).to.include({
				type: 'number',
				role: 'value.time',
				read: true,
				write: false,
			});
			// a door without a temporary rule
			await waitFor(() => instance.val(`doors.${DOOR_3855}.lockRuleType`) !== undefined, {
				description: 'second door',
			});
			expect(instance.val(`doors.${DOOR_3855}.lockRuleEndsAt`)).to.equal(null);
		});

		it('updates the rule status after an own lock_rule / unlock_duration command', async () => {
			const instance = await startConnected();
			await waitFor(() => instance.val(`doors.${DOOR_3855}.lockRuleType`) !== undefined, {
				description: 'initial',
			});
			instance.fireStateChange(`doors.${DOOR_3855}.unlock_duration`, 5);
			await waitFor(() => instance.val(`doors.${DOOR_3855}.locked`) === false, { description: 'unlocked' });
			await clock.tickAsync(2000);
			await waitFor(() => instance.val(`doors.${DOOR_3855}.lockRuleType`) === 'custom', {
				description: 'custom rule',
			});
			const endsAt = instance.val(`doors.${DOOR_3855}.lockRuleEndsAt`) as number;
			expect(endsAt).to.equal(mock.lockRules.get(DOOR_3855)!.ended_time * 1000);
		});

		// K-11: a refusal for one door must not stop the lock rule status of all others
		it('a refusal as API error code with HTTP 200 stops the requests for that door only', async () => {
			mock.failNext({
				method: 'GET',
				path: `/doors/${DOOR_A2}/lock_rule`,
				status: 200,
				code: 'CODE_OPERATION_FORBIDDEN',
				times: Number.POSITIVE_INFINITY,
			});
			const instance = await startConnected();
			await waitFor(() => instance.log.of('debug').some(m => m.includes(`Lock rule status of door ${DOOR_A2}`)), {
				description: 'debug note',
			});
			const askedA = (): number =>
				mock.findRequests({ method: 'GET', path: `/doors/${DOOR_A2}/lock_rule` }).length;
			expect(askedA()).to.equal(1);

			// the other door keeps being updated
			instance.fireStateChange(`doors.${DOOR_3855}.unlock_duration`, 5);
			await waitFor(() => instance.val(`doors.${DOOR_3855}.locked`) === false, { description: 'unlocked' });
			await clock.tickAsync(2000);
			await waitFor(() => instance.val(`doors.${DOOR_3855}.lockRuleType`) === 'custom', {
				description: 'rule of the other door',
			});
			// and the refused one is not asked again until the next load
			instance.fireStateChange(`doors.${DOOR_A2}.lock_rule`, 2);
			await waitFor(() => instance.states.get(`${NS}.doors.${DOOR_A2}.lock_rule`)?.ack === true, {
				description: 'lock_rule ack',
			});
			await clock.tickAsync(2000);
			await waitFor(() => mock.findRequests({ method: 'GET', path: `/doors/${DOOR_A2}` }).length === 1, {
				description: 'door status read back',
			});
			await delay(30);
			expect(askedA()).to.equal(1);
		});

		it('a refusal for one door with an HTTP client error (400) does not affect the other doors', async () => {
			mock.failNext({
				method: 'GET',
				path: `/doors/${DOOR_A2}/lock_rule`,
				status: 400,
				code: 'CODE_NOT_EXISTS',
				times: Number.POSITIVE_INFINITY,
			});
			mock.lockRules.set(DOOR_3855, { type: 'keep_lock', ended_time: 0 });
			const instance = await startConnected();
			await waitFor(() => instance.val(`doors.${DOOR_3855}.lockRuleType`) === 'keep_lock', {
				description: 'rule of the other door',
			});
		});

		it('a temporary failure (server error, device offline) stops nothing: the next refresh asks again', async () => {
			mock.failNext({ method: 'GET', path: /\/lock_rule$/, status: 500, times: 2 });
			mock.failNext({
				method: 'GET',
				path: /\/lock_rule$/,
				status: 200,
				code: 'CODE_DEVICE_DEVICE_OFFLINE',
				times: 2,
			});
			const instance = await startConnected();
			const asked = mock.findRequests({ method: 'GET', path: /\/lock_rule$/ }).length;
			instance.fireStateChange(`doors.${DOOR_3855}.lock_rule`, 2);
			await waitFor(() => instance.states.get(`${NS}.doors.${DOOR_3855}.lock_rule`)?.ack === true, {
				description: 'lock_rule ack',
			});
			await clock.tickAsync(2000);
			await waitFor(() => mock.findRequests({ method: 'GET', path: /\/lock_rule$/ }).length > asked, {
				description: 'asked again',
			});
			expect(instance.log.of('debug').some(m => m.includes('not asking again'))).to.equal(false);
		});

		// K-09: the end of a timed unlock must be checked also when the adapter did not set the rule in this run
		it('plans the check at the end of a rule that was active at start (adapter restart, rule from the app)', async () => {
			const endsAt = Math.floor(Date.now() / 1000) + 60;
			mock.lockRules.set(DOOR_3855, { type: 'custom', ended_time: endsAt });
			mock.findDoor(DOOR_3855)!.door_lock_relay_status = 'unlock';
			const instance = await startConnected({ enableWebhooks: false });
			await waitFor(() => instance.val(`doors.${DOOR_3855}.lockRuleType`) === 'custom', { description: 'rule' });
			expect(instance.val(`doors.${DOOR_3855}.locked`)).to.equal(false);
			const checks = (): number => mock.findRequests({ method: 'GET', path: `/doors/${DOOR_3855}` }).length;
			const before = checks();

			// the rule runs out on the controller
			mock.lockRules.delete(DOOR_3855);
			mock.findDoor(DOOR_3855)!.door_lock_relay_status = 'lock';
			await clock.tickAsync(endsAt * 1000 - Date.now() - 1000);
			await delay(30);
			expect(checks(), 'not before the end').to.equal(before);
			// end + 2 s, with some margin for the real time that passed since the check was planned
			await clock.tickAsync(1000 + 2000 + 500);
			await waitFor(() => instance.val(`doors.${DOOR_3855}.locked`) === true, { description: 'locked again' });
			expect(checks()).to.equal(before + 1);
		});

		it('plans the check for a rule the controller reports after an event (set in the UniFi app)', async () => {
			const instance = await startConnected();
			const endsAt = Math.floor(Date.now() / 1000) + 120;
			mock.lockRules.set(DOOR_3855, { type: 'custom', ended_time: endsAt });
			await mock.deliverWebhook(
				fixtures.webhookEvents.generic('access.temporary_unlock.start', {
					door: door(DOOR_3855),
					device: hub(),
				}),
			);
			await clock.tickAsync(2000);
			await waitFor(() => instance.val(`doors.${DOOR_3855}.lockRuleType`) === 'custom', { description: 'rule' });
			const before = mock.findRequests({ method: 'GET', path: `/doors/${DOOR_3855}` }).length;
			await clock.tickAsync(endsAt * 1000 - Date.now() + 2000 + 500);
			await waitFor(
				() => mock.findRequests({ method: 'GET', path: `/doors/${DOOR_3855}` }).length === before + 1,
				{
					description: 'check at the end of the rule',
				},
			);
		});

		it('plans no check for a rule without end time, one that has ended, or one beyond 24 h', async () => {
			const now = Math.floor(Date.now() / 1000);
			mock.lockRules.set(DOOR_3855, { type: 'keep_unlock', ended_time: now + 25 * 3600 });
			mock.lockRules.set(DOOR_A2, { type: 'custom', ended_time: now - 10 });
			const instance = await startConnected({ enableWebhooks: false });
			await waitFor(() => instance.val(`doors.${DOOR_A2}.lockRuleType`) === 'custom', { description: 'rules' });
			await delay(30);
			// timers: only the adapter's own (none for rule ends)
			const doorChecks = (): number => mock.findRequests({ method: 'GET', path: /^\/doors\/[^/]+$/ }).length;
			const before = doorChecks();
			await clock.tickAsync(24 * 3_600_000);
			await delay(30);
			expect(doorChecks()).to.equal(before);
		});

		it('stops asking when the controller does not support the endpoint (older firmware) and keeps working', async () => {
			mock.failNext({ method: 'GET', path: /\/lock_rule$/, status: 404, times: Number.POSITIVE_INFINITY });
			const instance = await startConnected();
			await waitFor(() => instance.log.of('debug').some(m => m.includes('Lock rule status not available')), {
				description: 'debug note',
			});
			const asked = mock.findRequests({ method: 'GET', path: /\/lock_rule$/ }).length;
			expect(asked, 'one probe only').to.equal(1);
			instance.fireStateChange(`doors.${DOOR_3855}.unlock`, true);
			await waitFor(() => instance.val(`doors.${DOOR_3855}.locked`) === false, { description: 'unlocked' });
			await clock.tickAsync(7000);
			await waitFor(() => instance.val(`doors.${DOOR_3855}.locked`) === true, {
				description: 'status read back',
			});
			expect(mock.findRequests({ method: 'GET', path: /\/lock_rule$/ })).to.have.length(asked);
			expect(instance.log.of('warn')).to.deep.equal([]);
		});
	});

	describe('API error codes in successful HTTP responses (D-02)', () => {
		it('an unlock answered with an error code is not acknowledged and the door is not shown as unlocked', async () => {
			const instance = await startConnected();
			mock.failNext({
				method: 'PUT',
				path: `/doors/${DOOR_3855}/unlock`,
				status: 200,
				code: 'CODE_DEVICE_DEVICE_OFFLINE',
				msg: 'The device is currently offline.',
			});
			const timersBefore = instance.timers.size;
			instance.fireStateChange(`doors.${DOOR_3855}.unlock`, true);
			await waitFor(() => instance.log.of('warn').length === 1, { description: 'warning' });
			expect(instance.log.of('warn')[0]).to.contain(`Unlock door ${DOOR_3855} failed`);
			expect(instance.log.of('warn')[0]).to.contain(
				'CODE_DEVICE_DEVICE_OFFLINE: The device is currently offline.',
			);
			expect(instance.states.get(`${NS}.doors.${DOOR_3855}.unlock`)).to.include({ val: true, ack: false });
			expect(instance.val(`doors.${DOOR_3855}.locked`)).to.equal(true);
			expect(instance.timers.size, 'no status check scheduled').to.equal(timersBefore);
			expect(instance.log.of('info').filter(m => m.includes('unlocked'))).to.deep.equal([]);
		});

		it('a lock rule answered with an error code is not acknowledged', async () => {
			const instance = await startConnected();
			mock.failNext({
				method: 'PUT',
				path: `/doors/${DOOR_3855}/lock_rule`,
				status: 200,
				code: 'CODE_OPERATION_FORBIDDEN',
			});
			instance.fireStateChange(`doors.${DOOR_3855}.lock_rule`, 1);
			await waitFor(() => instance.log.of('warn').length === 1, { description: 'warning' });
			expect(instance.log.of('warn')[0]).to.contain('CODE_OPERATION_FORBIDDEN');
			expect(instance.states.get(`${NS}.doors.${DOOR_3855}.lock_rule`)).to.include({ val: 1, ack: false });
			expect(instance.val(`doors.${DOOR_3855}.locked`)).to.equal(true);
		});

		it('a bootstrap answered with an error code counts as failed (no empty device list, retry scheduled)', async () => {
			mock.failNext({ path: '/devices', status: 200, code: 'CODE_SYSTEM_ERROR' });
			const instance = await start({ enableWebhooks: false });
			expect(instance.val('info.connection')).to.equal(false);
			expect(instance.log.of('warn')[0]).to.contain('CODE_SYSTEM_ERROR');
			await clock.tickAsync(30_000);
			await waitFor(() => instance.val('info.connection') === true, { description: 'connected after retry' });
		});

		// K-03: some other HTTPS service on host and port (proxy default site, wrong port) answers with 200
		it('a bootstrap answered without the UniFi Access envelope counts as failed, not as "0 devices"', async () => {
			mock.failNext({ path: '/devices', status: 200, body: '<html>router login</html>' });
			const instance = await start({ enableWebhooks: false });
			expect(instance.val('info.connection')).to.equal(false);
			expect(instance.log.of('warn')[0]).to.contain(
				'unexpected response without the UniFi Access response envelope',
			);
			expect(instance.log.of('warn')[0]).to.contain('do host and port point to the UniFi Access API?');
			expect(instance.log.of('info').filter(m => m.startsWith('Connected to UniFi Access'))).to.deep.equal([]);
			expect(mock.wsHandshakes).to.have.length(0);
		});

		it('a resync whose door list comes without "data" keeps the known doors working', async () => {
			const instance = await startConnected({ enableWebhooks: false });
			mock.failNext({ path: '/doors', method: 'GET', status: 200, body: { code: 'SUCCESS', msg: 'success' } });
			mock.dropWsConnections();
			await waitFor(() => instance.val('info.connection') === false, { description: 'connection lost' });
			await clock.tickAsync(200);
			await waitFor(() => mock.findRequests({ path: '/doors', method: 'GET' }).length === 2, {
				description: 'resync door request',
			});
			await waitFor(() => instance.log.of('warn').length === 1, { description: 'resync warning' });
			expect(instance.log.of('warn')[0]).to.contain('without a door list');
			// the failed resync counts as failed (retry) — it does not turn into "the controller has no doors"
			await clock.tickAsync(30_000);
			await waitFor(() => instance.val('info.connection') === true, { description: 'connected after retry' });
			instance.fireStateChange(`doors.${DOOR_3855}.unlock`, true);
			await mock.waitForRequest({ method: 'PUT', path: `/doors/${DOOR_3855}/unlock` });
		});

		it('an authentication error code with HTTP 200 is reported as "unauthorized"', async () => {
			mock.failNext({ status: 200, code: 'CODE_ACCESS_TOKEN_INVALID', times: Number.POSITIVE_INFINITY });
			const instance = await start({ enableWebhooks: false });
			expect(await instance.request('getConnectionStatus')).to.include({
				connected: false,
				lastError: 'unauthorized',
			});
		});
	});

	// T-04: regressions that so far only the integration tests caught (mutation probe of R2: M01, M03, M07)
	describe('safety nets in the fast suite (T-04)', () => {
		it('acknowledged writes to control states never trigger a door action (M01)', async () => {
			const instance = await startConnected({ enableWebhooks: false });
			const before = mock.requests.length;
			instance.fireStateChange(`doors.${DOOR_3855}.unlock`, true, true);
			instance.fireStateChange(`doors.${DOOR_3855}.unlock_duration`, 5, true);
			instance.fireStateChange(`doors.${DOOR_3855}.lock_rule`, 1, true);
			instance.fireStateChange('doors.emergency.lockdown', true, true);
			// a command that is acted upon proves the four above have been processed
			instance.fireStateChange(`doors.${DOOR_A2}.lock_rule`, 2);
			await waitFor(() => instance.states.get(`${NS}.doors.${DOOR_A2}.lock_rule`)?.ack === true, {
				description: 'lock_rule ack',
			});
			expect(
				mock.requests
					.slice(before)
					.filter(r => r.method === 'PUT')
					.map(r => r.path),
			).to.deep.equal([`/doors/${DOOR_A2}/lock_rule`]);
		});

		it('reregisterWebhook answers exactly {ok, id} — never the new secret (M03)', async () => {
			const instance = await startConnected();
			const answer = await instance.request('reregisterWebhook');
			expect(answer).to.deep.equal({ ok: true, id: mock.webhookEndpoints[0].id });
			expect(JSON.stringify(answer)).to.not.contain(mock.webhookEndpoints[0].secret);
		});

		it('a pulse unlock carries the configured actor with its name; without actor the body is empty (M07)', async () => {
			const user = mock.users[0] as { id: string; first_name?: string; last_name?: string };
			const instance = await startConnected({ enableWebhooks: false, unlockActorId: user.id });
			instance.fireStateChange(`doors.${DOOR_3855}.unlock`, true);
			const put = await mock.waitForRequest({ method: 'PUT', path: `/doors/${DOOR_3855}/unlock` });
			expect(put.body).to.deep.equal({
				actor_id: user.id,
				actor_name: [user.first_name, user.last_name].filter(Boolean).join(' '),
			});
			await instance.fireUnload();
			adapter = undefined;

			mock.requests.length = 0;
			const plain = await startConnected({ enableWebhooks: false, unlockActorId: '' });
			plain.fireStateChange(`doors.${DOOR_3855}.unlock`, true);
			expect(
				(await mock.waitForRequest({ method: 'PUT', path: `/doors/${DOOR_3855}/unlock` })).body,
			).to.deep.equal({});
		});
	});

	describe('door commands', () => {
		it('a failed unlock is neither acknowledged nor reflected in "locked" (warning only)', async () => {
			const instance = await startConnected();
			mock.failNext({ method: 'PUT', path: `/doors/${DOOR_3855}/unlock`, status: 500 });
			const timersBefore = clock.countTimers();
			instance.fireStateChange(`doors.${DOOR_3855}.unlock`, true);
			await waitFor(() => instance.log.of('warn').some(m => m.startsWith(`Unlock door ${DOOR_3855} failed`)), {
				description: 'warning',
			});
			expect(instance.states.get(`${NS}.doors.${DOOR_3855}.unlock`)).to.include({ val: true, ack: false });
			expect(instance.val(`doors.${DOOR_3855}.locked`)).to.equal(true);
			expect(clock.countTimers(), 'no re-lock timer').to.equal(timersBefore);
		});

		it('an invalid value for a door the controller does not know is ignored without writing a state that has no object', async () => {
			const instance = await startConnected();
			const writes = instance.stateWrites.length;
			instance.fireStateChange('doors.unknown-door.unlock_duration', 'abc');
			instance.fireStateChange('doors.unknown-door.lock_rule', 99);
			instance.fireStateChange('doors.unknown-door.unlock', 'yes');
			instance.fireStateChange('doors.emergency.unlock', true);
			instance.fireStateChange(`doors.${DOOR_A2}.lock_rule`, 2);
			await waitFor(() => instance.states.get(`${NS}.doors.${DOOR_A2}.lock_rule`)?.ack === true, {
				description: 'lock_rule ack',
			});
			expect(
				instance.stateWrites
					.slice(writes)
					.filter(w => w.id.includes('unknown-door') || w.id.includes('emergency.unlock')),
			).to.deep.equal([]);
			expect(instance.log.of('warn')).to.deep.equal([]);
		});

		it('ignores commands for doors the controller does not know', async () => {
			const instance = await startConnected();
			const before = mock.requests.length;
			instance.fireStateChange('doors.unknown-door.unlock', true);
			instance.fireStateChange('doors.unknown-door.unlock_duration', 5);
			instance.fireStateChange('doors.unknown-door.lock_rule', 1);
			// a command for a known door proves the three above have been processed
			instance.fireStateChange(`doors.${DOOR_A2}.lock_rule`, 2);
			await waitFor(() => instance.states.get(`${NS}.doors.${DOOR_A2}.lock_rule`)?.ack === true, {
				description: 'lock_rule ack',
			});
			expect(mock.requests.slice(before).map(r => r.path)).to.deep.equal([`/doors/${DOOR_A2}/lock_rule`]);
		});
	});

	describe('control states: only valid values trigger a door action (R-04, R-24)', () => {
		const doorWrites = (): string[] =>
			mock.requests
				.filter(r => r.method !== 'GET' && r.path.startsWith('/doors/'))
				.map(r => `${r.method} ${r.path}`);

		for (const [label, bad] of [
			['the string "10"', '10'],
			['null', null],
			['true', true],
			['NaN', Number.NaN],
			['Infinity', Number.POSITIVE_INFINITY],
			['a negative number', -1],
			['a value above the 600 min maximum', 601],
			['an object', { minutes: 5 }],
		] as [string, unknown][]) {
			it(`unlock_duration = ${label}: no door action, warning, state reset with ack`, async () => {
				const instance = await startConnected();
				instance.fireStateChange(`doors.${DOOR_3855}.unlock_duration`, bad);
				await waitFor(() => instance.log.of('warn').some(m => m.includes('unlock_duration')), {
					description: 'warning',
				});
				await waitFor(() => instance.states.get(`${NS}.doors.${DOOR_3855}.unlock_duration`)?.ack === true, {
					description: 'state reset',
				});
				expect(instance.val(`doors.${DOOR_3855}.unlock_duration`)).to.equal(0);
				expect(doorWrites()).to.deep.equal([]);
				expect(mock.unlocks).to.deep.equal([]);
				expect(instance.val(`doors.${DOOR_3855}.locked`)).to.equal(true);
			});
		}

		it('unlock_duration = 600 (maximum) is accepted', async () => {
			const instance = await startConnected();
			instance.fireStateChange(`doors.${DOOR_3855}.unlock_duration`, 600);
			await waitFor(() => instance.states.get(`${NS}.doors.${DOOR_3855}.unlock_duration`)?.ack === true, {
				description: 'ack',
			});
			expect(
				mock.findRequests({ method: 'PUT', path: `/doors/${DOOR_3855}/lock_rule` }).map(r => r.body),
			).to.deep.equal([{ type: 'custom', interval: 600 }]);
			expect(instance.log.of('warn')).to.deep.equal([]);
			expect(instance.obj(`doors.${DOOR_3855}.unlock_duration`)?.common).to.include({ min: 0, max: 600 });
		});

		it('an invalid unlock_duration restores the last acknowledged value', async () => {
			const instance = await startConnected();
			instance.fireStateChange(`doors.${DOOR_3855}.unlock_duration`, 3);
			await waitFor(() => instance.states.get(`${NS}.doors.${DOOR_3855}.unlock_duration`)?.ack === true, {
				description: 'ack',
			});
			instance.fireStateChange(`doors.${DOOR_3855}.unlock_duration`, 'abc');
			await waitFor(() => instance.states.get(`${NS}.doors.${DOOR_3855}.unlock_duration`)?.ack === true, {
				description: 'state reset',
			});
			expect(instance.val(`doors.${DOOR_3855}.unlock_duration`)).to.equal(3);
			expect(doorWrites()).to.deep.equal([`PUT /doors/${DOOR_3855}/lock_rule`]);
		});

		for (const [label, bad] of [
			['the string "1"', '1'],
			['null', null],
			['true', true],
			['NaN', Number.NaN],
			['a fraction', 1.5],
			['an unknown index', 9],
			['a negative index', -1],
		] as [string, unknown][]) {
			it(`lock_rule = ${label}: no door action (in particular no reset), warning, state reset with ack`, async () => {
				const instance = await startConnected();
				instance.fireStateChange(`doors.${DOOR_3855}.lock_rule`, bad);
				await waitFor(() => instance.log.of('warn').some(m => m.includes('lock_rule')), {
					description: 'warning',
				});
				await waitFor(() => instance.states.get(`${NS}.doors.${DOOR_3855}.lock_rule`)?.ack === true, {
					description: 'state reset',
				});
				expect(instance.val(`doors.${DOOR_3855}.lock_rule`)).to.equal(0);
				expect(doorWrites()).to.deep.equal([]);
			});
		}

		for (const [label, bad] of [
			['the string "true"', 'true'],
			['the number 1', 1],
			['an object', {}],
		] as [string, unknown][]) {
			it(`unlock = ${label}: no door action, warning, state reset to false with ack`, async () => {
				const instance = await startConnected();
				instance.fireStateChange(`doors.${DOOR_3855}.unlock`, bad);
				await waitFor(() => instance.log.of('warn').some(m => m.includes('unlock')), {
					description: 'warning',
				});
				await waitFor(() => instance.states.get(`${NS}.doors.${DOOR_3855}.unlock`)?.ack === true, {
					description: 'state reset',
				});
				expect(instance.val(`doors.${DOOR_3855}.unlock`)).to.equal(false);
				expect(doorWrites()).to.deep.equal([]);
				expect(mock.unlocks).to.deep.equal([]);
			});
		}

		for (const field of ['lockdown', 'evacuation'] as const) {
			for (const [label, bad] of [
				['the string "true"', 'true'],
				['the number 1', 1],
				['null', null],
			] as [string, unknown][]) {
				it(`doors.emergency.${field} = ${label}: no PUT, warning, state restored from the controller`, async () => {
					mock.emergency = { lockdown: field === 'lockdown', evacuation: field === 'evacuation' };
					const instance = await startConnected();
					instance.fireStateChange(`doors.emergency.${field}`, bad);
					await waitFor(() => instance.log.of('warn').some(m => m.includes(`doors.emergency.${field}`)), {
						description: 'warning',
					});
					await waitFor(() => instance.states.get(`${NS}.doors.emergency.${field}`)?.ack === true, {
						description: 'state restored',
					});
					expect(instance.val(`doors.emergency.${field}`)).to.equal(true);
					expect(mock.findRequests({ method: 'PUT', path: '/doors/settings/emergency' })).to.deep.equal([]);
					expect(mock.emergency).to.deep.equal({
						lockdown: field === 'lockdown',
						evacuation: field === 'evacuation',
					});
				});
			}
		}

		it('emergency: two commands in quick succession do not undo each other (read-modify-write is serialised)', async () => {
			mock.emergency = { lockdown: false, evacuation: true };
			const instance = await startConnected();
			// "everything back to normal", written without waiting in between
			instance.fireStateChange('doors.emergency.evacuation', false);
			instance.fireStateChange('doors.emergency.lockdown', false);
			await waitFor(() => mock.findRequests({ method: 'PUT', path: '/doors/settings/emergency' }).length === 2, {
				description: 'both commands sent',
			});
			await waitFor(() => instance.states.get(`${NS}.doors.emergency.lockdown`)?.ack === true, {
				description: 'ack',
			});
			expect(
				mock.findRequests({ method: 'PUT', path: '/doors/settings/emergency' }).map(r => r.body),
			).to.deep.equal([
				{ lockdown: false, evacuation: false },
				{ lockdown: false, evacuation: false },
			]);
			expect(mock.emergency, 'the evacuation must not be switched on again by the second command').to.deep.equal({
				lockdown: false,
				evacuation: false,
			});

			mock.emergency = { lockdown: true, evacuation: false };
			instance.fireStateChange('doors.emergency.lockdown', false);
			instance.fireStateChange('doors.emergency.evacuation', true);
			await waitFor(() => mock.emergency.evacuation === true, { description: 'evacuation on' });
			expect(mock.emergency).to.deep.equal({ lockdown: false, evacuation: true });
		});

		it('emergency: nothing is sent when the controller does not report the current status', async () => {
			mock.emergency = { lockdown: true, evacuation: false };
			const instance = await startConnected();
			mock.failNext({
				method: 'GET',
				path: '/doors/settings/emergency',
				status: 200,
				body: { code: 'SUCCESS', msg: 'success' },
			});
			instance.fireStateChange('doors.emergency.evacuation', true);
			await waitFor(
				() => instance.log.of('warn').some(m => m.includes('did not report the current emergency status')),
				{
					description: 'warning',
				},
			);
			expect(mock.findRequests({ method: 'PUT', path: '/doors/settings/emergency' })).to.deep.equal([]);
			expect(mock.emergency, 'the lockdown must not be cleared by a guessed value').to.deep.equal({
				lockdown: true,
				evacuation: false,
			});
		});

		it('emergency: the other flag is taken from the controller, never from a stale or unacknowledged state', async () => {
			const instance = await startConnected();
			// an evacuation command that never reached the controller leaves evacuation=true/ack=false behind
			mock.failNext({ method: 'PUT', path: '/doors/settings/emergency', status: 500 });
			instance.fireStateChange('doors.emergency.evacuation', true);
			await waitFor(() => instance.log.of('warn').some(m => m.startsWith('Set emergency status failed')), {
				description: 'failed evacuation',
			});
			expect(mock.emergency).to.deep.equal({ lockdown: false, evacuation: false });

			instance.fireStateChange('doors.emergency.lockdown', true);
			await waitFor(() => instance.states.get(`${NS}.doors.emergency.lockdown`)?.ack === true, {
				description: 'lockdown ack',
			});
			expect(mock.emergency, 'the failed evacuation must not be sent along').to.deep.equal({
				lockdown: true,
				evacuation: false,
			});
		});
	});

	describe('switching commands without a loaded controller state or connection (K-01)', () => {
		const putRequests = (): unknown[] => mock.requests.filter(r => r.method === 'PUT');

		it('before the first successful load: not executed, warned, reset — and not executed later either', async () => {
			mock.failNext({ status: 500, times: Number.POSITIVE_INFINITY });
			const instance = await start({ enableWebhooks: false });
			// objects of the door exist from an earlier run
			instance.objects.set(`${NS}.doors.${DOOR_3855}.unlock`, { _id: `${NS}.doors.${DOOR_3855}.unlock` });

			instance.fireStateChange(`doors.${DOOR_3855}.unlock`, true);
			instance.fireStateChange(`doors.${DOOR_3855}.unlock_duration`, 5);
			instance.fireStateChange(`doors.${DOOR_3855}.lock_rule`, 1);
			instance.fireStateChange('doors.emergency.lockdown', true);
			await waitFor(() => instance.states.get(`${NS}.doors.emergency.lockdown`)?.ack === true, {
				description: 'states reset',
			});
			expect(instance.states.get(`${NS}.doors.${DOOR_3855}.unlock`)).to.include({ val: false, ack: true });
			expect(instance.states.get(`${NS}.doors.${DOOR_3855}.unlock_duration`)).to.include({ val: 0, ack: true });
			expect(instance.states.get(`${NS}.doors.${DOOR_3855}.lock_rule`)).to.include({ val: 0, ack: true });
			// never confirmed by the controller: "unknown" rather than a guessed "off"
			expect(instance.states.get(`${NS}.doors.emergency.lockdown`)).to.include({ val: null, ack: true });
			const warnings = instance.log.of('warn').filter(m => m.startsWith('Command '));
			expect(warnings).to.have.length(4);
			expect(warnings[0]).to.equal(
				`Command doors.${DOOR_3855}.unlock not executed: the controller has not been reachable since the adapter start (doors not loaded yet). ` +
					'The state was reset — write it again once the controller is connected.',
			);

			mock.clearFaults();
			await clock.tickAsync(30_000);
			await waitFor(() => instance.val('info.connection') === true, { description: 'connected' });
			await clock.tickAsync(60_000);
			await delay(30);
			expect(putRequests(), 'nothing is executed afterwards').to.deep.equal([]);
		});

		it('while the connection is lost: not executed, warned, reset to the last acknowledged value', async () => {
			const instance = await startConnected({ enableWebhooks: false });
			instance.fireStateChange(`doors.${DOOR_3855}.lock_rule`, 2);
			await waitFor(() => instance.states.get(`${NS}.doors.${DOOR_3855}.lock_rule`)?.ack === true, {
				description: 'lock_rule ack',
			});
			const puts = putRequests().length;

			mock.wsAccepting = false;
			mock.dropWsConnections();
			await waitFor(() => instance.val('info.connection') === false, { description: 'connection lost' });
			instance.fireStateChange(`doors.${DOOR_3855}.unlock`, true);
			instance.fireStateChange(`doors.${DOOR_3855}.lock_rule`, 1);
			await waitFor(() => instance.states.get(`${NS}.doors.${DOOR_3855}.lock_rule`)?.ack === true, {
				description: 'lock_rule reset',
			});
			expect(instance.states.get(`${NS}.doors.${DOOR_3855}.lock_rule`)).to.include({ val: 2, ack: true });
			expect(instance.states.get(`${NS}.doors.${DOOR_3855}.unlock`)).to.include({ val: false, ack: true });
			expect(
				instance.log.of('warn').filter(m => m.includes('the connection to the controller is lost')),
			).to.have.length(2);

			mock.wsAccepting = true;
			await clock.tickAsync(200);
			await waitFor(() => instance.val('info.connection') === true, { description: 'connection back' });
			await delay(50);
			expect(putRequests().length, 'nothing is executed after the reconnect').to.equal(puts);
		});

		it('a door that the controller does not report any more (objects kept): warned and reset, no request', async () => {
			const instance = await startConnected({ enableWebhooks: false });
			instance.objects.set(`${NS}.doors.gone-door.unlock`, { _id: `${NS}.doors.gone-door.unlock` });
			instance.fireStateChange('doors.gone-door.unlock', true);
			await waitFor(() => instance.states.get(`${NS}.doors.gone-door.unlock`)?.ack === true, {
				description: 'reset',
			});
			expect(instance.val('doors.gone-door.unlock')).to.equal(false);
			expect(instance.log.of('warn')).to.deep.equal([
				'Command doors.gone-door.unlock not executed: the controller does not report a door with the id gone-door (any more). ' +
					'The state was reset — write it again once the controller is connected.',
			]);
			expect(putRequests()).to.deep.equal([]);
		});
	});

	describe('failed emergency commands do not leave the requested value standing (K-10)', () => {
		it('a refused command: the states are read back from the controller', async () => {
			mock.emergency = { lockdown: false, evacuation: true };
			const instance = await startConnected({ enableWebhooks: false });
			mock.failNext({ method: 'PUT', path: '/doors/settings/emergency', status: 403, code: 'CODE_UNAUTHORIZED' });
			const reads = mock.findRequests({ method: 'GET', path: '/doors/settings/emergency' }).length;
			instance.fireStateChange('doors.emergency.lockdown', true);
			await waitFor(() => instance.states.get(`${NS}.doors.emergency.lockdown`)?.ack === true, {
				description: 'lockdown restored',
			});
			expect(instance.states.get(`${NS}.doors.emergency.lockdown`)).to.include({ val: false, ack: true });
			expect(instance.states.get(`${NS}.doors.emergency.evacuation`)).to.include({ val: true, ack: true });
			// one read for the read-modify-write, one for putting the states back
			expect(mock.findRequests({ method: 'GET', path: '/doors/settings/emergency' })).to.have.length(reads + 2);
		});

		it('controller not readable either: the states fall back to what it reported last', async () => {
			mock.emergency = { lockdown: true, evacuation: false };
			const instance = await startConnected({ enableWebhooks: false });
			mock.failNext({ path: '/doors/settings/emergency', status: 500, times: Number.POSITIVE_INFINITY });
			instance.fireStateChange('doors.emergency.lockdown', false);
			instance.fireStateChange('doors.emergency.evacuation', true);
			await waitFor(
				() =>
					instance.states.get(`${NS}.doors.emergency.lockdown`)?.ack === true &&
					instance.states.get(`${NS}.doors.emergency.evacuation`)?.ack === true,
				{ description: 'states restored' },
			);
			expect(instance.val('doors.emergency.lockdown')).to.equal(true);
			expect(instance.val('doors.emergency.evacuation')).to.equal(false);
			expect(mock.emergency).to.deep.equal({ lockdown: true, evacuation: false });
		});

		it('the current status is not reported: the states are put back as well', async () => {
			mock.emergency = { lockdown: true, evacuation: false };
			const instance = await startConnected({ enableWebhooks: false });
			mock.failNext({
				method: 'GET',
				path: '/doors/settings/emergency',
				status: 200,
				body: { code: 'SUCCESS', msg: 'success' },
			});
			instance.fireStateChange('doors.emergency.evacuation', true);
			await waitFor(() => instance.states.get(`${NS}.doors.emergency.evacuation`)?.ack === true, {
				description: 'evacuation restored',
			});
			expect(instance.val('doors.emergency.evacuation')).to.equal(false);
		});
	});

	describe('access.device.dps_status (D-01)', () => {
		it('takes the door position from the documented data.object.status', async () => {
			const instance = await startConnected();
			expect(instance.val(`doors.${DOOR_3855}.position`)).to.equal('close');
			await mock.deliverWebhook(
				fixtures.webhookEvents.dpsStatus({ door: door(DOOR_3855), device: hub(), status: 'open' }),
			);
			await waitFor(() => instance.val(`doors.${DOOR_3855}.position`) === 'open', { description: 'open' });
			await waitFor(() => events()[0]?.subtype === 'open', { description: 'subtype' });
			await mock.deliverWebhook(
				fixtures.webhookEvents.dpsStatus({ door: door(DOOR_3855), device: hub(), status: 'close' }),
			);
			await waitFor(() => instance.val(`doors.${DOOR_3855}.position`) === 'close', { description: 'close' });
		});

		it('still accepts the legacy field names data.dps_status / data.value as a fallback', async () => {
			const instance = await startConnected();
			const legacy = fixtures.webhookEvents.dpsStatus({ door: door(DOOR_3855), device: hub(), status: 'open' });
			delete legacy.data.object;
			legacy.data.dps_status = 'open';
			await mock.deliverWebhook(legacy);
			await waitFor(() => instance.val(`doors.${DOOR_3855}.position`) === 'open', { description: 'open' });
			const legacy2 = fixtures.webhookEvents.dpsStatus({ door: door(DOOR_3855), device: hub(), status: 'open' });
			legacy2.data.object = null;
			legacy2.data.value = 'close';
			await mock.deliverWebhook(legacy2);
			await waitFor(() => instance.val(`doors.${DOOR_3855}.position`) === 'close', { description: 'close' });
		});

		it('never overwrites the position with "unknown" when the event carries no usable status', async () => {
			const instance = await startConnected();
			const broken = fixtures.webhookEvents.dpsStatus({ door: door(DOOR_3855), device: hub(), status: 'open' });
			broken.data.object = { event_type: 'dps_change', status: 42 };
			await mock.deliverWebhook(broken);
			await waitFor(() => events().length === 1, { description: 'event logged' });
			expect(instance.val(`doors.${DOOR_3855}.position`)).to.equal('close');
			expect(instance.stateWrites.filter(w => w.id.endsWith('.position') && w.val === 'unknown')).to.deep.equal(
				[],
			);
		});
	});

	// E2E finding E-04: lastThumbnailUrl survives restarts, the server settings may not. After the thumbnail
	// server was switched off (or port / TLS changed) the state kept a URL that leads nowhere and the www
	// panel showed "could not be loaded" instead of the hint that the server is off.
	describe('lastThumbnailUrl follows the configuration of the built-in HTTP server', () => {
		const PATH = `/preview/reader_${DEVICE_G2_PRO}_x_1700000000.jpg`;
		const OLD_URL = `http://192.0.2.9:8095/unifi-access/0/thumbnail/${DEVICE_G2_PRO}.jpg?ts=1700000000000`;

		async function startWithStoredThumbnail(overrides: Record<string, unknown>): Promise<FakeAdapter> {
			adapter = createAdapterWithFakeCore(MAIN, {
				controllerHost: '127.0.0.1',
				controllerPort: mock.port,
				apiToken: TOKEN,
				verifyTLS: false,
				wsReconnectDelay: 0.05,
				listenPort,
				listenIp: '127.0.0.1',
				enableWebhooks: true,
				forwardEvents: [],
				...overrides,
			});
			// what an earlier run with another server configuration left behind
			await adapter.setState(`devices.${DEVICE_G2_PRO}.lastThumbnailPath`, { val: PATH, ack: true });
			await adapter.setState(`devices.${DEVICE_G2_PRO}.lastThumbnailAt`, { val: 1_700_000_000_000, ack: true });
			await adapter.setState(`devices.${DEVICE_G2_PRO}.lastThumbnailUrl`, { val: OLD_URL, ack: true });
			await adapter.fireReady();
			return adapter;
		}

		it('clears the URL while the thumbnail server is off - also for a thumbnail that arrives then', async () => {
			const instance = await startWithStoredThumbnail({ enableThumbnailServer: false });
			expect(instance.val(`devices.${DEVICE_G2_PRO}.lastThumbnailUrl`)).to.equal('');
			expect(instance.val(`devices.${DEVICE_G2_PRO}.lastThumbnailPath`)).to.equal(PATH);

			const event = fixtures.webhookEvents.doorUnlock({
				door: door(DOOR_3855),
				device: hub(),
				readerId: DEVICE_G2_PRO,
			});
			await mock.deliverWebhook(event);
			await waitFor(
				() =>
					instance.val(`devices.${DEVICE_G2_PRO}.lastThumbnailPath`) ===
					event.data.location.extras.door_thumbnail,
				{ description: 'new thumbnail path' },
			);
			expect(instance.val(`devices.${DEVICE_G2_PRO}.lastThumbnailUrl`)).to.equal('');
			expect(instance.val(`devices.${DEVICE_G2_PRO}.lastThumbnailAt`)).to.be.a('number');
		});

		it('rebuilds the URL for the address, port and scheme the server runs with now', async () => {
			const instance = await startWithStoredThumbnail({ enableThumbnailServer: true });
			expect(instance.val(`devices.${DEVICE_G2_PRO}.lastThumbnailUrl`)).to.equal(
				`http://127.0.0.1:${listenPort}/unifi-access/0/thumbnail/${DEVICE_G2_PRO}.jpg?ts=1700000000000`,
			);
			// and the rebuilt URL works
			mock.addStaticResource(PATH);
			const response = await httpRequest({
				url: String(instance.val(`devices.${DEVICE_G2_PRO}.lastThumbnailUrl`)),
			});
			expect(response.status).to.equal(200);
		});

		it('does not write the URL again when it is already right, and leaves devices without thumbnail alone', async () => {
			const instance = await startWithStoredThumbnail({ enableThumbnailServer: true });
			const url = instance.val(`devices.${DEVICE_G2_PRO}.lastThumbnailUrl`);
			const writesBefore = instance.stateWrites.filter(w => w.id.endsWith('.lastThumbnailUrl')).length;
			// a reconnect reloads the controller state: nothing to refresh then
			mock.dropWsConnections();
			await waitFor(() => instance.val('info.connection') === false, { description: 'connection lost' });
			await clock.tickAsync(200);
			await waitFor(() => instance.val('info.connection') === true, { description: 'reconnected' });
			await delay(100);
			expect(instance.val(`devices.${DEVICE_G2_PRO}.lastThumbnailUrl`)).to.equal(url);
			expect(instance.stateWrites.filter(w => w.id.endsWith('.lastThumbnailUrl')).length).to.equal(writesBefore);
			// the hub never had a thumbnail: no state appears for it
			expect(instance.states.has(`${NS}.devices.${fixtures.IDS.DEVICE_HUB}.lastThumbnailUrl`)).to.equal(false);
		});

		it('clears a URL whose stored path is not a valid thumbnail path', async () => {
			adapter = createAdapterWithFakeCore(MAIN, {
				controllerHost: '127.0.0.1',
				controllerPort: mock.port,
				apiToken: TOKEN,
				verifyTLS: false,
				wsReconnectDelay: 0.05,
				listenPort,
				listenIp: '127.0.0.1',
				enableWebhooks: true,
				enableThumbnailServer: true,
				forwardEvents: [],
			});
			await adapter.setState(`devices.${DEVICE_G2_PRO}.lastThumbnailPath`, { val: '/../../users', ack: true });
			await adapter.setState(`devices.${DEVICE_G2_PRO}.lastThumbnailUrl`, { val: OLD_URL, ack: true });
			await adapter.fireReady();
			expect(adapter.val(`devices.${DEVICE_G2_PRO}.lastThumbnailUrl`)).to.equal('');
		});
	});

	describe('thumbnail paths from events (R-06)', () => {
		it('stores the documented door_thumbnail path of an event', async () => {
			const instance = await startConnected({ enableThumbnailServer: true });
			const event = fixtures.webhookEvents.doorUnlock({
				door: door(DOOR_3855),
				device: hub(),
				readerId: DEVICE_G2_PRO,
			});
			await mock.deliverWebhook(event);
			await waitFor(() => instance.val(`devices.${DEVICE_G2_PRO}.lastThumbnailPath`), { description: 'path' });
			expect(instance.val(`devices.${DEVICE_G2_PRO}.lastThumbnailPath`)).to.equal(
				event.data.location.extras.door_thumbnail,
			);
			expect(events()[0].thumbnailPath).to.equal(event.data.location.extras.door_thumbnail);
		});

		for (const bad of [
			`/preview/reader_${DEVICE_G2_PRO}_/../../../../users?page_size=1000`,
			`/preview/reader_${DEVICE_G2_PRO}_%2e%2e/%2e%2e/users`,
			`/../../users#/reader_${DEVICE_G2_PRO}_x.jpg`,
			`https://192.0.2.1/preview/reader_${DEVICE_G2_PRO}_x.jpg`,
		]) {
			it(`never stores or serves the manipulated thumbnail path ${JSON.stringify(bad)}`, async () => {
				const instance = await startConnected({ enableThumbnailServer: true });
				const event = fixtures.webhookEvents.doorUnlock({
					door: door(DOOR_3855),
					device: hub(),
					readerId: DEVICE_G2_PRO,
				});
				event.data.location.extras.door_thumbnail = bad;
				await mock.deliverWebhook(event);
				await waitFor(() => events().length === 1, { description: 'event logged' });
				await waitFor(() => instance.log.of('warn').some(m => m.includes('thumbnail path')), {
					description: 'warning',
				});

				expect(instance.stateWrites.filter(w => w.id.includes('lastThumbnail'))).to.deep.equal([]);
				expect(events()[0].thumbnailPath).to.equal(undefined);

				const before = mock.requests.length;
				const response = await httpRequest({
					url: `http://127.0.0.1:${listenPort}/unifi-access/0/thumbnail/${DEVICE_G2_PRO}.jpg`,
				});
				expect(response.status).to.equal(404);
				expect(mock.requests.slice(before)).to.deep.equal([]);
			});
		}

		it('a manipulated lastThumbnailPath state is not proxied to the controller', async () => {
			const instance = await startConnected({ enableThumbnailServer: true });
			await instance.setState(`devices.${DEVICE_G2_PRO}.lastThumbnailPath`, {
				val: '/preview/../../users',
				ack: false,
			});
			const before = mock.requests.length;
			const response = await httpRequest({
				url: `http://127.0.0.1:${listenPort}/unifi-access/0/thumbnail/${DEVICE_G2_PRO}.jpg`,
			});
			expect(response.status).to.equal(404);
			expect(response.text).to.not.contain(fixtures.DEFAULT_USERS[0].id);
			expect(mock.requests.slice(before)).to.deep.equal([]);
		});
	});

	describe('webhook signing secret and API token stay out of states and logs (R-05)', () => {
		it('writes the secret to no state and logs neither secret nor token at any level', async () => {
			const instance = await startConnected();
			const endpoint = mock.webhookEndpoints[0];
			await instance.request('reregisterWebhook');
			const fresh = mock.webhookEndpoints[0];
			expect(fresh.secret).to.not.equal(endpoint.secret);

			for (const secret of [endpoint.secret, fresh.secret]) {
				expect(
					instance.stateWrites.filter(w => typeof w.val === 'string' && w.val.includes(secret)),
					'state writes containing the secret',
				).to.deep.equal([]);
				expect(
					instance.log.messages.filter(m => m.message.includes(secret)),
					'log lines containing the secret',
				).to.deep.equal([]);
			}
			expect(instance.log.messages.filter(m => m.message.includes(TOKEN))).to.deep.equal([]);
			expect(instance.log.of('debug').some(m => m.includes('/webhooks/endpoints'))).to.equal(true);
			expect(instance.obj('info.webhookSecret')).to.equal(undefined);
			expect(instance.states.has(`${NS}.info.webhookSecret`)).to.equal(false);
		});

		it('removes the info.webhookSecret object and state left behind by earlier versions', async () => {
			adapter = createAdapterWithFakeCore(MAIN, {
				controllerHost: '127.0.0.1',
				controllerPort: mock.port,
				apiToken: TOKEN,
				listenPort,
				listenIp: '127.0.0.1',
				enableWebhooks: false,
			});
			await adapter.setObjectNotExistsAsync('info.webhookSecret', {
				type: 'state',
				common: { name: 'Webhook signing secret', type: 'string', role: 'value', read: true, write: false },
				native: {},
			});
			await adapter.setState('info.webhookSecret', { val: 'old-plaintext-secret', ack: true });

			await adapter.fireReady();

			expect(adapter.obj('info.webhookSecret')).to.equal(undefined);
			expect(adapter.states.has(`${NS}.info.webhookSecret`)).to.equal(false);
		});

		it('removes the leftover secret state even when host or token are not configured', async () => {
			adapter = createAdapterWithFakeCore(MAIN, { controllerHost: '', apiToken: '' });
			await adapter.setObjectNotExistsAsync('info.webhookSecret', { type: 'state', common: {}, native: {} });
			await adapter.setState('info.webhookSecret', { val: 'old-plaintext-secret', ack: true });
			await adapter.fireReady();
			expect(adapter.obj('info.webhookSecret')).to.equal(undefined);
			expect(adapter.states.has(`${NS}.info.webhookSecret`)).to.equal(false);
		});
	});

	describe('UniFi Protect integration (stub console)', () => {
		let protect: ProtectStub;

		beforeEach(async () => {
			protect = new ProtectStub();
			await protect.start();
			listenPort = await portOtherThan(listenPort, protect.port);
		});

		afterEach(async () => {
			await adapter?.fireUnload();
			adapter = undefined;
			await protect.stop();
		});

		const protectConfig = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
			enableWebhooks: false,
			enableProtect: true,
			protectUsername: 'viewer',
			protectPassword: 'protect-secret',
			protectVerifyTLS: false,
			protectPort: protect.port,
			...overrides,
		});

		describe('TLS verification (protectVerifyTLS, R-16)', () => {
			it('verification off: logs in to the console with its self-signed certificate', async () => {
				const instance = await startConnected(protectConfig());
				expect(protect.logins).to.deep.equal([{ username: 'viewer', password: 'protect-secret', status: 200 }]);
				expect(instance.val('info.protectConnected')).to.equal(true);
				expect(instance.log.of('warn')).to.deep.equal([]);
			});

			it('verification on without CA: one clear warning with instructions, no login, no retry', async () => {
				const instance = await startConnected(protectConfig({ protectVerifyTLS: true }));
				const warnings = instance.log.of('warn');
				expect(warnings).to.have.length(1);
				expect(warnings[0]).to.contain(
					'TLS certificate of the console was rejected (DEPTH_ZERO_SELF_SIGNED_CERT)',
				);
				expect(warnings[0]).to.contain('disable "Verify TLS certificate" on the Protect tab');
				expect(warnings[0]).to.contain('CA certificate');
				expect(protect.requests, 'nothing was sent over the unverified connection').to.deep.equal([]);
				expect(instance.val('info.protectConnected')).to.equal(false);

				await clock.tickAsync(15 * 60_000);
				await delay(30);
				expect(protect.requests, 'no retry loop').to.deep.equal([]);
				expect(instance.log.of('warn')).to.have.length(1);
			});

			it('verification on with the console certificate as CA: logs in', async () => {
				// one CA setting for both: trust the Access mock and the Protect stub
				const instance = await startConnected(
					protectConfig({ protectVerifyTLS: true, caCert: `${protect.cert}\n${mock.cert}` }),
				);
				expect(protect.logins.map(l => l.status)).to.deep.equal([200]);
				expect(instance.val('info.protectConnected')).to.equal(true);
				expect(instance.log.of('warn')).to.deep.equal([]);
			});

			// K-16: the chain is trusted; only the address used is not in the certificate
			it('verification on, console certificate for another host name: the warning points to the host name', async () => {
				const other = new ProtectStub({ altNames: ['console.example'] });
				await other.start();
				try {
					const instance = await startConnected(
						protectConfig({ protectVerifyTLS: true, caCert: other.cert, protectPort: other.port }),
					);
					const warnings = instance.log.of('warn');
					expect(warnings).to.have.length(1);
					expect(warnings[0]).to.contain('rejected (ERR_TLS_CERT_ALTNAME_INVALID)');
					expect(warnings[0]).to.contain('not issued for the configured host name');
					expect(warnings[0]).to.not.contain('store the CA certificate');
					expect(other.logins).to.deep.equal([]);
				} finally {
					await adapter?.fireUnload();
					adapter = undefined;
					await other.stop();
				}
			});

			it('the Access setting verifyTLS no longer decides about Protect', async () => {
				// Access verified against its CA, Protect explicitly unverified
				const instance = await startConnected(
					protectConfig({ verifyTLS: true, caCert: mock.cert, protectVerifyTLS: false }),
				);
				expect(instance.val('info.protectConnected')).to.equal(true);
			});
		});

		describe('login failures', () => {
			it('rejected credentials: one warning, integration off, no retry', async () => {
				const instance = await startConnected(protectConfig({ protectPassword: 'wrong' }));
				expect(instance.log.of('warn')).to.deep.equal([
					'Protect login failed: user name or password rejected. The Protect integration stays off until the instance is restarted.',
				]);
				expect(instance.val('info.protectConnected')).to.equal(false);
				const attempts = protect.logins.length;
				await clock.tickAsync(15 * 60_000);
				await delay(30);
				expect(protect.logins).to.have.length(attempts);
			});

			it('rate limit (429): retries after 30 s through an adapter timer and connects', async () => {
				protect.failLogins(429);
				const instance = await startConnected(protectConfig());
				expect(instance.val('info.protectConnected')).to.equal(false);
				expect(instance.log.of('warn')).to.deep.equal([
					'Protect login failed (rate-limited): Protect login failed: HTTP 429 — retrying in 30 s.',
				]);
				expect(instance.timers.size, 'retry runs on an adapter timer').to.be.greaterThan(0);

				await clock.tickAsync(29_999);
				await delay(30);
				expect(protect.logins).to.have.length(1);
				await clock.tickAsync(1);
				await waitFor(() => instance.val('info.protectConnected') === true, {
					description: 'protect connected',
				});
				expect(protect.logins.map(l => l.status)).to.deep.equal([429, 200]);
			});

			it('keeps retrying with growing distance while the console stays unavailable (30 s, 60 s, 120 s)', async () => {
				protect.failLogins(503, 3);
				const instance = await startConnected(protectConfig());
				for (const [wait, attempts] of [
					[30_000, 2],
					[60_000, 3],
					[120_000, 4],
				]) {
					await clock.tickAsync(wait - 1);
					await delay(30);
					expect(protect.logins, `before ${wait} ms`).to.have.length(attempts - 1);
					await clock.tickAsync(1);
					await waitFor(() => protect.logins.length === attempts, { description: `attempt ${attempts}` });
				}
				await waitFor(() => instance.val('info.protectConnected') === true, {
					description: 'protect connected',
				});
				expect(instance.log.of('warn'), 'only the first failure is a warning').to.have.length(1);
			});

			it('unload cancels a pending login retry', async () => {
				protect.failLogins(429, 100);
				const instance = await startConnected(protectConfig());
				await instance.fireUnload();
				expect(clock.countTimers()).to.equal(0);
				await clock.tickAsync(10 * 60_000);
				await delay(30);
				expect(protect.logins).to.have.length(1);
			});
		});

		describe('migration of a plain-text password to the encrypted attribute (C-16)', () => {
			/**
			 * stand-in for adapter.encrypt on a system with AES secret
			 *
			 * @param plain Text to encrypt
			 */
			const aes = (plain: string): string => `$/aes-192-cbc:00:${Buffer.from(plain).toString('hex')}`;

			/**
			 * Start an instance whose instance object holds `stored` as protectPassword while js-controller
			 * handed `decrypted` to the adapter (it decrypts every encryptedNative attribute at start).
			 *
			 * @param stored Value in the instance object
			 * @param decrypted Value in adapter.config
			 * @param options Encrypt function of the system and whether the attribute is listed as encrypted
			 * @param options.encrypt Stand-in for adapter.encrypt
			 * @param options.listed Whether the instance object lists protectPassword in encryptedNative
			 */
			async function startWithStoredPassword(
				stored: unknown,
				decrypted: unknown,
				options: { encrypt?: (plain: string) => string; listed?: boolean } = {},
			): Promise<FakeAdapter> {
				adapter = createAdapterWithFakeCore(MAIN, {
					controllerHost: '127.0.0.1',
					controllerPort: mock.port,
					apiToken: TOKEN,
					listenPort,
					listenIp: '127.0.0.1',
					...protectConfig({ protectPassword: decrypted }),
				});
				adapter.encrypt = options.encrypt ?? aes;
				adapter.objects.set(INSTANCE_OBJECT, {
					_id: INSTANCE_OBJECT,
					native: { protectPassword: stored, controllerHost: '127.0.0.1' },
					encryptedNative: options.listed === false ? ['apiToken'] : ['apiToken', 'protectPassword'],
				});
				await adapter.fireReady();
				return adapter;
			}
			const storedPassword = (): unknown => adapter!.objects.get(INSTANCE_OBJECT).native.protectPassword;

			it('empty password: nothing is written', async () => {
				const instance = await startWithStoredPassword('', '');
				expect(storedPassword()).to.equal('');
				expect(protect.logins.map(l => l.password)).to.deep.equal(['']);
				expect(instance.log.of('info').filter(m => m.includes('encrypting'))).to.deep.equal([]);
			});

			it('already encrypted: logs in with the decrypted password, nothing is written', async () => {
				const instance = await startWithStoredPassword(aes('protect-secret'), 'protect-secret');
				expect(storedPassword()).to.equal(aes('protect-secret'));
				expect(protect.logins).to.deep.equal([{ username: 'viewer', password: 'protect-secret', status: 200 }]);
				expect(instance.val('info.protectConnected')).to.equal(true);
			});

			it('plain text: logs in with the stored password and stores it encrypted — exactly once', async () => {
				// js-controller "decrypted" the plain text into garbage
				const instance = await startWithStoredPassword('protect-secret', '\u0001\u0002garbage');
				expect(protect.logins, 'login uses the stored plain text, not the garbage').to.deep.equal([
					{ username: 'viewer', password: 'protect-secret', status: 200 },
				]);
				expect(instance.val('info.protectConnected')).to.equal(true);
				expect(storedPassword()).to.equal(aes('protect-secret'));
				expect(
					adapter!.objects.get(INSTANCE_OBJECT).native.controllerHost,
					'other settings untouched',
				).to.equal('127.0.0.1');
				expect(instance.log.messages.filter(m => m.message.includes('protect-secret'))).to.deep.equal([]);

				// the restart js-controller performs after the write: now the value is encrypted
				await instance.fireUnload();
				const migrated = storedPassword();
				const second = await startWithStoredPassword(migrated, 'protect-secret');
				expect(storedPassword(), 'no second write, no restart loop').to.equal(migrated);
				expect(second.log.of('info').filter(m => m.includes('encrypting'))).to.deep.equal([]);
				expect(second.val('info.protectConnected')).to.equal(true);
			});

			it('old non-AES system secret, plain text: migrated once with the legacy encryption', async () => {
				const xor = (plain: string): string =>
					[...plain]
						.map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ 'Zgfr56gFe87jJOM'.charCodeAt(i % 15)))
						.join('');
				const instance = await startWithStoredPassword('protect-secret', xor('protect-secret'), {
					encrypt: xor,
				});
				expect(protect.logins.map(l => l.password)).to.deep.equal(['protect-secret']);
				expect(storedPassword()).to.equal(xor('protect-secret'));

				await instance.fireUnload();
				const second = await startWithStoredPassword(xor('protect-secret'), 'protect-secret', { encrypt: xor });
				expect(storedPassword(), 'no second write').to.equal(xor('protect-secret'));
				expect(second.val('info.protectConnected')).to.equal(true);
			});

			it('old non-AES system secret, undecidable value: nothing is written, a rejected login hints at re-entering the password', async () => {
				// stored value and its XOR form are both printable → cannot be told apart
				const xor = (plain: string): string =>
					[...plain].map(c => String.fromCharCode(c.charCodeAt(0) ^ '5'.charCodeAt(0))).join('');
				const instance = await startWithStoredPassword('abcabc', xor('abcabc'), { encrypt: xor });
				expect(storedPassword()).to.equal('abcabc');
				expect(protect.logins.map(l => l.status)).to.deep.equal([401]);
				expect(instance.log.of('warn')).to.have.length(1);
				expect(instance.log.of('warn')[0]).to.contain('re-enter the Protect password and save');
			});

			it('old non-AES system secret, non-ASCII plain text (not detectable): a rejected login hints at re-entering the password', async () => {
				const xor = (plain: string): string =>
					[...plain]
						.map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ 'Zgfr56gFe87jJOM'.charCodeAt(i % 15)))
						.join('');
				const instance = await startWithStoredPassword('pässwörd', xor('pässwörd'), { encrypt: xor });
				expect(storedPassword(), 'nothing is written').to.equal('pässwörd');
				expect(protect.logins.map(l => l.status)).to.deep.equal([401]);
				expect(instance.log.of('warn')).to.have.length(1);
				expect(instance.log.of('warn')[0]).to.contain('re-enter the Protect password and save');
			});

			it('attribute not listed as encrypted in the instance object: stored value is used, nothing is written', async () => {
				await startWithStoredPassword('protect-secret', 'protect-secret', { listed: false });
				expect(storedPassword()).to.equal('protect-secret');
				expect(protect.logins.map(l => l.status)).to.deep.equal([200]);
			});
		});
	});

	describe('TLS diagnostics for the Access controller (verifyTLS)', () => {
		it('names the rejected certificate and what to do about it', async () => {
			const instance = await start({ verifyTLS: true, enableWebhooks: false });
			expect(instance.val('info.connection')).to.equal(false);
			const warnings = instance.log.of('warn');
			expect(warnings).to.have.length(1);
			expect(warnings[0]).to.contain(
				'TLS certificate of the controller was rejected (DEPTH_ZERO_SELF_SIGNED_CERT)',
			);
			expect(warnings[0]).to.contain('disable "Verify TLS certificate" in the connection settings');
			expect(mock.requests, 'nothing was sent over the unverified connection').to.deep.equal([]);
		});

		it('connects with verifyTLS when the controller certificate is stored as CA', async () => {
			const instance = await startConnected({ verifyTLS: true, caCert: mock.cert, enableWebhooks: false });
			expect(instance.val('info.connection')).to.equal(true);
			expect(instance.log.of('warn')).to.deep.equal([]);
		});

		// U-02: a single-line admin field may have swallowed the line breaks — repaired, not reported
		it('connects with verifyTLS when the stored CA certificate lost its line breaks', async () => {
			const instance = await startConnected({
				verifyTLS: true,
				caCert: mock.cert.replace(/\n/g, ' '),
				enableWebhooks: false,
			});
			expect(instance.val('info.connection')).to.equal(true);
			expect(instance.log.of('warn')).to.deep.equal([]);
		});

		// U-02: Node ignores an unreadable CA silently — the adapter says so instead
		it('warns about a CA certificate that cannot be used', async () => {
			const instance = await start({ verifyTLS: true, caCert: 'not a certificate', enableWebhooks: false });
			const warnings = instance.log.of('warn');
			expect(warnings[0]).to.equal(
				'The CA certificate in the connection settings is not usable: no "-----BEGIN CERTIFICATE-----" … "-----END CERTIFICATE-----" block found. ' +
					'It is ignored. Paste the complete PEM text including the "-----BEGIN CERTIFICATE-----" and "-----END CERTIFICATE-----" lines.',
			);
		});

		it('mentions an unusable CA certificate only at debug level while no TLS verification uses it', async () => {
			const instance = await startConnected({
				verifyTLS: false,
				caCert: 'not a certificate',
				enableWebhooks: false,
			});
			expect(instance.log.of('warn')).to.deep.equal([]);
			expect(
				instance.log
					.of('debug')
					.some(m => m.startsWith('The CA certificate in the connection settings is not usable')),
			).to.equal(true);
		});

		// K-16: with a trusted chain, a host name mismatch is not cured by storing the CA certificate
		it('a certificate for another host name: the warning points to the host name, not to the CA certificate', async () => {
			const other = new MockUnifiController({ token: TOKEN, altNames: ['other.example'] });
			await other.start();
			try {
				const instance = await start({
					controllerPort: other.port,
					verifyTLS: true,
					caCert: other.cert,
					enableWebhooks: false,
				});
				const warnings = instance.log.of('warn');
				expect(warnings).to.have.length(1);
				expect(warnings[0]).to.contain('rejected (ERR_TLS_CERT_ALTNAME_INVALID)');
				expect(warnings[0]).to.contain('not issued for the configured host name');
				expect(warnings[0]).to.not.contain('store the CA certificate');
			} finally {
				await other.stop();
			}
		});
	});

	describe('connection state and resync (R-02)', () => {
		// K-12: a connection that keeps flapping must not trigger a full reload every few seconds
		it('reloads at most once per minute after reconnects; a pending reload covers further reconnects', async () => {
			const instance = await startConnected({ enableWebhooks: false });
			const loads = (): number => mock.findRequests({ path: '/devices' }).length;
			const reconnect = async (): Promise<void> => {
				mock.dropWsConnections();
				await waitFor(() => instance.val('info.connection') === false, { description: 'connection lost' });
				await clock.tickAsync(200);
				await waitFor(() => instance.val('info.connection') === true, { description: 'reconnected' });
			};
			await reconnect();
			await waitFor(() => loads() === 2, { description: 'first reload right away' });
			await reconnect();
			await reconnect();
			await delay(30);
			expect(loads(), 'no further reload within the minute').to.equal(2);
			await clock.tickAsync(60_000);
			await waitFor(() => loads() === 3, { description: 'one delayed reload' });
			await delay(30);
			expect(loads()).to.equal(3);
		});

		it('info.connection turns false when the WebSocket is lost and true again after the reconnect', async () => {
			const instance = await startConnected({ enableWebhooks: false });
			expect(instance.val('info.connection')).to.equal(true);

			mock.wsAccepting = false;
			mock.dropWsConnections();
			await waitFor(() => instance.val('info.connection') === false, { description: 'connection lost' });
			expect(await instance.request('getConnectionStatus')).to.include({
				connected: false,
				lastError: 'network',
			});

			// reconnect attempts keep failing while the controller refuses the WebSocket
			await clock.tickAsync(200);
			await delay(30);
			expect(instance.val('info.connection')).to.equal(false);

			mock.wsAccepting = true;
			await clock.tickAsync(200);
			await mock.waitForWsClients(1);
			await waitFor(() => instance.val('info.connection') === true, { description: 'connection back' });
			expect(await instance.request('getConnectionStatus')).to.include({ connected: true, lastError: null });
		});

		it('a reload after a reconnect keeps what was learned from events and does not rewrite unchanged door states', async () => {
			const instance = await startConnected();
			await mock.deliverWebhook(
				fixtures.webhookEvents.doorUnlock({
					door: door(DOOR_A2),
					device: hub(),
					deviceOverrides: { firmware: 'v7.7.7' },
				}),
			);
			await waitFor(() => instance.val(`devices.${DEVICE_HUB}.firmware`) === 'v7.7.7', {
				description: 'firmware',
			});
			const lastSeen = instance.val(`devices.${DEVICE_HUB}.lastSeenAt`);
			const writes = instance.stateWrites.length;
			const reloads = mock.findRequests({ path: '/devices' }).length;

			mock.dropWsConnections();
			await waitFor(() => instance.val('info.connection') === false, { description: 'connection lost' });
			await clock.tickAsync(200);
			await waitFor(() => mock.findRequests({ path: '/devices' }).length === reloads + 1, {
				description: 'reload',
			});
			await waitFor(() => instance.val('info.connection') === true, { description: 'reconnected' });
			await delay(50);

			const hubEntry = (await instance.request('listDevices')).devices.find(
				(d: { id: string }) => d.id === DEVICE_HUB,
			);
			expect(hubEntry).to.include({ firmware: 'v7.7.7', lastSeenAt: lastSeen });
			expect(instance.val(`devices.${DEVICE_HUB}.firmware`)).to.equal('v7.7.7');
			const doorWrites = instance.stateWrites
				.slice(writes)
				.filter(w => /\.doors\.[^.]+\.(locked|position)$/.test(w.id) && !w.id.includes(DOOR_A2));
			expect(doorWrites, 'unchanged doors are not written again').to.deep.equal([]);
		});

		it('reloads devices and doors after a reconnect so changes missed during the outage show up', async () => {
			const instance = await startConnected({ enableWebhooks: false });
			expect(instance.val(`doors.${DOOR_3855}.locked`)).to.equal(true);
			expect(instance.val(`doors.${DOOR_3855}.position`)).to.equal('close');
			const devicesBefore = mock.findRequests({ path: '/devices' }).length;
			const doorsBefore = mock.findRequests({ path: '/doors' }).length;

			mock.wsAccepting = false;
			mock.dropWsConnections();
			await waitFor(() => instance.val('info.connection') === false, { description: 'connection lost' });
			// meanwhile the door is unlocked and opened without the adapter hearing about it
			const changed = mock.findDoor(DOOR_3855)!;
			changed.door_lock_relay_status = 'unlock';
			changed.door_position_status = 'open';
			mock.wsAccepting = true;
			await clock.tickAsync(200);
			await mock.waitForWsClients(1);

			await waitFor(() => instance.val(`doors.${DOOR_3855}.locked`) === false, { description: 'resync locked' });
			expect(instance.val(`doors.${DOOR_3855}.position`)).to.equal('open');
			expect(mock.findRequests({ path: '/devices' })).to.have.length(devicesBefore + 1);
			expect(mock.findRequests({ path: '/doors' })).to.have.length(doorsBefore + 1);
			expect(mock.wsClients.size, 'the resync does not open a second WebSocket').to.equal(1);
		});

		it('logs one warning per outage, not one per reconnect attempt', async () => {
			const instance = await startConnected({ enableWebhooks: false });
			mock.wsAccepting = false;
			mock.dropWsConnections();
			await waitFor(() => instance.val('info.connection') === false, { description: 'connection lost' });
			const handshakes = mock.wsHandshakes.length;
			for (let i = 0; i < 6; i++) {
				await clock.tickAsync(100);
				await delay(20);
			}
			expect(mock.wsHandshakes.length, 'several reconnect attempts').to.be.greaterThan(handshakes + 2);
			expect(instance.log.of('warn')).to.have.length(1);
			expect(instance.log.of('warn')[0]).to.match(/^WebSocket error: /);
			expect(instance.log.of('info').filter(m => m.includes('reconnect in'))).to.have.length(1);
		});

		it('runs the WebSocket heartbeat and reconnect on adapter timers and stops them on unload', async () => {
			const instance = await startConnected({ enableWebhooks: false });
			expect(instance.intervals.size, 'heartbeat interval').to.equal(1);
			mock.wsAccepting = false;
			mock.dropWsConnections();
			await waitFor(() => instance.val('info.connection') === false, { description: 'connection lost' });
			await waitFor(() => instance.timers.size === 1, { description: 'reconnect timer' });
			expect(instance.intervals.size).to.equal(0);
			await instance.fireUnload();
			expect(clock.countTimers()).to.equal(0);
		});

		it('drops a dead WebSocket whose pings stay unanswered and reconnects (R-03)', async () => {
			const deaf = new MockUnifiController({ token: TOKEN, autoPong: false });
			await deaf.start();
			try {
				adapter = createAdapterWithFakeCore(MAIN, {
					controllerHost: '127.0.0.1',
					controllerPort: deaf.port,
					apiToken: TOKEN,
					wsReconnectDelay: 0.05,
					listenPort,
					listenIp: '127.0.0.1',
				});
				await adapter.fireReady();
				await deaf.waitForWsClients(1);
				await waitFor(() => adapter!.intervals.size === 1, { description: 'WebSocket open in the adapter' });
				await clock.tickAsync(30_000);
				await waitFor(() => deaf.wsPingCount === 1, { description: 'ping' });
				expect(adapter.val('info.connection')).to.equal(true);
				await clock.tickAsync(30_000);
				await waitFor(() => adapter!.val('info.connection') === false, {
					description: 'dead connection detected',
				});
				await clock.tickAsync(100);
				await deaf.waitForWsConnectionCount(2);
				await waitFor(() => adapter!.val('info.connection') === true, { description: 'reconnected' });
			} finally {
				await adapter?.fireUnload();
				adapter = undefined;
				await deaf.stop();
			}
		});
	});

	describe('robust start (R-08)', () => {
		it('a failure during start is logged as error instead of escaping as unhandled rejection', async () => {
			adapter = createAdapterWithFakeCore(MAIN, {
				controllerHost: '127.0.0.1',
				controllerPort: mock.port,
				apiToken: TOKEN,
				listenPort,
				listenIp: '127.0.0.1',
			});
			adapter.setObjectNotExistsAsync = async () => {
				throw new Error('objects db not reachable');
			};
			await adapter.fireReady();
			await waitFor(() => adapter!.log.of('error').length === 1, { description: 'error log' });
			expect(adapter.log.of('error')).to.deep.equal(['Adapter start failed: objects db not reachable']);
		});

		it('skips records without a usable id in the device, door and user lists instead of failing the whole load', async () => {
			mock.doors.push(
				{ id: 42 as unknown as string, name: 'numeric id' },
				{ name: 'no id' } as never,
				null as never,
			);
			(mock.devices as unknown[][])[0].push({ name: 'no id' }, { id: '' }, null, 'text');
			mock.users.push({ first_name: 'No', last_name: 'Id' } as never);
			const instance = await startConnected({ enableWebhooks: false });
			expect(instance.val('info.connection')).to.equal(true);
			expect(instance.obj(`doors.${DOOR_3855}`)?.type).to.equal('channel');
			expect((await instance.request('listDevices')).devices).to.have.length(
				fixtures.DEFAULT_DEVICES.flat().length,
			);
			expect(instance.log.of('warn')).to.deep.equal([]);
			expect([...instance.objects.keys()].filter(id => /undefined|null|\[object/.test(id))).to.deep.equal([]);
		});

		for (const [label, value] of [
			['0', 0],
			['a negative number', -5],
			['not a number', 'fast'],
			['NaN', Number.NaN],
		] as [string, unknown][]) {
			it(`wsReconnectDelay = ${label} falls back to 5 s instead of reconnecting in a tight loop`, async () => {
				const instance = await startConnected({ enableWebhooks: false, wsReconnectDelay: value });
				mock.wsAccepting = false;
				mock.dropWsConnections();
				await waitFor(() => instance.val('info.connection') === false, { description: 'connection lost' });
				const handshakes = mock.wsHandshakes.length;
				// back-off 2 s, 4 s, 5 s (cap) → after 1.9 s nothing happened yet
				await clock.tickAsync(1900);
				await delay(30);
				expect(mock.wsHandshakes).to.have.length(handshakes);
				await clock.tickAsync(100);
				await waitFor(() => mock.wsHandshakes.length === handshakes + 1, {
					description: 'first retry after 2 s',
				});
			});
		}
	});

	describe('malformed events never terminate the adapter (R-08)', () => {
		// test/mocha.setup.js turns every unhandled rejection into a test failure
		it('ignores WebSocket frames that are no event envelopes or carry fields of the wrong type', async () => {
			const instance = await startConnected({ enableWebhooks: false });
			for (const frame of [
				'null',
				'[]',
				'"text"',
				'17',
				'{"event":null}',
				'{"event":"access.data.device.remote_unlock","data":null}',
				'{"event":"access.data.device.remote_unlock","event_object_id":{"a":1},"data":{"location_type":"door","unique_id":"x","extras":7}}',
				'{"event":"access.remote_view","event_object_id":5,"data":{"device_id":{"x":1},"door_name":[1,2]}}',
				'{"event":"access.remote_view.change","data":{"reason_code":{"nested":true}}}',
				'{"event":"access.door.unlock","data":{"door_id":5,"device":{"id":{}},"location":"nowhere","actor":3}}',
				'{"event":"access.device.dps_status","data":{"location":{"id":["a"]},"object":"open"}}',
			]) {
				mock.sendRaw(frame);
			}
			// a regular event afterwards proves the frames above have been processed
			const ring = mock.emitRemoteView();
			await waitFor(() => instance.val('doorbell.activeCallId') === ring.event_object_id, {
				description: 'regular event after the malformed frames',
			});
			expect(mock.wsClients.size).to.equal(1);
			expect(instance.val('info.connection')).to.equal(true);
			expect(instance.log.of('error')).to.deep.equal([]);
			// no state was written with a non-string id in its path
			expect(instance.stateWrites.filter(w => /\[object|undefined|NaN/.test(w.id))).to.deep.equal([]);
		});

		it('answers 200 for signed webhooks with fields of the wrong type and keeps running', async () => {
			const instance = await startConnected();
			const endpoint = mock.webhookEndpoints[0];
			for (const body of [
				'null',
				'[]',
				'{"event":7}',
				'{"event":"access.door.unlock","data":"text"}',
				'{"event":"access.door.unlock","data":{"location":{"id":5,"extras":{"door_thumbnail":{"a":1}}},"device":{"id":9,"firmware":{},"online":"yes"}}}',
				`{"event":"access.device.dps_status","data":{"location":{"id":"${DOOR_3855}"},"object":{"status":{"x":1}}}}`,
				'{"event":"access.doorbell.completed","data":{"object":{"reason_code":"abc","request_id":4}}}',
			]) {
				const response = await sendWebhook({ url: endpoint.endpoint, secret: endpoint.secret, body });
				expect(response.status, body).to.equal(200);
			}
			const [result] = await mock.deliverWebhook(
				fixtures.webhookEvents.dpsStatus({ door: door(DOOR_3855), device: hub(), status: 'open' }),
			);
			expect(result.status).to.equal(200);
			await waitFor(() => instance.val(`doors.${DOOR_3855}.position`) === 'open', {
				description: 'regular event',
			});
			expect(instance.log.of('error')).to.deep.equal([]);
		});
	});

	describe('unlock event de-duplication (WebSocket remote_unlock vs. webhook door.unlock)', () => {
		it('logs access.data.device.remote_unlock 4 s later when no door.unlock webhook follows', async () => {
			const instance = await startConnected();
			mock.emitRemoteUnlock(DOOR_3855);
			await waitFor(() => instance.val(`doors.${DOOR_3855}.locked`) === false, { description: 'locked=false' });
			expect(events()).to.deep.equal([]);

			await clock.tickAsync(3999);
			expect(events()).to.deep.equal([]);
			await clock.tickAsync(1);
			await waitFor(() => events().length === 1, { description: 'logged event' });
			expect(events()[0]).to.include({
				type: 'access.data.device.remote_unlock',
				source: 'ws',
				doorId: DOOR_3855,
				doorName: 'Door 3855',
				deviceId: DEVICE_HUB,
			});
		});

		it('logs only the richer door.unlock event when the webhook arrives within the 4 s window', async () => {
			const instance = await startConnected();
			mock.emitRemoteUnlock(DOOR_3855);
			await waitFor(() => instance.val(`doors.${DOOR_3855}.locked`) === false, { description: 'locked=false' });
			await clock.tickAsync(1000);

			const [result] = await mock.deliverWebhook(
				fixtures.webhookEvents.doorUnlock({ door: door(DOOR_3855), device: hub(), readerId: DEVICE_G2_PRO }),
			);
			expect(result.status).to.equal(200);
			expect(events().map(e => e.type)).to.deep.equal(['access.door.unlock']);

			await clock.tickAsync(10_000);
			await delay(30);
			expect(events().map(e => e.type)).to.deep.equal(['access.door.unlock']);
			expect(events()[0]).to.include({ source: 'webhook', doorId: DOOR_3855, userName: 'Hon***' });
		});

		it('a door.unlock webhook for another door does not swallow the pending remote_unlock', async () => {
			const instance = await startConnected();
			mock.emitRemoteUnlock(DOOR_3855);
			await waitFor(() => instance.val(`doors.${DOOR_3855}.locked`) === false, { description: 'locked=false' });
			await mock.deliverWebhook(fixtures.webhookEvents.doorUnlock({ door: door(DOOR_A2), device: hub() }));

			await clock.tickAsync(4000);
			await waitFor(() => events().length === 2, { description: 'both events' });
			expect(events().map(e => `${e.type} ${e.doorId}`)).to.deep.equal([
				`access.data.device.remote_unlock ${DOOR_3855}`,
				`access.door.unlock ${DOOR_A2}`,
			]);
		});

		it('a repeated remote_unlock for the same door restarts the window and is logged once', async () => {
			const instance = await startConnected();
			mock.emitRemoteUnlock(DOOR_3855);
			await waitFor(() => instance.val(`doors.${DOOR_3855}.locked`) === false, { description: 'locked=false' });
			await clock.tickAsync(3000);
			const second = mock.emitRemoteUnlock(DOOR_3855, { data: { name: 'second' } });
			await waitFor(
				() =>
					instance.stateWrites.filter(w => w.id.endsWith(`doors.${DOOR_3855}.locked`) && w.val === false)
						.length === 2,
				{ description: 'second event processed' },
			);

			await clock.tickAsync(3999);
			expect(events()).to.deep.equal([]);
			await clock.tickAsync(1);
			await waitFor(() => events().length === 1, { description: 'logged event' });
			expect(events()[0].doorName).to.equal(second.data.name);
		});
	});

	describe('unlock event de-duplication does not depend on the order of arrival (RK U-1)', () => {
		it('door.unlock (webhook) first, remote_unlock (WebSocket) right after: logged once', async () => {
			const instance = await startConnected();
			await mock.deliverWebhook(
				fixtures.webhookEvents.doorUnlock({ door: door(DOOR_3855), device: hub(), readerId: DEVICE_G2_PRO }),
			);
			await waitFor(() => events().length === 1, { description: 'door.unlock logged' });
			const writes = instance.stateWrites.length;
			mock.emitRemoteUnlock(DOOR_3855);
			await waitFor(
				() =>
					instance.stateWrites
						.slice(writes)
						.some(w => w.id.endsWith(`doors.${DOOR_3855}.locked`) && w.val === false),
				{ description: 'remote_unlock processed' },
			);
			await clock.tickAsync(10_000);
			await delay(30);
			expect(events().map(e => e.type)).to.deep.equal(['access.door.unlock']);
			expect(instance.log.of('debug')).to.include(
				`[event] remote_unlock for doorId=${DOOR_3855}: already logged as access.door.unlock`,
			);
		});

		it('a remote_unlock long after a door.unlock is a new action and logged', async () => {
			const instance = await startConnected();
			await mock.deliverWebhook(fixtures.webhookEvents.doorUnlock({ door: door(DOOR_3855), device: hub() }));
			await waitFor(() => events().length === 1, { description: 'door.unlock logged' });
			// the window is measured in wall-clock time
			const realNow = Date.now;
			Date.now = () => realNow() + 5000;
			try {
				mock.emitRemoteUnlock(DOOR_3855);
				await waitFor(() => instance.stateWrites.some(w => w.id.endsWith(`doors.${DOOR_3855}.locked`)), {
					description: 'remote_unlock processed',
				});
				await delay(30);
				await clock.tickAsync(4000);
				await waitFor(() => events().length === 2, { description: 'both logged' });
			} finally {
				Date.now = realNow;
			}
		});

		it('a refused door.unlock of the same door does not swallow the pending remote_unlock', async () => {
			const instance = await startConnected();
			mock.emitRemoteUnlock(DOOR_3855);
			await waitFor(() => instance.val(`doors.${DOOR_3855}.locked`) === false, { description: 'locked=false' });
			await mock.deliverWebhook(
				fixtures.webhookEvents.doorUnlock({
					door: door(DOOR_3855),
					device: hub(),
					object: { result: 'BLOCKED', authentication_type: 'NFC' },
				}),
			);
			await clock.tickAsync(4000);
			await waitFor(() => events().length === 2, { description: 'both events' });
			expect(events().map(e => `${e.type} ${String(e.granted)}`)).to.deep.equal([
				'access.data.device.remote_unlock undefined',
				'access.door.unlock false',
			]);
		});
	});

	describe('system log lookup after an unlock (R-11, D-07)', () => {
		it('does not query the system logs at all while the Protect integration is off', async () => {
			const instance = await startConnected();
			await mock.deliverWebhook(fixtures.webhookEvents.doorUnlock({ door: door(DOOR_3855), device: hub() }));
			await mock.deliverWebhook(
				fixtures.webhookEvents.generic('access.temporary_unlock.start', {
					door: door(DOOR_3855),
					device: hub(),
				}),
			);
			await waitFor(() => events().length === 2, { description: 'events logged' });
			await clock.tickAsync(60_000);
			await delay(30);
			expect(mock.findRequests({ path: '/system/logs' })).to.deep.equal([]);
			expect(instance.log.of('warn')).to.deep.equal([]);
		});

		describe('with the Protect integration', () => {
			let protect: ProtectStub;
			const CAMERA = '66a1b2c3d4e5f60718293a4b';
			// ASSUMPTION (T-06): the target type "camera event" with the id "protect_<camera>_<event>" is not part
			// of the API reference (9.1.1 lists UAH, device_config, door, floor, building). These tests prove the
			// adapter's wiring, not the behaviour of a real console — see test/mock/README.md, "Annahmen".
			const cameraHit = (eventId = 'evt_77'): unknown => ({
				_source: {
					target: [
						{ type: 'door', id: DOOR_3855 },
						{ type: 'camera event', id: `protect_${CAMERA}_${eventId}` },
					],
				},
			});

			beforeEach(async () => {
				protect = new ProtectStub();
				await protect.start();
				listenPort = await portOtherThan(listenPort, protect.port);
			});

			afterEach(async () => {
				await adapter?.fireUnload();
				adapter = undefined;
				await protect.stop();
			});

			const startWithProtect = (overrides: Record<string, unknown> = {}): Promise<FakeAdapter> =>
				startConnected({
					enableProtect: true,
					protectUsername: 'viewer',
					protectPassword: 'protect-secret',
					protectPort: protect.port,
					...overrides,
				});

			it('the debug output of the system log masks the card id of the person (authentication.issuer, RK U-3)', async () => {
				const instance = await startWithProtect();
				// the raw system log is only written at log level debug
				(instance.log as unknown as { level: string }).level = 'debug';
				mock.systemLogHits = [
					{
						_source: {
							authentication: { credential_provider: 'NFC', issuer: '6FC02554' },
							target: [{ type: 'door', id: DOOR_3855 }],
						},
					},
				];
				await mock.deliverWebhook(fixtures.webhookEvents.doorUnlock({ door: door(DOOR_3855), device: hub() }));
				await waitFor(() => events().length === 1, { description: 'event logged' });
				await clock.tickAsync(3000);
				await waitFor(() => instance.log.of('debug').some(m => m.startsWith('[system-logs:door_openings]')), {
					description: 'system log debug output',
				});
				const output = instance.log.of('debug').filter(m => m.startsWith('[system-logs:'));
				expect(output.join('\n')).to.not.contain('6FC02554');
				expect(output[0]).to.contain('"issuer":"***"').and.contain('"credential_provider":"NFC"');
			});

			it('queries the documented topic door_openings 3 s after access.door.unlock and attaches the camera snapshot', async () => {
				const instance = await startWithProtect();
				mock.systemLogHits = [cameraHit()];
				await mock.deliverWebhook(fixtures.webhookEvents.doorUnlock({ door: door(DOOR_3855), device: hub() }));
				await waitFor(() => events().length === 1, { description: 'event logged' });
				const ts = events()[0].ts;

				await clock.tickAsync(2999);
				await delay(30);
				expect(mock.findRequests({ path: '/system/logs' })).to.have.length(0);
				await clock.tickAsync(1);
				await waitFor(() => events()[0].protectSnapshotUrl !== undefined, { description: 'snapshot attached' });

				const queries = mock.findRequests({ path: '/system/logs' });
				expect(queries.map(q => `${q.method} ${JSON.stringify(q.body)}`)).to.deep.equal([
					`POST ${JSON.stringify({
						topic: 'door_openings',
						since: Math.floor(ts / 1000) - 10,
						until: Math.floor(ts / 1000) + 30,
					})}`,
				]);
				expect(events()[0]).to.include({
					protectCameraId: CAMERA,
					protectEventId: 'evt_77',
					protectSnapshotUrl: `http://127.0.0.1:${listenPort}/unifi-access/0/protect-snapshot/${CAMERA}/${ts}.jpg`,
					protectVideoUrl: `http://127.0.0.1:${listenPort}/unifi-access/0/protect-video/evt_77.mp4`,
				});
				expect(instance.log.of('warn')).to.deep.equal([]);

				// the cached snapshot is served by the shared HTTP server
				const response = await httpRequest({ url: events()[0].protectSnapshotUrl as string });
				expect(response.status).to.equal(200);
				expect(response.body.equals(protect.snapshot)).to.equal(true);
			});

			// K-05: two doors opened within seconds — the lookup window contains the entries of both
			describe('camera events belong to the door of the event', () => {
				const OTHER_CAMERA = '77b2c3d4e5f60718293a4b5c';
				const hitFor = (doorId: string, camera: string, eventId: string, published?: number): unknown => ({
					_source: {
						event: published === undefined ? undefined : { published },
						target: [
							{ type: 'door', id: doorId },
							{ type: 'camera event', id: `protect_${camera}_${eventId}` },
						],
					},
				});
				const snapshotRequests = (): string[] =>
					protect.requests.filter(r => r.url.includes('/snapshot')).map(r => r.url);

				async function unlockAndLookUp(doorId: string): Promise<number> {
					await mock.deliverWebhook(fixtures.webhookEvents.doorUnlock({ door: door(doorId), device: hub() }));
					await waitFor(() => events().length === 1, { description: 'event logged' });
					const ts = events()[0].ts;
					mock.systemLogHits = mock.systemLogHits.map(h =>
						JSON.parse(
							JSON.stringify(h).replace(
								/"published":"TS([+-]\d+)"/g,
								(_m, d) => `"published":${ts + Number(d)}`,
							),
						),
					);
					await clock.tickAsync(3000);
					await waitFor(() => mock.findRequests({ path: '/system/logs' }).length >= 1, {
						description: 'query',
					});
					return ts;
				}

				it('the event of door B gets the camera of door B and exactly one snapshot is fetched', async () => {
					await startWithProtect();
					mock.systemLogHits = [hitFor(DOOR_A2, OTHER_CAMERA, 'evt_a'), hitFor(DOOR_3855, CAMERA, 'evt_b')];
					const before = snapshotRequests().length;
					await unlockAndLookUp(DOOR_3855);
					await waitFor(() => events()[0].protectSnapshotUrl !== undefined, {
						description: 'snapshot attached',
					});
					expect(events()[0]).to.include({ protectCameraId: CAMERA, protectEventId: 'evt_b' });
					expect(snapshotRequests().slice(before)).to.deep.equal([
						`/proxy/protect/api/cameras/${CAMERA}/snapshot`,
					]);
				});

				it('only the entry of another door: nothing is attached (rather none than a wrong picture)', async () => {
					await startWithProtect();
					mock.systemLogHits = [hitFor(DOOR_A2, OTHER_CAMERA, 'evt_a')];
					const before = snapshotRequests().length;
					await unlockAndLookUp(DOOR_3855);
					await waitFor(() => mock.findRequests({ path: '/system/logs' }).length === 2, {
						description: 'both topics asked',
					});
					await delay(50);
					expect(events()[0].protectCameraId).to.equal(undefined);
					expect(snapshotRequests().slice(before)).to.deep.equal([]);
				});

				it('a camera entry without any door target is not attached either', async () => {
					await startWithProtect();
					mock.systemLogHits = [
						{ _source: { target: [{ type: 'camera event', id: `protect_${CAMERA}_evt_x` }] } },
					];
					await unlockAndLookUp(DOOR_3855);
					await waitFor(() => mock.findRequests({ path: '/system/logs' }).length === 2, {
						description: 'both topics asked',
					});
					await delay(50);
					expect(events()[0].protectCameraId).to.equal(undefined);
				});

				it('several entries of the same door: the one closest in time wins', async () => {
					await startWithProtect();
					mock.systemLogHits = [
						hitFor(DOOR_3855, OTHER_CAMERA, 'evt_far', 'TS-9000' as unknown as number),
						hitFor(DOOR_3855, CAMERA, 'evt_near', 'TS+1000' as unknown as number),
					];
					await unlockAndLookUp(DOOR_3855);
					await waitFor(() => events()[0].protectSnapshotUrl !== undefined, {
						description: 'snapshot attached',
					});
					expect(events()[0]).to.include({ protectCameraId: CAMERA, protectEventId: 'evt_near' });
				});
			});

			// U-10: the media URLs written to events.last follow the public base URL as well
			it('builds the snapshot and clip URLs from the public base URL when one is set', async () => {
				await startWithProtect({ publicBaseUrl: 'https://iobroker.example.com' });
				mock.systemLogHits = [cameraHit()];
				// the controller would post to the proxy, which forwards to the local receiver
				await sendWebhook({
					url: `http://127.0.0.1:${listenPort}/unifi-access-webhook`,
					secret: mock.webhookEndpoints[0].secret,
					body: fixtures.webhookEvents.doorUnlock({ door: door(DOOR_3855), device: hub() }),
				});
				await waitFor(() => events().length === 1, { description: 'event logged' });
				const ts = events()[0].ts;
				await clock.tickAsync(3000);
				await waitFor(() => events()[0].protectSnapshotUrl !== undefined, { description: 'snapshot attached' });
				expect(events()[0]).to.include({
					protectSnapshotUrl: `https://iobroker.example.com/unifi-access/0/protect-snapshot/${CAMERA}/${ts}.jpg`,
					protectVideoUrl: 'https://iobroker.example.com/unifi-access/0/protect-video/evt_77.mp4',
				});
			});

			it('falls back to the topic "all" only when door_openings carries no camera event', async () => {
				await startWithProtect();
				await mock.deliverWebhook(fixtures.webhookEvents.doorUnlock({ door: door(DOOR_3855), device: hub() }));
				await waitFor(() => events().length === 1, { description: 'event logged' });
				await clock.tickAsync(3000);
				await waitFor(() => mock.findRequests({ path: '/system/logs' }).length === 2, {
					description: 'both queries',
				});
				expect(mock.findRequests({ path: '/system/logs' }).map(q => q.body.topic)).to.deep.equal([
					'door_openings',
					'all',
				]);
			});

			it('ignores camera events whose ids are not plain ids', async () => {
				const instance = await startWithProtect();
				mock.systemLogHits = [
					{ _source: { target: [{ type: 'camera event', id: 'protect_../../x_evt' }] } },
					{ _source: { target: [{ type: 'camera event', id: 'protect_' }] } },
					{ _source: { target: 'nothing' } },
					null,
				];
				const snapshots = protect.requests.length;
				await mock.deliverWebhook(fixtures.webhookEvents.doorUnlock({ door: door(DOOR_3855), device: hub() }));
				await waitFor(() => events().length === 1, { description: 'event logged' });
				await clock.tickAsync(3000);
				await waitFor(() => mock.findRequests({ path: '/system/logs' }).length === 2, {
					description: 'queries',
				});
				await delay(50);
				expect(protect.requests).to.have.length(snapshots);
				expect(events()[0].protectSnapshotUrl).to.equal(undefined);
				expect(instance.log.of('warn')).to.deep.equal([]);
			});

			it('a token without the system log permission is reported once, not on every unlock', async () => {
				const instance = await startWithProtect();
				mock.failNext({ path: '/system/logs', status: 403, times: Number.POSITIVE_INFINITY });
				for (let i = 1; i <= 3; i++) {
					await mock.deliverWebhook(
						fixtures.webhookEvents.doorUnlock({ door: door(DOOR_3855), device: hub() }),
					);
					await waitFor(() => events().length === i, { description: 'event logged' });
					await clock.tickAsync(3000);
					await waitFor(() => mock.findRequests({ path: '/system/logs' }).length === i * 2, {
						description: 'queries',
					});
				}
				await delay(30);
				const warnings = instance.log.of('warn');
				expect(warnings).to.have.length(1);
				expect(warnings[0]).to.contain('view:system_log');
			});

			it('logs in again after the Protect session was lost and the automatic re-login failed', async () => {
				const instance = await startWithProtect();
				mock.systemLogHits = [cameraHit()];
				// the console forgets the session and rate-limits the immediate re-login
				protect.expireSessions();
				protect.failLogins(429);
				await mock.deliverWebhook(fixtures.webhookEvents.doorUnlock({ door: door(DOOR_3855), device: hub() }));
				await waitFor(() => events().length === 1, { description: 'event 1' });
				await clock.tickAsync(3000);
				await waitFor(() => instance.log.of('warn').some(m => m.includes('snapshot fetch for camera')), {
					description: 'snapshot failed',
				});
				expect(protect.logins.map(l => l.status)).to.deep.equal([200, 429]);

				// the next door event notices the missing session and starts the login again
				await mock.deliverWebhook(fixtures.webhookEvents.doorUnlock({ door: door(DOOR_3855), device: hub() }));
				await waitFor(() => protect.logins.length === 3, { description: 'new login' });
				expect(protect.logins[2].status).to.equal(200);

				await mock.deliverWebhook(fixtures.webhookEvents.doorUnlock({ door: door(DOOR_3855), device: hub() }));
				await waitFor(() => events().length === 3, { description: 'event 3' });
				await clock.tickAsync(3000);
				await waitFor(() => events()[0].protectSnapshotUrl !== undefined, {
					description: 'snapshots work again',
				});
			});

			it('does not query the system logs after the Protect login was rejected', async () => {
				await startWithProtect({ protectPassword: 'wrong' });
				await mock.deliverWebhook(fixtures.webhookEvents.doorUnlock({ door: door(DOOR_3855), device: hub() }));
				await waitFor(() => events().length === 1, { description: 'event logged' });
				await clock.tickAsync(10_000);
				await delay(30);
				expect(mock.findRequests({ path: '/system/logs' })).to.deep.equal([]);
			});
		});
	});

	describe('objects exist before states are written (R-09)', () => {
		it('creates the info, doorbell, events and notification objects at start — also without a reachable controller', async () => {
			mock.failNext({ status: 500, times: Number.POSITIVE_INFINITY });
			const instance = await start({ enableGenericWebhook: true, genericWebhookAuth: 'none' });
			for (const id of [
				'info.webhookRegistered',
				'info.webhookEndpointId',
				'info.protectConnected',
				'events.last',
				'doorbell.activeCallId',
				'notifications.lastRaw',
				'notifications.lastTimestamp',
				'doors.emergency.lockdown',
				'admin.uiSettings',
			]) {
				expect(instance.obj(id)?.type, id).to.equal('state');
			}
			const response = await httpRequest({
				url: `http://127.0.0.1:${listenPort}/webhook`,
				method: 'POST',
				body: '{"alarm_id":"offline-alarm","events":[]}',
			});
			expect(response.status).to.equal(200);
			expect(instance.val('notifications.lastAlarmId')).to.equal('offline-alarm');
			// every state that was written has an object
			const written = new Set(instance.stateWrites.map(w => w.id));
			// info.connection is an instanceObject of io-package.json, created by js-controller itself
			written.delete(`${NS}.info.connection`);
			expect([...written].filter(id => !instance.objects.has(id))).to.deep.equal([]);
		});

		it('never writes a state without object during normal operation (devices, doors, thumbnails, events)', async () => {
			const instance = await startConnected({
				enableThumbnailServer: true,
				forwardEvents: [],
			});
			// a reader model without the thumbnail capability flag delivers a thumbnail
			await mock.deliverWebhook(
				fixtures.webhookEvents.doorUnlock({ door: door(DOOR_3855), device: hub(), readerId: DEVICE_HUB }),
			);
			await waitFor(() => instance.val(`devices.${DEVICE_HUB}.lastThumbnailPath`), {
				description: 'thumbnail stored',
			});
			expect(instance.obj(`devices.${DEVICE_HUB}.lastThumbnailPath`)?.type).to.equal('state');
			expect(instance.obj(`devices.${DEVICE_HUB}.lastThumbnailUrl`)?.type).to.equal('state');
			mock.emitRemoteView();
			mock.emitRemoteUnlock(DOOR_A2);
			await mock.deliverWebhook(
				fixtures.webhookEvents.dpsStatus({ door: door(DOOR_A2), device: hub(), status: 'close' }),
			);
			await waitFor(() => instance.val(`doors.${DOOR_A2}.position`) === 'close', {
				description: 'events processed',
			});
			await clock.tickAsync(10_000);
			await delay(50);
			const written = new Set(instance.stateWrites.map(w => w.id));
			// info.connection is an instanceObject of io-package.json, created by js-controller itself
			written.delete(`${NS}.info.connection`);
			expect([...written].filter(id => !instance.objects.has(id))).to.deep.equal([]);
		});

		it('a device that appears after the start gets its objects through a reload before its states are written', async () => {
			const instance = await startConnected();
			const newDevice = { id: 'aabbccddee01', name: 'UA-G3-NEW', type: 'UA-G3-PRO', alias: 'Side Entrance' };
			const before = mock.findRequests({ path: '/devices' }).length;
			(mock.devices as { id: string }[][])[0].push(newDevice);

			const event = fixtures.webhookEvents.doorbellIncoming({ door: door(DOOR_3855), device: newDevice });
			await mock.deliverWebhook(event);
			await waitFor(() => instance.obj('devices.aabbccddee01')?.type === 'channel', {
				description: 'device channel',
			});
			expect(mock.findRequests({ path: '/devices' })).to.have.length(before + 1);
			expect(
				instance.stateWrites.filter(w => w.id.includes('aabbccddee01') && !instance.objects.has(w.id)),
			).to.deep.equal([]);

			// the next event of that device is processed normally
			await mock.deliverWebhook(event);
			await waitFor(() => instance.val('devices.aabbccddee01.lastThumbnailPath'), {
				description: 'thumbnail of the new device',
			});
			expect(instance.val('devices.aabbccddee01.lastSeenAt')).to.be.a('string').with.length.greaterThan(0);
		});

		it('a device id that the controller never lists triggers one reload only and no state writes', async () => {
			const instance = await startConnected();
			const ghost = { id: 'ffffffffff99', name: 'ghost', type: 'UAH' };
			const before = mock.findRequests({ path: '/devices' }).length;
			for (let i = 1; i <= 3; i++) {
				await mock.deliverWebhook(
					fixtures.webhookEvents.dpsStatus({ door: door(DOOR_3855), device: ghost, status: 'open' }),
				);
				await waitFor(() => events().length === i, { description: 'event logged' });
			}
			await waitFor(() => mock.findRequests({ path: '/devices' }).length === before + 1, {
				description: 'one reload',
			});
			await delay(50);
			expect(mock.findRequests({ path: '/devices' })).to.have.length(before + 1);
			expect(instance.stateWrites.filter(w => w.id.includes('ffffffffff99'))).to.deep.equal([]);
		});

		it('a door that appears after the start gets its objects before its states are written', async () => {
			const instance = await startConnected();
			const newDoor = {
				id: 'c0ffee00-0000-4000-8000-000000000001',
				name: 'Garage',
				full_name: 'UNVR - 1F - Garage',
				type: 'door',
				is_bind_hub: true,
				door_lock_relay_status: 'unlock',
				door_position_status: 'open',
			};
			mock.doors.push(newDoor);
			await mock.deliverWebhook(fixtures.webhookEvents.doorUnlock({ door: newDoor, device: hub() }));
			await waitFor(() => events().length === 1, { description: 'event logged' });
			expect(instance.stateWrites.filter(w => w.id.includes(newDoor.id))).to.deep.equal([]);

			await clock.tickAsync(2000);
			await waitFor(() => instance.obj(`doors.${newDoor.id}`)?.type === 'channel', {
				description: 'door channel',
			});
			expect(instance.val(`doors.${newDoor.id}.locked`)).to.equal(false);
			expect(instance.val(`doors.${newDoor.id}.position`)).to.equal('open');
			expect(instance.obj(`doors.${newDoor.id}.unlock`)?.common.role).to.equal('button');
			expect(
				instance.stateWrites.filter(w => w.id.includes(newDoor.id) && !instance.objects.has(w.id)),
			).to.deep.equal([]);

			// and it can be controlled right away
			instance.fireStateChange(`doors.${newDoor.id}.unlock`, true);
			await waitFor(() => mock.unlocks.some(u => u.doorId === newDoor.id), {
				description: 'unlock of the new door',
			});
		});
	});

	describe('generic alarm webhook: field types (R-21)', () => {
		const post = (body: string): Promise<{ status: number }> =>
			httpRequest({ url: `http://127.0.0.1:${listenPort}/webhook`, method: 'POST', body });

		it('writes only values of the declared state type, whatever the body contains', async () => {
			const instance = await startConnected({ enableGenericWebhook: true, genericWebhookAuth: 'none' });
			for (const body of [
				'null',
				'[]',
				'42',
				'"text"',
				'{"alarm_id":{"a":1},"events":"none"}',
				'{"alarm_id":["x"],"events":[null]}',
				'{"alarm_id":7,"events":[{"id":{"x":1},"location":["a"],"scope":{"locations":{"b":2}},"user":true,"user_name":[],"location_name":{},"direction":5,"unlock_method_text":null,"time":{"t":1}}]}',
			]) {
				expect((await post(body)).status, body).to.equal(200);
			}
			const types: Record<string, string> = {
				lastRaw: 'string',
				lastAlarmId: 'string',
				lastEventType: 'string',
				lastLocationId: 'string',
				lastLocationName: 'string',
				lastUserId: 'string',
				lastUserName: 'string',
				lastDirection: 'string',
				lastUnlockMethod: 'string',
				lastTimestamp: 'number',
			};
			const wrong = instance.stateWrites
				.filter(w => w.id.startsWith(`${NS}.notifications.`))
				.filter(w => typeof w.val !== types[w.id.split('.').pop()!]);
			expect(wrong).to.deep.equal([]);
			expect(instance.val('notifications.lastAlarmId')).to.equal('7');
			expect(instance.val('notifications.lastDirection')).to.equal('5');
			expect(instance.val('notifications.lastLocationId')).to.equal('');
			expect(instance.log.of('warn')).to.deep.equal([]);
		});

		it('resolves door and user names and falls back to the names in the payload', async () => {
			const instance = await startConnected({ enableGenericWebhook: true, genericWebhookAuth: 'none' });
			const user = fixtures.DEFAULT_USERS[0];
			await post(JSON.stringify({ alarm_id: 'a1', events: [{ id: 'e', location: DOOR_3855, user: user.id }] }));
			expect(instance.val('notifications.lastLocationName')).to.equal('Door 3855');
			expect(instance.val('notifications.lastUserName')).to.equal('Hong Lu');
			await post(
				JSON.stringify({
					alarm_id: 'a2',
					events: [
						{
							id: 'e',
							scope: { locations: 'loc-9' },
							location_name: 'Side',
							user: 'u-9',
							user_name: 'Guest',
						},
					],
				}),
			);
			expect(instance.val('notifications.lastLocationId')).to.equal('loc-9');
			expect(instance.val('notifications.lastLocationName')).to.equal('Side');
			expect(instance.val('notifications.lastUserName')).to.equal('Guest');
		});
	});

	describe('sendTo commands always answer (X-01, R-25)', () => {
		it('listUsers reports why the list is empty in an "error" field', async () => {
			const instance = await startConnected({ enableWebhooks: false });
			expect(await instance.request('listUsers')).to.deep.equal({
				users: [
					{ id: fixtures.DEFAULT_USERS[0].id, name: 'Hong Lu' },
					{ id: fixtures.DEFAULT_USERS[1].id, name: 'Ttttt Tttt' },
				],
			});

			mock.failNext({ path: '/users', status: 500 });
			expect(await instance.request('listUsers')).to.deep.equal({ users: [], error: 'network' });

			mock.failNext({ path: '/users', status: 401, code: 'CODE_ACCESS_TOKEN_INVALID' });
			expect(await instance.request('listUsers')).to.deep.equal({ users: [], error: 'unauthorized' });

			// error code in the response envelope although the HTTP status is 200
			mock.failNext({ path: '/users', status: 200, body: { code: 'CODE_SYSTEM_ERROR', msg: 'failed' } });
			expect(await instance.request('listUsers')).to.deep.equal({ users: [], error: 'network' });
			mock.failNext({ path: '/users', status: 200, body: { code: 'CODE_UNAUTHORIZED', msg: 'no' } });
			expect(await instance.request('listUsers')).to.deep.equal({ users: [], error: 'unauthorized' });
		});

		// E2E finding E-02: the admin sends its requests as soon as the instance is reported alive. The
		// adapter answered them from its still empty state: "no devices", "host or token missing" (for a
		// correctly configured instance) and "HTTP server not running" - and the settings page kept showing that.
		describe('requests that arrive while the adapter is still starting', () => {
			const config = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
				controllerHost: '127.0.0.1',
				controllerPort: mock.port,
				apiToken: TOKEN,
				verifyTLS: false,
				wsReconnectDelay: 0.05,
				listenPort,
				listenIp: '127.0.0.1',
				enableWebhooks: true,
				enableThumbnailServer: true,
				forwardEvents: [],
				...overrides,
			});

			it('are answered with the loaded state once the start is over', async () => {
				adapter = createAdapterWithFakeCore(MAIN, config());
				const instance = adapter;
				const ready = instance.fireReady();
				// sent before the ready handler got further than its first await
				const [devices, users, server, status] = await Promise.all([
					instance.request('listDevices'),
					instance.request('listUsers'),
					instance.request('getServerInfo'),
					instance.request('getConnectionStatus'),
				]);
				await ready;

				expect((devices.devices as unknown[]).length).to.equal(4);
				expect(users).to.deep.equal({
					users: [
						{ id: fixtures.DEFAULT_USERS[0].id, name: 'Hong Lu' },
						{ id: fixtures.DEFAULT_USERS[1].id, name: 'Ttttt Tttt' },
					],
				});
				expect(server).to.include({ running: true, scheme: 'http', port: listenPort });
				expect(status).to.include({ connected: true, hasToken: true, lastError: null });
			});

			it('re-registers the webhook instead of answering "not-configured"', async () => {
				adapter = createAdapterWithFakeCore(MAIN, config());
				const instance = adapter;
				const ready = instance.fireReady();
				const answer = await instance.request('reregisterWebhook');
				await ready;

				expect(answer.ok).to.equal(true);
				expect(mock.webhookEndpoints.map(e => e.id)).to.deep.equal([answer.id]);
			});

			it('report the failed start instead of an empty state when the controller cannot be reached', async () => {
				mock.failNext({ hangUp: true, times: Number.POSITIVE_INFINITY });
				adapter = createAdapterWithFakeCore(MAIN, config());
				const instance = adapter;
				const ready = instance.fireReady();
				const [users, status] = await Promise.all([
					instance.request('listUsers'),
					instance.request('getConnectionStatus'),
				]);
				await ready;

				expect(users).to.deep.equal({ users: [], error: 'network' });
				expect(status).to.include({ connected: false, lastError: 'network' });
			});

			it('are answered at once without controller configuration and when the start failed', async () => {
				adapter = createAdapterWithFakeCore(MAIN, config({ controllerHost: '' }));
				const instance = adapter;
				const ready = instance.fireReady();
				expect(await instance.request('listUsers')).to.deep.equal({ users: [], error: 'not-configured' });
				await ready;
				expect(instance.timers.size).to.equal(0);
			});

			it('do not wait longer than 8 s for a start that hangs', async () => {
				adapter = createAdapterWithFakeCore(MAIN, config());
				const instance = adapter;
				// the ready handler never gets past its first step
				let release: () => void = () => undefined;
				const setState = instance.setState.bind(instance);
				let blocked = false;
				instance.setState = async (...args: Parameters<typeof setState>) => {
					if (!blocked) {
						blocked = true;
						await new Promise<void>(resolve => (release = resolve));
					}
					return setState(...args);
				};
				const ready = instance.fireReady();
				let answer: Record<string, unknown> | undefined;
				void instance.request('listDevices', undefined, 10_000).then(result => (answer = result));
				await clock.tickAsync(7900);
				await delay(30);
				expect(answer, 'no answer before the limit').to.equal(undefined);
				await clock.tickAsync(200);
				await waitFor(() => answer !== undefined, { description: 'answer after the limit' });
				expect(answer).to.deep.equal({ devices: [] });

				release();
				await ready;
				// afterwards requests are answered without delay
				expect(((await instance.request('listDevices')).devices as unknown[]).length).to.equal(4);
			});

			it('verifyToken and getNetworkInterfaces do not wait for the start', async () => {
				adapter = createAdapterWithFakeCore(MAIN, config());
				const instance = adapter;
				let release: () => void = () => undefined;
				const setState = instance.setState.bind(instance);
				let blocked = false;
				instance.setState = async (...args: Parameters<typeof setState>) => {
					if (!blocked) {
						blocked = true;
						await new Promise<void>(resolve => (release = resolve));
					}
					return setState(...args);
				};
				const ready = instance.fireReady();
				expect(
					await instance.request('verifyToken', { host: '127.0.0.1', port: mock.port, token: TOKEN }),
				).to.include({ ok: true });
				expect((await instance.request('getNetworkInterfaces')).addresses).to.be.an('array');
				release();
				await ready;
			});
		});

		it('listUsers without configured controller answers with error "not-configured"', async () => {
			const instance = await start({ apiToken: '' });
			expect(await instance.request('listUsers')).to.deep.equal({ users: [], error: 'not-configured' });
			expect(await instance.request('reregisterWebhook')).to.deep.equal({ ok: false, error: 'not-configured' });
			expect(await instance.request('listDevices')).to.deep.equal({ devices: [] });
			expect(await instance.request('getConnectionStatus')).to.include({ connected: false, hasToken: false });
		});

		it('an unknown command is answered with an error instead of leaving the caller waiting', async () => {
			const instance = await startConnected({ enableWebhooks: false });
			expect(await instance.request('thisCommandDoesNotExist', { a: 1 })).to.deep.equal({
				ok: false,
				error: 'unknown-command',
			});
		});

		it('verifyToken tolerates payloads of the wrong type', async () => {
			const instance = await startConnected({ enableWebhooks: false });
			for (const payload of [
				undefined,
				null,
				'text',
				5,
				[],
				{ host: 5, token: {} },
				{ host: '127.0.0.1', token: ['x'] },
			]) {
				expect(await instance.request('verifyToken', payload), JSON.stringify(payload)).to.deep.equal({
					ok: false,
					error: 'missing-fields',
				});
			}
			expect(
				await instance.request('verifyToken', { host: '127.0.0.1', port: 'not-a-port', token: TOKEN }, 20_000),
			).to.include({ ok: false });
			expect(
				await instance.request('verifyToken', { host: '127.0.0.1', port: mock.port, token: TOKEN }),
			).to.deep.equal({ ok: true, deviceCount: 4 });
		});

		describe('verifyToken (K-13, U-04, U-06, U-13)', () => {
			const probe = { host: '127.0.0.1', token: TOKEN };

			it('answers with the number of devices found — no device name posing as "controller"', async () => {
				const instance = await startConnected({ enableWebhooks: false });
				expect(await instance.request('verifyToken', { ...probe, port: mock.port })).to.deep.equal({
					ok: true,
					deviceCount: 4,
				});
				mock.devices = [[]];
				expect(await instance.request('verifyToken', { ...probe, port: mock.port })).to.deep.equal({
					ok: true,
					deviceCount: 0,
				});
			});

			it('a certificate failure is reported as "tls" with the OpenSSL code, not as "network"', async () => {
				const instance = await startConnected({ enableWebhooks: false });
				expect(
					await instance.request('verifyToken', { ...probe, port: mock.port, verifyTLS: true }),
				).to.deep.equal({ ok: false, error: 'tls', detail: 'DEPTH_ZERO_SELF_SIGNED_CERT' });

				const other = new MockUnifiController({ token: TOKEN, altNames: ['other.example'] });
				await other.start();
				try {
					expect(
						await instance.request('verifyToken', {
							...probe,
							port: other.port,
							verifyTLS: true,
							caCert: other.cert,
						}),
					).to.deep.equal({ ok: false, error: 'tls', detail: 'ERR_TLS_CERT_ALTNAME_INVALID' });
				} finally {
					await other.stop();
				}
			});

			it('uses verifyTLS and caCert of the form, not the stored ones', async () => {
				// stored: no verification, no CA — the form asks for verification with the right CA
				const instance = await startConnected({ enableWebhooks: false, verifyTLS: false, caCert: '' });
				expect(
					await instance.request('verifyToken', {
						...probe,
						port: mock.port,
						verifyTLS: true,
						caCert: mock.cert,
					}),
				).to.deep.equal({ ok: true, deviceCount: 4 });
			});

			it('an emptied CA field in the form is not replaced by the stored CA certificate', async () => {
				const instance = await startConnected({ enableWebhooks: false, verifyTLS: true, caCert: mock.cert });
				expect(
					await instance.request('verifyToken', { ...probe, port: mock.port, verifyTLS: true, caCert: '' }),
				).to.deep.equal({ ok: false, error: 'tls', detail: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
			});

			it('without verifyTLS / caCert in the payload the stored values apply', async () => {
				const instance = await startConnected({ enableWebhooks: false, verifyTLS: true, caCert: mock.cert });
				expect(await instance.request('verifyToken', { ...probe, port: mock.port })).to.deep.equal({
					ok: true,
					deviceCount: 4,
				});
				expect(
					await instance.request('verifyToken', { ...probe, port: mock.port, verifyTLS: false }),
					'the form switched verification off',
				).to.deep.equal({ ok: true, deviceCount: 4 });
			});

			// K-03: some other HTTPS service on host and port is not "connection successful"
			it('an answer without the UniFi Access envelope is not a success', async () => {
				const instance = await startConnected({ enableWebhooks: false });
				mock.failNext({ path: '/devices', status: 200, body: '<html>router login</html>' });
				expect(await instance.request('verifyToken', { ...probe, port: mock.port })).to.deep.equal({
					ok: false,
					error: 'network',
				});
			});

			// T-02: the admin sends the token in clear text — it must not reach any log level
			it('the API token of the payload appears in no log line, whatever the outcome', async () => {
				const secretToken = 'probe-token-that-must-not-be-logged';
				const instance = await startConnected({ enableWebhooks: false });
				instance.log.messages.length = 0;
				await instance.request('verifyToken', { ...probe, port: mock.port, token: secretToken });
				mock.token = secretToken;
				await instance.request('verifyToken', { ...probe, port: mock.port, token: secretToken });
				await instance.request('verifyToken', {
					...probe,
					port: mock.port,
					token: secretToken,
					verifyTLS: true,
				});
				mock.failNext({ path: '/devices', status: 500 });
				await instance.request('verifyToken', { ...probe, port: mock.port, token: secretToken });
				expect(instance.log.messages.length, 'something was logged at all').to.be.greaterThan(0);
				expect(instance.log.messages.filter(m => m.message.includes(secretToken))).to.deep.equal([]);
			});
		});

		it('a message without callback is processed without sending an answer', async () => {
			const instance = await startConnected({ enableWebhooks: false });
			const handler = (instance as unknown as { handlers: { message: (msg: unknown) => void } }).handlers.message;
			const before = instance.sentMessages.length;
			handler({ command: 'listDevices', message: null, from: 'system.adapter.test.0' });
			handler({ command: 42, from: 'system.adapter.test.0' });
			handler(null);
			await instance.request('getConnectionStatus');
			expect(instance.sentMessages).to.have.length(before + 1);
		});

		it('reregisterWebhook answers before the credentials are stored (storing restarts the instance)', async () => {
			const instance = await startConnected();
			const order: string[] = [];
			const sendTo = instance.sendTo.bind(instance);
			instance.sendTo = (...args: Parameters<FakeAdapter['sendTo']>) => {
				order.push('answer');
				return sendTo(...args);
			};
			const extend = instance.extendForeignObjectAsync.bind(instance);
			instance.extendForeignObjectAsync = async (id: string, obj: Record<string, unknown>) => {
				order.push('store');
				return extend(id, obj);
			};
			const answer = await instance.request('reregisterWebhook');
			expect(answer.ok).to.equal(true);
			await waitFor(() => order.includes('store'), { description: 'credentials stored' });
			expect(order).to.deep.equal(['answer', 'store']);
			expect(instance.objects.get(INSTANCE_OBJECT)?.native.webhookEndpointId).to.equal(answer.id);
		});
	});

	describe('admin.uiSettings (storage of the www panel, X-02)', () => {
		it('confirms a JSON object written by the panel and never treats it as a door command', async () => {
			const instance = await startConnected({ enableWebhooks: false });
			const before = mock.requests.length;
			const value = JSON.stringify({ showDoorList: false, thumbWidth: 160 });
			instance.fireStateChange('admin.uiSettings', value);
			await waitFor(() => instance.states.get(`${NS}.admin.uiSettings`)?.ack === true, { description: 'ack' });
			expect(instance.val('admin.uiSettings')).to.equal(value);
			expect(mock.requests.slice(before)).to.deep.equal([]);
			expect(instance.log.of('warn')).to.deep.equal([]);
			expect(instance.obj('admin.uiSettings')?.common).to.include({ write: true, role: 'json' });
		});

		for (const [label, bad] of [
			['not JSON', '{"thumbWidth":'],
			['a JSON array', '[1,2]'],
			['a JSON string', '"text"'],
			['a number', 5],
			['null', null],
			['an oversized value', JSON.stringify({ x: 'y'.repeat(10_001) })],
		] as [string, unknown][]) {
			it(`replaces ${label} by the last valid value and warns`, async () => {
				const instance = await startConnected({ enableWebhooks: false });
				const valid = JSON.stringify({ showEventLog: false });
				instance.fireStateChange('admin.uiSettings', valid);
				await waitFor(() => instance.states.get(`${NS}.admin.uiSettings`)?.ack === true, {
					description: 'ack',
				});
				instance.fireStateChange('admin.uiSettings', bad);
				await waitFor(() => instance.states.get(`${NS}.admin.uiSettings`)?.ack === true, {
					description: 'reset',
				});
				expect(instance.val('admin.uiSettings')).to.equal(valid);
				expect(instance.log.of('warn')).to.have.length(1);
				expect(instance.log.of('warn')[0]).to.contain('admin.uiSettings');
			});
		}

		it('falls back to "{}" when there never was a valid value', async () => {
			const instance = await startConnected({ enableWebhooks: false });
			instance.fireStateChange('admin.uiSettings', 'garbage');
			await waitFor(() => instance.states.get(`${NS}.admin.uiSettings`)?.ack === true, { description: 'reset' });
			expect(instance.val('admin.uiSettings')).to.equal('{}');
		});
	});

	describe('event forwarding', () => {
		it('forwards matching events as JSON to the target state and honours the device filter', async () => {
			const instance = await startConnected({
				forwardEvents: [
					{ event: 'access.remote_view', deviceId: DEVICE_G2_PRO, targetState: '0_userdata.0.ring' },
					{ event: 'access.remote_view', deviceId: 'some-other-device', targetState: '0_userdata.0.other' },
					{ event: 'access.remote_view.change', targetState: '0_userdata.0.change' },
					{ event: 'access.remote_view', targetState: '' },
				],
			});
			const ring = mock.emitRemoteView();
			await waitFor(() => instance.states.has('0_userdata.0.ring'), { description: 'forwarded state' });

			const forwarded = instance.states.get('0_userdata.0.ring')!;
			expect(forwarded.ack).to.equal(true);
			expect(JSON.parse(forwarded.val as string)).to.deep.include({
				type: 'access.remote_view',
				source: 'ws',
				deviceId: DEVICE_G2_PRO,
			});
			// the WebRTC credentials of the call are not forwarded (R-19)
			const { channel, token, ...data } = ring.data;
			expect(JSON.parse(forwarded.val as string).raw).to.deep.equal({ ...ring, data });
			expect(forwarded.val).to.not.contain(channel).and.not.contain(token);
			expect(instance.states.has('0_userdata.0.other')).to.equal(false);
			expect(instance.states.has('0_userdata.0.change')).to.equal(false);
		});

		it('a PIN or card id in authentication_value reaches neither events.last nor a forward state (RK U-3)', async () => {
			const instance = await startConnected({
				forwardEvents: [{ event: 'access.door.unlock', targetState: '0_userdata.0.unlock' }],
			});
			await mock.deliverWebhook(
				fixtures.webhookEvents.doorUnlock({
					door: door(DOOR_3855),
					device: hub(),
					object: { authentication_type: 'PIN_CODE', authentication_value: '246813' },
				}),
			);
			await waitFor(() => instance.states.has('0_userdata.0.unlock'), { description: 'forwarded state' });
			const forwarded = String(instance.states.get('0_userdata.0.unlock')!.val);
			const logged = String(instance.val('events.last'));
			for (const text of [forwarded, logged]) {
				expect(text).to.not.contain('246813');
				expect(text).to.contain('"authentication_value":"***"');
				expect(text).to.contain('"authentication_type":"PIN_CODE"');
			}
			expect(instance.log.messages.filter(m => m.message.includes('246813'))).to.deep.equal([]);
		});

		it('a rule with device filter does not match events without any device id (R-20)', async () => {
			const instance = await startConnected({
				forwardEvents: [
					{
						event: 'access.doorbell.incoming.REN',
						deviceId: DEVICE_G2_PRO,
						targetState: '0_userdata.0.filtered',
					},
					{ event: 'access.doorbell.incoming.REN', targetState: '0_userdata.0.unfiltered' },
				],
			});
			// REN doorbells carry "device": null
			await mock.deliverWebhook(fixtures.webhookEvents.doorbellIncomingRen({ door: door(DOOR_3855) }));
			await waitFor(() => instance.states.has('0_userdata.0.unfiltered'), { description: 'unfiltered rule' });
			expect(instance.states.has('0_userdata.0.filtered')).to.equal(false);
		});

		it('a forward target that cannot be written does not stop the other rules', async () => {
			const instance = await startConnected({
				forwardEvents: [
					{ event: 'access.remote_view', targetState: '0_userdata.0.broken' },
					{ event: 'access.remote_view', targetState: '0_userdata.0.fine' },
				],
			});
			const original = instance.setForeignStateAsync.bind(instance);
			instance.setForeignStateAsync = async (id: string, state: unknown, ack?: boolean) => {
				if (id === '0_userdata.0.broken') {
					throw new Error('no such object');
				}
				return original(id, state, ack);
			};
			mock.emitRemoteView();
			await waitFor(() => instance.states.has('0_userdata.0.fine'), { description: 'second rule' });
		});
	});

	describe('built-in HTTP server: TLS (R-07)', () => {
		const tlsConfig = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
			enableTls: true,
			certPublic: 'defaultPublic',
			certPrivate: 'defaultPrivate',
			certChained: '',
			enableThumbnailServer: true,
			...overrides,
		});

		/**
		 * Start an instance with the given certificate store.
		 *
		 * @param certificates Certificate store of the fake adapter: name → PEM
		 * @param overrides Config overrides
		 */
		async function startWithCertificates(
			certificates: Record<string, string>,
			overrides: Record<string, unknown> = {},
		): Promise<FakeAdapter> {
			adapter = createAdapterWithFakeCore(MAIN, {
				controllerHost: '127.0.0.1',
				controllerPort: mock.port,
				apiToken: TOKEN,
				wsReconnectDelay: 0.05,
				listenPort,
				listenIp: '127.0.0.1',
				enableWebhooks: true,
				forwardEvents: [],
				...tlsConfig(overrides),
			});
			adapter.certificates = certificates;
			await adapter.fireReady();
			await mock.waitForWsClients(1);
			return adapter;
		}

		it('serves HTTPS with the certificate from the ioBroker certificate store and registers an https webhook URL', async () => {
			const pair = createSelfSignedCert();
			const instance = await startWithCertificates({ defaultPublic: pair.cert, defaultPrivate: pair.key });
			await waitFor(() => instance.val('info.webhookRegistered') === true, { description: 'registered' });

			// the certificate presented is the one from the store (verified against it as CA)
			const response = await httpRequest({ url: `https://127.0.0.1:${listenPort}/nothing-here`, ca: pair.cert });
			expect(response.status).to.equal(404);
			// plain HTTP is not spoken on that port any more
			const plain = await httpRequest({
				url: `http://127.0.0.1:${listenPort}/nothing-here`,
				timeoutMs: 2000,
			}).then(
				r => `answered ${r.status}`,
				() => 'refused',
			);
			expect(plain).to.not.equal('answered 404');

			expect(mock.webhookEndpoints.map(e => e.endpoint)).to.deep.equal([
				`https://127.0.0.1:${listenPort}/unifi-access-webhook`,
			]);
			expect(await instance.request('getServerInfo')).to.deep.equal({
				running: true,
				scheme: 'https',
				port: listenPort,
				baseUrl: `https://127.0.0.1:${listenPort}`,
				tlsEnabled: true,
				tlsActive: true,
				tlsError: null,
				publicBaseUrl: null,
			});
			expect(instance.log.of('error')).to.deep.equal([]);
			expect(instance.log.of('warn')).to.deep.equal([]);

			// webhooks arrive over TLS and the thumbnail URL handed out is https as well
			const event = fixtures.webhookEvents.doorUnlock({
				door: door(DOOR_3855),
				device: hub(),
				readerId: DEVICE_G2_PRO,
			});
			const [result] = await mock.deliverWebhook(event);
			expect(result.status).to.equal(200);
			await waitFor(() => instance.val(`devices.${DEVICE_G2_PRO}.lastThumbnailUrl`), {
				description: 'thumbnail url',
			});
			const url = instance.val(`devices.${DEVICE_G2_PRO}.lastThumbnailUrl`) as string;
			expect(url.startsWith(`https://127.0.0.1:${listenPort}/unifi-access/0/thumbnail/`)).to.equal(true);
			mock.addStaticResource(event.data.location.extras.door_thumbnail);
			expect((await httpRequest({ url, ca: pair.cert })).status).to.equal(200);
		});

		it('presents the chained certificate when one is configured', async () => {
			const pair = createSelfSignedCert();
			const chain = createSelfSignedCert({ commonName: 'intermediate' });
			await startWithCertificates(
				{ defaultPublic: pair.cert, defaultPrivate: pair.key, chained: chain.cert },
				{ certChained: 'chained' },
			);
			expect((await httpRequest({ url: `https://127.0.0.1:${listenPort}/x`, ca: pair.cert })).status).to.equal(
				404,
			);
		});

		for (const [name, certificates, reason] of [
			['the certificates are not in the store', {}, /Could not find certificate "defaultPublic"/],
			['the certificate is empty', { defaultPublic: '', defaultPrivate: '' }, /Could not find|empty/],
			[
				'the certificate is not PEM',
				{ defaultPublic: 'not a certificate', defaultPrivate: 'not a key' },
				/not in PEM format/,
			],
			[
				'the private key does not belong to the certificate',
				{ defaultPublic: createSelfSignedCert().cert, defaultPrivate: createSelfSignedCert().key },
				/key values mismatch|mismatch/i,
			],
		] as [string, Record<string, string>, RegExp][]) {
			// K-17: fail closed — no silent fall-back to clear text
			it(`TLS enabled but ${name}: clear error, the server is not started, no URL is registered or handed out`, async () => {
				const instance = await startWithCertificates(certificates);
				await waitFor(() => instance.val('info.connection') === true, { description: 'connected' });

				const errors = instance.log.of('error');
				expect(errors).to.have.length(1);
				expect(errors[0]).to.contain('TLS is enabled for the built-in HTTP server, but the certificates');
				expect(errors[0]).to.match(reason);
				expect(errors[0]).to.contain('The server is NOT started (no fall-back to plain http)');

				expect(await isPortFree(listenPort), 'port not opened').to.equal(true);
				expect(mock.webhookEndpoints, 'no webhook URL registered').to.deep.equal([]);
				expect(instance.val('info.webhookRegistered')).to.equal(false);
				const info = await instance.request('getServerInfo');
				expect(info).to.include({
					running: false,
					scheme: null,
					baseUrl: null,
					tlsEnabled: true,
					tlsActive: false,
				});
				expect(info.tlsError).to.match(reason);
				expect(await instance.request('reregisterWebhook')).to.deep.equal({
					ok: false,
					error: 'receiver-not-running',
				});
				expect(instance.log.of('warn').filter(m => m.includes('no usable network address'))).to.deep.equal([]);
			});
		}

		it('without TLS: plain http, no certificate lookup', async () => {
			const instance = await startConnected({ enableThumbnailServer: true });
			expect(await instance.request('getServerInfo')).to.deep.equal({
				running: true,
				scheme: 'http',
				port: listenPort,
				baseUrl: `http://127.0.0.1:${listenPort}`,
				tlsEnabled: false,
				tlsActive: false,
				tlsError: null,
				publicBaseUrl: null,
			});
		});
	});

	// U-10: behind a reverse proxy or port forwarding the listen address is not what clients and the controller use
	describe('public base URL (publicBaseUrl)', () => {
		const PUBLIC = 'https://iobroker.example.com/unifi';

		it('is used for the registered webhook URL, lastThumbnailUrl and getServerInfo', async () => {
			const instance = await startConnected({ publicBaseUrl: `  ${PUBLIC}/ `, enableThumbnailServer: true });
			await waitFor(() => instance.val('info.webhookRegistered') === true, { description: 'registered' });
			expect(mock.webhookEndpoints.map(e => e.endpoint)).to.deep.equal([`${PUBLIC}/unifi-access-webhook`]);
			expect(await instance.request('getServerInfo')).to.deep.equal({
				running: true,
				scheme: 'http',
				port: listenPort,
				baseUrl: PUBLIC,
				tlsEnabled: false,
				tlsActive: false,
				tlsError: null,
				publicBaseUrl: PUBLIC,
			});

			// the receiver itself still listens on the local address (the proxy forwards to it)
			const event = fixtures.webhookEvents.doorUnlock({
				door: door(DOOR_3855),
				device: hub(),
				readerId: DEVICE_G2_PRO,
			});
			const secret = mock.webhookEndpoints[0].secret;
			const response = await sendWebhook({
				url: `http://127.0.0.1:${listenPort}/unifi-access-webhook`,
				secret,
				body: event,
			});
			expect(response.status).to.equal(200);
			await waitFor(() => instance.val(`devices.${DEVICE_G2_PRO}.lastThumbnailUrl`), {
				description: 'thumbnail url',
			});
			expect(instance.val(`devices.${DEVICE_G2_PRO}.lastThumbnailUrl`) as string).to.match(
				new RegExp(
					`^${PUBLIC.replace(/[.]/g, '\\.')}/unifi-access/0/thumbnail/${DEVICE_G2_PRO}\\.jpg\\?ts=\\d+$`,
				),
			);
		});

		it('an unusable value is reported and the URLs are built from the listen address', async () => {
			const instance = await startConnected({ publicBaseUrl: 'iobroker.example.com/x?y' });
			expect(instance.log.of('warn')).to.deep.equal([
				'The public base URL "iobroker.example.com/x?y" is not usable (expected http(s)://host[:port][/path] without query, fragment or blanks) — the URLs are built from the listen address instead.',
			]);
			await waitFor(() => instance.val('info.webhookRegistered') === true, { description: 'registered' });
			expect(mock.webhookEndpoints.map(e => e.endpoint)).to.deep.equal([
				`http://127.0.0.1:${listenPort}/unifi-access-webhook`,
			]);
			expect((await instance.request('getServerInfo')).publicBaseUrl).to.equal(null);
		});

		it('an endpoint registered with the listen address is moved to the public URL (same id and secret, no restart)', async () => {
			const existing = mock.addWebhookEndpoint({
				endpoint: `http://127.0.0.1:${listenPort}/unifi-access-webhook`,
				name: ENDPOINT_NAME,
			});
			const instance = await startConnected({
				publicBaseUrl: PUBLIC,
				webhookEndpointId: existing.id,
				webhookSecret: existing.secret,
			});
			await waitFor(() => mock.webhookEndpoints[0].endpoint === `${PUBLIC}/unifi-access-webhook`, {
				description: 'moved',
			});
			expect(mock.webhookEndpoints).to.have.length(1);
			expect(mock.webhookEndpoints[0].id).to.equal(existing.id);
			expect(instance.objects.has(INSTANCE_OBJECT), 'no write to the instance object').to.equal(false);
		});

		it('there is no URL while the server does not run, also with a public base URL', async () => {
			const instance = await startConnected({ publicBaseUrl: PUBLIC, enableWebhooks: false });
			expect(await instance.request('getServerInfo')).to.include({
				running: false,
				baseUrl: null,
				publicBaseUrl: PUBLIC,
			});
		});
	});

	describe('built-in HTTP server: started only when needed (R-17)', () => {
		it('does not open the port when no receiver is enabled', async () => {
			const instance = await startConnected({ enableWebhooks: false });
			expect(await isPortFree(listenPort)).to.equal(true);
			expect(await instance.request('getServerInfo')).to.include({ running: false, scheme: null, baseUrl: null });
			expect(instance.log.of('warn')).to.deep.equal([]);
		});

		it('refuses to (re)register a webhook nothing would listen for', async () => {
			const instance = await startConnected({ enableWebhooks: false, enableThumbnailServer: true });
			expect(await instance.request('reregisterWebhook')).to.deep.equal({
				ok: false,
				error: 'webhooks-disabled',
			});
			expect(mock.webhookEndpoints).to.deep.equal([]);
			expect(mock.findRequests({ path: /^\/webhooks/ })).to.deep.equal([]);
		});

		it('a port that is already in use is reported; the adapter keeps running without receivers and hands out no URLs', async () => {
			const blocker = createServer();
			await new Promise<void>(resolve => blocker.listen(listenPort, '127.0.0.1', resolve));
			try {
				const instance = await startConnected({ enableThumbnailServer: true });
				expect(
					instance.log.of('warn').filter(m => m.startsWith('Shared HTTP server failed to start')),
				).to.have.length(1);
				expect(instance.val('info.connection')).to.equal(true);
				expect(mock.webhookEndpoints, 'no endpoint registered for a receiver that does not run').to.deep.equal(
					[],
				);
				expect(await instance.request('reregisterWebhook')).to.deep.equal({
					ok: false,
					error: 'receiver-not-running',
				});
				mock.emitRemoteView({
					data: { door_thumbnail: `/preview/reader_${DEVICE_G2_PRO}_x_1.jpg` },
				});
				await waitFor(() => instance.val(`devices.${DEVICE_G2_PRO}.lastThumbnailPath`), {
					description: 'thumbnail path',
				});
				// no URL is handed out: the state is written, but empty (E-04: no stale URL is left behind)
				await waitFor(() => instance.stateWrites.some(w => w.id.endsWith('lastThumbnailUrl')), {
					description: 'thumbnail url state',
				});
				expect(
					instance.stateWrites.filter(w => w.id.endsWith('lastThumbnailUrl')).map(w => w.val),
				).to.deep.equal(['']);
			} finally {
				await new Promise(resolve => blocker.close(resolve));
			}
		});

		it('unload does not wait for a client that keeps its connection open', async () => {
			const instance = await startConnected({ enableThumbnailServer: true });
			const idle = connect(listenPort, '127.0.0.1');
			await new Promise(resolve => idle.once('connect', resolve));
			idle.write('GET /unifi-access/0/thumbnail/x.jpg HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n');
			await new Promise(resolve => idle.once('data', resolve));
			const started = Date.now();
			await instance.fireUnload();
			expect(Date.now() - started).to.be.lessThan(1500);
			expect(await isPortFree(listenPort)).to.equal(true);
			idle.destroy();
		});
	});

	describe('generic alarm webhook: authentication and logging (R-14)', () => {
		const post = (
			headers: Record<string, string> = {},
			body = '{"alarm_id":"secret-alarm-body"}',
		): Promise<{ status: number }> =>
			httpRequest({ url: `http://127.0.0.1:${listenPort}/webhook`, method: 'POST', headers, body });

		it('"basic" without configured credentials: warns at start and rejects everything, also empty credentials', async () => {
			const instance = await startConnected({
				enableWebhooks: false,
				enableGenericWebhook: true,
				genericWebhookAuth: 'basic',
				genericWebhookUsername: '',
				genericWebhookPassword: '',
			});
			expect(instance.log.of('warn')).to.deep.equal([
				'Generic webhook: authentication "basic" is selected but no user name and password are configured — every request will be rejected.',
			]);
			for (const headers of [
				{},
				{ Authorization: 'Basic Og==' },
				{ Authorization: `Basic ${Buffer.from(':').toString('base64')}` },
			] as Record<string, string>[]) {
				expect((await post(headers)).status).to.equal(401);
			}
			expect(instance.stateWrites.filter(w => w.id.includes('.notifications.'))).to.deep.equal([]);
		});

		it('"bearer" without configured token: warns at start and rejects everything', async () => {
			const instance = await startConnected({
				enableWebhooks: false,
				enableGenericWebhook: true,
				genericWebhookAuth: 'bearer',
				genericWebhookToken: '',
			});
			expect(instance.log.of('warn')).to.have.length(1);
			expect(instance.log.of('warn')[0]).to.contain('no token is configured');
			expect((await post({ Authorization: 'Bearer ' })).status).to.equal(401);
			expect((await post({ Authorization: 'Bearer undefined' })).status).to.equal(401);
		});

		it('logs the body of an accepted request once, at debug level only', async () => {
			const instance = await startConnected({
				enableWebhooks: false,
				enableGenericWebhook: true,
				genericWebhookAuth: 'bearer',
				genericWebhookToken: 'generic-token',
			});
			expect((await post({ Authorization: 'Bearer generic-token' })).status).to.equal(200);
			const withBody = instance.log.messages.filter(m => m.message.includes('secret-alarm-body'));
			expect(withBody.map(m => m.level)).to.deep.equal(['debug']);
			expect(instance.log.messages.filter(m => m.message.includes('generic-token'))).to.deep.equal([]);
			expect(instance.val('notifications.lastAlarmId')).to.equal('secret-alarm-body');
		});
	});

	describe('generic alarm webhook on a path of the adapter itself (RK-03)', () => {
		for (const path of ['unifi-access-webhook', '/unifi-access-webhook', '//unifi-access-webhook']) {
			it(`"${path}": not started, one error names the collision, the UniFi webhook keeps working`, async () => {
				const instance = await startConnected({ enableGenericWebhook: true, genericWebhookPath: path });
				await waitFor(() => instance.val('info.webhookRegistered') === true, { description: 'registered' });
				const errors = instance.log.of('error');
				expect(errors).to.have.length(1);
				expect(errors[0]).to.contain('Generic webhook NOT started');
				expect(errors[0]).to.contain(
					'"/unifi-access-webhook" is reserved for the UniFi Access webhook receiver',
				);

				const [result] = await mock.deliverWebhook(
					fixtures.webhookEvents.doorbellCompleted({ door: door(DOOR_A2), device: hub() }),
				);
				expect(result.status, 'signed UniFi webhook').to.equal(200);
				expect(instance.log.of('warn').filter(w => w.includes('signature'))).to.deep.equal([]);
			});
		}

		it('a path below /unifi-access/ is refused as well (thumbnail and Protect media routes)', async () => {
			const instance = await startConnected({
				enableWebhooks: false,
				enableThumbnailServer: true,
				enableGenericWebhook: true,
				genericWebhookPath: '/unifi-access/0/thumbnail/alarm',
			});
			expect(instance.log.of('error')).to.have.length(1);
			expect(instance.log.of('error')[0]).to.contain('reserved for the thumbnail and Protect media server');
			const answer = await httpRequest({
				url: `http://127.0.0.1:${listenPort}/unifi-access/0/thumbnail/alarm`,
				method: 'POST',
				body: '{"alarm_id":"x"}',
			});
			expect(answer.status).to.not.equal(200);
			expect(instance.val('notifications.lastAlarmId')).to.equal(undefined);
		});

		it('similar but free paths are accepted', async () => {
			const instance = await startConnected({
				enableGenericWebhook: true,
				genericWebhookPath: '/unifi-access-webhook2',
			});
			expect(instance.log.of('error')).to.deep.equal([]);
			const answer = await httpRequest({
				url: `http://127.0.0.1:${listenPort}/unifi-access-webhook2`,
				method: 'POST',
				body: '{"alarm_id":"free-path"}',
			});
			expect(answer.status).to.equal(200);
			await waitFor(() => instance.val('notifications.lastAlarmId') === 'free-path', { description: 'alarm' });
		});
	});

	describe('Protect clips are streamed (R-15)', () => {
		let protect: ProtectStub;

		beforeEach(async () => {
			protect = new ProtectStub();
			await protect.start();
			listenPort = await portOtherThan(listenPort, protect.port);
		});

		afterEach(async () => {
			await adapter?.fireUnload();
			adapter = undefined;
			await protect.stop();
		});

		it('passes a clip through the media endpoint without buffering it in the adapter', async () => {
			protect.clip = Buffer.alloc(3 * 1024 * 1024, 5);
			protect.events.evt_9 = { id: 'evt_9', clipUrl: 'video/export?camera=c1' };
			const instance = await startConnected({
				enableWebhooks: false,
				enableProtect: true,
				protectUsername: 'viewer',
				protectPassword: 'protect-secret',
				protectPort: protect.port,
			});
			expect(instance.val('info.protectConnected')).to.equal(true);
			const response = await httpRequest({
				url: `http://127.0.0.1:${listenPort}/unifi-access/0/protect-video/evt_9.mp4`,
				timeoutMs: 5000,
			});
			expect(response.status).to.equal(200);
			expect(response.headers['content-type']).to.equal('video/mp4');
			expect(response.headers['content-length']).to.equal(String(protect.clip.length));
			expect(response.body.equals(protect.clip)).to.equal(true);
		});

		it('answers 502 while Protect is not connected instead of failing the request handler', async () => {
			const instance = await startConnected({
				enableWebhooks: false,
				enableProtect: true,
				protectUsername: 'viewer',
				protectPassword: 'wrong',
				protectPort: protect.port,
			});
			expect(instance.val('info.protectConnected')).to.equal(false);
			const video = await httpRequest({
				url: `http://127.0.0.1:${listenPort}/unifi-access/0/protect-video/evt_9.mp4`,
			});
			expect(video.status).to.equal(502);
			// a snapshot URL is only ever answered from the cache of door-event snapshots (K-02)
			const snapshot = await httpRequest({
				url: `http://127.0.0.1:${listenPort}/unifi-access/0/protect-snapshot/66a1b2c3d4e5f60718293a4b/1.jpg`,
			});
			expect(snapshot.status).to.equal(404);
		});

		// K-02 / U-03: after a restart the snapshot of an old door event is gone — no live picture in its place
		it('the snapshot URL of a door event from before a restart answers 404 without asking Protect', async () => {
			await startConnected({
				enableWebhooks: false,
				enableProtect: true,
				protectUsername: 'viewer',
				protectPassword: 'protect-secret',
				protectPort: protect.port,
			});
			const before = protect.requests.length;
			const response = await httpRequest({
				url: `http://127.0.0.1:${listenPort}/unifi-access/0/protect-snapshot/66a1b2c3d4e5f60718293a4b/1722913291000.jpg`,
			});
			expect(response.status).to.equal(404);
			expect(protect.requests.slice(before)).to.deep.equal([]);
		});
	});

	describe('unload', () => {
		it('closes WebSocket and HTTP server and leaves no timer behind', async () => {
			const instance = await startConnected({ enableThumbnailServer: true });
			instance.fireStateChange(`doors.${DOOR_3855}.unlock`, true);
			await waitFor(() => instance.val(`doors.${DOOR_3855}.locked`) === false, { description: 'locked=false' });
			mock.emitRemoteUnlock(DOOR_A2);
			await waitFor(() => instance.val(`doors.${DOOR_A2}.locked`) === false, { description: 'locked=false' });
			expect((await httpRequest({ url: `http://127.0.0.1:${listenPort}/` })).status).to.equal(404);
			expect(clock.countTimers()).to.be.greaterThan(0);

			await instance.fireUnload();

			expect(clock.countTimers(), 'pending timers after unload').to.equal(0);
			await waitFor(() => mock.wsClients.size === 0, { description: 'WebSocket closed' });
			expect(await isPortFree(listenPort), 'HTTP port released').to.equal(true);

			const handshakes = mock.wsHandshakes.length;
			const requests = mock.requests.length;
			await clock.tickAsync(120_000);
			await delay(50);
			expect(mock.wsHandshakes, 'no reconnect after unload').to.have.length(handshakes);
			expect(mock.requests, 'no API calls after unload').to.have.length(requests);
		});

		describe('stopped while the start is still running (RK-01)', () => {
			let protect: ProtectStub;
			const stubs: sinon.SinonStub[] = [];

			beforeEach(async () => {
				protect = new ProtectStub();
				await protect.start();
				listenPort = await portOtherThan(listenPort, protect.port);
			});

			afterEach(async () => {
				for (const stub of stubs.splice(0)) {
					stub.restore();
				}
				await protect.stop();
			});

			const config = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
				controllerHost: '127.0.0.1',
				controllerPort: mock.port,
				apiToken: TOKEN,
				wsReconnectDelay: 0.05,
				listenPort,
				listenIp: '127.0.0.1',
				enableWebhooks: true,
				enableThumbnailServer: true,
				forwardEvents: [],
				enableProtect: true,
				protectUsername: 'viewer',
				protectPassword: 'protect-secret',
				protectPort: protect.port,
				...overrides,
			});

			/**
			 * Start an instance and stop it at the point `arm` picks; afterwards nothing may be left running.
			 *
			 * @param arm Installs the trigger; calls `stop()` at the moment the instance is to be stopped
			 * @param overrides Config overrides
			 */
			async function stopDuringStart(
				arm: (instance: FakeAdapter, stop: () => void) => void,
				overrides: Record<string, unknown> = {},
			): Promise<FakeAdapter> {
				const instance = createAdapterWithFakeCore(MAIN, config(overrides));
				let unloaded: Promise<void> | undefined;
				arm(instance, () => {
					unloaded ??= instance.fireUnload();
				});
				const ready = instance.fireReady();
				await ready;
				expect(unloaded, 'the stop was triggered during the start').to.not.equal(undefined);
				await unloaded;
				await delay(50);
				return instance;
			}

			/**
			 * Stop the instance right before the given method of the fake core runs with matching arguments.
			 *
			 * @param inst The adapter
			 * @param method Method of the fake core
			 * @param when Decides by the arguments whether this call is the trigger
			 * @param stop Stops the instance
			 */
			function stopBefore(
				inst: FakeAdapter,
				method: string,
				when: (args: unknown[]) => boolean,
				stop: () => void,
			): void {
				const target = inst as unknown as Record<string, (...args: unknown[]) => unknown>;
				const original = target[method].bind(inst);
				target[method] = (...args: unknown[]) => {
					if (when(args)) {
						stop();
					}
					return original(...args);
				};
			}

			async function expectNothingRunning(instance: FakeAdapter): Promise<void> {
				expect(await isPortFree(listenPort), 'HTTP port released').to.equal(true);
				expect(protect.logins, 'no Protect login after the stop').to.deep.equal([]);
				expect(mock.wsHandshakes, 'no WebSocket after the stop').to.have.length(0);
				expect(clock.countTimers(), 'no timer after the stop').to.equal(0);
				expect(instance.timers.size + instance.intervals.size).to.equal(0);
				const requests = mock.requests.length;
				await clock.tickAsync(20 * 60_000);
				await delay(30);
				expect(mock.requests, 'no API call after the stop').to.have.length(requests);
				expect(protect.logins).to.deep.equal([]);
			}

			it('stopped right at the beginning: no server, no WebSocket, no Protect login', async () => {
				const instance = await stopDuringStart((inst, stop) => {
					// the first await of the start: the stop arrives before anything was set up
					stopBefore(inst, 'setState', () => true, stop);
				});
				expect(mock.requests).to.have.length(0);
				await expectNothingRunning(instance);
			});

			it('stopped while the TLS certificates are loaded: the server is not started', async () => {
				const pair = createSelfSignedCert();
				const instance = await stopDuringStart(
					(inst, stop) => {
						inst.certificates = { defaultPublic: pair.cert, defaultPrivate: pair.key };
						stopBefore(inst, 'getCertificatesAsync', () => true, stop);
					},
					{ enableTls: true, certPublic: 'defaultPublic', certPrivate: 'defaultPrivate' },
				);
				await expectNothingRunning(instance);
			});

			it('stopped while the port is being bound: the server is closed again at once', async () => {
				const instance = await stopDuringStart((_inst, stop) => {
					const original = SharedHttpServer.prototype.start;
					stubs.push(
						sinon.stub(SharedHttpServer.prototype, 'start').callsFake(async function (
							this: SharedHttpServer,
						) {
							stop();
							await original.call(this);
						}),
					);
				});
				await expectNothingRunning(instance);
			});

			it('stopped while the controller state is loaded: no WebSocket, no Protect login', async () => {
				const instance = await stopDuringStart((inst, stop) => {
					stopBefore(
						inst,
						'setObjectNotExistsAsync',
						([id]) => String(id).includes(`doors.${DOOR_A2}`),
						stop,
					);
				});
				await expectNothingRunning(instance);
			});

			it('stopped while the Protect password is read: no Protect login', async () => {
				const instance = await stopDuringStart((inst, stop) => {
					stopBefore(inst, 'getForeignObjectAsync', ([id]) => id === INSTANCE_OBJECT, stop);
				});
				// the controller was reached before the stop; the WebSocket it opened is closed again
				await waitFor(() => mock.wsClients.size === 0, { description: 'WebSocket closed' });
				expect(await isPortFree(listenPort)).to.equal(true);
				expect(protect.logins).to.deep.equal([]);
				expect(clock.countTimers()).to.equal(0);
				expect(instance.timers.size + instance.intervals.size).to.equal(0);
			});

			it('stopped during a failing Protect login: no retry is planned and nothing is reported', async () => {
				protect.failLogins(503, 5);
				const instance = await stopDuringStart((_inst, stop) => {
					const original = ProtectHttp.prototype.login;
					stubs.push(
						sinon.stub(ProtectHttp.prototype, 'login').callsFake(async function (this: ProtectHttp) {
							stop();
							await original.call(this);
						}),
					);
				});
				expect(protect.logins.map(l => l.status)).to.deep.equal([503]);
				expect(instance.log.of('warn').filter(w => w.includes('Protect login failed'))).to.deep.equal([]);
				const logins = protect.logins.length;
				await clock.tickAsync(20 * 60_000);
				await delay(30);
				expect(protect.logins, 'no login retry after the stop').to.have.length(logins);
			});
		});

		it('cancels a pending bootstrap retry', async () => {
			mock.failNext({ status: 500, times: Number.POSITIVE_INFINITY });
			const instance = await start({ enableWebhooks: false });
			// the parallel bootstrap requests that are still in flight hold their own request timeouts for a moment
			await waitFor(() => clock.countTimers() === 1, { description: 'only the retry timer pending' });

			await instance.fireUnload();

			expect(clock.countTimers()).to.equal(0);
			const requests = mock.requests.length;
			await clock.tickAsync(120_000);
			await delay(30);
			expect(mock.requests).to.have.length(requests);
		});
	});
});
