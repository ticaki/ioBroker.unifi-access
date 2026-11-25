'use strict';

/**
 * Adapter-level functional tests: a real adapter instance (own process, real js-controller
 * databases, started through @iobroker/testing) talks to the mock UniFi Access controller.
 *
 * Wired into test/integration.js via `tests.integration(dir, { defineAdditionalTests })`.
 * Every suite starts its own mock controller on an OS-assigned port and its own adapter
 * instance with a matching configuration; nothing touches a real controller or the network.
 *
 * Timing: the adapter runs in a separate process, so fake timers are not available here.
 * Behaviour that depends on long timers (4 s unlock de-duplication, 5 s re-lock, 30 s
 * bootstrap retry) is covered in src/main.test.ts with an in-process adapter instead.
 */

const { expect } = require('chai');

const { startMockController, getFreePort, httpRequest, sendWebhook, waitFor, delay, fixtures } = require('../mock');
const tools = require('./harnessTools');

const TOKEN = 'integration-test-token';
const GENERIC_TOKEN = 'generic-webhook-token';
const WEBHOOK_PATH = '/unifi-access-webhook';
const FORWARD_TARGET = '0_userdata.0.unifiAccessForwardTest';
/** 50 ms WebSocket reconnect delay keeps the reconnect test fast */
const WS_RECONNECT_SECONDS = 0.05;

const { DEVICE_HUB, DEVICE_G2_PRO, DEVICE_ULTRA, DEVICE_LITE } = fixtures.IDS;
const USER = fixtures.DEFAULT_USERS[0];

/** One door per scenario: the adapter re-locks a door 5 s after a pulse, tests must not share that state. */
const DOORS = {
	pulse: '10000000-0000-4000-8000-000000000001',
	duration: '10000000-0000-4000-8000-000000000002',
	rule: '10000000-0000-4000-8000-000000000003',
	ws: '10000000-0000-4000-8000-000000000004',
	hook: '10000000-0000-4000-8000-000000000005',
	untouched: '10000000-0000-4000-8000-000000000006',
};

function integrationDoors() {
	return Object.entries(DOORS).map(([key, doorId]) => ({
		id: doorId,
		name: `Door ${key}`,
		full_name: `UNVR - 1F - Door ${key}`,
		floor_id: '7c62b4b3-692f-44ea-8eb8-e212833b4e0f',
		type: 'door',
		is_bind_hub: true,
		door_lock_relay_status: 'lock',
		door_position_status: 'close',
	}));
}

/**
 * @param {{ suite: (name: string, fn: (getHarness: () => any) => void) => void, describe: Mocha.SuiteFunction, it: Mocha.TestFunction }} args
 *   Test definition helpers handed in by @iobroker/testing
 */
function defineAdapterTests({ suite, describe, it }) {
	// ====================================================================================
	suite('UniFi Access adapter against the mock controller (pulse unlock, all receivers enabled)', getHarness => {
		let harness;
		let mock;
		let listenPort;
		let baseUrl;
		let webhookUrl;

		const state = localId => tools.stateValue(harness, localId);
		const door = key => mock.findDoor(DOORS[key]);
		/** commands sent for a door (status checks — GET — follow on their own schedule and are not counted) */
		const doorRequests = key =>
			mock.findRequests({ path: new RegExp(`^/doors/${DOORS[key]}/`) }).filter(r => r.method !== 'GET');
		const endpoint = () => mock.webhookEndpoints[0];

		before(async function () {
			this.timeout(60_000);
			harness = getHarness();
			mock = await startMockController({ token: TOKEN, doors: integrationDoors() });
			listenPort = await getFreePort();
			baseUrl = `http://127.0.0.1:${listenPort}`;
			webhookUrl = `${baseUrl}${WEBHOOK_PATH}`;

			await tools.setObject(harness, FORWARD_TARGET, {
				type: 'state',
				common: { name: 'forward target', type: 'string', role: 'json', read: true, write: true },
				native: {},
			});
			await tools.configureAdapter(harness, {
				controllerHost: '127.0.0.1',
				controllerPort: mock.port,
				apiToken: TOKEN,
				verifyTLS: false,
				wsReconnectDelay: WS_RECONNECT_SECONDS,
				defaultUnlockDuration: 0,
				listenPort,
				listenIp: '127.0.0.1',
				enableWebhooks: true,
				enableThumbnailServer: true,
				enableGenericWebhook: true,
				genericWebhookPath: '/webhook',
				genericWebhookAuth: 'bearer',
				genericWebhookToken: GENERIC_TOKEN,
				forwardEvents: [{ event: 'access.door.unlock', targetState: FORWARD_TARGET }],
			});
			await harness.startAdapterAndWait(true);
			await tools.waitForState(harness, 'info.webhookRegistered', s => s.val === true, 10_000);
			await mock.waitForWsClients(1, 5000);
		});

		after(async function () {
			this.timeout(20_000);
			await tools.stopAdapter(harness);
			await mock.stop();
		});

		describe('startup', function () {
			this.timeout(10_000);

			it('sets info.connection to true (acknowledged)', async () => {
				const connection = await tools.getState(harness, tools.id('info.connection'));
				expect(connection.val).to.equal(true);
				expect(connection.ack).to.equal(true);
			});

			it('bootstraps with exactly the documented read requests and the bearer token', () => {
				const reads = mock.requests.filter(r => r.method === 'GET' && !r.path.startsWith('/webhooks'));
				expect(reads.map(r => r.url).sort()).to.deep.equal(
					[
						'/api/v1/developer/devices?refresh=true',
						'/api/v1/developer/doors',
						'/api/v1/developer/users?page_num=1&page_size=100',
						'/api/v1/developer/doors/settings/emergency',
						// 7.11: the temporary lock rule of every door
						...Object.values(DOORS).map(doorId => `/api/v1/developer/doors/${doorId}/lock_rule`),
					].sort(),
				);
				for (const request of mock.requests) {
					expect(request.headers.authorization, request.url).to.equal(`Bearer ${TOKEN}`);
					expect(request.status, request.url).to.equal(200);
				}
			});

			it('opens exactly one authenticated WebSocket to /devices/notifications', () => {
				expect(mock.wsHandshakes).to.have.length(1);
				expect(mock.wsHandshakes[0].url).to.equal('/api/v1/developer/devices/notifications');
				expect(mock.wsHandshakes[0].headers.authorization).to.equal(`Bearer ${TOKEN}`);
				expect(mock.wsClients.size).to.equal(1);
			});

			it('creates a channel with typed states for every device (all groups of the nested list)', async () => {
				for (const device of fixtures.DEFAULT_DEVICES.flat()) {
					const channel = await tools.getObject(harness, tools.id(`devices.${device.id}`));
					expect(channel, device.id).to.be.an('object');
					expect(channel.type, device.id).to.equal('channel');
					expect(channel.common.name, device.id).to.equal(device.name);
					expect(await state(`devices.${device.id}.name`), device.id).to.equal(device.name);
					expect(await state(`devices.${device.id}.alias`), device.id).to.equal(device.alias);
					expect(await state(`devices.${device.id}.type`), device.id).to.equal(device.type);
					expect(await state(`devices.${device.id}.online`), device.id).to.equal(true);
				}
				expect(await state(`devices.${DEVICE_ULTRA}.model`)).to.equal('UA-Ultra');
				expect(await state(`devices.${DEVICE_G2_PRO}.model`)).to.equal('UA-G2-Pro');
				expect(await state(`devices.${DEVICE_HUB}.model`)).to.equal('UA-Hub');
				expect(await state(`devices.${DEVICE_LITE}.model`)).to.equal('UA-Lite');

				const ultra = await tools.getObject(harness, tools.id(`devices.${DEVICE_ULTRA}`));
				expect(ultra.native.capabilities).to.deep.equal([
					'event-thumbnail',
					'doorbell',
					'door-unlock',
					'live-events',
				]);

				const online = await tools.getObject(harness, tools.id(`devices.${DEVICE_ULTRA}.online`));
				expect(online.type).to.equal('state');
				expect(online.common).to.include({ type: 'boolean', role: 'value', read: true, write: false });
				const name = await tools.getObject(harness, tools.id(`devices.${DEVICE_ULTRA}.name`));
				expect(name.common).to.include({ type: 'string', role: 'value', read: true, write: false });
				expect(await tools.getObject(harness, tools.id(`devices.${DEVICE_ULTRA}.lastThumbnailPath`))).to.be.an(
					'object',
				);
				expect(
					await tools.getObject(harness, tools.id(`devices.${DEVICE_HUB}.lastThumbnailPath`)),
				).to.not.be.an('object');
			});

			it('creates a channel with typed states for every door', async () => {
				const base = `doors.${DOORS.untouched}`;
				const channel = await tools.getObject(harness, tools.id(base));
				expect(channel.type).to.equal('channel');
				expect(channel.common.name).to.equal('Door untouched');

				const expected = {
					name: { type: 'string', role: 'value', read: true, write: false },
					fullName: { type: 'string', role: 'value', read: true, write: false },
					locked: { type: 'boolean', role: 'value', read: true, write: false },
					position: { type: 'string', role: 'value', read: true, write: false },
					isBindHub: { type: 'boolean', role: 'value', read: true, write: false },
					unlock: { type: 'boolean', role: 'button', read: false, write: true },
					unlock_duration: { type: 'number', role: 'level', unit: 'min', read: true, write: true },
					lock_rule: { type: 'number', role: 'value', read: true, write: true },
					lockRuleType: { type: 'string', role: 'text', read: true, write: false },
					lockRuleEndsAt: { type: 'number', role: 'value.time', read: true, write: false },
				};
				for (const [leaf, common] of Object.entries(expected)) {
					const obj = await tools.getObject(harness, tools.id(`${base}.${leaf}`));
					expect(obj, leaf).to.be.an('object');
					expect(obj.type, leaf).to.equal('state');
					expect(obj.common, leaf).to.include(common);
				}

				expect(await state(`${base}.name`)).to.equal('Door untouched');
				expect(await state(`${base}.fullName`)).to.equal('UNVR - 1F - Door untouched');
				expect(await state(`${base}.locked`)).to.equal(true);
				expect(await state(`${base}.position`)).to.equal('close');
				expect(await state(`${base}.isBindHub`)).to.equal(true);
				expect(await state(`${base}.unlock_duration`)).to.equal(0);
				expect(await state(`${base}.lock_rule`)).to.equal(0);
			});

			it('mirrors the emergency status of the controller', async () => {
				expect(await state('doors.emergency.lockdown')).to.equal(false);
				expect(await state('doors.emergency.evacuation')).to.equal(false);
				const obj = await tools.getObject(harness, tools.id('doors.emergency.lockdown'));
				expect(obj.common).to.include({ type: 'boolean', role: 'switch', read: true, write: true });
			});

			it('registers its webhook endpoint with all documented events and stores the credentials', async () => {
				expect(mock.webhookEndpoints).to.have.length(1);
				expect(endpoint().endpoint).to.equal(webhookUrl);
				// instance and ioBroker host: two installations at one controller never share an endpoint name
				expect(endpoint().name).to.match(/^ioBroker\.unifi-access \(unifi-access\.0@[^)]+\)$/);
				expect([...endpoint().events].sort()).to.deep.equal([...fixtures.WEBHOOK_EVENTS].sort());
				expect(mock.findRequests({ method: 'POST', path: '/webhooks/endpoints' })).to.have.length(1);

				expect(await state('info.webhookRegistered')).to.equal(true);
				expect(await state('info.webhookEndpointId')).to.equal(endpoint().id);

				const instance = await tools.getObject(harness, tools.INSTANCE_OBJECT);
				expect(instance.native.webhookEndpointId).to.equal(endpoint().id);
				expect(instance.native.webhookSecret).to.be.a('string').with.length.greaterThan(0);
				expect(instance.native.webhookSecret, 'secret is stored encrypted').to.not.equal(endpoint().secret);
			});
		});

		describe('door control (state writes with ack=false)', function () {
			this.timeout(10_000);

			it('doors.<id>.unlock = true sends exactly one PUT /doors/<id>/unlock with an empty JSON body', async () => {
				await tools.writeState(harness, `doors.${DOORS.pulse}.unlock`, true);
				await tools.waitForState(harness, `doors.${DOORS.pulse}.unlock`, s => s.ack === true);

				const requests = doorRequests('pulse');
				expect(requests).to.have.length(1);
				expect(requests[0].method).to.equal('PUT');
				expect(requests[0].url).to.equal(`/api/v1/developer/doors/${DOORS.pulse}/unlock`);
				expect(requests[0].body).to.deep.equal({});
				expect(requests[0].headers.authorization).to.equal(`Bearer ${TOKEN}`);
				expect(requests[0].headers['content-type']).to.match(/^application\/json/);
				expect(requests[0].status).to.equal(200);
				expect(mock.unlocks.map(u => u.doorId)).to.deep.equal([DOORS.pulse]);

				expect(await state(`doors.${DOORS.pulse}.unlock`)).to.equal(true);
				expect(await state(`doors.${DOORS.pulse}.locked`)).to.equal(false);
			});

			it('ignores unlock = false and acknowledged writes (no request)', async () => {
				await tools.writeState(harness, `doors.${DOORS.untouched}.unlock`, false);
				await tools.writeState(harness, `doors.${DOORS.untouched}.unlock`, true, true);
				// a later command on another door proves the two writes above have been processed
				await tools.writeState(harness, `doors.${DOORS.rule}.lock_rule`, 2);
				await tools.waitForState(harness, `doors.${DOORS.rule}.lock_rule`, s => s.ack === true && s.val === 2);
				expect(doorRequests('untouched')).to.deep.equal([]);
				expect(await state(`doors.${DOORS.untouched}.locked`)).to.equal(true);
			});

			it('doors.<id>.unlock_duration = N sends PUT /doors/<id>/lock_rule {type:"custom", interval:N} (whole minutes)', async () => {
				await tools.writeState(harness, `doors.${DOORS.duration}.unlock_duration`, 7.9);
				await tools.waitForState(harness, `doors.${DOORS.duration}.unlock_duration`, s => s.ack === true);

				const requests = doorRequests('duration');
				expect(requests).to.have.length(1);
				expect(requests[0].method).to.equal('PUT');
				expect(requests[0].url).to.equal(`/api/v1/developer/doors/${DOORS.duration}/lock_rule`);
				expect(requests[0].body).to.deep.equal({ type: 'custom', interval: 7 });
				expect(requests[0].status).to.equal(200);
				expect(await state(`doors.${DOORS.duration}.unlock_duration`)).to.equal(7);
				expect(await state(`doors.${DOORS.duration}.locked`)).to.equal(false);
			});

			const rules = [
				[1, 'keep_unlock', false],
				[2, 'keep_lock', true],
				[3, 'lock_now', true],
				[0, 'reset', true],
			];
			for (const [index, type, locked] of rules) {
				it(`doors.<id>.lock_rule = ${index} sends PUT /doors/<id>/lock_rule {type:"${type}"}`, async () => {
					const before = doorRequests('rule').length;
					await tools.writeState(harness, `doors.${DOORS.rule}.lock_rule`, index);
					await tools.waitForState(
						harness,
						`doors.${DOORS.rule}.lock_rule`,
						s => s.ack === true && s.val === index,
					);
					const requests = doorRequests('rule').slice(before);
					expect(requests).to.have.length(1);
					expect(requests[0].method).to.equal('PUT');
					expect(requests[0].url).to.equal(`/api/v1/developer/doors/${DOORS.rule}/lock_rule`);
					expect(requests[0].body).to.deep.equal({ type });
					expect(await state(`doors.${DOORS.rule}.locked`)).to.equal(locked);
				});
			}

			it('ignores an unknown lock_rule value (no request)', async () => {
				const before = doorRequests('rule').length;
				await tools.writeState(harness, `doors.${DOORS.rule}.lock_rule`, 9);
				await tools.writeState(harness, `doors.${DOORS.rule}.lock_rule`, 2);
				await tools.waitForState(harness, `doors.${DOORS.rule}.lock_rule`, s => s.ack === true && s.val === 2);
				const requests = doorRequests('rule').slice(before);
				expect(requests.map(r => r.body)).to.deep.equal([{ type: 'keep_lock' }]);
			});

			it('doors.emergency.lockdown / .evacuation send PUT /doors/settings/emergency with both flags', async () => {
				const before = mock.requests.length;
				await tools.writeState(harness, 'doors.emergency.lockdown', true);
				await tools.waitForState(harness, 'doors.emergency.lockdown', s => s.ack === true && s.val === true);
				const first = await mock.waitForRequest(
					{ method: 'PUT', path: '/doors/settings/emergency' },
					{ fromIndex: before },
				);
				expect(first.body).to.deep.equal({ lockdown: true, evacuation: false });
				expect(mock.emergency).to.deep.equal({ lockdown: true, evacuation: false });

				const second = mock.requests.length;
				await tools.writeState(harness, 'doors.emergency.lockdown', false);
				await tools.waitForState(harness, 'doors.emergency.lockdown', s => s.ack === true && s.val === false);
				const reset = await mock.waitForRequest(
					{ method: 'PUT', path: '/doors/settings/emergency' },
					{ fromIndex: second },
				);
				expect(reset.body).to.deep.equal({ lockdown: false, evacuation: false });
			});
		});

		describe('WebSocket notifications', function () {
			this.timeout(10_000);

			it('access.remote_view fills doorbell.* and is appended to events.last', async () => {
				const before = Date.now();
				const ring = mock.emitRemoteView({ eventObjectId: '535b6125-860c-489a-b0a1-0ba01906afa9' });
				await tools.waitForState(harness, 'doorbell.activeCallId', s => s.val === ring.event_object_id);

				const from = await tools.waitForState(harness, 'doorbell.activeFromDevice', s => s.val === 'Door 3855');
				expect(from.ack).to.equal(true);
				const startedAt = await tools.waitForState(
					harness,
					'doorbell.activeStartedAt',
					s => typeof s.val === 'number',
				);
				expect(startedAt.val).to.be.within(before - 1000, Date.now() + 1000);

				const logged = await tools.waitForEvent(harness, e => e.type === 'access.remote_view');
				expect(logged).to.include({
					source: 'ws',
					type: 'access.remote_view',
					deviceId: DEVICE_G2_PRO,
					deviceName: 'UA-G2-PRO-BB7A',
					doorName: 'Door 3855',
				});
				expect(logged.ts).to.equal(startedAt.val);
				expect(logged.raw.event_object_id).to.equal(ring.event_object_id);
			});

			for (const [code, subtype] of [
				[108, 'visitor_cancelled'],
				[105, 'timeout'],
				[106, 'admin_rejected'],
				[400, 'answered_elsewhere'],
			]) {
				it(`access.remote_view.change with reason_code ${code} ends the active call (${subtype})`, async () => {
					const ring = mock.emitRemoteView();
					await tools.waitForState(harness, 'doorbell.activeCallId', s => s.val === ring.event_object_id);

					const change = mock.emitRemoteViewChange(code);
					await tools.waitForState(harness, 'doorbell.activeCallId', s => s.val === null);
					await tools.waitForState(harness, 'doorbell.activeFromDevice', s => s.val === null);
					await tools.waitForState(harness, 'doorbell.activeStartedAt', s => s.val === null);

					const logged = await tools.waitForEvent(
						harness,
						e => e.raw && e.raw.event_object_id === change.event_object_id,
					);
					expect(logged).to.include({ source: 'ws', type: 'access.remote_view.change', subtype });
				});
			}

			// reason_code 107 ("An admin successfully unlocked a door", api_reference 11.1) also ends the
			// doorbell call — the webhook counterpart access.doorbell.completed is documented as "accepted,
			// declined, or canceled".
			it('access.remote_view.change with reason_code 107 (admin unlocked) ends the active call', async () => {
				const ring = mock.emitRemoteView();
				await tools.waitForState(harness, 'doorbell.activeCallId', s => s.val === ring.event_object_id);
				mock.emitRemoteViewChange(107);
				await tools.waitForState(harness, 'doorbell.activeCallId', s => s.val === null);
				expect(await state('doorbell.activeFromDevice')).to.equal(null);
				expect(await state('doorbell.activeStartedAt')).to.equal(null);
			});

			it('access.data.device.remote_unlock marks the door as unlocked', async () => {
				expect(await state(`doors.${DOORS.ws}.locked`)).to.equal(true);
				mock.emitRemoteUnlock(DOORS.ws);
				const locked = await tools.waitForState(harness, `doors.${DOORS.ws}.locked`, s => s.val === false);
				expect(locked.ack).to.equal(true);
			});

			it('ignores frames that are not JSON and keeps processing events', async () => {
				mock.sendRaw('Hello');
				const ring = mock.emitRemoteView();
				await tools.waitForState(harness, 'doorbell.activeCallId', s => s.val === ring.event_object_id);
				expect(mock.wsClients.size).to.equal(1);
				mock.emitRemoteViewChange(108);
				await tools.waitForState(harness, 'doorbell.activeCallId', s => s.val === null);
			});

			it('reconnects after the connection was cut and processes events again', async () => {
				const connections = mock.wsConnectionCount;
				mock.dropWsConnections();
				await mock.waitForWsConnectionCount(connections + 1, 5000);
				await mock.waitForWsClients(1, 5000);

				const ring = mock.emitRemoteView();
				await tools.waitForState(harness, 'doorbell.activeCallId', s => s.val === ring.event_object_id);
				mock.emitRemoteViewChange(105);
				await tools.waitForState(harness, 'doorbell.activeCallId', s => s.val === null);
				expect(await state('info.connection')).to.equal(true);
			});

			it('info.connection becomes false while the controller is unreachable', async () => {
				mock.wsAccepting = false;
				try {
					mock.dropWsConnections();
					await tools.waitForState(harness, 'info.connection', s => s.val === false, 3000);
				} finally {
					mock.wsAccepting = true;
					await mock.waitForWsClients(1, 5000);
				}
				await tools.waitForState(harness, 'info.connection', s => s.val === true, 3000);
			});
		});

		describe('webhook events (HMAC-signed POSTs from the controller)', function () {
			this.timeout(10_000);

			const hub = () => mock.findDevice(DEVICE_HUB);
			const reader = () => mock.findDevice(DEVICE_G2_PRO);

			it('access.door.unlock updates door, device, thumbnail states, events.last and the forward target', async () => {
				const before = Date.now();
				const event = fixtures.webhookEvents.doorUnlock({
					door: door('hook'),
					device: hub(),
					readerId: DEVICE_G2_PRO,
					thumbnailTime: 1_722_913_291,
				});
				const thumbnailPath = event.data.location.extras.door_thumbnail;

				const results = await mock.deliverWebhook(event);
				expect(results).to.have.length(1);
				expect(results[0].status).to.equal(200);
				expect(results[0].body).to.equal('OK');

				// the receiver answers after processing, so the states are final here
				expect(await state(`doors.${DOORS.hook}.locked`)).to.equal(false);
				expect(await state(`devices.${DEVICE_HUB}.firmware`)).to.equal('v4.6.1.0');
				expect(await state(`devices.${DEVICE_HUB}.online`)).to.equal(true);
				const lastSeen = await state(`devices.${DEVICE_HUB}.lastSeenAt`);
				expect(Date.parse(lastSeen)).to.be.within(before - 1000, Date.now() + 1000);

				expect(await state(`devices.${DEVICE_G2_PRO}.lastThumbnailPath`)).to.equal(thumbnailPath);
				const thumbnailAt = await state(`devices.${DEVICE_G2_PRO}.lastThumbnailAt`);
				expect(thumbnailAt).to.be.within(before - 1000, Date.now() + 1000);
				expect(await state(`devices.${DEVICE_G2_PRO}.lastThumbnailUrl`)).to.equal(
					`${baseUrl}/unifi-access/0/thumbnail/${DEVICE_G2_PRO}.jpg?ts=${thumbnailAt}`,
				);

				const logged = (await tools.eventLog(harness))[0];
				expect(logged).to.include({
					source: 'webhook',
					type: 'access.door.unlock',
					doorId: DOORS.hook,
					doorName: 'Door hook',
					deviceId: DEVICE_HUB,
					deviceName: 'UA-HUB-3855',
					userName: 'Hon***',
					thumbnailPath,
				});
				expect(logged.ts).to.equal(thumbnailAt);
				expect(logged.raw).to.deep.equal(event);

				const forwarded = await tools.getState(harness, FORWARD_TARGET);
				expect(forwarded.ack).to.equal(true);
				expect(JSON.parse(forwarded.val)).to.include({ type: 'access.door.unlock', doorId: DOORS.hook });
			});

			it('serves the thumbnail of that event through the proxy URL from lastThumbnailUrl', async () => {
				const path = await state(`devices.${DEVICE_G2_PRO}.lastThumbnailPath`);
				const url = await state(`devices.${DEVICE_G2_PRO}.lastThumbnailUrl`);
				const image = Buffer.concat([fixtures.TINY_JPEG, Buffer.from('integration')]);
				mock.addStaticResource(path, image);
				const before = mock.requests.length;

				const response = await httpRequest({ url });

				expect(response.status).to.equal(200);
				expect(response.headers['content-type']).to.equal('image/jpeg');
				expect(response.body.equals(image)).to.equal(true);
				const upstream = mock.requests.slice(before).filter(r => r.path.startsWith('/system/static/'));
				expect(upstream).to.have.length(1);
				expect(upstream[0].url).to.equal(`/api/v1/developer/system/static${path}`);
				expect(upstream[0].headers.authorization).to.equal(`Bearer ${TOKEN}`);
			});

			it('thumbnail proxy: 404 for a device without thumbnail and for path traversal attempts', async () => {
				const prefix = '/unifi-access/0/thumbnail';
				const before = mock.requests.length;
				for (const rawPath of [
					`${prefix}/${DEVICE_ULTRA}.jpg`,
					`${prefix}/doesnotexist.jpg`,
					`${prefix}/../../etc/passwd`,
					`${prefix}/..%2F..%2Fetc%2Fpasswd.jpg`,
					`${prefix}/${DEVICE_G2_PRO}.jpg/../../../x.jpg`,
				]) {
					const response = await httpRequest({ url: baseUrl, rawPath });
					expect(response.status, rawPath).to.equal(404);
				}
				expect(mock.requests.slice(before).filter(r => r.path.startsWith('/system/static/'))).to.deep.equal([]);
			});

			it('access.device.dps_status is logged and refreshes the reporting device', async () => {
				const event = fixtures.webhookEvents.dpsStatus({ door: door('hook'), device: hub(), status: 'open' });
				const [result] = await mock.deliverWebhook(event);
				expect(result.status).to.equal(200);
				const logged = (await tools.eventLog(harness))[0];
				expect(logged).to.include({
					source: 'webhook',
					type: 'access.device.dps_status',
					doorId: DOORS.hook,
					doorName: 'Door hook',
					deviceId: DEVICE_HUB,
				});
			});

			// The documented access.device.dps_status payload (api_reference 11.7) carries the sensor
			// state in data.object.status ("open" | "close").
			it('access.device.dps_status updates doors.<id>.position from data.object.status', async () => {
				const open = fixtures.webhookEvents.dpsStatus({ door: door('hook'), device: hub(), status: 'open' });
				expect((await mock.deliverWebhook(open))[0].status).to.equal(200);
				expect(await state(`doors.${DOORS.hook}.position`)).to.equal('open');
				expect((await tools.eventLog(harness))[0].subtype).to.equal('open');

				const close = fixtures.webhookEvents.dpsStatus({ door: door('hook'), device: hub(), status: 'close' });
				expect((await mock.deliverWebhook(close))[0].status).to.equal(200);
				expect(await state(`doors.${DOORS.hook}.position`)).to.equal('close');
			});

			it('access.doorbell.incoming records the reader thumbnail and is logged', async () => {
				const event = fixtures.webhookEvents.doorbellIncoming({
					door: door('hook'),
					device: reader(),
					thumbnailTime: 1_722_999_999,
				});
				const [result] = await mock.deliverWebhook(event);
				expect(result.status).to.equal(200);

				expect(await state(`devices.${DEVICE_G2_PRO}.lastThumbnailPath`)).to.equal(
					`/preview/reader_${DEVICE_G2_PRO}_${DOORS.hook}_1722999999.jpg`,
				);
				expect(await state(`devices.${DEVICE_G2_PRO}.firmware`)).to.equal('v1.5.33');
				const logged = (await tools.eventLog(harness))[0];
				expect(logged).to.include({
					source: 'webhook',
					type: 'access.doorbell.incoming',
					doorId: DOORS.hook,
					deviceId: DEVICE_G2_PRO,
				});
			});

			it('access.doorbell.incoming.REN (no device block) records the thumbnail by the reader id in the path', async () => {
				const event = fixtures.webhookEvents.doorbellIncomingRen({
					door: door('hook'),
					readerId: DEVICE_ULTRA,
				});
				const [result] = await mock.deliverWebhook(event);
				expect(result.status).to.equal(200);
				expect(await state(`devices.${DEVICE_ULTRA}.lastThumbnailPath`)).to.equal(
					event.data.location.extras.door_thumbnail,
				);
				expect((await tools.eventLog(harness))[0]).to.include({
					type: 'access.doorbell.incoming.REN',
					doorId: DOORS.hook,
				});
			});

			it('access.doorbell.completed is logged', async () => {
				const event = fixtures.webhookEvents.doorbellCompleted({
					door: door('hook'),
					device: reader(),
					reasonCode: 400,
				});
				const [result] = await mock.deliverWebhook(event);
				expect(result.status).to.equal(200);
				const logged = (await tools.eventLog(harness))[0];
				expect(logged).to.include({ source: 'webhook', type: 'access.doorbell.completed', doorId: DOORS.hook });
				expect(logged.raw.data.object.reason_code).to.equal(400);
			});

			it('access.device.emergency_status makes the adapter re-read the emergency status', async () => {
				mock.emergency = { lockdown: false, evacuation: true };
				const before = mock.requests.length;
				const event = fixtures.webhookEvents.emergencyStatus({
					device: hub(),
					mode: 'evacuation',
					value: true,
				});
				const [result] = await mock.deliverWebhook(event);
				expect(result.status).to.equal(200);

				await mock.waitForRequest({ method: 'GET', path: '/doors/settings/emergency' }, { fromIndex: before });
				await tools.waitForState(harness, 'doors.emergency.evacuation', s => s.val === true && s.ack === true);
				expect(await state('doors.emergency.lockdown')).to.equal(false);
				expect((await tools.eventLog(harness))[0].type).to.equal('access.device.emergency_status');
			});

			for (const name of [
				'access.unlock_schedule.activate',
				'access.unlock_schedule.deactivate',
				'access.temporary_unlock.start',
				'access.temporary_unlock.end',
				'access.visitor.status.changed',
			]) {
				it(`${name} is accepted and logged`, async () => {
					const event = fixtures.webhookEvents.generic(name, { door: door('hook'), device: hub() });
					const [result] = await mock.deliverWebhook(event);
					expect(result.status).to.equal(200);
					const logged = (await tools.eventLog(harness))[0];
					expect(logged).to.include({ source: 'webhook', type: name, doorId: DOORS.hook });
					expect(logged.raw.event_object_id).to.equal(event.event_object_id);
				});
			}

			for (const signature of ['invalid', 'tampered', 'expired', 'future', 'missing', 'malformed']) {
				it(`rejects a webhook with ${signature} signature (401) and changes nothing`, async () => {
					const eventsBefore = await state('events.last');
					const lastSeenBefore = await state(`devices.${DEVICE_HUB}.lastSeenAt`);
					const event = fixtures.webhookEvents.doorUnlock({ door: door('untouched'), device: hub() });

					const [result] = await mock.deliverWebhook(event, { signature });

					expect(result.status).to.equal(401);
					expect(await state(`doors.${DOORS.untouched}.locked`)).to.equal(true);
					expect(await state('events.last')).to.equal(eventsBefore);
					expect(await state(`devices.${DEVICE_HUB}.lastSeenAt`)).to.equal(lastSeenBefore);
				});
			}

			it('rejects GET on the webhook path (405) and unknown paths (404)', async () => {
				expect((await httpRequest({ url: webhookUrl })).status).to.equal(405);
				expect((await httpRequest({ url: `${baseUrl}/` })).status).to.equal(404);
				expect(
					(await httpRequest({ url: `${baseUrl}${WEBHOOK_PATH}/other`, method: 'POST', body: '{}' })).status,
				).to.equal(404);
			});
		});

		describe('generic webhook (alarm manager)', function () {
			this.timeout(10_000);

			const payload = () => ({
				alarm_id: 'alarm-4711',
				events: [
					{
						id: 'access.door.unlock',
						location: DOORS.hook,
						user: USER.id,
						direction: 'entry',
						unlock_method_text: 'NFC',
						time: '2026-01-02T03:04:05Z',
					},
				],
			});

			it('rejects requests without the configured bearer token (401, states untouched)', async () => {
				const response = await httpRequest({
					url: `${baseUrl}/webhook`,
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload()),
				});
				expect(response.status).to.equal(401);
				expect(await state('notifications.lastAlarmId')).to.not.equal('alarm-4711');
			});

			it('stores an authenticated alarm payload in notifications.* and resolves door and user names', async () => {
				const raw = JSON.stringify(payload());
				const response = await httpRequest({
					url: `${baseUrl}/webhook`,
					method: 'POST',
					headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GENERIC_TOKEN}` },
					body: raw,
				});
				expect(response.status).to.equal(200);
				expect(response.text).to.equal('OK');

				expect(await state('notifications.lastRaw')).to.equal(raw);
				expect(await state('notifications.lastAlarmId')).to.equal('alarm-4711');
				expect(await state('notifications.lastEventType')).to.equal('access.door.unlock');
				expect(await state('notifications.lastLocationId')).to.equal(DOORS.hook);
				expect(await state('notifications.lastLocationName')).to.equal('Door hook');
				expect(await state('notifications.lastUserId')).to.equal(USER.id);
				expect(await state('notifications.lastUserName')).to.equal('Hong Lu');
				expect(await state('notifications.lastDirection')).to.equal('entry');
				expect(await state('notifications.lastUnlockMethod')).to.equal('NFC');
				expect(await state('notifications.lastTimestamp')).to.equal(Date.parse('2026-01-02T03:04:05Z'));
			});

			it('answers 200 for a body that is not JSON but leaves the states untouched', async () => {
				const response = await httpRequest({
					url: `${baseUrl}/webhook`,
					method: 'POST',
					headers: { Authorization: `Bearer ${GENERIC_TOKEN}` },
					body: 'plain text alarm',
				});
				expect(response.status).to.equal(200);
				expect(await state('notifications.lastAlarmId')).to.equal('alarm-4711');
			});
		});

		describe('sendTo commands', function () {
			this.timeout(20_000);

			it('getConnectionStatus reports the connection in the documented format', async () => {
				expect(await tools.sendTo(harness, 'getConnectionStatus')).to.deep.equal({
					connected: true,
					lastError: null,
					hasToken: true,
					controllerName: 'UNVR - Main Floor',
					webhookRegistered: true,
				});
			});

			it('listDevices returns every device with model and capabilities', async () => {
				const { devices } = await tools.sendTo(harness, 'listDevices');
				expect(devices.map(d => d.id).sort()).to.deep.equal(
					fixtures.DEFAULT_DEVICES.flat()
						.map(d => d.id)
						.sort(),
				);
				const ultra = devices.find(d => d.id === DEVICE_ULTRA);
				expect(ultra).to.deep.include({
					id: DEVICE_ULTRA,
					name: 'UA-ULTRA-AA01',
					alias: 'Garden Gate',
					type: 'UA-ULTRA',
					model: 'UA-Ultra',
					online: true,
					capabilities: ['event-thumbnail', 'doorbell', 'door-unlock', 'live-events'],
				});
				const hubEntry = devices.find(d => d.id === DEVICE_HUB);
				expect(hubEntry.model).to.equal('UA-Hub');
				expect(hubEntry.capabilities).to.deep.equal(['live-events']);
				// the hub was seen in webhook events above
				expect(hubEntry.firmware).to.equal('v4.6.1.0');
				expect(Date.parse(hubEntry.lastSeenAt)).to.be.a('number').and.not.NaN;
			});

			it('listUsers returns id and display name of every user', async () => {
				const { users } = await tools.sendTo(harness, 'listUsers');
				expect(users).to.deep.equal([
					{ id: fixtures.DEFAULT_USERS[0].id, name: 'Hong Lu' },
					{ id: fixtures.DEFAULT_USERS[1].id, name: 'Ttttt Tttt' },
				]);
			});

			it('getNetworkInterfaces returns a list of IPv4 addresses', async () => {
				const { addresses } = await tools.sendTo(harness, 'getNetworkInterfaces');
				expect(addresses).to.be.an('array');
				for (const address of addresses) {
					expect(address).to.match(/^\d{1,3}(\.\d{1,3}){3}$/);
				}
			});

			it('verifyToken: ok for a valid token (read-only probe, no state change)', async () => {
				const before = mock.requests.length;
				const answer = await tools.sendTo(harness, 'verifyToken', {
					host: '127.0.0.1',
					port: mock.port,
					token: TOKEN,
					verifyTLS: false,
				});
				expect(answer).to.deep.equal({ ok: true, controllerName: 'UNVR - Main Floor' });
				const probe = mock.requests.slice(before);
				expect(probe.map(r => `${r.method} ${r.url}`)).to.deep.equal([
					'GET /api/v1/developer/devices?refresh=true',
				]);
			});

			it('verifyToken: "unauthorized" for a wrong token', async () => {
				const answer = await tools.sendTo(harness, 'verifyToken', {
					host: '127.0.0.1',
					port: mock.port,
					token: 'wrong-token',
				});
				expect(answer).to.deep.equal({ ok: false, error: 'unauthorized' });
			});

			it('verifyToken: "network" for an unreachable controller', async () => {
				const answer = await tools.sendTo(
					harness,
					'verifyToken',
					{ host: '127.0.0.1', port: await getFreePort(), token: TOKEN },
					15_000,
				);
				expect(answer).to.deep.equal({ ok: false, error: 'network' });
			});

			it('verifyToken: "network" when TLS verification is requested for the self-signed certificate', async () => {
				const answer = await tools.sendTo(harness, 'verifyToken', {
					host: '127.0.0.1',
					port: mock.port,
					token: TOKEN,
					verifyTLS: true,
				});
				expect(answer).to.deep.equal({ ok: false, error: 'network' });
			});

			it('verifyToken: "missing-fields" without host or token', async () => {
				expect(await tools.sendTo(harness, 'verifyToken', { host: '', token: TOKEN })).to.deep.equal({
					ok: false,
					error: 'missing-fields',
				});
				expect(await tools.sendTo(harness, 'verifyToken', { host: '127.0.0.1' })).to.deep.equal({
					ok: false,
					error: 'missing-fields',
				});
			});

			it('reregisterWebhook replaces the endpoint and switches to the fresh secret', async () => {
				const old = { ...endpoint() };

				const answer = await tools.sendTo(harness, 'reregisterWebhook');

				expect(mock.webhookEndpoints).to.have.length(1);
				const fresh = endpoint();
				expect(answer).to.deep.equal({ ok: true, id: fresh.id });
				expect(fresh.id).to.not.equal(old.id);
				expect(fresh.secret).to.not.equal(old.secret);
				expect(fresh.endpoint).to.equal(webhookUrl);
				expect(mock.findRequests({ method: 'DELETE', path: `/webhooks/endpoints/${old.id}` })).to.have.length(
					1,
				);
				await tools.waitForState(harness, 'info.webhookEndpointId', s => s.val === fresh.id);

				const event = fixtures.webhookEvents.doorbellCompleted({
					door: mock.findDoor(DOORS.hook),
					device: mock.findDevice(DEVICE_G2_PRO),
					reasonCode: 105,
				});
				const withOldSecret = await sendWebhook({ url: webhookUrl, secret: old.secret, body: event });
				expect(withOldSecret.status, 'old secret').to.equal(401);
				const [withNewSecret] = await mock.deliverWebhook(event);
				expect(withNewSecret.status, 'new secret').to.equal(200);

				expect((await tools.sendTo(harness, 'getConnectionStatus')).webhookRegistered).to.equal(true);
			});

			it('answers an unknown command with an error (the caller is not left waiting, the adapter keeps running)', async () => {
				expect(await tools.sendTo(harness, 'thisCommandDoesNotExist', {})).to.deep.equal({
					ok: false,
					error: 'unknown-command',
				});
				expect((await tools.sendTo(harness, 'getConnectionStatus')).connected).to.equal(true);
				expect(harness.isAdapterRunning()).to.equal(true);
			});

			it('admin.uiSettings is a writable JSON state and a value written by the www panel is confirmed', async () => {
				const obj = await tools.getObject(harness, tools.id('admin.uiSettings'));
				expect(obj.common).to.include({ type: 'string', role: 'json', read: true, write: true });
				const value = JSON.stringify({ showDoorList: false, thumbWidth: 128 });
				await tools.writeState(harness, 'admin.uiSettings', value);
				const confirmed = await tools.waitForState(harness, 'admin.uiSettings', s => s.ack === true);
				expect(confirmed.val).to.equal(value);
			});
		});

		describe('unload', function () {
			this.timeout(20_000);

			it('terminates by itself, closes the WebSocket and releases the HTTP port', async () => {
				expect(await tools.isPortFree(listenPort), 'port in use while running').to.equal(false);
				expect(mock.wsClients.size).to.equal(1);

				const exit = await tools.stopAdapter(harness, 10_000);

				// 11 = ADAPTER_REQUESTED_TERMINATION: the regular exit code after a stop request
				expect(exit).to.equal(11);
				await waitFor(() => mock.wsClients.size === 0, { description: 'WebSocket closed', timeoutMs: 3000 });
				expect(await tools.isPortFree(listenPort), 'port released').to.equal(true);
				const handshakes = mock.wsHandshakes.length;
				await delay(WS_RECONNECT_SECONDS * 1000 * 4);
				expect(mock.wsHandshakes, 'no reconnect attempts after unload').to.have.length(handshakes);
			});
		});
	});

	// ====================================================================================
	suite('UniFi Access adapter: timed unlock, actor, verified TLS, receivers disabled', getHarness => {
		let harness;
		let mock;
		let listenPort;
		let baseUrl;

		const state = localId => tools.stateValue(harness, localId);
		/** commands sent for a door (status checks — GET — follow on their own schedule and are not counted) */
		const doorRequests = key =>
			mock.findRequests({ path: new RegExp(`^/doors/${DOORS[key]}/`) }).filter(r => r.method !== 'GET');

		before(async function () {
			this.timeout(60_000);
			harness = getHarness();
			mock = await startMockController({ token: TOKEN, doors: integrationDoors() });
			listenPort = await getFreePort();
			baseUrl = `http://127.0.0.1:${listenPort}`;
			await tools.configureAdapter(harness, {
				controllerHost: '127.0.0.1',
				controllerPort: mock.port,
				apiToken: TOKEN,
				verifyTLS: true,
				caCert: mock.cert,
				wsReconnectDelay: WS_RECONNECT_SECONDS,
				defaultUnlockDuration: 10,
				unlockActorId: USER.id,
				listenPort,
				listenIp: '127.0.0.1',
				enableWebhooks: false,
				enableThumbnailServer: false,
				enableGenericWebhook: false,
			});
			await harness.startAdapterAndWait(true);
			await mock.waitForWsClients(1, 5000);
			// the shared HTTP server is started after the bootstrap
			await waitFor(async () => !(await tools.isPortFree(listenPort)), {
				description: 'shared HTTP server',
				timeoutMs: 5000,
			});
		});

		after(async function () {
			this.timeout(20_000);
			await tools.stopAdapter(harness);
			await mock.stop();
		});

		describe('TLS', function () {
			this.timeout(10_000);

			it('connects over HTTPS and WebSocket with verifyTLS=true and the controller certificate as CA', async () => {
				expect(await state('info.connection')).to.equal(true);
				expect(mock.wsClients.size).to.equal(1);
				expect(mock.findRequests({ method: 'GET', path: '/devices' })).to.have.length(1);
			});
		});

		describe('door control with defaultUnlockDuration = 10', function () {
			this.timeout(10_000);

			it('doors.<id>.unlock = true sends exactly one PUT /doors/<id>/lock_rule {type:"custom", interval:10}', async () => {
				await tools.writeState(harness, `doors.${DOORS.pulse}.unlock`, true);
				await tools.waitForState(harness, `doors.${DOORS.pulse}.unlock`, s => s.ack === true);

				const requests = doorRequests('pulse');
				expect(requests).to.have.length(1);
				expect(requests[0].method).to.equal('PUT');
				expect(requests[0].url).to.equal(`/api/v1/developer/doors/${DOORS.pulse}/lock_rule`);
				expect(requests[0].body).to.deep.equal({ type: 'custom', interval: 10 });
				expect(requests[0].status).to.equal(200);
				expect(mock.unlocks).to.deep.equal([]);
				expect(await state(`doors.${DOORS.pulse}.locked`)).to.equal(false);
			});

			it('doors.<id>.unlock_duration = 0 sends a pulse PUT /doors/<id>/unlock with the configured actor', async () => {
				await tools.writeState(harness, `doors.${DOORS.duration}.unlock_duration`, 0);
				await tools.waitForState(harness, `doors.${DOORS.duration}.locked`, s => s.val === false);

				const requests = doorRequests('duration');
				expect(requests).to.have.length(1);
				expect(requests[0].method).to.equal('PUT');
				expect(requests[0].url).to.equal(`/api/v1/developer/doors/${DOORS.duration}/unlock`);
				expect(requests[0].body).to.deep.equal({ actor_id: USER.id, actor_name: 'Hong Lu' });
				expect(requests[0].status).to.equal(200);
			});
		});

		describe('disabled receivers', function () {
			this.timeout(10_000);

			it('does not register a webhook endpoint', async () => {
				expect(mock.findRequests({ path: /^\/webhooks\// })).to.deep.equal([]);
				expect(mock.webhookEndpoints).to.deep.equal([]);
				expect(await state('info.webhookRegistered')).to.not.equal(true);
				expect((await tools.sendTo(harness, 'getConnectionStatus')).webhookRegistered).to.equal(false);
			});

			it('answers 404 on the webhook, thumbnail and generic webhook paths', async () => {
				const event = fixtures.webhookEvents.doorUnlock({
					door: mock.findDoor(DOORS.hook),
					device: mock.findDevice(DEVICE_HUB),
				});
				const webhook = await sendWebhook({
					url: `${baseUrl}${WEBHOOK_PATH}`,
					secret: 'anything',
					body: event,
				});
				expect(webhook.status).to.equal(404);
				expect(
					(await httpRequest({ url: `${baseUrl}/unifi-access/0/thumbnail/${DEVICE_G2_PRO}.jpg` })).status,
				).to.equal(404);
				expect((await httpRequest({ url: `${baseUrl}/webhook`, method: 'POST', body: '{}' })).status).to.equal(
					404,
				);
				expect(await state(`doors.${DOORS.hook}.locked`)).to.equal(true);
			});

			it('reregisterWebhook still registers on demand', async () => {
				const answer = await tools.sendTo(harness, 'reregisterWebhook');
				expect(answer.ok).to.equal(true);
				expect(mock.webhookEndpoints).to.have.length(1);
				expect(mock.webhookEndpoints[0].id).to.equal(answer.id);
				expect(mock.webhookEndpoints[0].endpoint).to.equal(`${baseUrl}${WEBHOOK_PATH}`);
			});
		});
	});

	// ====================================================================================
	suite('UniFi Access adapter: controller rejects the API token', getHarness => {
		let harness;
		let mock;

		before(async function () {
			this.timeout(60_000);
			harness = getHarness();
			mock = await startMockController({ token: TOKEN });
			await tools.configureAdapter(harness, {
				controllerHost: '127.0.0.1',
				controllerPort: mock.port,
				apiToken: 'revoked-token',
				listenPort: await getFreePort(),
				listenIp: '127.0.0.1',
				enableWebhooks: true,
			});
			await harness.startAdapterAndWait(false);
			await mock.waitForRequest({ method: 'GET', path: '/devices' }, { timeoutMs: 10_000 });
		});

		after(async function () {
			this.timeout(20_000);
			await tools.stopAdapter(harness);
			await mock.stop();
		});

		describe('startup with a wrong token', function () {
			this.timeout(10_000);

			it('keeps info.connection false and reports lastError "unauthorized"', async () => {
				const status = await waitFor(
					async () => {
						const answer = await tools.sendTo(harness, 'getConnectionStatus');
						return answer.lastError ? answer : undefined;
					},
					{ timeoutMs: 5000, description: 'lastError' },
				);
				expect(status).to.deep.equal({
					connected: false,
					lastError: 'unauthorized',
					hasToken: true,
					controllerName: null,
					webhookRegistered: false,
				});
				expect(await tools.stateValue(harness, 'info.connection')).to.equal(false);
			});

			it('sends the configured token, creates no device objects and opens no WebSocket', async () => {
				expect(mock.requests.every(r => r.headers.authorization === 'Bearer revoked-token')).to.equal(true);
				expect(mock.requests.every(r => r.status === 401)).to.equal(true);
				expect(mock.wsHandshakes).to.deep.equal([]);
				expect(await tools.getObject(harness, tools.id(`devices.${DEVICE_HUB}`))).to.not.be.an('object');
				expect((await tools.sendTo(harness, 'listDevices')).devices).to.deep.equal([]);
			});

			it('keeps running and still answers verifyToken with a valid token', async () => {
				const answer = await tools.sendTo(harness, 'verifyToken', {
					host: '127.0.0.1',
					port: mock.port,
					token: TOKEN,
				});
				expect(answer).to.deep.equal({ ok: true, controllerName: 'UNVR - Main Floor' });
				expect(harness.isAdapterRunning()).to.equal(true);
			});
		});
	});

	// ====================================================================================
	suite('UniFi Access adapter: controller unreachable', getHarness => {
		let harness;
		let listenPort;

		before(async function () {
			this.timeout(60_000);
			harness = getHarness();
			listenPort = await getFreePort();
			await tools.configureAdapter(harness, {
				controllerHost: '127.0.0.1',
				controllerPort: await getFreePort(),
				apiToken: TOKEN,
				listenPort,
				listenIp: '127.0.0.1',
				enableGenericWebhook: true,
				genericWebhookAuth: 'none',
			});
			await harness.startAdapterAndWait(false);
		});

		after(async function () {
			this.timeout(20_000);
			await tools.stopAdapter(harness);
		});

		describe('startup without a controller', function () {
			this.timeout(20_000);

			it('keeps info.connection false and reports lastError "network"', async () => {
				const status = await waitFor(
					async () => {
						const answer = await tools.sendTo(harness, 'getConnectionStatus');
						return answer.lastError ? answer : undefined;
					},
					{ timeoutMs: 15_000, description: 'lastError' },
				);
				expect(status).to.deep.equal({
					connected: false,
					lastError: 'network',
					hasToken: true,
					controllerName: null,
					webhookRegistered: false,
				});
				expect(await tools.stateValue(harness, 'info.connection')).to.equal(false);
			});

			it('still serves the generic webhook', async () => {
				await waitFor(async () => !(await tools.isPortFree(listenPort)), {
					description: 'shared HTTP server',
					timeoutMs: 10_000,
				});
				const response = await httpRequest({
					url: `http://127.0.0.1:${listenPort}/webhook`,
					method: 'POST',
					body: '{"alarm_id":"offline-alarm","events":[]}',
				});
				expect(response.status).to.equal(200);
			});

			// Without objects js-controller warns "State … has no existing object, this might lead to an error
			// in future versions" for each state and the values are invisible in admin.
			it('creates the objects of the states it writes even without a successful bootstrap', async () => {
				await httpRequest({
					url: `http://127.0.0.1:${listenPort}/webhook`,
					method: 'POST',
					body: '{"alarm_id":"offline-alarm","events":[]}',
				});
				expect(await tools.stateValue(harness, 'notifications.lastAlarmId')).to.equal('offline-alarm');
				for (const leaf of ['lastRaw', 'lastAlarmId', 'lastEventType', 'lastTimestamp']) {
					const obj = await tools.getObject(harness, tools.id(`notifications.${leaf}`));
					expect(obj, leaf).to.be.an('object');
					expect(obj.type, leaf).to.equal('state');
				}
			});

			it('stops cleanly although a bootstrap retry is pending', async () => {
				const exit = await tools.stopAdapter(harness, 10_000);
				expect(exit).to.equal(11);
				expect(await tools.isPortFree(listenPort)).to.equal(true);
			});
		});
	});
}

module.exports = { defineAdapterTests };
