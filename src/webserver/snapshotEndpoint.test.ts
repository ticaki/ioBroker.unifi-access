import { expect } from 'chai';

import {
	createTestLogger,
	fixtures,
	getFreePort,
	httpRequest,
	MockUnifiController,
	type TestLogger,
} from '../../test/mock';
import { UnifiHttp } from '../lib/unifiHttp';
import { SharedHttpServer } from './sharedHttpServer';
import { ThumbnailHandler } from './snapshotEndpoint';

const TOKEN = 'thumbnail-test-token';
const PREFIX = '/unifi-access/0/thumbnail';
const READER = fixtures.IDS.DEVICE_G2_PRO;
const THUMBNAIL_PATH = `/preview/reader_${READER}_d2b87427-7efa-43c1-aa52-b00d40d99ecf_1722913291.jpg`;

describe('ThumbnailHandler (thumbnail proxy on the shared HTTP server)', () => {
	let mock: MockUnifiController;
	let server: SharedHttpServer;
	let logger: TestLogger;
	let baseUrl: string;
	let http: UnifiHttp | null;
	/** deviceId → stored door_thumbnail path (what main.ts keeps in devices.<id>.lastThumbnailPath) */
	let paths: Map<string, string>;
	let lookups: string[];
	let resolvePath: (deviceId: string) => Promise<string | null>;

	before(async () => {
		mock = new MockUnifiController({ token: TOKEN });
		await mock.start();
	});

	after(async () => {
		await mock.stop();
	});

	beforeEach(async () => {
		mock.reset();
		logger = createTestLogger();
		http = new UnifiHttp({ host: '127.0.0.1', port: mock.port, token: TOKEN });
		paths = new Map();
		lookups = [];
		resolvePath = async deviceId => {
			lookups.push(deviceId);
			return paths.get(deviceId) ?? null;
		};
		const port = await getFreePort();
		baseUrl = `http://127.0.0.1:${port}`;
		server = new SharedHttpServer({ port, ip: '127.0.0.1', logger });
		const handler = new ThumbnailHandler({
			pathPrefix: PREFIX,
			http: () => http,
			resolvePath: deviceId => resolvePath(deviceId),
			logger,
		});
		server.registerHandler('thumbnail', handler.matches, handler.handle);
		await server.start();
	});

	afterEach(async () => {
		await server.stop();
	});

	describe('proxying', () => {
		it('serves the stored thumbnail of a device as image/jpeg, fetched with the bearer token', async () => {
			const image = Buffer.concat([fixtures.TINY_JPEG, Buffer.from([0x00, 0xff, 0x10, 0x80])]);
			mock.addStaticResource(THUMBNAIL_PATH, image);
			paths.set(READER, THUMBNAIL_PATH);

			const response = await httpRequest({ url: `${baseUrl}${PREFIX}/${READER}.jpg` });

			expect(response.status).to.equal(200);
			expect(response.headers['content-type']).to.equal('image/jpeg');
			expect(response.headers['cache-control']).to.equal('no-store');
			expect(response.body.equals(image)).to.equal(true);
			expect(lookups).to.deep.equal([READER]);
			expect(mock.requests).to.have.length(1);
			expect(mock.requests[0].method).to.equal('GET');
			expect(mock.requests[0].url).to.equal(`/api/v1/developer/system/static${THUMBNAIL_PATH}`);
			expect(mock.requests[0].headers.authorization).to.equal(`Bearer ${TOKEN}`);
		});

		it('ignores the query string (cache buster ?ts=…)', async () => {
			mock.addStaticResource(THUMBNAIL_PATH);
			paths.set(READER, THUMBNAIL_PATH);
			const response = await httpRequest({ url: `${baseUrl}${PREFIX}/${READER}.jpg?ts=1722913291000` });
			expect(response.status).to.equal(200);
			expect(lookups).to.deep.equal([READER]);
		});

		it('accepts device ids with letters, digits, "_" and "-"', async () => {
			mock.addStaticResource('/preview/x.jpg');
			paths.set('Ab_9-z', '/preview/x.jpg');
			expect((await httpRequest({ url: `${baseUrl}${PREFIX}/Ab_9-z.jpg` })).status).to.equal(200);
		});

		it('does not hand the client anything but the image (no credentials in the response)', async () => {
			mock.addStaticResource(THUMBNAIL_PATH);
			paths.set(READER, THUMBNAIL_PATH);
			const response = await httpRequest({ url: `${baseUrl}${PREFIX}/${READER}.jpg` });
			expect(JSON.stringify(response.headers)).to.not.contain(TOKEN);
			expect(response.text).to.not.contain(TOKEN);
		});
	});

	describe('error responses', () => {
		it('404 "no thumbnail seen" when no thumbnail is known for the device (no upstream request)', async () => {
			const response = await httpRequest({ url: `${baseUrl}${PREFIX}/${READER}.jpg` });
			expect(response.status).to.equal(404);
			expect(response.text).to.equal('no thumbnail seen');
			expect(mock.requests).to.have.length(0);
		});

		it('502 when the controller does not have the resource', async () => {
			paths.set(READER, '/preview/gone.jpg');
			const response = await httpRequest({ url: `${baseUrl}${PREFIX}/${READER}.jpg` });
			expect(response.status).to.equal(502);
			expect(response.text).to.equal('');
			expect(logger.of('warn')).to.have.length(1);
			expect(logger.of('warn')[0]).to.contain(`Thumbnail fetch for ${READER} failed`);
		});

		it('502 when the controller connection breaks', async () => {
			paths.set(READER, THUMBNAIL_PATH);
			mock.failNext({ hangUp: true });
			expect((await httpRequest({ url: `${baseUrl}${PREFIX}/${READER}.jpg` })).status).to.equal(502);
		});

		it('502 when the controller rejects the token', async () => {
			paths.set(READER, THUMBNAIL_PATH);
			mock.addStaticResource(THUMBNAIL_PATH);
			http = new UnifiHttp({ host: '127.0.0.1', port: mock.port, token: 'revoked' });
			expect((await httpRequest({ url: `${baseUrl}${PREFIX}/${READER}.jpg` })).status).to.equal(502);
		});

		it('503 when there is no controller client', async () => {
			http = null;
			paths.set(READER, THUMBNAIL_PATH);
			const response = await httpRequest({ url: `${baseUrl}${PREFIX}/${READER}.jpg` });
			expect(response.status).to.equal(503);
			expect(response.text).to.equal('no controller connection');
			expect(lookups).to.deep.equal([]);
		});

		it('500 when the path lookup fails', async () => {
			resolvePath = async () => {
				throw new Error('states db down');
			};
			const response = await httpRequest({ url: `${baseUrl}${PREFIX}/${READER}.jpg` });
			expect(response.status).to.equal(500);
			expect(logger.of('warn')).to.deep.equal(['Thumbnail path lookup failed: states db down']);
			expect(mock.requests).to.have.length(0);
		});

		for (const method of ['POST', 'PUT', 'DELETE']) {
			it(`405 for ${method}`, async () => {
				paths.set(READER, THUMBNAIL_PATH);
				const response = await httpRequest({ url: `${baseUrl}${PREFIX}/${READER}.jpg`, method });
				expect(response.status).to.equal(405);
				expect(lookups).to.deep.equal([]);
			});
		}
	});

	describe('request validation / path traversal', () => {
		const rejected: [name: string, rawPath: string][] = [
			['other extension', `${PREFIX}/${READER}.png`],
			['no extension', `${PREFIX}/${READER}`],
			['empty id', `${PREFIX}/.jpg`],
			['nested path', `${PREFIX}/a/b.jpg`],
			['dot segments', `${PREFIX}/../../etc/passwd`],
			['dot segments with .jpg', `${PREFIX}/../../etc/passwd.jpg`],
			['dot segments back into the prefix', `${PREFIX}/../thumbnail/${READER}.jpg`],
			['encoded dot segments', `${PREFIX}/%2e%2e%2f%2e%2e%2fetc%2fpasswd.jpg`],
			['encoded slash', `${PREFIX}/a%2Fb.jpg`],
			['backslash', `${PREFIX}/..\\..\\secret.jpg`],
			['null byte', `${PREFIX}/${READER}%00.jpg`],
			['dots in id', `${PREFIX}/..jpg`],
			['absolute static path', `${PREFIX}//preview/x.jpg`],
		];
		for (const [name, rawPath] of rejected) {
			it(`404 without lookup or upstream request: ${name}`, async () => {
				paths.set(READER, THUMBNAIL_PATH);
				mock.addStaticResource(THUMBNAIL_PATH);
				const response = await httpRequest({ url: baseUrl, rawPath });
				expect(response.status).to.equal(404);
				expect(lookups).to.deep.equal([]);
				expect(mock.requests).to.have.length(0);
			});
		}

		it('requests outside the prefix are not handled at all', async () => {
			paths.set(READER, THUMBNAIL_PATH);
			for (const rawPath of [
				PREFIX,
				`${PREFIX}x/${READER}.jpg`,
				`/unifi-access/1/thumbnail/${READER}.jpg`,
				'/',
			]) {
				expect((await httpRequest({ url: baseUrl, rawPath })).status, rawPath).to.equal(404);
			}
			expect(lookups).to.deep.equal([]);
		});

		// The stored thumbnail path originates from event payloads / a state. The HTTP client resolves dot
		// segments, so an unchecked "/../../users" would make the proxy fetch GET /api/v1/developer/users with
		// the adapter's API token and serve the answer to an unauthenticated client as "image/jpeg".
		for (const stored of [
			'/../../users',
			'/preview/reader_ab_/../../../../users?page_size=1000',
			'/preview/%2e%2e/%2e%2e/%2e%2e/users',
			'/preview/..%2F..%2F..%2Fusers',
			'/preview/..\\..\\..\\users',
			'/preview/x.jpg?expand[]=access_policy',
			'https://192.0.2.1/preview/x.jpg',
			'//192.0.2.1/preview/x.jpg',
			'/users',
			'/doors',
		]) {
			it(`a stored path ${JSON.stringify(stored)} is answered with 404 and never reaches the controller`, async () => {
				paths.set(READER, stored);
				const response = await httpRequest({ url: `${baseUrl}${PREFIX}/${READER}.jpg` });
				expect(response.status).to.equal(404);
				expect(response.text).to.not.contain(fixtures.DEFAULT_USERS[0].id);
				expect(mock.requests).to.deep.equal([]);
				expect(logger.of('warn')).to.have.length(1);
				expect(logger.of('warn')[0]).to.contain('invalid thumbnail path');
			});
		}
	});
});
