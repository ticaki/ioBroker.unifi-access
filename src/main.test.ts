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
	ProtectStub,
	sendWebhook,
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
			expect(instance.log.of('warn')).to.deep.equal([
				'Bootstrap failed (network): Request failed with status code 500',
			]);

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
			});
			// the WebRTC credentials of the call are not forwarded (R-19)
			const { channel, token, ...data } = ring.data;
			expect(JSON.parse(forwarded.val as string).raw).to.deep.equal({ ...ring, data });
			expect(forwarded.val).to.not.contain(channel).and.not.contain(token);
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
