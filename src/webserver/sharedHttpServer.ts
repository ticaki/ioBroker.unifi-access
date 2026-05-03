import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';

export interface RequestHandler {
	(req: IncomingMessage, res: ServerResponse): Promise<boolean> | boolean;
}

export interface SharedHttpServerLogger {
	debug: (msg: string) => void;
	info: (msg: string) => void;
	warn: (msg: string) => void;
}

export interface SharedHttpServerTls {
	key: string;
	cert: string;
	ca?: string;
}

export interface SharedHttpServerOptions {
	port: number;
	ip?: string;
	tls?: SharedHttpServerTls;
	logger: SharedHttpServerLogger;
}

interface RegisteredHandler {
	name: string;
	matches: (req: IncomingMessage) => boolean;
	handler: RequestHandler;
}

/**
 * Single HTTP(S) listener that dispatches incoming requests to registered handlers
 * based on a per-handler match predicate (typically a URL path / prefix). Replaces
 * the three previously separate servers (UniFi webhook receiver, thumbnail proxy,
 * generic webhook receiver) so users only need to configure one port.
 */
export class SharedHttpServer {
	private readonly options: SharedHttpServerOptions;
	private server: Server | null = null;
	private handlers: RegisteredHandler[] = [];

	constructor(options: SharedHttpServerOptions) {
		this.options = options;
	}

	registerHandler(name: string, matches: (req: IncomingMessage) => boolean, handler: RequestHandler): void {
		this.handlers.push({ name, matches, handler });
	}

	get scheme(): 'http' | 'https' {
		return this.options.tls ? 'https' : 'http';
	}

	start(): Promise<void> {
		return new Promise((resolve, reject) => {
			const handler = (req: IncomingMessage, res: ServerResponse): void => {
				void this.dispatch(req, res);
			};
			const server = this.options.tls
				? createHttpsServer(
						{ key: this.options.tls.key, cert: this.options.tls.cert, ca: this.options.tls.ca },
						handler,
					)
				: createHttpServer(handler);
			server.once('error', reject);
			const onListening = (): void => {
				server.removeListener('error', reject);
				this.server = server;
				const where = this.options.ip ? `${this.options.ip}:${this.options.port}` : `:${this.options.port}`;
				this.options.logger.info(`Shared ${this.scheme} server listening on ${where}`);
				resolve();
			};
			if (this.options.ip) {
				server.listen(this.options.port, this.options.ip, onListening);
			} else {
				server.listen(this.options.port, onListening);
			}
		});
	}

	stop(): Promise<void> {
		return new Promise(resolve => {
			if (!this.server) {
				resolve();
				return;
			}
			this.server.close(() => resolve());
			this.server = null;
		});
	}

	private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
		for (const entry of this.handlers) {
			let isMatch = false;
			try {
				isMatch = entry.matches(req);
			} catch (err) {
				this.options.logger.warn(`Handler ${entry.name} match check failed: ${(err as Error).message}`);
			}
			if (!isMatch) {
				continue;
			}
			try {
				const handled = await entry.handler(req, res);
				if (handled === false) {
					continue;
				}
				return;
			} catch (err) {
				this.options.logger.warn(`Handler ${entry.name} threw: ${(err as Error).message}`);
				if (!res.headersSent) {
					res.statusCode = 500;
					res.end();
				}
				return;
			}
		}
		res.statusCode = 404;
		res.end();
	}
}
