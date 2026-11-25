import { expect } from 'chai';
import { AxiosError } from 'axios';

import { createSelfSignedCert, fixtures, getFreePort, MockUnifiController, rejection } from '../../test/mock';
import {
	apiErrorCode,
	classifyError,
	InvalidStaticPathError,
	redactSecrets,
	UnexpectedResponseError,
	UnifiApiError,
	UnifiHttp,
} from './unifiHttp';

const TOKEN = 'module-test-token';
const { DOOR_A2 } = fixtures.IDS;

describe('UnifiHttp (against the mock controller)', () => {
	let mock: MockUnifiController;
	let http: UnifiHttp;

	before(async () => {
		mock = new MockUnifiController({ token: TOKEN });
		await mock.start();
	});

	after(async () => {
		await mock.stop();
	});

	beforeEach(() => {
		mock.reset();
		http = new UnifiHttp({ host: '127.0.0.1', port: mock.port, token: TOKEN });
	});

	it('exposes the base url', () => {
		expect(http.url).to.equal(`https://127.0.0.1:${mock.port}`);
	});

	describe('request headers', () => {
		it('sends the bearer token and accepts JSON on every request', async () => {
			await http.listDoors();
			await http.unlockDoor(DOOR_A2);
			expect(mock.requests).to.have.length(2);
			for (const request of mock.requests) {
				expect(request.headers.authorization).to.equal(`Bearer ${TOKEN}`);
				expect(request.headers.accept).to.equal('application/json');
				expect(request.authorized).to.equal(true);
			}
		});

		it('sends JSON bodies with a JSON content type', async () => {
			await http.setDoorLockRule(DOOR_A2, { type: 'keep_lock' });
			expect(mock.requests[0].headers['content-type']).to.match(/^application\/json/);
		});
	});

	describe('listDevices()', () => {
		it('requests GET /devices?refresh=true', async () => {
			await http.listDevices();
			expect(mock.requests).to.have.length(1);
			expect(mock.requests[0].method).to.equal('GET');
			expect(mock.requests[0].url).to.equal('/api/v1/developer/devices?refresh=true');
			expect(mock.requests[0].query).to.deep.equal({ refresh: 'true' });
		});

		it('flattens the documented Device[][] response over all groups', async () => {
			const devices = await http.listDevices();
			expect(devices.map(d => d.id)).to.deep.equal(fixtures.DEFAULT_DEVICES.flat().map(d => d.id));
			expect(devices[0]).to.deep.equal(fixtures.DEFAULT_DEVICES[0][0]);
		});

		it('keeps undocumented extra fields (firmware, online) untouched', async () => {
			mock.devices = [
				[{ id: 'aabbccddeeff', name: 'UA-ULTRA-EEFF', type: 'UA-ULTRA', firmware: 'v1.2.3', online: false }],
			];
			expect(await http.listDevices()).to.deep.equal([
				{ id: 'aabbccddeeff', name: 'UA-ULTRA-EEFF', type: 'UA-ULTRA', firmware: 'v1.2.3', online: false },
			]);
		});

		it('accepts an already flat Device[] response', async () => {
			mock.devices = [
				{ id: 'a1', name: 'one', type: 'UAH' },
				{ id: 'a2', name: 'two', type: 'UA-G2-PRO' },
			];
			expect((await http.listDevices()).map(d => d.id)).to.deep.equal(['a1', 'a2']);
		});

		it('returns an empty list for empty groups', async () => {
			mock.devices = [];
			expect(await http.listDevices()).to.deep.equal([]);
			mock.devices = [[]];
			expect(await http.listDevices()).to.deep.equal([]);
			mock.devices = [[], [{ id: 'late', type: 'UAH' }]];
			expect((await http.listDevices()).map(d => d.id)).to.deep.equal(['late']);
		});

		// K-03: an empty list would make every known device look gone
		it('rejects when "data" is missing or not an array', async () => {
			mock.failNext({ path: '/devices', status: 200, body: { code: 'SUCCESS', msg: 'success' } });
			expect(await rejection(http.listDevices())).to.be.instanceOf(UnexpectedResponseError);
			mock.failNext({ path: '/devices', status: 200, body: { code: 'SUCCESS', msg: 'success', data: 'nope' } });
			expect(await rejection(http.listDevices())).to.be.instanceOf(UnexpectedResponseError);
		});
	});

	describe('listDoors() / listUsers()', () => {
		it('listDoors requests GET /doors and returns the door list', async () => {
			const doors = await http.listDoors();
			expect(mock.requests).to.have.length(1);
			expect(mock.requests[0].method).to.equal('GET');
			expect(mock.requests[0].url).to.equal('/api/v1/developer/doors');
			expect(doors).to.deep.equal(fixtures.DEFAULT_DOORS);
		});

		it('listUsers requests GET /users with the documented pagination parameters and returns the user list', async () => {
			const users = await http.listUsers();
			expect(mock.requests).to.have.length(1);
			expect(mock.requests[0].method).to.equal('GET');
			expect(mock.requests[0].path).to.equal('/users');
			expect(mock.requests[0].query).to.deep.equal({ page_num: '1', page_size: '100' });
			expect(users.map(u => u.id)).to.deep.equal(fixtures.DEFAULT_USERS.map(u => u.id));
			expect(users[0].first_name).to.equal('Hong');
		});

		describe('listUsers() pagination (api_reference 3.5)', () => {
			const manyUsers = (count: number): { id: string; first_name: string }[] =>
				Array.from({ length: count }, (_, i) => ({ id: `user-${i + 1}`, first_name: `User ${i + 1}` }));

			it('fetches all pages until pagination.total is reached', async () => {
				mock.users = manyUsers(250);
				const users = await http.listUsers();
				expect(users).to.have.length(250);
				expect(users.map(u => u.id)).to.deep.equal(mock.users.map(u => u.id));
				expect(mock.requests.map(r => r.query)).to.deep.equal([
					{ page_num: '1', page_size: '100' },
					{ page_num: '2', page_size: '100' },
					{ page_num: '3', page_size: '100' },
				]);
			});

			it('does not request a further page when the first one is complete (exactly one page size)', async () => {
				mock.users = manyUsers(100);
				expect(await http.listUsers()).to.have.length(100);
				expect(mock.requests).to.have.length(1);
			});

			it('without a pagination block: continues while pages are full and stops at the first short page', async () => {
				const all = manyUsers(130);
				mock.failNext({ path: '/users', status: 200, body: { code: 'SUCCESS', data: all.slice(0, 100) } });
				mock.failNext({ path: '/users', status: 200, body: { code: 'SUCCESS', data: all.slice(100) } });
				expect(await http.listUsers()).to.have.length(130);
				expect(mock.requests).to.have.length(2);
			});

			it('a controller that ignores the paging parameters and always returns everything is not looped over', async () => {
				const all = manyUsers(100);
				mock.failNext({
					path: '/users',
					status: 200,
					body: { code: 'SUCCESS', data: all },
					times: Number.POSITIVE_INFINITY,
				});
				const users = await http.listUsers();
				// no pagination info and identical pages: stop instead of collecting duplicates
				expect(users).to.have.length(100);
				expect(mock.requests.length).to.be.lessThan(4);
			});

			it('never requests more than 50 pages', async () => {
				mock.failNext({
					path: '/users',
					status: 200,
					body: {
						code: 'SUCCESS',
						data: manyUsers(100),
						pagination: { page_num: 1, page_size: 100, total: 1e9 },
					},
					times: Number.POSITIVE_INFINITY,
				});
				await http.listUsers();
				expect(mock.requests.length).to.be.at.most(50);
			});

			it('falls back to the plain request when the controller rejects the paging parameters', async () => {
				mock.failNext({ path: '/users', status: 400, code: 'CODE_PARAMS_INVALID' });
				const users = await http.listUsers();
				expect(users).to.have.length(fixtures.DEFAULT_USERS.length);
				expect(mock.requests.map(r => r.url)).to.deep.equal([
					'/api/v1/developer/users?page_num=1&page_size=100',
					'/api/v1/developer/users',
				]);
			});

			it('an error on a later page rejects (no silently truncated list)', async () => {
				mock.users = manyUsers(150);
				const original = mock.users;
				mock.failNext({
					path: '/users',
					status: 200,
					body: {
						code: 'SUCCESS',
						data: original.slice(0, 100),
						pagination: { page_num: 1, page_size: 100, total: 150 },
					},
				});
				mock.failNext({ path: '/users', status: 500 });
				const err = await rejection(http.listUsers());
				expect((err as AxiosError).response?.status).to.equal(500);
			});
		});

		it('listUsers falls back to an empty list when "data" is missing', async () => {
			mock.failNext({ status: 200, body: { code: 'SUCCESS', msg: 'success' } });
			expect(await http.listUsers()).to.deep.equal([]);
		});

		// K-03: an empty door list would make every door unknown (control states stop working)
		it('listDoors rejects when "data" is missing or not an array', async () => {
			mock.failNext({ status: 200, body: { code: 'SUCCESS', msg: 'success' } });
			expect(await rejection(http.listDoors())).to.be.instanceOf(UnexpectedResponseError);
			mock.failNext({ status: 200, body: { code: 'SUCCESS', msg: 'success', data: {} } });
			expect(await rejection(http.listDoors())).to.be.instanceOf(UnexpectedResponseError);
		});
	});

	describe('unlockDoor()', () => {
		it('sends PUT /doors/:id/unlock with an empty JSON object when no actor is given', async () => {
			await http.unlockDoor(DOOR_A2);
			expect(mock.requests).to.have.length(1);
			const request = mock.requests[0];
			expect(request.method).to.equal('PUT');
			expect(request.url).to.equal(`/api/v1/developer/doors/${DOOR_A2}/unlock`);
			expect(request.query).to.deep.equal({});
			expect(request.body).to.deep.equal({});
			expect(request.status).to.equal(200);
			expect(mock.unlocks).to.have.length(1);
			expect(mock.unlocks[0].doorId).to.equal(DOOR_A2);
		});

		it('passes actor_id and actor_name together and nothing else (no duration)', async () => {
			await http.unlockDoor(DOOR_A2, { id: 'actor-uuid', name: 'Actor Name' });
			expect(mock.requests[0].body).to.deep.equal({ actor_id: 'actor-uuid', actor_name: 'Actor Name' });
			expect(mock.requests[0].status).to.equal(200);
		});

		it('omits the actor when id or name is empty (the API requires both or none)', async () => {
			await http.unlockDoor(DOOR_A2, { id: 'actor-uuid', name: '' });
			await http.unlockDoor(DOOR_A2, { id: '', name: 'Actor Name' });
			expect(mock.requests.map(r => r.body)).to.deep.equal([{}, {}]);
			expect(mock.requests.map(r => r.status)).to.deep.equal([200, 200]);
		});

		it('URL-encodes the door id', async () => {
			await rejection(http.unlockDoor('a/b c?d'));
			expect(mock.requests[0].url).to.equal('/api/v1/developer/doors/a%2Fb%20c%3Fd/unlock');
		});

		it('rejects for an unknown door (HTTP 400, CODE_NOT_EXISTS)', async () => {
			const err = await rejection(http.unlockDoor('does-not-exist'));
			expect(err).to.be.instanceOf(AxiosError);
			expect((err as AxiosError<{ code: string }>).response?.data.code).to.equal('CODE_NOT_EXISTS');
		});
	});

	describe('setDoorLockRule()', () => {
		it('sends PUT /doors/:id/lock_rule {type:"custom", interval} with the interval in minutes', async () => {
			await http.setDoorLockRule(DOOR_A2, { type: 'custom', interval: 10 });
			expect(mock.requests).to.have.length(1);
			const request = mock.requests[0];
			expect(request.method).to.equal('PUT');
			expect(request.url).to.equal(`/api/v1/developer/doors/${DOOR_A2}/lock_rule`);
			expect(request.body).to.deep.equal({ type: 'custom', interval: 10 });
			expect(request.status).to.equal(200);
			expect(mock.lockRules.get(DOOR_A2)?.type).to.equal('custom');
		});

		for (const type of ['keep_lock', 'keep_unlock', 'reset', 'lock_early', 'lock_now'] as const) {
			it(`sends {type:"${type}"} without interval`, async () => {
				await http.setDoorLockRule(DOOR_A2, { type });
				expect(mock.requests[0].body).to.deep.equal({ type });
				expect(mock.requests[0].status).to.equal(200);
			});
		}

		it('rejects when the controller refuses the payload (HTTP 400, CODE_PARAMS_INVALID)', async () => {
			const err = await rejection(http.setDoorLockRule(DOOR_A2, { type: 'custom' }));
			expect((err as AxiosError<{ code: string }>).response?.status).to.equal(400);
			expect((err as AxiosError<{ code: string }>).response?.data.code).to.equal('CODE_PARAMS_INVALID');
		});
	});

	describe('getDoor() / getDoorLockRule()', () => {
		it('getDoor requests GET /doors/:id and returns the door with its lock and position status', async () => {
			const door = await http.getDoor(fixtures.IDS.DOOR_3855);
			expect(mock.requests[0].method).to.equal('GET');
			expect(mock.requests[0].url).to.equal(`/api/v1/developer/doors/${fixtures.IDS.DOOR_3855}`);
			expect(door).to.deep.include({
				id: fixtures.IDS.DOOR_3855,
				door_lock_relay_status: 'lock',
				door_position_status: 'close',
			});
		});

		it('getDoor URL-encodes the id and rejects for an unknown door', async () => {
			const err = await rejection(http.getDoor('no/such door'));
			expect((err as AxiosError).response?.status).to.equal(400);
			expect(mock.requests[0].url).to.equal('/api/v1/developer/doors/no%2Fsuch%20door');
		});

		it('getDoor returns null when the response carries no door object', async () => {
			mock.failNext({ status: 200, body: { code: 'SUCCESS', msg: 'success' } });
			expect(await http.getDoor(fixtures.IDS.DOOR_3855)).to.equal(null);
			mock.failNext({ status: 200, body: { code: 'SUCCESS', data: 'text' } });
			expect(await http.getDoor(fixtures.IDS.DOOR_3855)).to.equal(null);
		});

		it('getDoorLockRule requests GET /doors/:id/lock_rule and returns type and ended_time', async () => {
			mock.lockRules.set(fixtures.IDS.DOOR_3855, { type: 'keep_lock', ended_time: 3_602_128_309 });
			expect(await http.getDoorLockRule(fixtures.IDS.DOOR_3855)).to.deep.equal({
				type: 'keep_lock',
				ended_time: 3_602_128_309,
			});
			expect(mock.requests[0].method).to.equal('GET');
			expect(mock.requests[0].url).to.equal(`/api/v1/developer/doors/${fixtures.IDS.DOOR_3855}/lock_rule`);
		});

		it('getDoorLockRule returns null when the response carries no rule object', async () => {
			mock.failNext({ status: 200, body: { code: 'SUCCESS', msg: 'success', data: null } });
			expect(await http.getDoorLockRule(fixtures.IDS.DOOR_3855)).to.equal(null);
		});
	});

	describe('getStaticResource()', () => {
		const path = '/preview/reader_0418d6a2bb7a_d2b87427-7efa-43c1-aa52-b00d40d99ecf_1722913291.jpg';

		it('requests GET /system/static/<path> and returns the raw bytes', async () => {
			const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
			mock.addStaticResource(path, bytes);
			const result = await http.getStaticResource(path);
			expect(mock.requests).to.have.length(1);
			expect(mock.requests[0].method).to.equal('GET');
			expect(mock.requests[0].url).to.equal(`/api/v1/developer/system/static${path}`);
			expect(Buffer.isBuffer(result)).to.equal(true);
			expect(result.equals(bytes)).to.equal(true);
		});

		it('strips leading slashes so the path is always relative to /system/static/', async () => {
			mock.addStaticResource('avatar/abc');
			await http.getStaticResource('avatar/abc');
			await http.getStaticResource('///avatar/abc');
			expect(mock.requests.map(r => r.url)).to.deep.equal([
				'/api/v1/developer/system/static/avatar/abc',
				'/api/v1/developer/system/static/avatar/abc',
			]);
		});

		it('rejects when the resource does not exist', async () => {
			const err = await rejection(http.getStaticResource('/preview/missing.jpg'));
			expect((err as AxiosError).response?.status).to.equal(404);
		});

		for (const bad of [
			'/../../users',
			'/preview/../../../users?page_size=1000',
			'/preview/%2e%2e/%2e%2e/users',
			'/preview/..%2f..%2fusers',
			'/preview/..\\..\\users',
			'/preview/x.jpg?page_size=1000',
			'https://127.0.0.1/preview/x.jpg',
			'//evil.example/preview/x.jpg',
			'/users',
			'',
		]) {
			it(`refuses the path ${JSON.stringify(bad)} without sending any request`, async () => {
				const err = await rejection(http.getStaticResource(bad));
				expect(err).to.be.instanceOf(InvalidStaticPathError);
				expect(mock.requests).to.have.length(0);
			});
		}
	});

	describe('emergency status', () => {
		it('getEmergencyStatus requests GET /doors/settings/emergency', async () => {
			mock.emergency = { lockdown: true, evacuation: false };
			expect(await http.getEmergencyStatus()).to.deep.equal({ lockdown: true, evacuation: false });
			expect(mock.requests[0].method).to.equal('GET');
			expect(mock.requests[0].path).to.equal('/doors/settings/emergency');
		});

		it('getEmergencyStatus falls back to "all off" when "data" is missing', async () => {
			mock.failNext({ status: 200, body: { code: 'SUCCESS', msg: 'success' } });
			expect(await http.getEmergencyStatus()).to.deep.equal({ lockdown: false, evacuation: false });
		});

		it('readEmergencyStatus returns both flags, or null when the response does not carry them as booleans', async () => {
			mock.emergency = { lockdown: false, evacuation: true };
			expect(await http.readEmergencyStatus()).to.deep.equal({ lockdown: false, evacuation: true });
			for (const data of [
				undefined,
				null,
				{},
				{ lockdown: true },
				{ lockdown: 'true', evacuation: false },
				'text',
			]) {
				mock.failNext({ status: 200, body: { code: 'SUCCESS', msg: 'success', data } });
				expect(await http.readEmergencyStatus(), JSON.stringify(data)).to.equal(null);
			}
		});

		it('setEmergencyStatus sends PUT /doors/settings/emergency with the payload', async () => {
			await http.setEmergencyStatus({ lockdown: false, evacuation: true });
			expect(mock.requests[0].method).to.equal('PUT');
			expect(mock.requests[0].path).to.equal('/doors/settings/emergency');
			expect(mock.requests[0].body).to.deep.equal({ lockdown: false, evacuation: true });
			expect(mock.emergency).to.deep.equal({ lockdown: false, evacuation: true });
		});
	});

	describe('webhook endpoints', () => {
		const payload = {
			name: 'ioBroker.unifi-access (unifi-access.0)',
			endpoint: 'http://192.0.2.10:8095/unifi-access-webhook',
			events: ['access.door.unlock', 'access.device.dps_status'],
		};

		it('createWebhookEndpoint sends POST /webhooks/endpoints and returns id and secret', async () => {
			const result = await http.createWebhookEndpoint(payload);
			expect(mock.requests).to.have.length(1);
			expect(mock.requests[0].method).to.equal('POST');
			expect(mock.requests[0].path).to.equal('/webhooks/endpoints');
			expect(mock.requests[0].body).to.deep.equal(payload);
			expect(result.code).to.equal('SUCCESS');
			expect(result.endpoint).to.deep.equal(mock.webhookEndpoints[0]);
			expect(result.endpoint?.secret).to.be.a('string').with.length.greaterThan(0);
		});

		it('createWebhookEndpoint reports CODE_DEVICE_WEBHOOK_ENDPOINT_DUPLICATED without an endpoint', async () => {
			mock.addWebhookEndpoint(payload);
			const result = await http.createWebhookEndpoint(payload);
			expect(result.code).to.equal('CODE_DEVICE_WEBHOOK_ENDPOINT_DUPLICATED');
			expect(result.endpoint).to.equal(undefined);
			expect(mock.webhookEndpoints).to.have.length(1);
		});

		it('listWebhookEndpoints requests GET /webhooks/endpoints (secrets included)', async () => {
			const existing = mock.addWebhookEndpoint(payload);
			const list = await http.listWebhookEndpoints();
			expect(mock.requests[0].method).to.equal('GET');
			expect(mock.requests[0].path).to.equal('/webhooks/endpoints');
			expect(list).to.deep.equal([existing]);
		});

		it('listWebhookEndpoints falls back to an empty list when "data" is missing', async () => {
			mock.failNext({ status: 200, body: { code: 'SUCCESS', msg: 'success' } });
			expect(await http.listWebhookEndpoints()).to.deep.equal([]);
		});

		it('deleteWebhookEndpoint sends DELETE /webhooks/endpoints/:id (URL-encoded)', async () => {
			const existing = mock.addWebhookEndpoint(payload);
			await http.deleteWebhookEndpoint(existing.id);
			expect(mock.requests[0].method).to.equal('DELETE');
			expect(mock.requests[0].url).to.equal(`/api/v1/developer/webhooks/endpoints/${existing.id}`);
			expect(mock.webhookEndpoints).to.have.length(0);

			await rejection(http.deleteWebhookEndpoint('a/b'));
			expect(mock.requests[1].url).to.equal('/api/v1/developer/webhooks/endpoints/a%2Fb');
		});
	});

	describe('fetchSystemLogsRaw()', () => {
		it('sends POST /system/logs {topic, since, until} and returns the raw envelope', async () => {
			mock.systemLogHits = [{ '@timestamp': '2023-07-11T12:11:27Z', _source: { target: [] } }];
			const raw = (await http.fetchSystemLogsRaw('door_openings', 1_690_770_546, 1_690_771_546)) as {
				code: string;
				data: { hits: unknown[] };
			};
			expect(mock.requests[0].method).to.equal('POST');
			expect(mock.requests[0].path).to.equal('/system/logs');
			expect(mock.requests[0].body).to.deep.equal({
				topic: 'door_openings',
				since: 1_690_770_546,
				until: 1_690_771_546,
			});
			expect(raw.code).to.equal('SUCCESS');
			expect(raw.data.hits).to.have.length(1);
		});
	});

	describe('error handling', () => {
		it('HTTP 401 (wrong token) rejects and classifies as "unauthorized"', async () => {
			const wrong = new UnifiHttp({ host: '127.0.0.1', port: mock.port, token: 'wrong' });
			const err = await rejection(wrong.listDevices());
			expect((err as AxiosError<{ code: string }>).response?.status).to.equal(401);
			expect((err as AxiosError<{ code: string }>).response?.data.code).to.equal('CODE_ACCESS_TOKEN_INVALID');
			expect(classifyError(err)).to.equal('unauthorized');
			expect(mock.requests[0].authorized).to.equal(false);
		});

		it('HTTP 403 classifies as "unauthorized"', async () => {
			mock.failNext({ code: 'CODE_UNAUTHORIZED' });
			const err = await rejection(http.listDoors());
			expect((err as AxiosError).response?.status).to.equal(403);
			expect(classifyError(err)).to.equal('unauthorized');
		});

		for (const status of [400, 404, 429, 500, 503]) {
			it(`HTTP ${status} rejects and classifies as "network"`, async () => {
				mock.failNext({ status, code: 'CODE_SYSTEM_ERROR' });
				const err = await rejection(http.listDoors());
				expect((err as AxiosError).response?.status).to.equal(status);
				expect(classifyError(err)).to.equal('network');
			});
		}

		it('a dropped connection rejects and classifies as "network"', async () => {
			mock.failNext({ hangUp: true });
			const err = await rejection(http.listDevices());
			expect(err).to.be.instanceOf(AxiosError);
			expect((err as AxiosError).response).to.equal(undefined);
			expect(classifyError(err)).to.equal('network');
		});

		it('an unreachable controller rejects and classifies as "network"', async function () {
			// connecting to a closed port can take a moment on Windows before it is refused
			this.timeout(15_000);
			const closedPort = await getFreePort();
			const unreachable = new UnifiHttp({ host: '127.0.0.1', port: closedPort, token: TOKEN });
			const err = await rejection(unreachable.listDevices());
			expect((err as AxiosError).code).to.equal('ECONNREFUSED');
			expect(classifyError(err)).to.equal('network');
		});

		it('classifyError treats non-HTTP errors as "network"', () => {
			expect(classifyError(new Error('boom'))).to.equal('network');
			expect(classifyError(undefined)).to.equal('network');
			expect(classifyError('nope')).to.equal('network');
		});

		// api_reference 2.8: "code: Represents the result of request handling and indicates success or failure".
		// The documentation does not say which HTTP status accompanies an error code, so both are handled.
		describe('response envelope with code != "SUCCESS" (HTTP 200)', () => {
			it('unlockDoor() rejects when the controller answers with an error code', async () => {
				mock.failNext({
					status: 200,
					code: 'CODE_DEVICE_DEVICE_OFFLINE',
					msg: 'The device is currently offline.',
				});
				const err = await rejection(http.unlockDoor(DOOR_A2));
				expect(String((err as Error).message)).to.contain('CODE_DEVICE_DEVICE_OFFLINE');
				expect(err).to.be.instanceOf(UnifiApiError);
				expect(err).to.include({
					code: 'CODE_DEVICE_DEVICE_OFFLINE',
					apiMessage: 'The device is currently offline.',
					httpStatus: 200,
				});
				expect((err as Error).message).to.contain('The device is currently offline.');
				expect((err as Error).message).to.contain(`PUT /api/v1/developer/doors/${DOOR_A2}/unlock`);
			});

			it('setDoorLockRule() rejects when the controller answers with an error code', async () => {
				mock.failNext({ status: 200, code: 'CODE_OPERATION_FORBIDDEN' });
				const err = await rejection(http.setDoorLockRule(DOOR_A2, { type: 'keep_unlock' }));
				expect(String((err as Error).message)).to.contain('CODE_OPERATION_FORBIDDEN');
			});

			it('listDevices() rejects instead of returning an empty list', async () => {
				mock.failNext({ status: 200, code: 'CODE_SYSTEM_ERROR' });
				const err = await rejection(http.listDevices());
				expect(String((err as Error).message)).to.contain('CODE_SYSTEM_ERROR');
			});

			for (const [name, call] of [
				['listDoors', (c: UnifiHttp) => c.listDoors()],
				['listUsers', (c: UnifiHttp) => c.listUsers()],
				['getDoor', (c: UnifiHttp) => c.getDoor(DOOR_A2)],
				['getDoorLockRule', (c: UnifiHttp) => c.getDoorLockRule(DOOR_A2)],
				['getEmergencyStatus', (c: UnifiHttp) => c.getEmergencyStatus()],
				['setEmergencyStatus', (c: UnifiHttp) => c.setEmergencyStatus({ lockdown: true })],
				['listWebhookEndpoints', (c: UnifiHttp) => c.listWebhookEndpoints()],
				['deleteWebhookEndpoint', (c: UnifiHttp) => c.deleteWebhookEndpoint('x')],
				[
					'updateWebhookEndpoint',
					(c: UnifiHttp) => c.updateWebhookEndpoint('x', { name: 'n', endpoint: 'http://a/b', events: [] }),
				],
				['fetchSystemLogsRaw', (c: UnifiHttp) => c.fetchSystemLogsRaw('door_openings', 1, 2)],
			] as [string, (c: UnifiHttp) => Promise<unknown>][]) {
				it(`${name}() rejects with the API error code`, async () => {
					mock.failNext({ status: 200, code: 'CODE_SYSTEM_ERROR', msg: 'An error occurred.', times: 2 });
					const err = await rejection(call(http));
					expect(err).to.be.instanceOf(UnifiApiError);
					expect((err as UnifiApiError).code).to.equal('CODE_SYSTEM_ERROR');
				});
			}

			it('getStaticResource() does not hand out a JSON error envelope as image bytes', async () => {
				mock.failNext({ status: 200, code: 'CODE_RESOURCE_NOT_FOUND', msg: 'not found' });
				const err = await rejection(http.getStaticResource('/preview/x.jpg'));
				expect(err).to.be.instanceOf(UnifiApiError);
				expect((err as UnifiApiError).code).to.equal('CODE_RESOURCE_NOT_FOUND');
			});

			it('getStaticResource() returns binary data untouched, even when the bytes look like JSON', async () => {
				const bytes = Buffer.from('{"code":"CODE_SYSTEM_ERROR"}');
				mock.addStaticResource('/preview/json-looking.jpg', bytes, 'image/jpeg');
				const result = await http.getStaticResource('/preview/json-looking.jpg');
				expect(result.equals(bytes)).to.equal(true);
			});

			// K-03: a reverse proxy, web interface or wrong port that answers every path with 200 is not the API
			it('a JSON request answered without the envelope (no "code") rejects with UnexpectedResponseError', async () => {
				for (const body of [{ data: [{ id: 'door-1', name: 'Plain' }] }, [], '<html>hello</html>', '']) {
					mock.failNext({ status: 200, body });
					const err = await rejection(http.listDoors());
					expect(err, JSON.stringify(body)).to.be.instanceOf(UnexpectedResponseError);
					expect((err as Error).message).to.contain('[GET /api/v1/developer/doors]');
					expect((err as Error).message).to.contain('host and port');
					expect(classifyError(err)).to.equal('network');
				}
				for (const call of [
					(c: UnifiHttp) => c.unlockDoor(DOOR_A2),
					(c: UnifiHttp) => c.setDoorLockRule(DOOR_A2, { type: 'keep_lock' }),
					(c: UnifiHttp) => c.setEmergencyStatus({ lockdown: false }),
					(c: UnifiHttp) => c.listWebhookEndpoints(),
				]) {
					mock.failNext({ status: 200, body: 'OK' });
					expect(await rejection(call(http))).to.be.instanceOf(UnexpectedResponseError);
				}
			});

			it('classifyError() treats the authentication codes as "unauthorized", other codes as "network"', async () => {
				for (const code of ['CODE_AUTH_FAILED', 'CODE_ACCESS_TOKEN_INVALID', 'CODE_UNAUTHORIZED']) {
					mock.failNext({ status: 200, code });
					expect(classifyError(await rejection(http.listDoors())), code).to.equal('unauthorized');
				}
				mock.failNext({ status: 200, code: 'CODE_SYSTEM_ERROR' });
				expect(classifyError(await rejection(http.listDoors()))).to.equal('network');
			});
		});

		describe('error code with an HTTP error status', () => {
			it('keeps the AxiosError (status available) and adds API code, message and endpoint to its text', async () => {
				mock.failNext({ status: 400, code: 'CODE_PARAMS_INVALID', msg: 'Invalid parameters.' });
				const err = await rejection(http.setDoorLockRule(DOOR_A2, { type: 'custom', interval: 5 }));
				expect(err).to.be.instanceOf(AxiosError);
				expect((err as AxiosError).response?.status).to.equal(400);
				expect((err as Error).message).to.equal(
					`Request failed with status code 400 (CODE_PARAMS_INVALID: Invalid parameters.) [PUT /api/v1/developer/doors/${DOOR_A2}/lock_rule]`,
				);
				expect(apiErrorCode(err)).to.equal('CODE_PARAMS_INVALID');
			});

			it('apiErrorCode() is undefined for errors without an API code', async () => {
				mock.failNext({ hangUp: true });
				expect(apiErrorCode(await rejection(http.listDoors()))).to.equal(undefined);
				expect(apiErrorCode(new Error('boom'))).to.equal(undefined);
				expect(apiErrorCode(undefined)).to.equal(undefined);
			});

			for (const [name, call, permission] of [
				['listDevices', (c: UnifiHttp) => c.listDevices(), 'view:device'],
				['listDoors', (c: UnifiHttp) => c.listDoors(), 'view:space'],
				['getDoorLockRule', (c: UnifiHttp) => c.getDoorLockRule(DOOR_A2), 'view:space'],
				['unlockDoor', (c: UnifiHttp) => c.unlockDoor(DOOR_A2), 'edit:space'],
				['setEmergencyStatus', (c: UnifiHttp) => c.setEmergencyStatus({ lockdown: true }), 'edit:space'],
				['listUsers', (c: UnifiHttp) => c.listUsers(), 'view:user'],
				['getStaticResource', (c: UnifiHttp) => c.getStaticResource('/preview/x.jpg'), 'view:system_log'],
				[
					'fetchSystemLogsRaw',
					(c: UnifiHttp) => c.fetchSystemLogsRaw('door_openings', 1, 2),
					'view:system_log',
				],
				['listWebhookEndpoints', (c: UnifiHttp) => c.listWebhookEndpoints(), 'view:webhook'],
				['deleteWebhookEndpoint', (c: UnifiHttp) => c.deleteWebhookEndpoint('x'), 'edit:webhook'],
			] as [string, (c: UnifiHttp) => Promise<unknown>, string][]) {
				it(`403 on ${name}() names the endpoint and the token permission it needs (${permission})`, async () => {
					mock.failNext({ status: 403, code: 'CODE_UNAUTHORIZED', times: 2 });
					const err = await rejection(call(http));
					expect((err as AxiosError).response?.status).to.equal(403);
					expect((err as Error).message).to.contain(`API token needs the permission "${permission}"`);
					expect((err as Error).message).to.match(/\[(GET|PUT|POST|DELETE) \/api\/v1\/developer\//);
					expect(classifyError(err)).to.equal('unauthorized');
				});
			}
		});

		describe('createWebhookEndpoint(): duplicate endpoint', () => {
			for (const status of [200, 400, 409]) {
				it(`reports CODE_DEVICE_WEBHOOK_ENDPOINT_DUPLICATED as a result, not as an error (HTTP ${status})`, async () => {
					const strict = new MockUnifiController({ token: TOKEN, duplicateEndpointHttpStatus: status });
					await strict.start();
					try {
						const client = new UnifiHttp({ host: '127.0.0.1', port: strict.port, token: TOKEN });
						const payload = {
							name: 'n',
							endpoint: 'http://192.0.2.10:8095/hook',
							events: ['access.door.unlock'],
						};
						expect((await client.createWebhookEndpoint(payload)).code).to.equal('SUCCESS');
						expect(await client.createWebhookEndpoint(payload)).to.deep.equal({
							code: 'CODE_DEVICE_WEBHOOK_ENDPOINT_DUPLICATED',
							endpoint: undefined,
						});
					} finally {
						await strict.stop();
					}
				});
			}

			it('other error codes on create are thrown', async () => {
				mock.failNext({ status: 200, code: 'CODE_PARAMS_INVALID' });
				const err = await rejection(
					http.createWebhookEndpoint({ name: 'n', endpoint: 'http://192.0.2.10:8095/hook', events: [] }),
				);
				expect((err as UnifiApiError).code).to.equal('CODE_PARAMS_INVALID');
			});
		});
	});

	describe('TLS', () => {
		it('verifyTLS=false accepts the self-signed controller certificate', async () => {
			const client = new UnifiHttp({ host: '127.0.0.1', port: mock.port, token: TOKEN, verifyTLS: false });
			expect(await client.listDoors()).to.have.length(2);
		});

		it('verifyTLS unset behaves like verifyTLS=false', async () => {
			expect(await http.listDoors()).to.have.length(2);
		});

		it('verifyTLS=true rejects the self-signed certificate before any request is sent', async () => {
			const client = new UnifiHttp({ host: '127.0.0.1', port: mock.port, token: TOKEN, verifyTLS: true });
			const err = await rejection(client.listDoors());
			expect((err as AxiosError).code).to.equal('DEPTH_ZERO_SELF_SIGNED_CERT');
			expect(classifyError(err)).to.equal('network');
			expect(mock.requests).to.have.length(0);
		});

		it('verifyTLS=true with the controller certificate as caCert succeeds', async () => {
			const client = new UnifiHttp({
				host: '127.0.0.1',
				port: mock.port,
				token: TOKEN,
				verifyTLS: true,
				caCert: mock.cert,
			});
			expect(await client.listDoors()).to.have.length(2);
			expect(mock.requests).to.have.length(1);
		});

		it('verifyTLS=true with the certificate also verifies the host name (localhost)', async () => {
			const client = new UnifiHttp({
				host: 'localhost',
				port: mock.port,
				token: TOKEN,
				verifyTLS: true,
				caCert: mock.cert,
			});
			let doors;
			try {
				doors = await client.listDoors();
			} catch (err) {
				// "localhost" may resolve to ::1 only, where the mock (bound to 127.0.0.1) does not listen
				expect((err as AxiosError).code).to.equal('ECONNREFUSED');
				return;
			}
			expect(doors).to.have.length(2);
		});

		it('verifyTLS=true with a foreign CA certificate is rejected', async () => {
			const client = new UnifiHttp({
				host: '127.0.0.1',
				port: mock.port,
				token: TOKEN,
				verifyTLS: true,
				caCert: createSelfSignedCert().cert,
			});
			const err = await rejection(client.listDoors());
			expect((err as AxiosError).response).to.equal(undefined);
			expect(mock.requests).to.have.length(0);
		});
	});

	describe('updateWebhookEndpoint()', () => {
		it('sends PUT /webhooks/endpoints/:id with name, URL and events and returns the endpoint (secret unchanged)', async () => {
			const existing = mock.addWebhookEndpoint({
				endpoint: 'http://192.0.2.10:8095/hook',
				name: 'old',
				events: ['a'],
			});
			const updated = await http.updateWebhookEndpoint(existing.id, {
				name: 'new',
				endpoint: 'http://192.0.2.11:8095/hook',
				events: ['access.door.unlock', 'access.device.dps_status'],
			});
			expect(mock.requests[0].method).to.equal('PUT');
			expect(mock.requests[0].url).to.equal(`/api/v1/developer/webhooks/endpoints/${existing.id}`);
			expect(mock.requests[0].body).to.deep.equal({
				name: 'new',
				endpoint: 'http://192.0.2.11:8095/hook',
				events: ['access.door.unlock', 'access.device.dps_status'],
			});
			expect(updated).to.deep.include({ id: existing.id, secret: existing.secret, name: 'new' });
			expect(mock.webhookEndpoints[0].events).to.deep.equal(['access.door.unlock', 'access.device.dps_status']);
		});

		it('rejects for an unknown endpoint id', async () => {
			const err = await rejection(
				http.updateWebhookEndpoint('missing', { name: 'n', endpoint: 'http://x/y', events: [] }),
			);
			expect((err as AxiosError).response?.status).to.equal(400);
		});
	});

	describe('redactSecrets()', () => {
		// K-15: webhook endpoints of other integrations may carry any custom header
		it('masks every value below "headers", whatever the header is called', () => {
			expect(
				redactSecrets({
					data: [
						{
							id: 'e1',
							name: 'foreign',
							endpoint: 'http://x/y',
							headers: { 'X-Api-Key': 'abc', 'X-Custom': 'def', Accept: 'json' },
						},
					],
				}),
			).to.deep.equal({
				data: [
					{
						id: 'e1',
						name: 'foreign',
						endpoint: 'http://x/y',
						headers: { 'X-Api-Key': '***', 'X-Custom': '***', Accept: '***' },
					},
				],
			});
		});

		it('masks credential-like keys anywhere (secret, token, password, key, auth, credential, signature)', () => {
			expect(
				redactSecrets({
					secret: 's',
					apiKey: 'k',
					access_token: 't',
					passwd: 'p',
					basicAuth: 'b',
					credentials: { user: 'u' },
					signature: 'sig',
					name: 'kept',
					nested: [{ clientSecret: 'c', id: 1 }],
				}),
			).to.deep.equal({
				secret: '***',
				apiKey: '***',
				access_token: '***',
				passwd: '***',
				basicAuth: '***',
				credentials: '***',
				signature: '***',
				name: 'kept',
				nested: [{ clientSecret: '***', id: 1 }],
			});
		});
	});

	describe('debugLog', () => {
		it('logs method, url and status of webhook endpoint calls only', async () => {
			const lines: string[] = [];
			const client = new UnifiHttp({
				host: '127.0.0.1',
				port: mock.port,
				token: TOKEN,
				debugLog: line => lines.push(line),
			});
			await client.listDoors();
			await client.listDevices();
			expect(lines).to.deep.equal([]);
			await client.listWebhookEndpoints();
			expect(lines).to.have.length(1);
			expect(lines[0]).to.contain('GET /api/v1/developer/webhooks/endpoints');
			expect(lines[0]).to.contain('status=200');
		});

		// The response body of every /webhooks/endpoints call contains the HMAC signing secret of each endpoint.
		it('never writes the webhook signing secret (or the API token) into the log', async () => {
			const lines: string[] = [];
			const client = new UnifiHttp({
				host: '127.0.0.1',
				port: mock.port,
				token: TOKEN,
				debugLog: line => lines.push(line),
			});
			const created = await client.createWebhookEndpoint({
				name: 'n',
				endpoint: 'http://192.0.2.10:8095/unifi-access-webhook',
				events: ['access.door.unlock'],
			});
			await client.listWebhookEndpoints();
			const secret = created.endpoint?.secret ?? '';
			expect(secret).to.have.length.greaterThan(0);
			expect(lines).to.have.length(2);
			expect(lines.join('\n')).to.not.contain(secret);
			expect(lines.join('\n')).to.not.contain(TOKEN);
			expect(lines.join('\n')).to.contain('"secret":"***"');
		});

		it('never writes custom headers of foreign webhook endpoints into the log (K-15)', async () => {
			const lines: string[] = [];
			const client = new UnifiHttp({
				host: '127.0.0.1',
				port: mock.port,
				token: TOKEN,
				debugLog: line => lines.push(line),
			});
			mock.addWebhookEndpoint({
				endpoint: 'http://192.0.2.99/other',
				name: 'other integration',
				headers: { 'X-Api-Key': 'foreign-api-key-123', 'X-Hub': 'hub-value-456' },
			});
			await client.listWebhookEndpoints();
			expect(lines).to.have.length(1);
			expect(lines[0]).to.not.contain('foreign-api-key-123');
			expect(lines[0]).to.not.contain('hub-value-456');
			expect(lines[0]).to.contain('"X-Api-Key":"***"');
		});
	});
});
