import { expect } from 'chai';
import { AxiosError } from 'axios';

import { createSelfSignedCert, fixtures, getFreePort, MockUnifiController, rejection } from '../../test/mock';
import { classifyError, InvalidStaticPathError, UnifiHttp } from './unifiHttp';

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

	describe('verify()', () => {
		it('performs a read-only GET /devices', async () => {
			await http.verify();
			expect(mock.requests).to.have.length(1);
			expect(mock.requests[0].method).to.equal('GET');
			expect(mock.requests[0].path).to.equal('/devices');
			expect(mock.requests[0].rawBody).to.equal('');
		});

		it('rejects when the token is wrong', async () => {
			const wrong = new UnifiHttp({ host: '127.0.0.1', port: mock.port, token: 'wrong' });
			const err = await rejection(wrong.verify());
			expect(err).to.be.instanceOf(AxiosError);
			expect((err as AxiosError).response?.status).to.equal(401);
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

		it('returns an empty list when "data" is missing or not an array', async () => {
			mock.failNext({ path: '/devices', status: 200, body: { code: 'SUCCESS', msg: 'success' } });
			expect(await http.listDevices()).to.deep.equal([]);
			mock.failNext({ path: '/devices', status: 200, body: { code: 'SUCCESS', msg: 'success', data: 'nope' } });
			expect(await http.listDevices()).to.deep.equal([]);
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

		it('listUsers requests GET /users and returns the user list', async () => {
			const users = await http.listUsers();
			expect(mock.requests).to.have.length(1);
			expect(mock.requests[0].method).to.equal('GET');
			expect(mock.requests[0].path).to.equal('/users');
			expect(users.map(u => u.id)).to.deep.equal(fixtures.DEFAULT_USERS.map(u => u.id));
			expect(users[0].first_name).to.equal('Hong');
		});

		it('fall back to an empty list when "data" is missing', async () => {
			mock.failNext({ status: 200, body: { code: 'SUCCESS', msg: 'success' }, times: 2 });
			expect(await http.listDoors()).to.deep.equal([]);
			expect(await http.listUsers()).to.deep.equal([]);
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

		// BUG-C-01: UnifiHttp ignores the `code` field of the documented response envelope
		// (api_reference 2.8: "code: Represents the result of request handling and indicates success or
		// failure"). A response with HTTP 200 and code != SUCCESS is treated as success: write calls resolve
		// and read calls silently return an empty list.
		describe('response envelope with code != "SUCCESS" (HTTP 200)', () => {
			it.skip('BUG-C-01: unlockDoor() rejects when the controller answers with an error code', async () => {
				mock.failNext({
					status: 200,
					code: 'CODE_DEVICE_DEVICE_OFFLINE',
					msg: 'The device is currently offline.',
				});
				const err = await rejection(http.unlockDoor(DOOR_A2));
				expect(String((err as Error).message)).to.contain('CODE_DEVICE_DEVICE_OFFLINE');
			});

			it.skip('BUG-C-01: setDoorLockRule() rejects when the controller answers with an error code', async () => {
				mock.failNext({ status: 200, code: 'CODE_OPERATION_FORBIDDEN' });
				const err = await rejection(http.setDoorLockRule(DOOR_A2, { type: 'keep_unlock' }));
				expect(String((err as Error).message)).to.contain('CODE_OPERATION_FORBIDDEN');
			});

			it.skip('BUG-C-01: listDevices() rejects instead of returning an empty list', async () => {
				mock.failNext({ status: 200, code: 'CODE_SYSTEM_ERROR' });
				const err = await rejection(http.listDevices());
				expect(String((err as Error).message)).to.contain('CODE_SYSTEM_ERROR');
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
	});
});
