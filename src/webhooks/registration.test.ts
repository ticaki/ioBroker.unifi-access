import { expect } from 'chai';
import { AxiosError } from 'axios';

import { createTestLogger, fixtures, MockUnifiController, rejection, type TestLogger } from '../../test/mock';
import { UnifiHttp } from '../lib/unifiHttp';
import { DEFAULT_WEBHOOK_EVENTS, ensureRegistration, reregister, type RegistrationOptions } from './registration';

const TOKEN = 'registration-test-token';
const NAME = 'ioBroker.unifi-access (unifi-access.0)';
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

		it('reuses an endpoint with the same URL even if it was registered under another name', async () => {
			const existing = mock.addWebhookEndpoint({ endpoint: PUBLIC_URL, name: 'created by hand' });
			const result = await ensureRegistration(options);
			expect(result.id).to.equal(existing.id);
			expect(calls()).to.deep.equal([`GET ${ENDPOINTS}`]);
		});

		// BUG-C-07: an endpoint that already exists for the URL is reused as it is — its event subscription is
		// never compared with the events the adapter needs. An endpoint that was registered with fewer events
		// (older adapter version, created by hand) therefore never delivers the missing event types.
		it.skip('BUG-C-07: an existing endpoint ends up subscribed to all required events', async () => {
			mock.addWebhookEndpoint({ endpoint: PUBLIC_URL, name: NAME, events: ['access.door.unlock'] });
			const result = await ensureRegistration(options);
			const registered = mock.webhookEndpoints.filter(e => e.endpoint === PUBLIC_URL);
			expect(registered).to.have.length(1);
			expect(registered[0].id).to.equal(result.id);
			expect(registered[0].secret).to.equal(result.secret);
			expect([...registered[0].events].sort()).to.deep.equal([...DEFAULT_WEBHOOK_EVENTS].sort());
		});

		it('removes stale endpoints of this adapter instance (same name, outdated URL) and keeps foreign ones', async () => {
			const stale1 = mock.addWebhookEndpoint({ endpoint: OLD_URL, name: NAME });
			const stale2 = mock.addWebhookEndpoint({
				endpoint: 'http://172.17.0.2:8095/unifi-access-webhook',
				name: NAME,
			});
			const foreign = mock.addWebhookEndpoint({
				endpoint: 'https://example.invalid/hook',
				name: 'other integration',
			});

			const result = await ensureRegistration(options);

			expect(calls()).to.deep.equal([
				`GET ${ENDPOINTS}`,
				`DELETE ${ENDPOINTS}/${stale1.id}`,
				`DELETE ${ENDPOINTS}/${stale2.id}`,
				`POST ${ENDPOINTS}`,
			]);
			expect(mock.webhookEndpoints.map(e => e.id)).to.deep.equal([foreign.id, result.id]);
		});

		it('removes stale endpoints also when the current URL is already registered', async () => {
			const stale = mock.addWebhookEndpoint({ endpoint: OLD_URL, name: NAME });
			const current = mock.addWebhookEndpoint({ endpoint: PUBLIC_URL, name: NAME });
			const result = await ensureRegistration(options);
			expect(result.id).to.equal(current.id);
			expect(calls()).to.deep.equal([`GET ${ENDPOINTS}`, `DELETE ${ENDPOINTS}/${stale.id}`]);
			expect(mock.webhookEndpoints).to.deep.equal([current]);
		});

		it('continues when a stale endpoint cannot be removed (warning)', async () => {
			const stale = mock.addWebhookEndpoint({ endpoint: OLD_URL, name: NAME });
			mock.failNext({ method: 'DELETE', status: 500 });
			const result = await ensureRegistration(options);
			expect(result.endpoint).to.equal(PUBLIC_URL);
			expect(logger.of('warn')).to.have.length(1);
			expect(logger.of('warn')[0]).to.contain(`Could not remove stale endpoint ${stale.id}`);
			expect(mock.webhookEndpoints).to.have.length(2);
		});

		it('recreates the endpoint when the list does not return its secret', async () => {
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

		it('deletes by stored id (outdated URL) and by URL, but leaves unrelated endpoints alone', async () => {
			const byId = mock.addWebhookEndpoint({ endpoint: OLD_URL, name: NAME });
			const byUrl = mock.addWebhookEndpoint({ endpoint: PUBLIC_URL, name: 'someone else' });
			const foreign = mock.addWebhookEndpoint({ endpoint: 'https://example.invalid/hook', name: NAME });

			const result = await reregister(options, byId.id);

			expect(mock.findRequests({ method: 'DELETE' }).map(r => r.path)).to.have.members([
				`${ENDPOINTS}/${byId.id}`,
				`${ENDPOINTS}/${byUrl.id}`,
			]);
			expect(mock.webhookEndpoints.map(e => e.id)).to.deep.equal([foreign.id, result.id]);
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
	});
});
