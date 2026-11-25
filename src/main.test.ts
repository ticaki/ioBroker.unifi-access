/**
 * Time-dependent behaviour of the adapter class (src/main.ts).
 *
 * The adapter runs in-process on a stand-in for @iobroker/adapter-core (test/mock/fakeAdapterCore.js)
 * and talks to the mock UniFi Access controller over real sockets, while sinon fake timers
 * control the adapter's long timers (4 s unlock de-duplication, 5 s / N min re-lock, 3 s system
 * log lookup, 30 s bootstrap retry). Everything that does not need fake timers is tested against
 * a real js-controller in test/functional/adapterTests.js (`npm run test:integration`).
 */

import { expect } from 'chai';
import { join } from 'node:path';
import sinon from 'sinon';

import {
	createAdapterWithFakeCore,
	delay,
	fixtures,
	getFreePort,
	httpRequest,
	isPortFree,
	MockUnifiController,
	waitFor,
	type FakeAdapter,
} from '../test/mock';

const TOKEN = 'main-test-token';
const MAIN = join(__dirname, 'main');
const NS = 'unifi-access.0';
const INSTANCE_OBJECT = `system.adapter.${NS}`;
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
				name: `ioBroker.unifi-access (${NS})`,
			});
			const instance = await startConnected({ webhookEndpointId: existing.id, webhookSecret: existing.secret });
			expect(instance.objects.has(INSTANCE_OBJECT)).to.equal(false);
			expect(mock.webhookEndpoints).to.deep.equal([existing]);
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

		it('keeps retrying every 30 s while the controller stays down', async () => {
			mock.failNext({ status: 500, times: Number.POSITIVE_INFINITY });
			await start({ enableWebhooks: false });
			for (let attempt = 2; attempt <= 4; attempt++) {
				await clock.tickAsync(30_000);
				await waitFor(() => mock.findRequests({ path: '/devices' }).length === attempt, {
					description: `bootstrap attempt ${attempt}`,
				});
			}
		});

		// BUG-C-14: the webhook endpoint is registered exactly once, right after the first bootstrap attempt.
		// If the controller is unreachable at that moment the registration fails ("Webhook registration failed")
		// and is never repeated — not even after the bootstrap retry succeeded. Webhook events stay off until
		// the adapter is restarted.
		it.skip('BUG-C-14: registers the webhook after the controller became reachable', async () => {
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

	describe('door unlock: re-lock timer', () => {
		it('pulse unlock: locked=false immediately, back to true after 5 s', async () => {
			const instance = await startConnected();
			instance.fireStateChange(`doors.${DOOR_3855}.unlock`, true);
			await waitFor(() => instance.val(`doors.${DOOR_3855}.locked`) === false, { description: 'locked=false' });
			expect(mock.unlocks.map(u => u.doorId)).to.deep.equal([DOOR_3855]);
			expect(instance.states.get(`${NS}.doors.${DOOR_3855}.unlock`)).to.include({ val: true, ack: true });

			await clock.tickAsync(4999);
			expect(instance.val(`doors.${DOOR_3855}.locked`)).to.equal(false);
			await clock.tickAsync(1);
			await waitFor(() => instance.val(`doors.${DOOR_3855}.locked`) === true, { description: 'locked=true' });
		});

		it('timed unlock (defaultUnlockDuration = 2): back to locked after 2 minutes', async () => {
			const instance = await startConnected({ defaultUnlockDuration: 2 });
			instance.fireStateChange(`doors.${DOOR_3855}.unlock`, true);
			await waitFor(() => instance.val(`doors.${DOOR_3855}.locked`) === false, { description: 'locked=false' });
			expect(mock.findRequests({ path: `/doors/${DOOR_3855}/lock_rule` }).map(r => r.body)).to.deep.equal([
				{ type: 'custom', interval: 2 },
			]);

			await clock.tickAsync(2 * 60_000 - 1);
			expect(instance.val(`doors.${DOOR_3855}.locked`)).to.equal(false);
			await clock.tickAsync(1);
			await waitFor(() => instance.val(`doors.${DOOR_3855}.locked`) === true, { description: 'locked=true' });
		});

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

	describe('system log lookup after an unlock', () => {
		it('queries the system logs 3 s after access.door.unlock for a window around the event', async () => {
			const instance = await startConnected();
			await mock.deliverWebhook(fixtures.webhookEvents.doorUnlock({ door: door(DOOR_3855), device: hub() }));
			const ts = events()[0].ts;
			expect(mock.findRequests({ path: '/system/logs' })).to.have.length(0);

			await clock.tickAsync(2999);
			await delay(30);
			expect(mock.findRequests({ path: '/system/logs' })).to.have.length(0);
			await clock.tickAsync(1);
			await waitFor(() => mock.findRequests({ path: '/system/logs' }).length === 2, {
				description: 'log queries',
			});

			const queries = mock.findRequests({ path: '/system/logs' });
			expect(queries.every(q => q.method === 'POST')).to.equal(true);
			expect(queries[0].body).to.deep.equal({
				topic: 'door_openings',
				since: Math.floor(ts / 1000) - 10,
				until: Math.floor(ts / 1000) + 30,
			});
			expect(instance.log.of('warn').filter(m => m.includes('system-logs'))).to.deep.equal([]);
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
				raw: ring,
			});
			expect(instance.states.has('0_userdata.0.other')).to.equal(false);
			expect(instance.states.has('0_userdata.0.change')).to.equal(false);
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
