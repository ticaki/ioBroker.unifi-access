import { expect } from 'chai';

import {
	computeSignature,
	createTestLogger,
	fixtures,
	httpRequest,
	sendWebhook,
	signatureHeader,
	type SignatureMode,
	type TestLogger,
	waitFor,
} from '../../test/mock';
import type { UnifiAccessEventEnvelope } from '../lib/types';
import { SharedHttpServer } from '../webserver/sharedHttpServer';
import { WebhookHandler } from './server';

const PATH = '/unifi-access-webhook';
const SECRET = '6601f1243d2ff70f';

describe('WebhookHandler (UniFi Access webhook receiver)', () => {
	let server: SharedHttpServer;
	let logger: TestLogger;
	let url: string;
	let secret: string | null;
	let received: UnifiAccessEventEnvelope[];
	let onEvent: (event: UnifiAccessEventEnvelope) => Promise<void> | void;

	const door = fixtures.DEFAULT_DOORS[1];
	const hub = fixtures.DEFAULT_DEVICES[0][0];
	const sampleEvent = (): UnifiAccessEventEnvelope =>
		fixtures.webhookEvents.doorUnlock({ door, device: hub, readerId: fixtures.IDS.DEVICE_G2_PRO });

	beforeEach(async () => {
		logger = createTestLogger();
		secret = SECRET;
		received = [];
		onEvent = event => {
			received.push(event);
		};
		server = new SharedHttpServer({ port: 0, ip: '127.0.0.1', logger });
		const handler = new WebhookHandler({
			path: PATH,
			secret: () => secret,
			logger,
			onEvent: event => onEvent(event),
		});
		server.registerHandler('unifi-webhook', handler.matches, handler.handle);
		await server.start();
		url = `http://127.0.0.1:${server.port}${PATH}`;
	});

	afterEach(async () => {
		await server.stop();
	});

	describe('valid signature', () => {
		it('answers 200 "OK" and dispatches the parsed event exactly once', async () => {
			const event = sampleEvent();
			const response = await sendWebhook({ url, secret: SECRET, body: event });
			expect(response.status).to.equal(200);
			expect(response.body).to.equal('OK');
			expect(received).to.deep.equal([event]);
		});

		it('ignores the query string when matching the path', async () => {
			const response = await sendWebhook({ url: `${url}?source=unifi`, secret: SECRET, body: sampleEvent() });
			expect(response.status).to.equal(200);
			expect(received).to.have.length(1);
		});

		it('accepts the documented header layout with a space after the comma ("t=…, v1=…")', async () => {
			const body = JSON.stringify(sampleEvent());
			const t = Math.floor(Date.now() / 1000);
			const response = await sendWebhook({
				url,
				body,
				signatureHeader: `t=${t}, v1=${computeSignature(SECRET, body, t)}`,
			});
			expect(response.status).to.equal(200);
			expect(received).to.have.length(1);
		});

		it('accepts the pairs in any order and upper-case hex', async () => {
			const body = JSON.stringify(sampleEvent());
			const t = Math.floor(Date.now() / 1000);
			const response = await sendWebhook({
				url,
				body,
				signatureHeader: `v1=${computeSignature(SECRET, body, t).toUpperCase()},t=${t}`,
			});
			expect(response.status).to.equal(200);
		});

		it('verifies the signature over the raw body bytes (formatting and non-ASCII preserved)', async () => {
			const body = `{\n\t"event": "access.door.unlock",\r\n  "data": { "location": { "name": "Haustür – Süd ✓" } }\n}\n`;
			const response = await sendWebhook({ url, secret: SECRET, body });
			expect(response.status).to.equal(200);
			expect((received[0].data.location as { name: string }).name).to.equal('Haustür – Süd ✓');
		});

		it('accepts timestamps inside the 5 minute tolerance (past and future)', async () => {
			const now = Math.floor(Date.now() / 1000);
			expect(
				(await sendWebhook({ url, secret: SECRET, body: sampleEvent(), timestamp: now - 280 })).status,
			).to.equal(200);
			expect(
				(await sendWebhook({ url, secret: SECRET, body: sampleEvent(), timestamp: now + 280 })).status,
			).to.equal(200);
			expect(received).to.have.length(2);
		});

		it('still answers 200 when the event callback throws or rejects (warning only, no unhandled rejection)', async () => {
			onEvent = () => {
				throw new Error('sync handler failure');
			};
			expect((await sendWebhook({ url, secret: SECRET, body: sampleEvent() })).status).to.equal(200);
			onEvent = async () => {
				await Promise.resolve();
				throw new Error('async handler failure');
			};
			expect((await sendWebhook({ url, secret: SECRET, body: sampleEvent() })).status).to.equal(200);
			// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the handler must cope with it
			onEvent = () => Promise.reject('not even an Error');
			expect((await sendWebhook({ url, secret: SECRET, body: sampleEvent() })).status).to.equal(200);
			await waitFor(() => logger.of('warn').length === 3, { description: 'warnings' });
			expect(logger.of('warn')).to.deep.equal([
				'Webhook handler error: sync handler failure',
				'Webhook handler error: async handler failure',
				'Webhook handler error: not even an Error',
			]);
		});

		// The controller gives up after 5 seconds ("It is recommended to handle asynchronous processing
		// logic", api_reference 11.7): the receipt is acknowledged at once, processing follows.
		it('acknowledges with 200 before the event callback has finished', async () => {
			let finish: () => void = () => undefined;
			let started = false;
			let finished = false;
			onEvent = async () => {
				started = true;
				await new Promise<void>(resolve => {
					finish = resolve;
				});
				finished = true;
			};
			const response = await sendWebhook({ url, secret: SECRET, body: sampleEvent() });
			expect(response.status).to.equal(200);
			expect(response.body).to.equal('OK');
			expect(started, 'processing has started').to.equal(true);
			expect(finished, 'the answer did not wait for the processing').to.equal(false);
			finish();
			await waitFor(() => finished, { description: 'processing finished' });
		});

		it('a slow event callback does not delay the answers to later webhooks', async () => {
			const release: (() => void)[] = [];
			onEvent = () =>
				new Promise<void>(resolve => {
					release.push(resolve);
				});
			for (let i = 0; i < 3; i++) {
				expect(
					(await sendWebhook({ url, secret: SECRET, body: sampleEvent(), timeoutMs: 1000 })).status,
				).to.equal(200);
			}
			expect(release).to.have.length(3);
			release.forEach(done => done());
		});

		it('reads the secret for every request (rotation takes effect immediately)', async () => {
			expect((await sendWebhook({ url, secret: SECRET, body: sampleEvent() })).status).to.equal(200);
			secret = 'rotated-secret';
			expect((await sendWebhook({ url, secret: SECRET, body: sampleEvent() })).status).to.equal(401);
			expect((await sendWebhook({ url, secret: 'rotated-secret', body: sampleEvent() })).status).to.equal(200);
			expect(received).to.have.length(2);
		});
	});

	describe('rejected requests (401, nothing dispatched)', () => {
		const modes: [SignatureMode, string][] = [
			['missing', 'no Signature header'],
			['invalid', 'signature created with a different secret'],
			['tampered', 'body modified after signing'],
			['malformed', 'header without t= / v1= pairs'],
		];
		for (const [mode, description] of modes) {
			it(`${mode}: ${description}`, async () => {
				const response = await sendWebhook({ url, secret: SECRET, body: sampleEvent(), signature: mode });
				expect(response.status).to.equal(401);
				expect(response.body).to.equal('');
				expect(received).to.deep.equal([]);
				expect(logger.of('warn')).to.deep.equal(['Webhook signature verification failed.']);
			});
		}

		for (const [mode, description] of [
			['expired', 'correctly signed but one hour old'],
			['future', 'correctly signed but one hour ahead'],
		] as [SignatureMode, string][]) {
			it(`${mode}: ${description} — rejected with a message that names the clock difference`, async () => {
				const response = await sendWebhook({ url, secret: SECRET, body: sampleEvent(), signature: mode });
				expect(response.status).to.equal(401);
				expect(response.body).to.equal('');
				expect(received).to.deep.equal([]);
				const warnings = logger.of('warn');
				expect(warnings).to.have.length(1);
				const match =
					/^Webhook rejected: its timestamp differs by (\d+) s from the clock of this host \(allowed: 300 s\)\. Check date and time/.exec(
						warnings[0],
					);
				expect(match, warnings[0]).to.not.equal(null);
				// signed with "now ± 3600 s"; a second boundary between signing and checking (slow runner)
				// shifts the difference by a few seconds in either direction
				expect(Number(match![1])).to.be.closeTo(3600, 5);
			});
		}

		it('a wrong signature with an old timestamp is reported as signature failure (the clock hint is for correctly signed requests only)', async () => {
			const old = Math.floor(Date.now() / 1000) - 3600;
			const response = await sendWebhook({
				url,
				secret: `${SECRET}-wrong`,
				body: sampleEvent(),
				timestamp: old,
			});
			expect(response.status).to.equal(401);
			expect(logger.of('warn')).to.deep.equal(['Webhook signature verification failed.']);
		});

		it('timestamps just outside the 5 minute tolerance', async () => {
			const now = Math.floor(Date.now() / 1000);
			expect(
				(await sendWebhook({ url, secret: SECRET, body: sampleEvent(), timestamp: now - 320 })).status,
			).to.equal(401);
			expect(
				(await sendWebhook({ url, secret: SECRET, body: sampleEvent(), timestamp: now + 320 })).status,
			).to.equal(401);
			expect(received).to.deep.equal([]);
		});

		const brokenHeaders: [string, (body: string, t: number) => string][] = [
			['timestamp missing', (body, t) => `v1=${computeSignature(SECRET, body, t)}`],
			['signature missing', (_body, t) => `t=${t}`],
			['timestamp not numeric', (body, t) => `t=abc,v1=${computeSignature(SECRET, body, t)}`],
			['signature not hex', (_body, t) => `t=${t},v1=${'z'.repeat(64)}`],
			['signature truncated', (body, t) => `t=${t},v1=${computeSignature(SECRET, body, t).slice(0, 32)}`],
			['signature with trailing garbage', (body, t) => `t=${t},v1=${computeSignature(SECRET, body, t)}00`],
			['empty header', () => ''],
			['unsupported scheme only (v0)', (body, t) => `t=${t},v0=${computeSignature(SECRET, body, t)}`],
		];
		for (const [name, build] of brokenHeaders) {
			it(`broken header: ${name}`, async () => {
				const body = JSON.stringify(sampleEvent());
				const t = Math.floor(Date.now() / 1000);
				const response = await sendWebhook({ url, body, signatureHeader: build(body, t) });
				expect(response.status).to.equal(401);
				expect(received).to.deep.equal([]);
			});
		}

		it('a signature for a different timestamp than the one sent', async () => {
			const body = JSON.stringify(sampleEvent());
			const t = Math.floor(Date.now() / 1000);
			const response = await sendWebhook({
				url,
				body,
				signatureHeader: `t=${t},v1=${computeSignature(SECRET, body, t - 1)}`,
			});
			expect(response.status).to.equal(401);
		});

		it('no secret known yet (not registered): even a "correctly" signed request is rejected', async () => {
			secret = null;
			const response = await sendWebhook({ url, secret: '', body: sampleEvent() });
			expect(response.status).to.equal(401);
			expect(received).to.deep.equal([]);
			expect(logger.of('warn')).to.deep.equal(['Webhook received but no secret configured — rejecting.']);

			secret = '';
			expect((await sendWebhook({ url, secret: '', body: sampleEvent() })).status).to.equal(401);
			expect(received).to.deep.equal([]);
		});
	});

	describe('other responses', () => {
		for (const method of ['GET', 'PUT', 'DELETE']) {
			it(`${method} is answered with 405`, async () => {
				const response = await sendWebhook({ url, secret: SECRET, body: sampleEvent(), method });
				expect(response.status).to.equal(405);
				expect(received).to.deep.equal([]);
			});
		}

		it('a correctly signed body that is not JSON is answered with 400', async () => {
			const response = await sendWebhook({ url, secret: SECRET, body: 'this is not json' });
			expect(response.status).to.equal(400);
			expect(received).to.deep.equal([]);
			expect(logger.of('warn')[0]).to.match(/^Webhook JSON parse failed: /);
		});

		it('other paths are not handled (404 from the shared server)', async () => {
			for (const path of [`${PATH}/extra`, `${PATH}x`, '/', '/unifi-access-webhoo']) {
				const body = JSON.stringify(sampleEvent());
				const response = await httpRequest({
					url: url.replace(PATH, path),
					method: 'POST',
					headers: { 'Content-Type': 'application/json', Signature: signatureHeader(SECRET, body) },
					body,
				});
				expect(response.status, path).to.equal(404);
			}
			expect(received).to.deep.equal([]);
		});

		it('an oversized body (> 1 MB) is never dispatched and the receiver keeps working', async () => {
			const huge = JSON.stringify({ event: 'access.door.unlock', data: { filler: 'x'.repeat(1_100_000) } });
			const outcome = await sendWebhook({ url, secret: SECRET, body: huge }).then(
				response => response.status,
				() => 'connection closed',
			);
			expect(outcome).to.be.oneOf([400, 413, 'connection closed']);
			expect(received).to.deep.equal([]);

			expect((await sendWebhook({ url, secret: SECRET, body: sampleEvent() })).status).to.equal(200);
			expect(received).to.have.length(1);
		});
	});

	// K-14: anybody on the network can send requests to the receiver
	it('rejected requests of the same kind give one warning per minute, the rest at debug level', async () => {
		for (let i = 0; i < 5; i++) {
			const response = await sendWebhook({ url, secret: SECRET, body: sampleEvent(), signature: 'invalid' });
			expect(response.status).to.equal(401);
		}
		secret = null;
		for (let i = 0; i < 3; i++) {
			const response = await sendWebhook({ url, secret: SECRET, body: sampleEvent() });
			expect(response.status).to.equal(401);
		}
		expect(logger.of('warn')).to.deep.equal([
			'Webhook signature verification failed.',
			'Webhook received but no secret configured — rejecting.',
		]);
		expect(logger.of('debug').filter(m => m.startsWith('Webhook'))).to.have.length(6);
	});
});
