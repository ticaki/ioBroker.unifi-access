import { expect } from 'chai';
import { AxiosError } from 'axios';

import { createTestLogger, fixtures, MockUnifiController, rejection, type TestLogger } from '../../test/mock';
import { UnifiHttp } from '../lib/unifiHttp';
import {
	DEFAULT_WEBHOOK_EVENTS,
	ensureRegistration,
	RegistrationStoppedError,
	reregister,
	type RegistrationOptions,
} from './registration';

const TOKEN = 'registration-test-token';
/** Name scheme with the ioBroker host: identifies one installation */
const NAME = 'ioBroker.unifi-access (unifi-access.0@iobroker-prod)';
/** Name scheme of earlier adapter versions — the same for every installation */
const LEGACY_NAME = 'ioBroker.unifi-access (unifi-access.0)';
const OTHER_HOST_NAME = 'ioBroker.unifi-access (unifi-access.0@dev-server)';
const PUBLIC_URL = 'http://192.0.2.10:8095/unifi-access-webhook';
const OLD_URL = 'http://192.0.2.99:8095/unifi-access-webhook';
const ENDPOINTS = '/webhooks/endpoints';
const EMPTY_LIST = { code: 'SUCCESS', msg: 'success', data: [] };

describe('webhook registration (against the mock controller)', () => {
	let mock: MockUnifiController;
	let logger: TestLogger;
	let options: RegistrationOptions;

	const calls = (): string[] => mock.requests.map(r => `${r.method} ${r.path}`);

	before(async () => {
		mock = new MockUnifiController({ token: TOKEN });
		await mock.start();
	});

	after(async () => {
		await mock.stop();
	});

	beforeEach(() => {
		mock.reset();
		logger = createTestLogger();
		options = {
			http: new UnifiHttp({ host: '127.0.0.1', port: mock.port, token: TOKEN }),
			publicUrl: PUBLIC_URL,
			name: NAME,
			logger,
		};
	});

	it('DEFAULT_WEBHOOK_EVENTS are exactly the documented webhook events (api_reference 11.2)', () => {
		expect([...DEFAULT_WEBHOOK_EVENTS].sort()).to.deep.equal([...fixtures.WEBHOOK_EVENTS].sort());
	});

	describe('ensureRegistration()', () => {
		it('registers a new endpoint with name, URL and all default events', async () => {
			const result = await ensureRegistration(options);

			expect(calls()).to.deep.equal([`GET ${ENDPOINTS}`, `POST ${ENDPOINTS}`]);
			expect(mock.requests[1].body).to.deep.equal({
				name: NAME,
				endpoint: PUBLIC_URL,
				events: [...DEFAULT_WEBHOOK_EVENTS],
			});
			expect(mock.webhookEndpoints).to.have.length(1);
			expect(result).to.deep.equal({
				id: mock.webhookEndpoints[0].id,
				secret: mock.webhookEndpoints[0].secret,
				endpoint: PUBLIC_URL,
			});
			expect(logger.of('info')).to.deep.equal([
				`Registered new webhook endpoint ${result.id} for ${PUBLIC_URL}.`,
			]);
		});

		it('registers only the requested events when given', async () => {
			await ensureRegistration({ ...options, events: ['access.door.unlock'] });
			expect(mock.requests[1].body.events).to.deep.equal(['access.door.unlock']);
		});

		it('reuses an endpoint that is already registered for the URL (no write request)', async () => {
			const existing = mock.addWebhookEndpoint({ endpoint: PUBLIC_URL, name: NAME });
			const result = await ensureRegistration(options);
			expect(calls()).to.deep.equal([`GET ${ENDPOINTS}`]);
			expect(result).to.deep.equal({ id: existing.id, secret: existing.secret, endpoint: PUBLIC_URL });
			expect(mock.webhookEndpoints).to.deep.equal([existing]);
		});

		it('adopts an endpoint with the same URL that was registered under another name: renamed via PUT, id and secret kept', async () => {
			const existing = mock.addWebhookEndpoint({ endpoint: PUBLIC_URL, name: LEGACY_NAME });
			const result = await ensureRegistration(options);
			expect(result).to.deep.equal({ id: existing.id, secret: existing.secret, endpoint: PUBLIC_URL });
			expect(calls()).to.deep.equal([`GET ${ENDPOINTS}`, `PUT ${ENDPOINTS}/${existing.id}`]);
			expect(mock.webhookEndpoints).to.have.length(1);
			expect(mock.webhookEndpoints[0].name).to.equal(NAME);
		});

		// An endpoint that was registered with fewer events (older adapter version, created by hand) would
		// never deliver the missing event types.
		it('an existing endpoint ends up subscribed to all required events — via PUT, with unchanged id and secret', async () => {
			const existing = mock.addWebhookEndpoint({
				endpoint: PUBLIC_URL,
				name: NAME,
				events: ['access.door.unlock'],
			});
			const { id, secret } = existing;
			const result = await ensureRegistration(options);

			expect(calls()).to.deep.equal([`GET ${ENDPOINTS}`, `PUT ${ENDPOINTS}/${id}`]);
			expect(mock.requests[1].body).to.deep.equal({
				name: NAME,
				endpoint: PUBLIC_URL,
				events: [...DEFAULT_WEBHOOK_EVENTS],
			});
			const registered = mock.webhookEndpoints.filter(e => e.endpoint === PUBLIC_URL);
			expect(registered).to.have.length(1);
			expect(registered[0].id).to.equal(result.id);
			expect(registered[0].secret).to.equal(result.secret);
			expect([...registered[0].events].sort()).to.deep.equal([...DEFAULT_WEBHOOK_EVENTS].sort());
			// no new credentials → nothing to store, no adapter restart
			expect(result).to.deep.equal({ id, secret, endpoint: PUBLIC_URL });
		});

		it('does not send an update when only the order of the events differs', async () => {
			mock.addWebhookEndpoint({
				endpoint: PUBLIC_URL,
				name: NAME,
				events: [...DEFAULT_WEBHOOK_EVENTS].reverse(),
			});
			await ensureRegistration(options);
			expect(calls()).to.deep.equal([`GET ${ENDPOINTS}`]);
		});

		it('keeps custom headers of the endpoint when it is updated', async () => {
			const existing = mock.addWebhookEndpoint({
				endpoint: PUBLIC_URL,
				name: NAME,
				events: ['access.door.unlock'],
				headers: { 'X-Proxy-Auth': 'abc' },
			});
			await ensureRegistration(options);
			expect(mock.requests[1].body.headers).to.deep.equal({ 'X-Proxy-Auth': 'abc' });
			expect(mock.webhookEndpoints.find(e => e.id === existing.id)?.headers).to.deep.equal({
				'X-Proxy-Auth': 'abc',
			});
		});

		it('keeps working with the old event list when the update is refused (warning)', async () => {
			const existing = mock.addWebhookEndpoint({
				endpoint: PUBLIC_URL,
				name: NAME,
				events: ['access.door.unlock'],
			});
			mock.failNext({ method: 'PUT', status: 500 });
			const result = await ensureRegistration(options);
			expect(result).to.deep.equal({ id: existing.id, secret: existing.secret, endpoint: PUBLIC_URL });
			expect(logger.of('warn')).to.have.length(1);
			expect(logger.of('warn')[0]).to.contain('could not be updated');
			expect(calls()).to.deep.equal([`GET ${ENDPOINTS}`, `PUT ${ENDPOINTS}/${existing.id}`]);
		});

		it('moves the endpoint of this installation to the new URL (changed IP) via PUT — id and secret stay', async () => {
			const stale = mock.addWebhookEndpoint({ endpoint: OLD_URL, name: NAME });
			const foreign = mock.addWebhookEndpoint({
				endpoint: 'https://example.invalid/hook',
				name: 'other integration',
			});

			const result = await ensureRegistration(options);

			expect(calls()).to.deep.equal([`GET ${ENDPOINTS}`, `PUT ${ENDPOINTS}/${stale.id}`]);
			expect(result).to.deep.equal({ id: stale.id, secret: stale.secret, endpoint: PUBLIC_URL });
			expect(mock.webhookEndpoints.map(e => `${e.id} ${e.endpoint}`)).to.deep.equal([
				`${stale.id} ${PUBLIC_URL}`,
				`${foreign.id} https://example.invalid/hook`,
			]);
		});

		it('with several outdated endpoints of this installation: the stored one is moved, the others are removed', async () => {
			const stale1 = mock.addWebhookEndpoint({ endpoint: OLD_URL, name: NAME });
			const stored = mock.addWebhookEndpoint({
				endpoint: 'http://172.17.0.2:8095/unifi-access-webhook',
				name: NAME,
			});

			const result = await ensureRegistration({ ...options, storedId: stored.id, storedSecret: stored.secret });

			expect(calls()).to.deep.equal([
				`GET ${ENDPOINTS}`,
				`PUT ${ENDPOINTS}/${stored.id}`,
				`DELETE ${ENDPOINTS}/${stale1.id}`,
			]);
			expect(result.id).to.equal(stored.id);
			expect(mock.webhookEndpoints.map(e => e.id)).to.deep.equal([stored.id]);
		});

		it('removes outdated endpoints of this installation also when the current URL is already registered', async () => {
			const stale = mock.addWebhookEndpoint({ endpoint: OLD_URL, name: NAME });
			const current = mock.addWebhookEndpoint({ endpoint: PUBLIC_URL, name: NAME });
			const result = await ensureRegistration(options);
			expect(result.id).to.equal(current.id);
			expect(calls()).to.deep.equal([`GET ${ENDPOINTS}`, `DELETE ${ENDPOINTS}/${stale.id}`]);
			expect(mock.webhookEndpoints).to.deep.equal([current]);
		});

		describe('two installations at the same controller (R-18b)', () => {
			it('never touches the endpoint of another ioBroker host', async () => {
				const other = mock.addWebhookEndpoint({ endpoint: OLD_URL, name: OTHER_HOST_NAME });
				const result = await ensureRegistration(options);
				expect(calls()).to.deep.equal([`GET ${ENDPOINTS}`, `POST ${ENDPOINTS}`]);
				expect(mock.webhookEndpoints.map(e => e.id)).to.deep.equal([other.id, result.id]);
				expect(mock.webhookEndpoints[0]).to.deep.equal(other);
			});

			it('never touches an endpoint with the name scheme of earlier versions unless it is the stored one', async () => {
				// could belong to this installation or to a second one — the name alone does not tell
				const legacy = mock.addWebhookEndpoint({ endpoint: OLD_URL, name: LEGACY_NAME });
				const result = await ensureRegistration(options);
				expect(mock.findRequests({ method: 'DELETE' })).to.deep.equal([]);
				expect(mock.findRequests({ method: 'PUT' })).to.deep.equal([]);
				expect(mock.webhookEndpoints.map(e => e.id)).to.deep.equal([legacy.id, result.id]);
			});

			it('takes over the endpoint with the old name scheme when its id is the stored one (moved and renamed, secret kept)', async () => {
				const legacy = mock.addWebhookEndpoint({ endpoint: OLD_URL, name: LEGACY_NAME });
				const result = await ensureRegistration({
					...options,
					storedId: legacy.id,
					storedSecret: legacy.secret,
				});
				expect(calls()).to.deep.equal([`GET ${ENDPOINTS}`, `PUT ${ENDPOINTS}/${legacy.id}`]);
				expect(result).to.deep.equal({ id: legacy.id, secret: legacy.secret, endpoint: PUBLIC_URL });
				expect(mock.webhookEndpoints[0]).to.include({ name: NAME, endpoint: PUBLIC_URL });
			});

			it('both installations keep their own endpoint across repeated starts', async () => {
				const prod = { ...options };
				const dev = { ...options, name: OTHER_HOST_NAME, publicUrl: OLD_URL };
				const first = { prod: await ensureRegistration(prod), dev: await ensureRegistration(dev) };
				for (let start = 0; start < 3; start++) {
					expect(
						await ensureRegistration({ ...prod, storedId: first.prod.id, storedSecret: first.prod.secret }),
					).to.deep.equal(first.prod);
					expect(
						await ensureRegistration({ ...dev, storedId: first.dev.id, storedSecret: first.dev.secret }),
					).to.deep.equal(first.dev);
				}
				expect(mock.webhookEndpoints).to.have.length(2);
				expect(mock.findRequests({ method: 'DELETE' })).to.deep.equal([]);
				expect(mock.findRequests({ method: 'POST' })).to.have.length(2);
			});
		});

		it('continues when a stale endpoint cannot be removed (warning)', async () => {
			const stale = mock.addWebhookEndpoint({ endpoint: OLD_URL, name: NAME });
			mock.addWebhookEndpoint({ endpoint: PUBLIC_URL, name: NAME });
			mock.failNext({ method: 'DELETE', status: 500 });
			const result = await ensureRegistration(options);
			expect(result.endpoint).to.equal(PUBLIC_URL);
			expect(logger.of('warn')).to.have.length(1);
			expect(logger.of('warn')[0]).to.contain(`Could not remove stale endpoint ${stale.id}`);
			expect(mock.webhookEndpoints).to.have.length(2);
		});

		it('registers a new endpoint when the outdated one cannot be moved (warning)', async () => {
			const stale = mock.addWebhookEndpoint({ endpoint: OLD_URL, name: NAME });
			mock.failNext({ method: 'PUT', status: 500 });
			const result = await ensureRegistration(options);
			expect(calls()).to.deep.equal([
				`GET ${ENDPOINTS}`,
				`PUT ${ENDPOINTS}/${stale.id}`,
				`DELETE ${ENDPOINTS}/${stale.id}`,
				`POST ${ENDPOINTS}`,
			]);
			expect(result.id).to.not.equal(stale.id);
			expect(mock.webhookEndpoints.map(e => e.id)).to.deep.equal([result.id]);
			expect(logger.of('warn')[0]).to.contain(`Could not update webhook endpoint ${stale.id}`);
		});

		describe('list without secrets (R-18a: no recreate on every start, no restart loop)', () => {
			it('uses the stored secret when the endpoint is the stored one — no write request', async () => {
				const existing = mock.addWebhookEndpoint({ endpoint: PUBLIC_URL, name: NAME });
				mock.omitSecretInList = true;
				for (let start = 0; start < 3; start++) {
					const result = await ensureRegistration({
						...options,
						storedId: existing.id,
						storedSecret: existing.secret,
					});
					expect(result).to.deep.equal({ id: existing.id, secret: existing.secret, endpoint: PUBLIC_URL });
				}
				expect(calls()).to.deep.equal([`GET ${ENDPOINTS}`, `GET ${ENDPOINTS}`, `GET ${ENDPOINTS}`]);
			});

			it('recreates once when nothing is stored, and is stable afterwards', async () => {
				mock.addWebhookEndpoint({ endpoint: PUBLIC_URL, name: NAME });
				mock.omitSecretInList = true;
				const first = await ensureRegistration(options);
				const writes = mock.requests.filter(r => r.method !== 'GET').length;
				for (let start = 0; start < 3; start++) {
					expect(
						await ensureRegistration({ ...options, storedId: first.id, storedSecret: first.secret }),
					).to.deep.equal(first);
				}
				expect(mock.requests.filter(r => r.method !== 'GET')).to.have.length(writes);
				expect(mock.webhookEndpoints).to.have.length(1);
			});
		});

		it('recreates the endpoint when the list does not return its secret and none is stored', async () => {
			const existing = mock.addWebhookEndpoint({ endpoint: PUBLIC_URL, name: NAME });
			mock.omitSecretInList = true;

			const result = await ensureRegistration(options);

			expect(calls()).to.deep.equal([
				`GET ${ENDPOINTS}`,
				`DELETE ${ENDPOINTS}/${existing.id}`,
				`POST ${ENDPOINTS}`,
			]);
			expect(result.id).to.not.equal(existing.id);
			expect(result.secret).to.equal(mock.webhookEndpoints[0].secret);
			expect(mock.webhookEndpoints).to.have.length(1);
		});

		it('duplicate on create (registered between list and create): reuses the endpoint from a fresh list', async () => {
			const existing = mock.addWebhookEndpoint({ endpoint: PUBLIC_URL, name: NAME });
			// first list is still empty, the create then collides with the existing endpoint
			mock.failNext({ method: 'GET', path: ENDPOINTS, status: 200, body: EMPTY_LIST });

			const result = await ensureRegistration(options);

			expect(calls()).to.deep.equal([`GET ${ENDPOINTS}`, `POST ${ENDPOINTS}`, `GET ${ENDPOINTS}`]);
			expect(mock.requests[1].response).to.deep.include({ code: 'CODE_DEVICE_WEBHOOK_ENDPOINT_DUPLICATED' });
			expect(result).to.deep.equal({ id: existing.id, secret: existing.secret, endpoint: PUBLIC_URL });
			expect(mock.webhookEndpoints).to.deep.equal([existing]);
		});

		it('duplicate on create but still not listed: fails with a clear error', async () => {
			mock.addWebhookEndpoint({ endpoint: PUBLIC_URL, name: NAME });
			mock.failNext({ method: 'GET', path: ENDPOINTS, status: 200, body: EMPTY_LIST, times: 2 });
			const err = await rejection(ensureRegistration(options));
			expect(err.message).to.equal(
				'Webhook endpoint is duplicated on controller but could not be found in the list.',
			);
		});

		it('fails when the create response carries no id/secret', async () => {
			mock.failNext({
				method: 'POST',
				status: 200,
				body: { code: 'SUCCESS', msg: 'success', data: { endpoint: PUBLIC_URL } },
			});
			const err = await rejection(ensureRegistration(options));
			expect(err.message).to.equal('Webhook endpoint created but response did not include id/secret.');
		});

		it('rejects when the endpoint list cannot be fetched (nothing is created)', async () => {
			mock.failNext({ method: 'GET', status: 500 });
			const err = await rejection(ensureRegistration(options));
			expect(err).to.be.instanceOf(AxiosError);
			expect(calls()).to.deep.equal([`GET ${ENDPOINTS}`]);
		});

		it('rejects when the token is not accepted', async () => {
			const unauthorized = {
				...options,
				http: new UnifiHttp({ host: '127.0.0.1', port: mock.port, token: 'wrong' }),
			};
			const err = await rejection(ensureRegistration(unauthorized));
			expect((err as AxiosError).response?.status).to.equal(401);
			expect(mock.webhookEndpoints).to.have.length(0);
		});
	});

	describe('reregister()', () => {
		it('deletes the stored endpoint and creates a new one with a fresh secret', async () => {
			const old = mock.addWebhookEndpoint({ endpoint: PUBLIC_URL, name: NAME });

			const result = await reregister(options, old.id);

			expect(calls()).to.deep.equal([`GET ${ENDPOINTS}`, `DELETE ${ENDPOINTS}/${old.id}`, `POST ${ENDPOINTS}`]);
			expect(mock.requests[2].body).to.deep.equal({
				name: NAME,
				endpoint: PUBLIC_URL,
				events: [...DEFAULT_WEBHOOK_EVENTS],
			});
			expect(result.id).to.not.equal(old.id);
			expect(result.secret).to.not.equal(old.secret);
			expect(result.endpoint).to.equal(PUBLIC_URL);
			expect(mock.webhookEndpoints.map(e => e.id)).to.deep.equal([result.id]);
			expect(logger.of('info')).to.deep.equal([`Deleted webhook endpoint ${old.id}.`]);
		});

		it('deletes by stored id, by URL and by the name of this installation, but leaves everything else alone', async () => {
			const byId = mock.addWebhookEndpoint({ endpoint: OLD_URL, name: LEGACY_NAME });
			const byUrl = mock.addWebhookEndpoint({ endpoint: PUBLIC_URL, name: 'someone else' });
			const byName = mock.addWebhookEndpoint({
				endpoint: 'http://172.17.0.2:8095/unifi-access-webhook',
				name: NAME,
			});
			const otherHost = mock.addWebhookEndpoint({
				endpoint: 'http://192.0.2.50:8095/unifi-access-webhook',
				name: OTHER_HOST_NAME,
			});
			const legacyOfSomeoneElse = mock.addWebhookEndpoint({
				endpoint: 'http://192.0.2.51:8095/unifi-access-webhook',
				name: LEGACY_NAME,
			});
			const foreign = mock.addWebhookEndpoint({
				endpoint: 'https://example.invalid/hook',
				name: 'other integration',
			});

			const result = await reregister(options, byId.id);

			expect(mock.findRequests({ method: 'DELETE' }).map(r => r.path)).to.have.members([
				`${ENDPOINTS}/${byId.id}`,
				`${ENDPOINTS}/${byUrl.id}`,
				`${ENDPOINTS}/${byName.id}`,
			]);
			expect(mock.webhookEndpoints.map(e => e.id)).to.deep.equal([
				otherHost.id,
				legacyOfSomeoneElse.id,
				foreign.id,
				result.id,
			]);
		});

		it('simply registers when nothing is stored and nothing exists', async () => {
			const result = await reregister(options, null);
			expect(calls()).to.deep.equal([`GET ${ENDPOINTS}`, `POST ${ENDPOINTS}`]);
			expect(mock.webhookEndpoints.map(e => e.id)).to.deep.equal([result.id]);
		});

		it('honours a custom event list', async () => {
			await reregister({ ...options, events: ['access.doorbell.incoming'] }, null);
			expect(mock.requests[1].body.events).to.deep.equal(['access.doorbell.incoming']);
		});

		it('recovers when the cleanup could not list the endpoints: duplicate → second cleanup → retry', async () => {
			const old = mock.addWebhookEndpoint({ endpoint: PUBLIC_URL, name: NAME });
			mock.failNext({ method: 'GET', path: ENDPOINTS, status: 500 });

			const result = await reregister(options, old.id);

			expect(calls()).to.deep.equal([
				`GET ${ENDPOINTS}`, // fails
				`POST ${ENDPOINTS}`, // duplicate
				`GET ${ENDPOINTS}`,
				`DELETE ${ENDPOINTS}/${old.id}`,
				`POST ${ENDPOINTS}`,
			]);
			expect(result.id).to.not.equal(old.id);
			expect(mock.webhookEndpoints.map(e => e.id)).to.deep.equal([result.id]);
			expect(logger.of('warn')).to.have.length(2);
			expect(logger.of('warn')[0]).to.contain('Could not list webhook endpoints before delete');
			expect(logger.of('warn')[1]).to.equal('Webhook endpoint still duplicated after delete — retrying cleanup.');
		});

		it('fails with a clear error when the old endpoint cannot be deleted at all', async () => {
			const old = mock.addWebhookEndpoint({ endpoint: PUBLIC_URL, name: NAME });
			mock.failNext({ method: 'DELETE', status: 500, times: Number.POSITIVE_INFINITY });

			const err = await rejection(reregister(options, old.id));

			expect(err.message).to.equal(
				'Webhook endpoint re-registration failed: response did not include id/secret after duplicate cleanup.',
			);
			expect(mock.webhookEndpoints).to.deep.equal([old]);
			expect(
				logger.of('warn').filter(m => m.includes(`Failed to delete webhook endpoint ${old.id}`)),
			).to.have.length(2);
		});

		it('fails when the create response carries no id/secret', async () => {
			mock.failNext({ method: 'POST', status: 200, body: { code: 'SUCCESS', msg: 'success', data: {} } });
			const err = await rejection(reregister(options, null));
			expect(err.message).to.equal('Webhook endpoint created but response did not include id/secret.');
		});

		it('rejects when the create request fails', async () => {
			mock.failNext({ method: 'POST', status: 500 });
			const err = await rejection(reregister(options, null));
			expect(err).to.be.instanceOf(AxiosError);
		});

		describe('stops sending once isStopped() says so (R2K-03)', () => {
			it('stopped before the start: nothing is sent', async () => {
				const err = await rejection(reregister({ ...options, isStopped: () => true }, null));
				expect(err).to.be.instanceOf(RegistrationStoppedError);
				expect(calls()).to.deep.equal([]);
			});

			it('stopped after the listing: no DELETE, no POST', async () => {
				const old = mock.addWebhookEndpoint({ endpoint: PUBLIC_URL, name: NAME });
				let stopped = false;
				const original = options.http.listWebhookEndpoints.bind(options.http);
				const http = Object.create(options.http) as typeof options.http;
				http.listWebhookEndpoints = async () => {
					const list = await original();
					stopped = true;
					return list;
				};
				const err = await rejection(reregister({ ...options, http, isStopped: () => stopped }, old.id));
				expect(err).to.be.instanceOf(RegistrationStoppedError);
				expect(calls()).to.deep.equal([`GET ${ENDPOINTS}`]);
				expect(mock.webhookEndpoints).to.deep.equal([old]);
			});

			it('stopped after the delete: no POST', async () => {
				const old = mock.addWebhookEndpoint({ endpoint: PUBLIC_URL, name: NAME });
				const isStopped = (): boolean => mock.findRequests({ method: 'DELETE' }).length > 0;
				const err = await rejection(reregister({ ...options, isStopped }, old.id));
				expect(err).to.be.instanceOf(RegistrationStoppedError);
				expect(calls()).to.deep.equal([`GET ${ENDPOINTS}`, `DELETE ${ENDPOINTS}/${old.id}`]);
			});
		});
	});
});
