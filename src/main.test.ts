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
		// the client side of the WebSocket is open once the heartbeat interval runs
		await waitFor(() => instance.intervals.size === 1, { description: 'WebSocket open in the adapter' });
		return instance;
	}

	beforeEach(async () => {
		mock = new MockUnifiController({ token: TOKEN });
		await mock.start();
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

		it('makes up for a failed registration at the next reconnect and does not repeat the warning', async () => {
			mock.failNext({ path: '/webhooks/endpoints', status: 500, times: 2 });
			const instance = await startConnected();
			expect(instance.val('info.webhookRegistered')).to.equal(false);

			for (let i = 0; i < 2 && instance.val('info.webhookRegistered') !== true; i++) {
				mock.dropWsConnections();
				await waitFor(() => instance.val('info.connection') === false, { description: 'connection lost' });
				await clock.tickAsync(200);
				await waitFor(() => instance.val('info.connection') === true, { description: 'reconnected' });
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

		it('an authentication error code with HTTP 200 is reported as "unauthorized"', async () => {
			mock.failNext({ status: 200, code: 'CODE_ACCESS_TOKEN_INVALID', times: Number.POSITIVE_INFINITY });
			const instance = await start({ enableWebhooks: false });
			expect(await instance.request('getConnectionStatus')).to.include({
				connected: false,
				lastError: 'unauthorized',
			});
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
	});

	describe('connection state and resync (R-02)', () => {
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
			).to.deep.equal({
				ok: true,
				controllerName: 'UNVR - Main Floor',
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
			it(`TLS enabled but ${name}: clear error, server runs on http and no https URL is registered or handed out`, async () => {
				const instance = await startWithCertificates(certificates);
				await waitFor(() => instance.val('info.webhookRegistered') === true, { description: 'registered' });

				const errors = instance.log.of('error');
				expect(errors).to.have.length(1);
				expect(errors[0]).to.contain('TLS is enabled for the built-in HTTP server, but the certificates');
				expect(errors[0]).to.match(reason);
				expect(errors[0]).to.contain('WITHOUT TLS');

				expect((await httpRequest({ url: `http://127.0.0.1:${listenPort}/nothing-here` })).status).to.equal(
					404,
				);
				expect(mock.webhookEndpoints.map(e => e.endpoint)).to.deep.equal([
					`http://127.0.0.1:${listenPort}/unifi-access-webhook`,
				]);
				const info = await instance.request('getServerInfo');
				expect(info).to.include({
					running: true,
					scheme: 'http',
					baseUrl: `http://127.0.0.1:${listenPort}`,
					tlsEnabled: true,
					tlsActive: false,
				});
				expect(info.tlsError).to.match(reason);

				const event = fixtures.webhookEvents.doorUnlock({
					door: door(DOOR_3855),
					device: hub(),
					readerId: DEVICE_G2_PRO,
				});
				await mock.deliverWebhook(event);
				await waitFor(() => instance.val(`devices.${DEVICE_G2_PRO}.lastThumbnailUrl`), {
					description: 'thumbnail url',
				});
				expect(instance.val(`devices.${DEVICE_G2_PRO}.lastThumbnailUrl`)).to.match(/^http:\/\//);
				expect(JSON.stringify([...instance.states.values()])).to.not.contain('https://127.0.0.1');
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
				expect(instance.stateWrites.filter(w => w.id.endsWith('lastThumbnailUrl'))).to.deep.equal([]);
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

	describe('Protect clips are streamed (R-15)', () => {
		let protect: ProtectStub;

		beforeEach(async () => {
			protect = new ProtectStub();
			await protect.start();
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
			for (const path of ['protect-video/evt_9.mp4', 'protect-snapshot/66a1b2c3d4e5f60718293a4b/1.jpg']) {
				const response = await httpRequest({ url: `http://127.0.0.1:${listenPort}/unifi-access/0/${path}` });
				expect(response.status, path).to.equal(502);
			}
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
