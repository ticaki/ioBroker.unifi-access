import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';
import type { RequestHandler } from './sharedHttpServer';

export interface ProtectMediaHandlerOptions {
	snapshotPathPrefix: string;
	videoPathPrefix: string;
	/** Return cached snapshot buffer for key `<cameraId>:<ts>`, or undefined on miss. */
	getSnapshot: (cameraId: string, ts: string) => Buffer | undefined;
	/** On-demand snapshot fetch from Protect when cache misses. */
	fetchSnapshot: (cameraId: string) => Promise<Buffer>;
	/** Fetch Protect event metadata to resolve the clip URL. */
	getEventMeta: (eventId: string) => Promise<{ clipUrl?: string } | null>;
	/**
	 * Fetch video clip by path (full path or relative to /proxy/protect/api/). A stream is passed on
	 * chunk by chunk, so a clip never has to fit into memory.
	 */
	fetchClip: (clipPath: string) => Promise<Buffer | { stream: Readable; contentLength?: number }>;
	/** Largest clip that is served (default {@link DEFAULT_MAX_CLIP_BYTES}); larger ones are cut off / refused. */
	maxClipBytes?: number;
	logger: { warn: (msg: string) => void };
}

/** Default upper bound for a served clip: door-event clips are a few MB, this only stops runaway responses. */
export const DEFAULT_MAX_CLIP_BYTES = 256 * 1024 * 1024;

export class ProtectMediaHandler {
	constructor(private readonly options: ProtectMediaHandlerOptions) {}

	matches = (req: IncomingMessage): boolean => {
		const url = req.url?.split('?')[0] ?? '';
		return (
			url.startsWith(`${this.options.snapshotPathPrefix}/`) || url.startsWith(`${this.options.videoPathPrefix}/`)
		);
	};

	handle: RequestHandler = async (req, res) => {
		if (req.method !== 'GET') {
			res.statusCode = 405;
			res.end();
			return true;
		}
		const url = req.url?.split('?')[0] ?? '';
		if (url.startsWith(`${this.options.snapshotPathPrefix}/`)) {
			return this.handleSnapshot(url, res);
		}
		return this.handleVideo(url, res);
	};

	private async handleSnapshot(url: string, res: ServerResponse): Promise<true> {
		// URL: <prefix>/<cameraId>/<ts>.jpg
		const tail = url.slice(this.options.snapshotPathPrefix.length + 1);
		const match = /^([A-Za-z0-9]{1,64})\/(\d{1,16})\.jpg$/.exec(tail);
		if (!match) {
			res.statusCode = 400;
			res.end();
			return true;
		}
		const [, cameraId, ts] = match;

		let buf = this.options.getSnapshot(cameraId, ts);
		if (!buf) {
			try {
				buf = await this.options.fetchSnapshot(cameraId);
			} catch (err) {
				this.options.logger.warn(`Protect snapshot ${cameraId} failed: ${(err as Error).message}`);
				res.statusCode = 502;
				res.end();
				return true;
			}
		}

		res.statusCode = 200;
		res.setHeader('Content-Type', 'image/jpeg');
		res.setHeader('Cache-Control', 'no-store');
		res.end(buf);
		return true;
	}

	private async handleVideo(url: string, res: ServerResponse): Promise<true> {
		// URL: <prefix>/<eventId>.mp4
		const tail = url.slice(this.options.videoPathPrefix.length + 1);
		const match = /^([A-Za-z0-9_-]{1,128})\.mp4$/.exec(tail);
		if (!match) {
			res.statusCode = 400;
			res.end();
			return true;
		}
		const eventId = match[1];

		let meta: { clipUrl?: string } | null;
		try {
			meta = await this.options.getEventMeta(eventId);
		} catch (err) {
			this.options.logger.warn(`Protect event meta ${eventId} failed: ${(err as Error).message}`);
			res.statusCode = 502;
			res.end();
			return true;
		}

		if (!meta?.clipUrl) {
			res.statusCode = 501;
			res.end('Video clip not available for this event');
			return true;
		}

		const maxBytes = this.options.maxClipBytes ?? DEFAULT_MAX_CLIP_BYTES;
		let clip: Buffer | { stream: Readable; contentLength?: number };
		try {
			clip = await this.options.fetchClip(meta.clipUrl);
		} catch (err) {
			this.options.logger.warn(`Protect clip ${eventId} failed: ${(err as Error).message}`);
			res.statusCode = 502;
			res.end();
			return true;
		}

		const announced = Buffer.isBuffer(clip) ? clip.length : clip.contentLength;
		if (announced !== undefined && announced > maxBytes) {
			if (!Buffer.isBuffer(clip)) {
				clip.stream.destroy();
			}
			this.options.logger.warn(
				`Protect clip ${eventId} not served: ${announced} bytes exceed the limit of ${maxBytes}.`,
			);
			res.statusCode = 502;
			res.end();
			return true;
		}

		res.statusCode = 200;
		res.setHeader('Content-Type', 'video/mp4');
		res.setHeader('Cache-Control', 'no-store');
		if (Buffer.isBuffer(clip)) {
			res.end(clip);
			return true;
		}
		if (clip.contentLength !== undefined) {
			res.setHeader('Content-Length', String(clip.contentLength));
		}
		await this.pipeClip(clip.stream, res, eventId, maxBytes);
		return true;
	}

	/**
	 * Pass a clip stream on to the client with back-pressure. Ends early (connection closed) when the
	 * source fails, the client goes away or more than `maxBytes` arrive.
	 *
	 * @param source Clip stream from Protect
	 * @param res Response to the client
	 * @param eventId Event id for the log
	 * @param maxBytes Upper bound for the number of bytes passed on
	 */
	private pipeClip(source: Readable, res: ServerResponse, eventId: string, maxBytes: number): Promise<void> {
		return new Promise(resolve => {
			let sent = 0;
			let done = false;
			const finish = (problem?: string): void => {
				if (done) {
					return;
				}
				done = true;
				if (problem) {
					this.options.logger.warn(`Protect clip ${eventId} aborted: ${problem}`);
					source.destroy();
					// headers are out already — the only honest signal left is to cut the connection
					res.destroy();
				} else {
					res.end();
				}
				resolve();
			};
			source.on('data', (chunk: Buffer) => {
				sent += chunk.length;
				if (sent > maxBytes) {
					finish(`more than ${maxBytes} bytes`);
					return;
				}
				if (!res.write(chunk)) {
					source.pause();
					res.once('drain', () => source.resume());
				}
			});
			source.on('end', () => finish());
			source.on('error', (err: Error) => finish(err.message));
			res.on('close', () => {
				if (!done) {
					done = true;
					source.destroy();
					resolve();
				}
			});
		});
	}
}
