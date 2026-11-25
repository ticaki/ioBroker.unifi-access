import { expect } from 'chai';
import { connect } from 'node:net';
import { Agent, get as httpGet, type IncomingMessage, type Server } from 'node:http';

import {
	createSelfSignedCert,
	createTestLogger,
	getFreePort,
	httpRequest,
	rejection,
	type TestLogger,
} from '../../test/mock';
import { SharedHttpServer } from './sharedHttpServer';

describe('SharedHttpServer', () => {
	let server: SharedHttpServer | undefined;
	let logger: TestLogger;
	let port: number;
	let baseUrl: string;

	beforeEach(async () => {
		logger = createTestLogger();
		port = await getFreePort();
		baseUrl = `http://127.0.0.1:${port}`;
		server = new SharedHttpServer({ port, ip: '127.0.0.1', logger });
	});

	afterEach(async () => {
		await server?.stop();
		server = undefined;
	});

	const pathIs =
		(path: string) =>
		(req: IncomingMessage): boolean =>
			req.url === path;

	it('listens on the configured ip and port and logs where', async () => {
		await server!.start();
		expect(logger.of('info')).to.deep.equal([`Shared http server listening on 127.0.0.1:${port}`]);
		expect(server!.scheme).to.equal('http');
		const response = await httpRequest({ url: `${baseUrl}/` });
		expect(response.status).to.equal(404);
	});

	it('binds all interfaces when no ip is given', async () => {
		await server!.stop();
		server = new SharedHttpServer({ port, logger });
		await server.start();
		expect(logger.of('info')).to.deep.equal([`Shared http server listening on :${port}`]);
		expect((await httpRequest({ url: `${baseUrl}/` })).status).to.equal(404);
	});

	it('answers 404 with an empty body when no handler matches', async () => {
		server!.registerHandler('a', pathIs('/a'), (_req, res) => {
			res.end('A');
			return true;
		});
		await server!.start();
		const response = await httpRequest({ url: `${baseUrl}/unknown` });
		expect(response.status).to.equal(404);
		expect(response.text).to.equal('');
	});

	it('dispatches to the first matching handler only (registration order)', async () => {
		const calls: string[] = [];
		server!.registerHandler('first', pathIs('/x'), (_req, res) => {
			calls.push('first');
			res.end('first');
			return true;
		});
		server!.registerHandler('second', pathIs('/x'), (_req, res) => {
			calls.push('second');
			res.end('second');
			return true;
		});
		server!.registerHandler('other', pathIs('/y'), async (_req, res) => {
			await Promise.resolve();
			calls.push('other');
			res.end('other');
			return true;
		});
		await server!.start();
		expect((await httpRequest({ url: `${baseUrl}/x` })).text).to.equal('first');
		expect((await httpRequest({ url: `${baseUrl}/y` })).text).to.equal('other');
		expect(calls).to.deep.equal(['first', 'other']);
	});

	it('falls through to the next matching handler when a handler returns false', async () => {
		server!.registerHandler('declines', pathIs('/x'), () => false);
		server!.registerHandler('accepts', pathIs('/x'), (_req, res) => {
			res.end('accepted');
			return true;
		});
		server!.registerHandler('declines-only', pathIs('/z'), () => false);
		await server!.start();
		expect((await httpRequest({ url: `${baseUrl}/x` })).text).to.equal('accepted');
		expect((await httpRequest({ url: `${baseUrl}/z` })).status).to.equal(404);
	});

	it('skips a handler whose match predicate throws (warning) and keeps dispatching', async () => {
		server!.registerHandler(
			'broken',
			() => {
				throw new Error('match exploded');
			},
			() => true,
		);
		server!.registerHandler('ok', pathIs('/x'), (_req, res) => {
			res.end('ok');
			return true;
		});
		await server!.start();
		expect((await httpRequest({ url: `${baseUrl}/x` })).text).to.equal('ok');
		expect(logger.of('warn')).to.deep.equal(['Handler broken match check failed: match exploded']);
	});

	it('answers 500 when a handler throws synchronously or rejects, and keeps serving', async () => {
		server!.registerHandler('throws', pathIs('/throws'), () => {
			throw new Error('sync boom');
		});
		server!.registerHandler('rejects', pathIs('/rejects'), async () => {
			await Promise.resolve();
			throw new Error('async boom');
		});
		server!.registerHandler('ok', pathIs('/ok'), (_req, res) => {
			res.end('ok');
			return true;
		});
		await server!.start();
		expect((await httpRequest({ url: `${baseUrl}/throws` })).status).to.equal(500);
		expect((await httpRequest({ url: `${baseUrl}/rejects` })).status).to.equal(500);
		expect((await httpRequest({ url: `${baseUrl}/ok` })).text).to.equal('ok');
		expect(logger.of('warn')).to.deep.equal([
			'Handler throws threw: sync boom',
			'Handler rejects threw: async boom',
		]);
	});

	it('start() rejects when the port is already in use', async () => {
		await server!.start();
		const second = new SharedHttpServer({ port, ip: '127.0.0.1', logger: createTestLogger() });
		const err = (await rejection(second.start())) as NodeJS.ErrnoException;
		expect(err.code).to.equal('EADDRINUSE');
		await second.stop();
		// the first server is unaffected
		expect((await httpRequest({ url: `${baseUrl}/` })).status).to.equal(404);
	});

	it('stop() releases the port; stopping twice or before start() is harmless', async () => {
		const never = new SharedHttpServer({ port: await getFreePort(), ip: '127.0.0.1', logger: createTestLogger() });
		await never.stop();

		await server!.start();
		await server!.stop();
		await server!.stop();

		const reuse = new SharedHttpServer({ port, ip: '127.0.0.1', logger: createTestLogger() });
		await reuse.start();
		await reuse.stop();
	});

	it('stop() resolves although a client still holds an idle keep-alive connection', async () => {
		server!.registerHandler('ok', pathIs('/ok'), (_req, res) => {
			res.end('ok');
			return true;
		});
		await server!.start();
		const agent = new Agent({ keepAlive: true });
		try {
			await new Promise<void>((resolve, reject) => {
				httpGet(`${baseUrl}/ok`, { agent }, res => {
					res.resume();
					res.on('end', resolve);
				}).on('error', reject);
			});
			await server!.stop();
		} finally {
			agent.destroy();
		}
	});

	it('stop() does not wait for a request that is still being answered', async () => {
		server!.registerHandler('slow', pathIs('/slow'), () => new Promise<boolean>(() => undefined));
		await server!.start();
		const pending = httpRequest({ url: `${baseUrl}/slow`, timeoutMs: 5000 }).catch((err: Error) => err);
		await new Promise(resolve => setTimeout(resolve, 50));
		const started = Date.now();
		await server!.stop();
		expect(Date.now() - started).to.be.lessThan(1000);
		expect(await pending).to.be.instanceOf(Error);
	});

	it('reports the number of handlers and whether it is listening', async () => {
		expect(server!.handlerCount).to.equal(0);
		expect(server!.listening).to.equal(false);
		server!.registerHandler('ok', pathIs('/ok'), (_req, res) => {
			res.end('ok');
			return true;
		});
		expect(server!.handlerCount).to.equal(1);
		await server!.start();
		expect(server!.listening).to.equal(true);
		await server!.stop();
		expect(server!.listening).to.equal(false);
	});

	it('keeps an error listener for its whole lifetime: a late server error is logged, not thrown', async () => {
		await server!.start();
		const internal = (server as unknown as { server: Server }).server;
		expect(internal.listenerCount('error')).to.be.greaterThan(0);
		internal.emit('error', new Error('EMFILE: too many open files'));
		expect(logger.of('warn')).to.deep.equal(['Shared http server error: EMFILE: too many open files']);
	});

	it('answers a malformed request with 400 and keeps serving', async () => {
		server!.registerHandler('ok', pathIs('/ok'), (_req, res) => {
			res.end('ok');
			return true;
		});
		await server!.start();
		const answer = await new Promise<string>((resolve, reject) => {
			const socket = connect(port, '127.0.0.1', () => socket.write('NOT HTTP AT ALL\r\n\r\n'));
			let data = '';
			socket.on('data', chunk => (data += chunk.toString()));
			socket.on('close', () => resolve(data));
			socket.on('error', reject);
		});
		expect(answer).to.match(/^HTTP\/1\.1 400 /);
		expect((await httpRequest({ url: `${baseUrl}/ok` })).status).to.equal(200);
		expect(logger.of('warn')).to.deep.equal([]);
	});

	it('serves HTTPS when key and certificate are given', async () => {
		await server!.stop();
		const tls = createSelfSignedCert();
		server = new SharedHttpServer({ port, ip: '127.0.0.1', tls, logger });
		server.registerHandler('ok', pathIs('/ok'), (_req, res) => {
			res.end('secure');
			return true;
		});
		await server.start();
		expect(server.scheme).to.equal('https');
		expect(logger.of('info')).to.deep.equal([`Shared https server listening on 127.0.0.1:${port}`]);
		const response = await httpRequest({ url: `https://127.0.0.1:${port}/ok`, ca: tls.cert });
		expect(response.status).to.equal(200);
		expect(response.text).to.equal('secure');
	});
});
