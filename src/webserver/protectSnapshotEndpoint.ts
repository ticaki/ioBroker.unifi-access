import type { IncomingMessage, ServerResponse } from 'node:http';
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
	/** Fetch video clip by path (full path or relative to /proxy/protect/api/). */
	fetchClip: (clipPath: string) => Promise<Buffer>;
	logger: { warn: (msg: string) => void };
}

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
		const match = /^([A-Za-z0-9]+)\/(\d+)\.jpg$/.exec(tail);
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
		const match = /^([A-Za-z0-9_-]+)\.mp4$/.exec(tail);
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

		try {
			const buf = await this.options.fetchClip(meta.clipUrl);
			res.statusCode = 200;
			res.setHeader('Content-Type', 'video/mp4');
			res.setHeader('Cache-Control', 'no-store');
			res.end(buf);
		} catch (err) {
			this.options.logger.warn(`Protect clip ${eventId} failed: ${(err as Error).message}`);
			res.statusCode = 502;
			res.end();
		}
		return true;
	}
}
