import { expect } from 'chai';
import type { ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { Readable } from 'node:stream';

import { createTestLogger, getFreePort, httpRequest, type TestLogger, waitFor } from '../../test/mock';
import { ProtectMediaHandler } from './protectSnapshotEndpoint';
import { SharedHttpServer } from './sharedHttpServer';

const SNAPSHOT_PREFIX = '/unifi-access/0/protect-snapshot';
const VIDEO_PREFIX = '/unifi-access/0/protect-video';

/** small limit so the tests do not need large buffers */
const MAX_CLIP_BYTES = 200_000;

describe('ProtectMediaHandler (Protect snapshot / clip proxy)', () => {
	let server: SharedHttpServer;
	let logger: TestLogger;
	let baseUrl: string;

	let cache: Map<string, Buffer>;
	let getEventMeta: (eventId: string) => Promise<{ clipUrl?: string } | null>;
	let fetchClip: (clipPath: string) => Promise<Buffer | { stream: Readable; contentLength?: number }>;
	let calls: string[];
	/** response of the latest request (to see when the server noticed a client that left) */
	let lastResponse: ServerResponse | undefined;

	beforeEach(async () => {
		logger = createTestLogger();
		cache = new Map();
		calls = [];
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
			getEventMeta: eventId => getEventMeta(eventId),
			fetchClip: clipPath => fetchClip(clipPath),
			maxClipBytes: MAX_CLIP_BYTES,
			logger,
		});
		lastResponse = undefined;
		server.registerHandler('protect-media', handler.matches, (req, res) => {
			lastResponse = res;
			return handler.handle(req, res);
		});
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

		// K-02 / U-03: the URL names a door event — a live picture under it would be taken for the event
		it('answers 404 on a cache miss and does not fetch a live picture from Protect', async () => {
			cache.set('cam1abc:1722913291000', Buffer.from('cached-image'));
			for (const path of [
				`${SNAPSHOT_PREFIX}/cam1abc/1.jpg?x=1`,
				`${SNAPSHOT_PREFIX}/othercam/1722913291000.jpg`,
			]) {
				const response = await httpRequest({ url: `${baseUrl}${path}` });
				expect(response.status, path).to.equal(404);
				expect(response.text).to.equal('Snapshot of this event is not available any more');
			}
			expect(calls).to.deep.equal([]);
			expect(logger.of('warn')).to.deep.equal([]);
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

		describe('streamed clips (bounded memory)', () => {
			it('passes a clip stream on chunk by chunk with its Content-Length', async () => {
				const chunks = [Buffer.alloc(40_000, 1), Buffer.alloc(40_000, 2), Buffer.alloc(10_000, 3)];
				fetchClip = async () => ({ stream: Readable.from(chunks), contentLength: 90_000 });
				const response = await httpRequest({ url: `${baseUrl}${VIDEO_PREFIX}/evt1.mp4` });
				expect(response.status).to.equal(200);
				expect(response.headers['content-type']).to.equal('video/mp4');
				expect(response.headers['content-length']).to.equal('90000');
				expect(response.body.equals(Buffer.concat(chunks))).to.equal(true);
				expect(logger.of('warn')).to.deep.equal([]);
			});

			it('streams a clip of unknown length (chunked)', async () => {
				fetchClip = async () => ({ stream: Readable.from([Buffer.from('abc'), Buffer.from('def')]) });
				const response = await httpRequest({ url: `${baseUrl}${VIDEO_PREFIX}/evt1.mp4` });
				expect(response.status).to.equal(200);
				expect(response.text).to.equal('abcdef');
			});

			it('refuses a clip whose announced size exceeds the limit without reading it (502)', async () => {
				let read = false;
				const stream = new Readable({
					read() {
						read = true;
						this.push(null);
					},
				});
				fetchClip = async () => ({ stream, contentLength: MAX_CLIP_BYTES + 1 });
				const response = await httpRequest({ url: `${baseUrl}${VIDEO_PREFIX}/evt1.mp4` });
				expect(response.status).to.equal(502);
				expect(read).to.equal(false);
				expect(stream.destroyed).to.equal(true);
				expect(logger.of('warn')).to.deep.equal([
					`Protect clip evt1 not served: ${MAX_CLIP_BYTES + 1} bytes exceed the limit of ${MAX_CLIP_BYTES}.`,
				]);
			});

			it('refuses a buffered clip that exceeds the limit (502)', async () => {
				fetchClip = async () => Buffer.alloc(MAX_CLIP_BYTES + 1);
				expect((await httpRequest({ url: `${baseUrl}${VIDEO_PREFIX}/evt1.mp4` })).status).to.equal(502);
			});

			it('cuts an endless stream off at the limit instead of buffering or forwarding it forever', async () => {
				let produced = 0;
				const stream = new Readable({
					read() {
						produced += 16_384;
						this.push(Buffer.alloc(16_384, 7));
					},
				});
				fetchClip = async () => ({ stream });
				const outcome = await httpRequest({ url: `${baseUrl}${VIDEO_PREFIX}/evt1.mp4`, timeoutMs: 5000 }).then(
					response => `completed with ${response.body.length} bytes`,
					() => 'connection cut',
				);
				expect(outcome).to.equal('connection cut');
				expect(stream.destroyed).to.equal(true);
				expect(produced).to.be.at.most(MAX_CLIP_BYTES + 20 * 16_384);
				expect(logger.of('warn')).to.deep.equal([
					`Protect clip evt1 aborted: more than ${MAX_CLIP_BYTES} bytes`,
				]);
			});

			it('cuts the connection when the source fails in the middle of the clip', async () => {
				const stream = new Readable({ read() {} });
				fetchClip = async () => ({ stream });
				const pending = httpRequest({ url: `${baseUrl}${VIDEO_PREFIX}/evt1.mp4`, timeoutMs: 5000 }).then(
					() => 'completed',
					() => 'connection cut',
				);
				stream.push(Buffer.from('first part'));
				await new Promise(resolve => setTimeout(resolve, 30));
				stream.destroy(new Error('Protect went away'));
				expect(await pending).to.equal('connection cut');
				expect(logger.of('warn')).to.deep.equal(['Protect clip evt1 aborted: Protect went away']);
			});

			// K-06: the client goes away while the event is looked up / the clip is opened
			it('a client that left during the event lookup: the clip is not opened at all', async () => {
				let releaseMeta: () => void = () => undefined;
				let metaAsked = false;
				getEventMeta = eventId => {
					metaAsked = true;
					return new Promise(resolve => {
						releaseMeta = () => resolve({ clipUrl: `video/${eventId}.mp4` });
					});
				};
				const client = connect(Number(new URL(baseUrl).port), '127.0.0.1', () => {
					client.write(`GET ${VIDEO_PREFIX}/evt1.mp4 HTTP/1.1\r\nHost: x\r\n\r\n`);
				});
				await waitFor(() => metaAsked, { description: 'event lookup started' });
				client.destroy();
				// the server sees the closed connection before the lookup answers
				await waitFor(() => lastResponse?.destroyed === true, {
					description: 'server noticed the client left',
				});
				releaseMeta();
				// a request that proves the handler finished the first one
				expect((await httpRequest({ url: `${baseUrl}${SNAPSHOT_PREFIX}/cam1/1.jpg` })).status).to.equal(404);
				expect(calls).to.deep.equal([]);
			});

			it('a client that left while the clip was opened: the upstream stream is destroyed, nothing hangs', async () => {
				const stream = new Readable({ read() {} });
				let releaseClip: () => void = () => undefined;
				let clipAsked = false;
				fetchClip = () => {
					clipAsked = true;
					return new Promise(resolve => {
						releaseClip = () => resolve({ stream, contentLength: 1000 });
					});
				};
				const client = connect(Number(new URL(baseUrl).port), '127.0.0.1', () => {
					client.write(`GET ${VIDEO_PREFIX}/evt1.mp4 HTTP/1.1\r\nHost: x\r\n\r\n`);
				});
				await waitFor(() => clipAsked, { description: 'clip requested' });
				client.destroy();
				await waitFor(() => lastResponse?.destroyed === true, {
					description: 'server noticed the client left',
				});
				releaseClip();
				await waitFor(() => stream.destroyed, { description: 'source stream destroyed' });
				expect(logger.of('warn')).to.deep.equal([]);
			});

			it('stops reading from Protect when the client disconnects', async () => {
				const stream = new Readable({ read() {} });
				fetchClip = async () => ({ stream });
				const client = connect(Number(new URL(baseUrl).port), '127.0.0.1', () => {
					client.write(`GET ${VIDEO_PREFIX}/evt1.mp4 HTTP/1.1\r\nHost: x\r\n\r\n`);
				});
				stream.push(Buffer.from('first part'));
				await new Promise<void>(resolve => client.once('data', () => resolve()));
				client.destroy();
				await waitFor(() => stream.destroyed, { description: 'source stream destroyed' });
				expect(logger.of('warn')).to.deep.equal([]);
			});
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

		// K-14: a dashboard polling a broken URL must not flood the log
		it('repeated failures of the same kind give one warning per minute, the rest at debug level', async () => {
			getEventMeta = async () => {
				throw new Error('meta down');
			};
			for (let i = 0; i < 5; i++) {
				expect((await httpRequest({ url: `${baseUrl}${VIDEO_PREFIX}/evt${i}.mp4` })).status).to.equal(502);
			}
			expect(logger.of('warn')).to.deep.equal(['Protect event meta evt0 failed: meta down']);
			expect(logger.of('debug').filter(m => m.includes('meta down'))).to.have.length(4);
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
