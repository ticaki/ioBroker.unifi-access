import { expect } from 'chai';
import { AxiosError } from 'axios';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { createSelfSignedCert, rejection } from '../../test/mock';
import { classifyProtectError, ProtectHttp } from './protectHttp';

interface SeenRequest {
	method: string;
	url: string;
	headers: IncomingMessage['headers'];
	body: string;
}

/**
 * Minimal stand-in for a UniFi OS console with Protect: cookie login with CSRF token and the
 * three Protect proxy routes the adapter uses. This is NOT part of the documented UniFi Access
 * developer API — the behaviour is modelled on what `protectHttp.ts` expects, nothing more.
 */
class ProtectStub {
	readonly requests: SeenRequest[] = [];
	private server: Server | null = null;
	port = 0;

	username = 'viewer';
	password = 'secret';
	/** HTTP status forced for POST /api/auth/login (0 = check the credentials) */
	loginStatus = 0;
	sendCookie = true;
	sessions = 0;
	/** Session ids that have been invalidated server-side */
	readonly expired = new Set<string>();
	snapshot = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
	clip = Buffer.from('mp4-bytes');
	events: Record<string, Record<string, unknown>> = {};
	/** Force this status for the next media/meta request */
	nextMediaStatus = 0;

	cert = '';

	async start(): Promise<void> {
		const tls = createSelfSignedCert();
		this.cert = tls.cert;
		const server = createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (chunk: Buffer) => chunks.push(chunk));
			req.on('end', () => this.handle(req, res, Buffer.concat(chunks).toString('utf8')));
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		this.server = server;
		this.port = (server.address() as { port: number }).port;
	}

	async stop(): Promise<void> {
		const server = this.server;
		if (!server) {
			return;
		}
		this.server = null;
		await new Promise<void>(resolve => {
			server.close(() => resolve());
			server.closeAllConnections();
		});
	}

	get host(): string {
		return `127.0.0.1:${this.port}`;
	}

	private currentSession(req: IncomingMessage): string | undefined {
		const match = /TOKEN=([^;]+)/.exec(req.headers.cookie ?? '');
		return match && !this.expired.has(match[1]) ? match[1] : undefined;
	}

	private handle(req: IncomingMessage, res: ServerResponse, body: string): void {
		const url = req.url ?? '/';
		this.requests.push({ method: req.method ?? 'GET', url, headers: req.headers, body });

		if (url === '/' && req.method === 'GET') {
			res.writeHead(200, { 'x-csrf-token': 'initial-csrf' });
			res.end('<html></html>');
			return;
		}
		if (url === '/api/auth/login' && req.method === 'POST') {
			if (this.loginStatus) {
				res.writeHead(this.loginStatus);
				res.end();
				return;
			}
			const parsed = JSON.parse(body) as { username: string; password: string };
			if (parsed.username !== this.username || parsed.password !== this.password) {
				res.writeHead(401);
				res.end();
				return;
			}
			this.sessions += 1;
			const headers: Record<string, string | string[]> = { 'x-updated-csrf-token': `csrf-${this.sessions}` };
			if (this.sendCookie) {
				headers['set-cookie'] = [`TOKEN=session-${this.sessions}; Path=/; HttpOnly; Secure`];
			}
			res.writeHead(200, headers);
			res.end('{}');
			return;
		}
		if (url.startsWith('/proxy/protect/api/')) {
			if (this.nextMediaStatus) {
				const status = this.nextMediaStatus;
				this.nextMediaStatus = 0;
				res.writeHead(status);
				res.end();
				return;
			}
			if (!this.currentSession(req)) {
				res.writeHead(401);
				res.end();
				return;
			}
			let match: RegExpExecArray | null;
			if ((match = /^\/proxy\/protect\/api\/cameras\/([^/]+)\/snapshot$/.exec(url))) {
				res.writeHead(200, { 'Content-Type': 'image/jpeg' });
				res.end(this.snapshot);
				return;
			}
			if ((match = /^\/proxy\/protect\/api\/events\/([^/]+)$/.exec(url))) {
				const event = this.events[decodeURIComponent(match[1])];
				if (!event) {
					res.writeHead(404);
					res.end();
					return;
				}
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(event));
				return;
			}
			if (url.startsWith('/proxy/protect/api/video/')) {
				res.writeHead(200, { 'Content-Type': 'video/mp4' });
				res.end(this.clip);
				return;
			}
		}
		res.writeHead(404);
		res.end();
	}
}

describe('ProtectHttp (against a local UniFi OS / Protect stand-in)', () => {
	let stub: ProtectStub;
	let protect: ProtectHttp;

	const paths = (): string[] => stub.requests.map(r => `${r.method} ${r.url}`);

	beforeEach(async () => {
		stub = new ProtectStub();
		await stub.start();
		protect = new ProtectHttp({ host: stub.host, username: 'viewer', password: 'secret' });
	});

	afterEach(async () => {
		await stub.stop();
	});

	describe('login()', () => {
		it('fetches the CSRF token, posts the credentials and remembers the session', async () => {
			expect(protect.isLoggedIn()).to.equal(false);
			await protect.login();
			expect(protect.isLoggedIn()).to.equal(true);
			expect(paths()).to.deep.equal(['GET /', 'POST /api/auth/login']);
			const login = stub.requests[1];
			expect(JSON.parse(login.body)).to.deep.equal({
				username: 'viewer',
				password: 'secret',
				rememberMe: true,
				token: '',
			});
			expect(login.headers['content-type']).to.match(/^application\/json/);
			expect(login.headers['x-csrf-token']).to.equal('initial-csrf');
		});

		it('rejects wrong credentials (401) with a clear message', async () => {
			protect = new ProtectHttp({ host: stub.host, username: 'viewer', password: 'wrong' });
			const err = await rejection(protect.login());
			expect(err.message).to.equal('Protect login failed: credentials rejected');
			expect(protect.isLoggedIn()).to.equal(false);
		});

		it('reports 403 as rejected credentials as well', async () => {
			stub.loginStatus = 403;
			expect((await rejection(protect.login())).message).to.equal('Protect login failed: credentials rejected');
		});

		it('reports rate limiting with the status code in the message (main.ts keys its retry on "429")', async () => {
			stub.loginStatus = 429;
			const err = await rejection(protect.login());
			expect(err.message).to.equal('Protect login failed: HTTP 429');
			expect(protect.isLoggedIn()).to.equal(false);
		});

		it('rejects on a server error', async () => {
			stub.loginStatus = 500;
			const err = await rejection(protect.login());
			expect(err).to.be.instanceOf(AxiosError);
			expect(protect.isLoggedIn()).to.equal(false);
		});

		it('fails when the login response carries no session cookie', async () => {
			stub.sendCookie = false;
			const err = await rejection(protect.login());
			expect(err.message).to.equal('Protect login failed: no session cookie in response');
			expect(protect.isLoggedIn()).to.equal(false);
		});

		it('rejects when the console is unreachable', async function () {
			this.timeout(15_000);
			await stub.stop();
			const err = await rejection(protect.login());
			expect(classifyProtectError(err)).to.equal('network');
			expect(protect.isLoggedIn()).to.equal(false);
		});

		it('verifyTLS=true refuses the self-signed certificate', async () => {
			protect = new ProtectHttp({ host: stub.host, username: 'viewer', password: 'secret', verifyTLS: true });
			const err = await rejection(protect.login());
			expect((err as AxiosError).code).to.equal('DEPTH_ZERO_SELF_SIGNED_CERT');
			expect(stub.requests).to.have.length(0);
		});
	});

	describe('getSnapshot()', () => {
		it('requests the camera snapshot with session cookie and CSRF token and returns the bytes', async () => {
			await protect.login();
			const buffer = await protect.getSnapshot('66a1b2c3d4e5f60718293a4b');
			expect(buffer.equals(stub.snapshot)).to.equal(true);
			const request = stub.requests[2];
			expect(request.method).to.equal('GET');
			expect(request.url).to.equal('/proxy/protect/api/cameras/66a1b2c3d4e5f60718293a4b/snapshot');
			expect(request.headers.cookie).to.equal('TOKEN=session-1');
			expect(request.headers['x-csrf-token']).to.equal('csrf-1');
		});

		it('logs in again once when the session has expired and retries', async () => {
			await protect.login();
			stub.expired.add('session-1');
			const buffer = await protect.getSnapshot('cam1');
			expect(buffer.equals(stub.snapshot)).to.equal(true);
			expect(paths()).to.deep.equal([
				'GET /',
				'POST /api/auth/login',
				'GET /proxy/protect/api/cameras/cam1/snapshot',
				'GET /',
				'POST /api/auth/login',
				'GET /proxy/protect/api/cameras/cam1/snapshot',
			]);
			expect(stub.requests[5].headers.cookie).to.equal('TOKEN=session-2');
			expect(protect.isLoggedIn()).to.equal(true);
		});

		it('gives up when the retry after re-login is rejected again', async () => {
			await protect.login();
			stub.expired.add('session-1').add('session-2');
			const err = await rejection(protect.getSnapshot('cam1'));
			expect(err.message).to.equal('Protect snapshot HTTP 401');
			expect(stub.requests.filter(r => r.url === '/api/auth/login')).to.have.length(2);
		});

		it('fails when the re-login itself is rejected', async () => {
			await protect.login();
			stub.expired.add('session-1');
			stub.password = 'changed';
			const err = await rejection(protect.getSnapshot('cam1'));
			expect(err.message).to.equal('Protect login failed: credentials rejected');
			expect(protect.isLoggedIn()).to.equal(false);
		});

		it('rejects other error statuses without logging in again', async () => {
			await protect.login();
			stub.nextMediaStatus = 404;
			const err = await rejection(protect.getSnapshot('unknown'));
			expect(err.message).to.equal('Protect snapshot HTTP 404');
			expect(stub.requests.filter(r => r.url === '/api/auth/login')).to.have.length(1);
		});
	});

	describe('ids in request paths', () => {
		for (const bad of ['..', '.', 'cam/1', 'cam%2F1', 'cam 1', '', 'a'.repeat(129)]) {
			it(`getSnapshot() refuses the camera id ${JSON.stringify(bad.slice(0, 20))} without sending a request`, async () => {
				await protect.login();
				const before = stub.requests.length;
				const err = await rejection(protect.getSnapshot(bad));
				expect(err.message).to.equal('Protect camera id rejected');
				expect(stub.requests).to.have.length(before);
			});

			it(`getEventMeta() refuses the event id ${JSON.stringify(bad.slice(0, 20))} without sending a request`, async () => {
				await protect.login();
				const before = stub.requests.length;
				expect(await protect.getEventMeta(bad)).to.equal(null);
				expect(stub.requests).to.have.length(before);
			});
		}
	});

	describe('getEventMeta()', () => {
		beforeEach(async () => {
			await protect.login();
		});

		it('returns the clip URL of an event (field clipUrl)', async () => {
			stub.events.evt_1 = { id: 'evt_1', clipUrl: 'video/export?camera=c1&start=1' };
			expect(await protect.getEventMeta('evt_1')).to.deep.equal({ clipUrl: 'video/export?camera=c1&start=1' });
			expect(stub.requests[2].url).to.equal('/proxy/protect/api/events/evt_1');
			expect(stub.requests[2].headers.cookie).to.equal('TOKEN=session-1');
		});

		it('falls back to the field "clip"', async () => {
			stub.events.evt2 = { id: 'evt2', clip: '/proxy/protect/api/video/clip2.mp4' };
			expect(await protect.getEventMeta('evt2')).to.deep.equal({ clipUrl: '/proxy/protect/api/video/clip2.mp4' });
		});

		it('returns an empty meta object when the event has no clip', async () => {
			stub.events.evt3 = { id: 'evt3' };
			expect(await protect.getEventMeta('evt3')).to.deep.equal({ clipUrl: undefined });
		});

		it('returns null for an unknown event', async () => {
			expect(await protect.getEventMeta('missing')).to.equal(null);
		});

		it('logs in again when the session has expired and retries', async () => {
			stub.events.evt4 = { clipUrl: 'video/x.mp4' };
			stub.expired.add('session-1');
			expect(await protect.getEventMeta('evt4')).to.deep.equal({ clipUrl: 'video/x.mp4' });
			expect(stub.requests.filter(r => r.url === '/api/auth/login')).to.have.length(2);
		});

		it('returns null (never throws) when the console is unreachable or the re-login fails', async function () {
			this.timeout(15_000);
			stub.expired.add('session-1');
			stub.password = 'changed';
			expect(await protect.getEventMeta('evt')).to.equal(null);
			await stub.stop();
			expect(await protect.getEventMeta('evt')).to.equal(null);
		});
	});

	describe('getClipBuffer()', () => {
		beforeEach(async () => {
			await protect.login();
		});

		it('fetches an absolute clip path as it is', async () => {
			const buffer = await protect.getClipBuffer('/proxy/protect/api/video/export?camera=c1');
			expect(buffer.equals(stub.clip)).to.equal(true);
			expect(stub.requests[2].url).to.equal('/proxy/protect/api/video/export?camera=c1');
			expect(stub.requests[2].headers.cookie).to.equal('TOKEN=session-1');
		});

		it('resolves a relative clip path below /proxy/protect/api/', async () => {
			await protect.getClipBuffer('video/export?camera=c1');
			expect(stub.requests[2].url).to.equal('/proxy/protect/api/video/export?camera=c1');
		});

		for (const bad of [
			'//evil.example/clip.mp4',
			'https://evil.example/clip.mp4',
			'/api/users',
			'video/../../../../api/users',
			'video/%2e%2e/%2e%2e/%2e%2e/%2e%2e/api/users',
			'video\\..\\x',
		]) {
			it(`refuses the clip location ${JSON.stringify(bad)} without sending a request`, async () => {
				const before = stub.requests.length;
				const err = await rejection(protect.getClipBuffer(bad));
				expect(err.message).to.equal('Protect clip location rejected');
				expect(stub.requests).to.have.length(before);
			});
		}

		it('rejects when the clip cannot be fetched', async () => {
			stub.nextMediaStatus = 404;
			const err = await rejection(protect.getClipBuffer('video/gone.mp4'));
			expect(err.message).to.equal('Protect clip HTTP 404');
		});
	});

	describe('classifyProtectError()', () => {
		const withStatus = (status: number): AxiosError =>
			new AxiosError('failed', 'ERR_BAD_REQUEST', undefined, undefined, {
				status,
				statusText: '',
				headers: {},
				config: {} as never,
				data: undefined,
			});

		it('separates configuration problems (credentials, tls) from temporary ones (rate-limited, network)', () => {
			expect(classifyProtectError(withStatus(401))).to.equal('credentials');
			expect(classifyProtectError(withStatus(403))).to.equal('credentials');
			expect(classifyProtectError(withStatus(429))).to.equal('rate-limited');
			expect(classifyProtectError(withStatus(500))).to.equal('network');
			expect(classifyProtectError(new AxiosError('tls', 'DEPTH_ZERO_SELF_SIGNED_CERT'))).to.equal('tls');
			expect(classifyProtectError(new AxiosError('tls', 'ERR_TLS_CERT_ALTNAME_INVALID'))).to.equal('tls');
			expect(classifyProtectError(new AxiosError('refused', 'ECONNREFUSED'))).to.equal('network');
			expect(classifyProtectError(new Error('boom'))).to.equal('network');
			expect(classifyProtectError(undefined)).to.equal('network');
		});

		it('classifies the errors login() really throws', async () => {
			stub.loginStatus = 401;
			expect(classifyProtectError(await rejection(protect.login()))).to.equal('credentials');
			stub.loginStatus = 429;
			expect(classifyProtectError(await rejection(protect.login()))).to.equal('rate-limited');
			stub.loginStatus = 0;
			stub.sendCookie = false;
			expect(classifyProtectError(await rejection(protect.login()))).to.equal('network');

			const verifying = new ProtectHttp({
				host: stub.host,
				username: 'viewer',
				password: 'secret',
				verifyTLS: true,
			});
			expect(classifyProtectError(await rejection(verifying.login()))).to.equal('tls');
		});
	});

	describe('TLS options', () => {
		it('verifyTLS=true with the console certificate as caCert logs in', async () => {
			const trusting = new ProtectHttp({
				host: '127.0.0.1',
				port: stub.port,
				username: 'viewer',
				password: 'secret',
				verifyTLS: true,
				caCert: stub.cert,
			});
			await trusting.login();
			expect(trusting.isLoggedIn()).to.equal(true);
		});

		it('verifyTLS=true with a foreign CA is refused', async () => {
			const foreign = new ProtectHttp({
				host: '127.0.0.1',
				port: stub.port,
				username: 'viewer',
				password: 'secret',
				verifyTLS: true,
				caCert: createSelfSignedCert().cert,
			});
			expect(classifyProtectError(await rejection(foreign.login()))).to.equal('tls');
			expect(foreign.isLoggedIn()).to.equal(false);
		});

		it('appends the port to the host unless it is 443', () => {
			const client = (options: { host: string; port?: number }): string =>
				(
					new ProtectHttp({ ...options, username: 'u', password: 'p' }) as unknown as {
						client: { defaults: { baseURL: string } };
					}
				).client.defaults.baseURL;
			expect(client({ host: 'console.local' })).to.equal('https://console.local');
			expect(client({ host: 'console.local', port: 443 })).to.equal('https://console.local');
			expect(client({ host: 'console.local', port: 8443 })).to.equal('https://console.local:8443');
		});
	});
});
