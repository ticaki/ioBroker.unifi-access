import type { IncomingMessage } from 'node:http';
import type { UnifiHttp } from '../lib/unifiHttp';
import type { RequestHandler } from './sharedHttpServer';

export interface ThumbnailHandlerOptions {
	pathPrefix: string;
	http: () => UnifiHttp | null;
	resolvePath: (deviceId: string) => Promise<string | null>;
	logger: { debug: (msg: string) => void; info: (msg: string) => void; warn: (msg: string) => void };
}

/**
 * Serves the latest UniFi Access event thumbnail for a device as a JPEG.
 *
 * The browser hits GET <pathPrefix>/<deviceId>.jpg, we look up the most recent
 * door_thumbnail path captured from a webhook/WebSocket event, and proxy the
 * actual image bytes from /api/v1/developer/system/static. Bearer auth never
 * leaves the adapter.
 *
 * Returns 404 if no thumbnail has been seen for the device yet.
 */
export class ThumbnailHandler {
	readonly options: ThumbnailHandlerOptions;

	constructor(options: ThumbnailHandlerOptions) {
		this.options = options;
	}

	matches = (req: IncomingMessage): boolean => {
		const url = req.url?.split('?')[0] ?? '';
		return url.startsWith(`${this.options.pathPrefix}/`);
	};

	handle: RequestHandler = async (req, res) => {
		if (req.method !== 'GET') {
			res.statusCode = 405;
			res.end();
			return true;
		}
		const url = req.url?.split('?')[0] ?? '';
		const tail = url.slice(this.options.pathPrefix.length + 1);
		const match = /^([A-Za-z0-9_-]+)\.jpg$/.exec(tail);
		if (!match) {
			res.statusCode = 404;
			res.end();
			return true;
		}
		const deviceId = match[1];

		const http = this.options.http();
		if (!http) {
			res.statusCode = 503;
			res.end('no controller connection');
			return true;
		}
		let path: string | null;
		try {
			path = await this.options.resolvePath(deviceId);
		} catch (err) {
			this.options.logger.warn(`Thumbnail path lookup failed: ${(err as Error).message}`);
			res.statusCode = 500;
			res.end();
			return true;
		}
		if (!path) {
			res.statusCode = 404;
			res.end('no thumbnail seen');
			return true;
		}
		try {
			const buf = await http.getStaticResource(path);
			res.statusCode = 200;
			res.setHeader('Content-Type', 'image/jpeg');
			res.setHeader('Cache-Control', 'no-store');
			res.end(buf);
		} catch (err) {
			this.options.logger.warn(`Thumbnail fetch for ${deviceId} failed: ${(err as Error).message}`);
			res.statusCode = 502;
			res.end();
		}
		return true;
	};
}
