import { expect } from 'chai';

import { createTestLogger, getFreePort, httpRequest, type TestLogger } from '../../test/mock';
import { ProtectMediaHandler } from './protectSnapshotEndpoint';
import { SharedHttpServer } from './sharedHttpServer';

const SNAPSHOT_PREFIX = '/unifi-access/0/protect-snapshot';
const VIDEO_PREFIX = '/unifi-access/0/protect-video';

describe('ProtectMediaHandler (Protect snapshot / clip proxy)', () => {
	let server: SharedHttpServer;
	let logger: TestLogger;
	let baseUrl: string;

	let cache: Map<string, Buffer>;
	let fetchSnapshot: (cameraId: string) => Promise<Buffer>;
	let getEventMeta: (eventId: string) => Promise<{ clipUrl?: string } | null>;
	let fetchClip: (clipPath: string) => Promise<Buffer>;
	let calls: string[];

	beforeEach(async () => {
		logger = createTestLogger();
		cache = new Map();
		calls = [];
		fetchSnapshot = async cameraId => {
			calls.push(`fetchSnapshot ${cameraId}`);
			return Buffer.from(`live-${cameraId}`);
		};
		getEventMeta = async eventId => {
			calls.push(`getEventMeta ${eventId}`);
			return { clipUrl: `video/${eventId}.mp4` };
		};
		fetchClip = async clipPath => {
			calls.push(`fetchClip ${clipPath}`);
			return Buffer.from(`clip-${clipPath}`);
		};
		const port = await getFreePort();
		baseUrl = `http://127.0.0.1:${port}`;
		server = new SharedHttpServer({ port, ip: '127.0.0.1', logger });
		const handler = new ProtectMediaHandler({
			snapshotPathPrefix: SNAPSHOT_PREFIX,
			videoPathPrefix: VIDEO_PREFIX,
			getSnapshot: (cameraId, ts) => cache.get(`${cameraId}:${ts}`),
			fetchSnapshot: cameraId => fetchSnapshot(cameraId),
			getEventMeta: eventId => getEventMeta(eventId),
			fetchClip: clipPath => fetchClip(clipPath),
			logger,
		});
		server.registerHandler('protect-media', handler.matches, handler.handle);
		await server.start();
	});

	afterEach(async () => {
		await server.stop();
	});

	describe('snapshots: GET <prefix>/<cameraId>/<ts>.jpg', () => {
		it('serves the snapshot cached for camera and event time without contacting Protect', async () => {
			cache.set('cam1abc:1722913291000', Buffer.from('cached-image'));
			const response = await httpRequest({ url: `${baseUrl}${SNAPSHOT_PREFIX}/cam1abc/1722913291000.jpg` });
			expect(response.status).to.equal(200);
			expect(response.headers['content-type']).to.equal('image/jpeg');
			expect(response.headers['cache-control']).to.equal('no-store');
			expect(response.text).to.equal('cached-image');
			expect(calls).to.deep.equal([]);
		});

		it('fetches a live snapshot on a cache miss', async () => {
			const response = await httpRequest({ url: `${baseUrl}${SNAPSHOT_PREFIX}/cam1abc/1.jpg?x=1` });
			expect(response.status).to.equal(200);
			expect(response.text).to.equal('live-cam1abc');
			expect(calls).to.deep.equal(['fetchSnapshot cam1abc']);
		});

		it('answers 502 when Protect cannot deliver the snapshot', async () => {
			fetchSnapshot = async () => {
				throw new Error('Protect snapshot HTTP 404');
			};
			const response = await httpRequest({ url: `${baseUrl}${SNAPSHOT_PREFIX}/cam1abc/1.jpg` });
			expect(response.status).to.equal(502);
			expect(logger.of('warn')).to.deep.equal(['Protect snapshot cam1abc failed: Protect snapshot HTTP 404']);
		});

		for (const tail of [
			'cam1.jpg',
			'cam1/abc.jpg',
			'cam-1/1.jpg',
			'cam1/1.png',
			'../x/1.jpg',
			'cam1/1.jpg/extra',
			`${'a'.repeat(65)}/1.jpg`,
			`cam1/${'1'.repeat(17)}.jpg`,
			'cam1%2F..%2Fx/1.jpg',
			'',
		]) {
			it(`answers 400 for the malformed path "${tail}"`, async () => {
				const response = await httpRequest({ url: baseUrl, rawPath: `${SNAPSHOT_PREFIX}/${tail}` });
				expect(response.status).to.equal(400);
				expect(calls).to.deep.equal([]);
			});
		}
	});

	describe('clips: GET <prefix>/<eventId>.mp4', () => {
		it('resolves the clip of the event and serves it as video/mp4', async () => {
			const response = await httpRequest({ url: `${baseUrl}${VIDEO_PREFIX}/evt_1-a.mp4` });
			expect(response.status).to.equal(200);
			expect(response.headers['content-type']).to.equal('video/mp4');
			expect(response.headers['cache-control']).to.equal('no-store');
			expect(response.text).to.equal('clip-video/evt_1-a.mp4');
			expect(calls).to.deep.equal(['getEventMeta evt_1-a', 'fetchClip video/evt_1-a.mp4']);
		});

		it('answers 501 when the event has no clip', async () => {
			getEventMeta = async () => ({});
			const response = await httpRequest({ url: `${baseUrl}${VIDEO_PREFIX}/evt1.mp4` });
			expect(response.status).to.equal(501);
			expect(response.text).to.equal('Video clip not available for this event');

			getEventMeta = async () => null;
			expect((await httpRequest({ url: `${baseUrl}${VIDEO_PREFIX}/evt1.mp4` })).status).to.equal(501);
		});

		it('answers 502 when the event lookup or the clip download fails', async () => {
			getEventMeta = async () => {
				throw new Error('meta down');
			};
			expect((await httpRequest({ url: `${baseUrl}${VIDEO_PREFIX}/evt1.mp4` })).status).to.equal(502);

			getEventMeta = async () => ({ clipUrl: 'video/evt1.mp4' });
			fetchClip = async () => {
				throw new Error('Protect clip HTTP 404');
			};
			expect((await httpRequest({ url: `${baseUrl}${VIDEO_PREFIX}/evt1.mp4` })).status).to.equal(502);
			expect(logger.of('warn')).to.deep.equal([
				'Protect event meta evt1 failed: meta down',
				'Protect clip evt1 failed: Protect clip HTTP 404',
			]);
		});

		for (const tail of [
			'evt1',
			'evt1.jpg',
			'a/b.mp4',
			'../evt1.mp4',
			'evt%2F1.mp4',
			'.mp4',
			`${'e'.repeat(129)}.mp4`,
		]) {
			it(`answers 400 for the malformed path "${tail}"`, async () => {
				const response = await httpRequest({ url: baseUrl, rawPath: `${VIDEO_PREFIX}/${tail}` });
				expect(response.status).to.equal(400);
				expect(calls).to.deep.equal([]);
			});
		}
	});

	it('answers 405 for anything but GET', async () => {
		expect((await httpRequest({ url: `${baseUrl}${SNAPSHOT_PREFIX}/cam1/1.jpg`, method: 'POST' })).status).to.equal(
			405,
		);
		expect((await httpRequest({ url: `${baseUrl}${VIDEO_PREFIX}/evt1.mp4`, method: 'DELETE' })).status).to.equal(
			405,
		);
		expect(calls).to.deep.equal([]);
	});

	it('does not handle paths outside its two prefixes', async () => {
		for (const path of [
			SNAPSHOT_PREFIX,
			VIDEO_PREFIX,
			`${SNAPSHOT_PREFIX}x/cam1/1.jpg`,
			'/unifi-access/0/thumbnail/x.jpg',
		]) {
			expect((await httpRequest({ url: baseUrl, rawPath: path })).status, path).to.equal(404);
		}
		expect(calls).to.deep.equal([]);
	});
});
