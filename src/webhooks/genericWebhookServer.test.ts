import { expect } from 'chai';

import { createTestLogger, getFreePort, httpRequest, type TestLogger } from '../../test/mock';
import { SharedHttpServer } from '../webserver/sharedHttpServer';
import { GenericWebhookHandler, normalizeWebhookPath, type GenericWebhookHandlerOptions } from './genericWebhookServer';

type Captured = Parameters<GenericWebhookHandlerOptions['onRequest']>[0];

const PATH = '/webhook';
const basic = (user: string, password: string): string =>
	`Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;

describe('GenericWebhookHandler (alarm manager webhook)', () => {
	let server: SharedHttpServer | undefined;
	let logger: TestLogger;
	let url: string;
	let captured: Captured[];

	async function mount(
		options: Partial<Pick<GenericWebhookHandlerOptions, 'auth' | 'username' | 'password' | 'token' | 'onRequest'>>,
	): Promise<void> {
		logger = createTestLogger();
		captured = [];
		const port = await getFreePort();
		url = `http://127.0.0.1:${port}${PATH}`;
		server = new SharedHttpServer({ port, ip: '127.0.0.1', logger });
		const handler = new GenericWebhookHandler({
			path: PATH,
			auth: 'none',
			logger,
			onRequest: data => {
				captured.push(data);
			},
			...options,
		});
		server.registerHandler('generic-webhook', handler.matches, handler.handle);
		await server.start();
	}

	const post = (headers: Record<string, string> = {}, body = '{"alarm_id":"a1"}'): ReturnType<typeof httpRequest> =>
		httpRequest({ url, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });

	afterEach(async () => {
		await server?.stop();
		server = undefined;
	});

	describe('auth "none"', () => {
		beforeEach(() => mount({ auth: 'none' }));

		it('accepts a POST without credentials and passes body, headers, method and url on', async () => {
			const body = '{"alarm_id":"a1","events":[{"id":"evt","location":"door-1"}]}';
			const response = await httpRequest({
				url: `${url}?source=panel`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-Custom': 'yes' },
				body,
			});
			expect(response.status).to.equal(200);
			expect(response.text).to.equal('OK');
			expect(captured).to.have.length(1);
			expect(Buffer.isBuffer(captured[0].body)).to.equal(true);
			expect(captured[0].body.toString('utf8')).to.equal(body);
			expect(captured[0].method).to.equal('POST');
			expect(captured[0].url).to.equal(`${PATH}?source=panel`);
			expect(captured[0].headers['x-custom']).to.equal('yes');
			expect(captured[0].headers['content-type']).to.equal('application/json');
		});

		it('passes binary bodies through unchanged', async () => {
			const body = Buffer.from([0x00, 0xff, 0x80, 0x0a, 0x7f]);
			await httpRequest({ url, method: 'POST', body });
			expect(captured[0].body.equals(body)).to.equal(true);
		});

		it('accepts other methods as well and reports them', async () => {
			expect((await httpRequest({ url, method: 'GET' })).status).to.equal(200);
			expect((await httpRequest({ url, method: 'PUT', body: 'x' })).status).to.equal(200);
			expect(captured.map(c => c.method)).to.deep.equal(['GET', 'PUT']);
			expect(captured[0].body).to.have.length(0);
		});

		it('ignores credentials that are sent anyway', async () => {
			expect((await post({ Authorization: 'Bearer whatever' })).status).to.equal(200);
		});

		it('only handles the exact path (query string ignored)', async () => {
			expect((await httpRequest({ url: `${url}/sub`, method: 'POST', body: '{}' })).status).to.equal(404);
			expect((await httpRequest({ url: `${url}x`, method: 'POST', body: '{}' })).status).to.equal(404);
			expect(captured).to.deep.equal([]);
		});

		it('never dispatches an oversized body (> 1 MB) and keeps working afterwards', async () => {
			const outcome = await httpRequest({ url, method: 'POST', body: 'x'.repeat(1_100_000) }).then(
				response => response.status,
				() => 'connection closed',
			);
			expect(outcome).to.be.oneOf([400, 413, 'connection closed']);
			expect(captured).to.deep.equal([]);
			expect((await post()).status).to.equal(200);
		});
	});

	describe('auth "basic"', () => {
		beforeEach(() => mount({ auth: 'basic', username: 'alarm', password: 'p:ss:word' }));

		it('accepts the configured user and password (password may contain colons)', async () => {
			const response = await post({ Authorization: basic('alarm', 'p:ss:word') });
			expect(response.status).to.equal(200);
			expect(captured).to.have.length(1);
		});

		const denied: [string, Record<string, string>][] = [
			['no Authorization header', {}],
			['wrong password', { Authorization: basic('alarm', 'wrong') }],
			['wrong user', { Authorization: basic('admin', 'p:ss:word') }],
			['empty credentials', { Authorization: basic('', '') }],
			['password prefix only', { Authorization: basic('alarm', 'p') }],
			['bearer scheme', { Authorization: 'Bearer p:ss:word' }],
			[
				'lower-case scheme with wrong password',
				{ Authorization: basic('alarm', 'nope').replace('Basic', 'basic') },
			],
			['not base64', { Authorization: 'Basic %%%' }],
		];
		for (const [name, headers] of denied) {
			it(`401 without dispatch: ${name}`, async () => {
				const response = await post(headers);
				expect(response.status).to.equal(401);
				expect(response.text).to.equal('Unauthorized');
				expect(captured).to.deep.equal([]);
			});
		}

		// Clients that wait for a challenge (RFC 7617) must be asked for the scheme that is configured,
		// otherwise they never send their basic credentials.
		it('challenges with the Basic scheme', async () => {
			const response = await post();
			expect(response.headers['www-authenticate']).to.match(/^Basic /);
			expect(response.headers['www-authenticate']).to.equal('Basic realm="webhook", charset="UTF-8"');
		});

		it('accepts non-ASCII credentials (UTF-8)', async () => {
			await server?.stop();
			await mount({ auth: 'basic', username: 'jürgen', password: 'pässwört' });
			expect((await post({ Authorization: basic('jürgen', 'pässwört') })).status).to.equal(200);
			expect((await post({ Authorization: basic('jurgen', 'pässwört') })).status).to.equal(401);
		});
	});

	describe('auth "bearer"', () => {
		beforeEach(() => mount({ auth: 'bearer', token: 's3cr3t-token' }));

		it('accepts the configured token', async () => {
			const response = await post({ Authorization: 'Bearer s3cr3t-token' });
			expect(response.status).to.equal(200);
			expect(captured).to.have.length(1);
		});

		const denied: [string, Record<string, string>][] = [
			['no Authorization header', {}],
			['wrong token', { Authorization: 'Bearer other-token' }],
			['token prefix only', { Authorization: 'Bearer s3cr3t' }],
			['token with suffix', { Authorization: 'Bearer s3cr3t-token-and-more' }],
			['empty token', { Authorization: 'Bearer ' }],
			['basic scheme', { Authorization: basic('s3cr3t-token', '') }],
			['token without scheme', { Authorization: 's3cr3t-token' }],
		];
		for (const [name, headers] of denied) {
			it(`401 without dispatch: ${name}`, async () => {
				const response = await post(headers);
				expect(response.status).to.equal(401);
				expect(response.headers['www-authenticate']).to.equal('Bearer realm="webhook"');
				expect(captured).to.deep.equal([]);
			});
		}
	});

	describe('missing credentials in the configuration', () => {
		// "basic" selected but nothing entered: `Authorization: Basic Og==` (an empty user and password)
		// used to match the empty configuration and let everybody in.
		for (const [name, options] of [
			['no user and no password', {}],
			['user without password', { username: 'alarm' }],
			['password without user', { password: 'secret' }],
			['empty strings', { username: '', password: '' }],
		] as [string, Partial<GenericWebhookHandlerOptions>][]) {
			it(`basic mode with ${name} rejects every request — also empty credentials`, async () => {
				await mount({ auth: 'basic', ...options });
				for (const headers of [
					{ Authorization: 'Basic Og==' },
					{ Authorization: basic('', '') },
					{ Authorization: basic(options.username ?? '', options.password ?? '') },
					{ Authorization: 'Basic ' },
					{},
				] as Record<string, string>[]) {
					const response = await post(headers);
					expect(response.status, JSON.stringify(headers)).to.equal(401);
					expect(response.headers['www-authenticate']).to.match(/^Basic /);
				}
				expect(captured).to.deep.equal([]);
			});
		}

		it('reports whether usable credentials are configured', () => {
			const handler = (options: Partial<GenericWebhookHandlerOptions>): GenericWebhookHandler =>
				new GenericWebhookHandler({
					path: '/webhook',
					auth: 'none',
					logger,
					onRequest: () => undefined,
					...options,
				});
			expect(handler({ auth: 'none' }).credentialsConfigured).to.equal(true);
			expect(handler({ auth: 'basic' }).credentialsConfigured).to.equal(false);
			expect(handler({ auth: 'basic', username: 'u' }).credentialsConfigured).to.equal(false);
			expect(handler({ auth: 'basic', username: 'u', password: 'p' }).credentialsConfigured).to.equal(true);
			expect(handler({ auth: 'bearer' }).credentialsConfigured).to.equal(false);
			expect(handler({ auth: 'bearer', token: '' }).credentialsConfigured).to.equal(false);
			expect(handler({ auth: 'bearer', token: 't' }).credentialsConfigured).to.equal(true);
			expect(handler({ auth: 'token' as GenericWebhookHandlerOptions['auth'] }).credentialsConfigured).to.equal(
				false,
			);
		});

		it('does not write the request body to the log (it is logged once, by the consumer)', async () => {
			await mount({ auth: 'none' });
			await post({}, 'super-secret-alarm-content');
			expect(logger.messages.filter(m => m.message.includes('super-secret-alarm-content'))).to.deep.equal([]);
			expect(logger.of('info')).to.deep.equal(logger.of('info').filter(m => !m.includes('Generic webhook')));
		});

		it('bearer mode without a configured token rejects every request', async () => {
			await mount({ auth: 'bearer' });
			expect((await post({ Authorization: 'Bearer ' })).status).to.equal(401);
			expect((await post({ Authorization: 'Bearer undefined' })).status).to.equal(401);
			expect((await post()).status).to.equal(401);
			expect(captured).to.deep.equal([]);
		});

		it('an unknown auth mode rejects every request', async () => {
			await mount({ auth: 'token' as GenericWebhookHandlerOptions['auth'] });
			expect((await post({ Authorization: 'Bearer x' })).status).to.equal(401);
			expect(captured).to.deep.equal([]);
		});
	});

	describe('callback errors', () => {
		it('answers 500 when the request callback fails and keeps serving', async () => {
			let fail = true;
			await mount({
				auth: 'none',
				onRequest: data => {
					if (fail) {
						throw new Error('callback failed');
					}
					captured.push(data);
				},
			});
			expect((await post()).status).to.equal(500);
			fail = false;
			expect((await post()).status).to.equal(200);
			expect(logger.of('warn')).to.deep.equal(['Handler generic-webhook threw: callback failed']);
		});
	});

	// U-01: the admin page shows "/alarm" for the setting "alarm" — the handler must answer exactly there
	describe('listen path normalisation (U-01)', () => {
		for (const [raw, expected] of [
			['alarm', '/alarm'],
			['/alarm', '/alarm'],
			['  /alarm  ', '/alarm'],
			['', '/webhook'],
			[undefined, '/webhook'],
			['/alarm?x=1', '/alarm'],
			['/alarm#frag', '/alarm'],
			['//hooks///alarm', '/hooks/alarm'],
			['hooks/alarm/', '/hooks/alarm/'],
		] as [unknown, string][]) {
			it(`${JSON.stringify(raw)} → ${expected}`, () => {
				expect(normalizeWebhookPath(raw)).to.equal(expected);
			});
		}

		it('a path set without leading slash is answered at /<path>', async () => {
			logger = createTestLogger();
			captured = [];
			const port = await getFreePort();
			server = new SharedHttpServer({ port, ip: '127.0.0.1', logger });
			const handler = new GenericWebhookHandler({
				path: 'alarm',
				auth: 'none',
				logger,
				onRequest: data => {
					captured.push(data);
				},
			});
			server.registerHandler('generic-webhook', handler.matches, handler.handle);
			await server.start();
			const response = await httpRequest({
				url: `http://127.0.0.1:${port}/alarm?src=x`,
				method: 'POST',
				body: '{}',
			});
			expect(response.status).to.equal(200);
			expect(captured).to.have.length(1);
			expect(
				(await httpRequest({ url: `http://127.0.0.1:${port}/other`, method: 'POST', body: '{}' })).status,
			).to.equal(404);
		});

		it('a percent-encoded request path matches the literal setting', async () => {
			logger = createTestLogger();
			captured = [];
			const port = await getFreePort();
			server = new SharedHttpServer({ port, ip: '127.0.0.1', logger });
			const handler = new GenericWebhookHandler({
				path: '/alarm~1',
				auth: 'none',
				logger,
				onRequest: () => undefined,
			});
			server.registerHandler('generic-webhook', handler.matches, handler.handle);
			await server.start();
			const response = await httpRequest({
				url: `http://127.0.0.1:${port}`,
				rawPath: '/alarm%7E1',
				method: 'POST',
				body: '{}',
			});
			expect(response.status).to.equal(200);
		});
	});
});
