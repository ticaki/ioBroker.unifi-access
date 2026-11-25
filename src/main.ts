/*
 * ioBroker.unifi-access
 * Integration of Ubiquiti UniFi Access (UA Ultra and others) for ioBroker.
 * API integration follows the documented developer API: see .doc/api_reference.pdf.
 */

import * as utils from '@iobroker/adapter-core';

import { classifyError, UnifiApiError, UnifiHttp } from './lib/unifiHttp';
import { classifyProtectError, ProtectHttp, type ProtectClipStream } from './lib/protectHttp';
import { classifyStoredSecret } from './lib/secretMigration';
import { tlsCertificateErrorCode } from './lib/tlsErrors';
import { UnifiWebSocket } from './lib/unifiWebSocket';
import type { TimerHost } from './lib/timerHost';
import {
	asRecord,
	asString,
	DOORBELL_REASONS,
	isAccessGranted,
	parseAccessEvent,
	type ParsedAccessEvent,
} from './lib/eventNormalizer';
import { Library } from './lib/library';
import { detectModel, featuresFor, type DeviceCapability, type UnifiDeviceModel } from './lib/deviceModels';
import { isSafeProtectId, sanitizeStaticPath } from './lib/pathSafety';
import {
	describeValue,
	extractDpsStatus,
	LOCK_RULE_BY_INDEX,
	MAX_UNLOCK_MINUTES,
	normalizeDefaultUnlockMinutes,
	normalizePort,
	parseLockRuleIndex,
	parseUnlockMinutes,
} from './lib/controlValues';
import type { LastError, NormalizedEvent, UnifiDeviceRaw, UnifiDoorRaw, UnifiLockRuleType } from './lib/types';
import { networkInterfaces } from 'node:os';
import { createSecureContext } from 'node:tls';
import { WebhookHandler } from './webhooks/server';
import { DEFAULT_WEBHOOK_EVENTS, ensureRegistration, reregister } from './webhooks/registration';
import { ThumbnailHandler } from './webserver/snapshotEndpoint';
import { ProtectMediaHandler } from './webserver/protectSnapshotEndpoint';
import { GenericWebhookHandler } from './webhooks/genericWebhookServer';
import { SharedHttpServer, type SharedHttpServerTls } from './webserver/sharedHttpServer';

const WEBHOOK_PATH = '/unifi-access-webhook';

/** Several door events in a row lead to one GET /doors after this pause. */
const DOOR_REFRESH_DEBOUNCE_MS = 2000;
/** After an own lock-rule command: read the door status back. */
const DOOR_CHECK_AFTER_COMMAND_MS = 2000;
/** After a pulse unlock / an unlock event: the relay has dropped again by then. */
const DOOR_CHECK_AFTER_EVENT_MS = 7000;
/** Upper bound for the JSON the www panel may store in admin.uiSettings. */
const UI_SETTINGS_MAX_LENGTH = 10_000;

/** How long a sendTo request waits for the start of the adapter to finish before it is answered anyway. */
const STARTUP_WAIT_MS = 8000;
/** sendTo commands whose answer depends on what the start of the adapter sets up or loads. */
const STATE_DEPENDENT_COMMANDS = new Set([
	'getConnectionStatus',
	'listDevices',
	'listUsers',
	'reregisterWebhook',
	'getServerInfo',
]);

const USER_RELEVANT_EVENTS = new Set([
	'access.remote_view',
	'access.remote_view.change',
	'access.data.device.remote_unlock',
	'access.door.unlock',
	'access.doorbell.incoming',
	'access.doorbell.incoming.REN',
	'access.doorbell.completed',
	'access.device.dps_status',
	'access.device.emergency_status',
	'access.unlock_schedule.activate',
	'access.unlock_schedule.deactivate',
	'access.temporary_unlock.start',
	'access.temporary_unlock.end',
	'access.visitor.status.changed',
]);

interface DeviceCacheEntry {
	id: string;
	name: string;
	alias?: string;
	type?: string;
	model: UnifiDeviceModel;
	firmware?: string;
	online?: boolean;
	capabilities: readonly DeviceCapability[];
	lastSeenAt?: string;
}

interface ForwardRule {
	event: string;
	deviceId?: string;
	targetState: string;
}

/**
 * Message of an unknown thrown value.
 *
 * @param err Whatever was thrown
 */
function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Upper limit (seconds) of the WebSocket reconnect back-off from the configuration. Anything that is
 * not a positive number falls back to 5 s — a zero or negative delay would reconnect in a tight loop.
 *
 * @param value Raw `wsReconnectDelay`
 */
function normalizeReconnectDelay(value: unknown): number {
	const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
	return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.min(n, 3600) : 5;
}

class UnifiAccess extends utils.Adapter {
	private http: UnifiHttp | null = null;
	private protectHttp: ProtectHttp | null = null;
	private ws: UnifiWebSocket | null = null;
	private library!: Library;
	private httpServer: SharedHttpServer | null = null;

	private connectedToController = false;
	private lastErrorKind: LastError = null;
	private controllerName: string | null = null;
	private webhookSecret: string | null = null;
	private webhookEndpointId: string | null = null;
	/** True once the endpoint is known to be registered with the controller in this run. */
	private webhookRegistered = false;
	private webhookRegistrationRunning = false;
	/** The registration was made before a connection outage and has to be checked again. */
	private webhookRegistrationStale = false;
	private webhookRegistrationFailureLog = '';
	/** The shared HTTP server is listening with the webhook receiver mounted. */
	private webhookReceiverActive = false;

	private bootstrapRetryTimer: ioBroker.Timeout | undefined;
	private bootstrapRunning = false;
	private bootstrapRequestedAgain = false;
	private bootstrapSucceededOnce = false;
	private bootstrapFailures = 0;
	private lastBootstrapFailureLog = '';
	private connectionStatusWritten = false;
	private unloading = false;
	/** Set when the WebSocket closed: the next "open" reloads devices and doors. */
	private wsNeedsResync = false;
	private wsErrorLogged = false;
	private protectRetryTimer: ioBroker.Timeout | undefined;
	private protectLoginRunning = false;

	private devices: Map<string, DeviceCacheEntry> = new Map();
	private userNameCache: Map<string, string> = new Map();
	private doorNameCache: Map<string, string> = new Map();
	private forwardRules: ForwardRule[] = [];

	private readonly protectSnapshotCache = new Map<string, Buffer>();
	private readonly protectSnapshotCacheOrder: string[] = [];
	private static readonly PROTECT_CACHE_MAX = 50;
	private static readonly PROTECT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
	private protectSnapshotCacheBytes = 0;
	/** Why TLS could not be activated although it is enabled (null: no problem). */
	private tlsError: string | null = null;

	// Dedup: access.data.device.remote_unlock (WS) + access.door.unlock (webhook) describe the same action.
	// remote_unlock (no door/user data) is delayed 4 s; if door.unlock arrives in that window,
	// the pending remote_unlock is cancelled and door.unlock (richer data) is pushed instead.
	private readonly unlockPendingTimers = new Map<string, ioBroker.Timeout>();
	private readonly unlockPendingEvents = new Map<string, NormalizedEvent>();

	/** Last value the adapter acknowledged per control state — what an invalid write is reset to. */
	private readonly lastAckedControlValues = new Map<string, number>();

	/** Debounced refresh of all doors (GET /doors). */
	private doorRefreshTimer: ioBroker.Timeout | undefined;
	private doorRefreshWithLockRules = false;
	/** Pending status checks per door (GET /doors/:id). */
	private readonly doorCheckTimers = new Map<string, ioBroker.Timeout[]>();
	/** False once the controller turned out not to offer GET /doors/:id/lock_rule. */
	private lockRuleSupported = true;
	/** The doorbell call currently published in doorbell.active*. */
	private activeDoorbellCall: { requestId?: string; fromWebhook: boolean } | null = null;
	/** Serialises emergency commands (read-modify-write of two flags). */
	private emergencyQueue: Promise<void> = Promise.resolve();
	/** One check per door at the end of a timed unlock — survives the short checks after later events. */
	private readonly doorRuleEndTimers = new Map<string, ioBroker.Timeout>();
	private webhookRegistrationRetryTimer: ioBroker.Timeout | undefined;
	private webhookRegistrationFailures = 0;
	/** First characters of the ioBroker installation UUID — part of the webhook endpoint name. */
	private installationId = '';
	/** Device ids from events that are not in the controller's device list (already looked up once). */
	private readonly unknownDeviceIds = new Set<string>();
	private systemLogFailureLogged = false;
	private lastValidUiSettings = '{}';

	/** Legacy system secret: plain-text and encrypted Protect passwords cannot be told apart. */
	private protectPasswordUncertain = false;

	/** Resolved when the first attempt to load the controller state is over (successful or not). */
	private readonly startup: Promise<void>;
	private startupFinished = false;
	private finishStartup: () => void = () => undefined;

	public constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({
			...options,
			name: 'unifi-access',
		});
		this.startup = new Promise<void>(resolve => {
			this.finishStartup = () => {
				this.startupFinished = true;
				resolve();
			};
		});
		// a failure during start is logged — it must not end as an unhandled rejection (restart loop)
		this.on('ready', () =>
			this.onReady()
				.catch((err: unknown) => {
					this.log.error(`Adapter start failed: ${errorText(err)}`);
				})
				// whatever happened: messages must not wait for a start that is over
				.finally(() => this.finishStartup()),
		);
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	private async onReady(): Promise<void> {
		this.library = new Library(this);
		await this.setState('info.connection', false, true);
		await this.removeObsoleteObjects();
		await this.library.ensureBaseObjects();
		// what an earlier run left behind is not true for this one until proven
		await this.setState('info.webhookRegistered', { val: false, ack: true });
		await this.setState('info.protectConnected', { val: false, ack: true });
		await this.loadInstallationId();

		const cfg = this.config;
		const host = cfg.controllerHost ?? '';
		const port = normalizePort(cfg.controllerPort, 12_445);
		const token = cfg.apiToken ?? '';
		const verifyTLS = cfg.verifyTLS === true;
		const caCert = cfg.caCert || undefined;

		this.forwardRules = Array.isArray(cfg.forwardEvents) ? cfg.forwardEvents : [];
		// credentials of the webhook endpoint registered by an earlier run
		this.webhookEndpointId = asString(cfg.webhookEndpointId) ?? null;
		this.webhookSecret = asString(cfg.webhookSecret) ?? null;

		if (!host || !token) {
			this.log.warn('Controller host or API token missing — open the admin UI to configure.');
			this.setConnectionStatus(false, null);
			return;
		}

		this.http = new UnifiHttp({ host, port, token, verifyTLS, caCert, debugLog: (m: string) => this.log.debug(m) });

		this.subscribeStates('doors.*.unlock');
		this.subscribeStates('doors.*.unlock_duration');
		this.subscribeStates('doors.*.lock_rule');
		this.subscribeStates('doors.emergency.*');
		this.subscribeStates('admin.uiSettings');
		try {
			const stored = await this.getStateAsync('admin.uiSettings');
			if (typeof stored?.val === 'string' && asRecord(JSON.parse(stored.val))) {
				this.lastValidUiSettings = stored.val;
			}
		} catch {
			// not valid JSON: the panel falls back to its defaults, an invalid write is reset to "{}"
		}

		// The receivers listen before the controller is contacted: the webhook endpoint is registered
		// at the end of a successful bootstrap and events may arrive right away.
		await this.startSharedHttpServer();
		await this.bootstrapAndConnect();
		// sendTo requests that arrived meanwhile are answered now, with what was loaded
		this.finishStartup();
		// Last: the Protect login may take long when the console does not answer; door control and
		// events must not wait for it.
		await this.initProtect(host, caCert);
	}

	/** Read the first characters of the installation UUID (part of the webhook endpoint name). */
	private async loadInstallationId(): Promise<void> {
		try {
			const meta = await this.getForeignObjectAsync('system.meta.uuid');
			const uuid = asString((meta?.native as Record<string, unknown> | undefined)?.uuid);
			this.installationId = uuid ? uuid.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) : '';
		} catch {
			this.installationId = '';
		}
	}

	/**
	 * Set up the optional UniFi Protect client (camera snapshots for door events).
	 *
	 * @param host Console host (the same host as UniFi Access)
	 * @param caCert CA certificate from the connection settings
	 */
	private async initProtect(host: string, caCert: string | undefined): Promise<void> {
		const cfg = this.config;
		if (cfg.enableProtect !== true) {
			this.log.debug('[protect] integration disabled');
			return;
		}
		if (!cfg.protectUsername) {
			this.log.warn('[protect] integration enabled but no username configured — skipping');
			return;
		}
		const password = await this.resolveProtectPassword();
		this.protectHttp = new ProtectHttp({
			host,
			port: normalizePort(cfg.protectPort, 443),
			username: cfg.protectUsername,
			password,
			// exactly as configured — there is no silent fallback to an unverified connection
			verifyTLS: cfg.protectVerifyTLS === true,
			caCert,
		});
		await this.tryProtectLogin(1);
	}

	/**
	 * The Protect password to log in with.
	 *
	 * `protectPassword` became an encrypted attribute; instances configured before that still hold it
	 * in plain text, which js-controller turns into garbage when it "decrypts" the configuration at
	 * start. The stored value is inspected and — if it is plain text — used directly and written back
	 * encrypted once (the write restarts the instance; afterwards the value is recognised as encrypted).
	 */
	private async resolveProtectPassword(): Promise<string> {
		const decrypted = typeof this.config.protectPassword === 'string' ? this.config.protectPassword : '';
		const instanceId = `system.adapter.${this.namespace}`;
		let instance: ioBroker.Object | null | undefined;
		try {
			instance = await this.getForeignObjectAsync(instanceId);
		} catch (err) {
			this.log.debug(`[protect] could not read the instance object: ${errorText(err)}`);
		}
		if (!instance) {
			return decrypted;
		}
		const encryptedNative = (instance as { encryptedNative?: unknown }).encryptedNative;
		const stored = classifyStoredSecret({
			raw: (instance.native as Record<string, unknown> | undefined)?.protectPassword,
			decrypted,
			isEncryptedAttribute: Array.isArray(encryptedNative) && encryptedNative.includes('protectPassword'),
			encrypt: plain => this.encrypt(plain),
		});
		if (stored.kind === 'plaintext') {
			this.log.info('[protect] the stored Protect password is not encrypted yet — encrypting it now.');
			try {
				await this.extendForeignObjectAsync(instanceId, { native: { protectPassword: stored.encrypted } });
			} catch (err) {
				this.log.warn(`[protect] could not store the encrypted Protect password: ${errorText(err)}`);
			}
		} else if (stored.kind === 'ambiguous') {
			this.protectPasswordUncertain = true;
		} else if (stored.kind === 'encrypted') {
			// Without the AES marker the value was classified by heuristics (legacy system secret): a
			// plain-text password with non-ASCII characters looks the same as an encrypted one.
			const raw = (instance.native as Record<string, unknown> | undefined)?.protectPassword;
			this.protectPasswordUncertain = typeof raw === 'string' && !raw.startsWith('$/aes-192-cbc:');
		}
		return stored.password;
	}

	private async tryProtectLogin(attempt: number): Promise<void> {
		const protect = this.protectHttp;
		if (!protect || this.protectLoginRunning) {
			return;
		}
		this.protectLoginRunning = true;
		try {
			await protect.login();
			this.log.info(attempt === 1 ? 'UniFi Protect API client initialized' : 'Protect login retry succeeded.');
			this.protectLoginRunning = false;
			await this.setState('info.protectConnected', { val: true, ack: true });
			return;
		} catch (err) {
			this.protectLoginRunning = false;
			const kind = classifyProtectError(err);
			if (kind === 'tls') {
				// A configuration problem: retrying cannot help, so say exactly once what to do.
				this.log.warn(
					`Protect login failed: the TLS certificate of the console was rejected (${tlsCertificateErrorCode(err)}). ` +
						`Either disable "Verify TLS certificate" on the Protect tab or store the CA certificate of the console ` +
						`in the connection settings. The Protect integration stays off until the instance is restarted.`,
				);
				this.protectHttp = null;
			} else if (kind === 'credentials') {
				this.log.warn(
					`Protect login failed: user name or password rejected.${
						this.protectPasswordUncertain
							? ' The password was saved by an earlier adapter version and may need to be entered again: open the instance settings, re-enter the Protect password and save.'
							: ''
					} The Protect integration stays off until the instance is restarted.`,
				);
				this.protectHttp = null;
			} else {
				// rate limit / console not reachable (yet): try again with growing distance
				const delayMs = Math.min(30_000 * 2 ** Math.min(attempt - 1, 10), 10 * 60_000);
				const text = `Protect login failed (${kind}): ${errorText(err)} — retrying in ${Math.round(delayMs / 1000)} s.`;
				if (attempt === 1) {
					this.log.warn(text);
				} else {
					this.log.debug(text);
				}
				this.protectRetryTimer = this.setTimeout(() => {
					this.protectRetryTimer = undefined;
					this.tryProtectLogin(attempt + 1).catch((e: unknown) => {
						this.log.debug(`Protect login retry failed unexpectedly: ${errorText(e)}`);
					});
				}, delayMs);
			}
		}
		await this.setState('info.protectConnected', { val: false, ack: true });
	}

	private requireProtect(): ProtectHttp {
		if (!this.protectHttp) {
			throw new Error('UniFi Protect is not connected');
		}
		return this.protectHttp;
	}

	/**
	 * Load key and certificate for the built-in HTTP server from the ioBroker certificate store.
	 *
	 * @returns The TLS options, or `undefined` when TLS is off or the certificates are not usable. In
	 * the latter case the reason is logged as error and kept in `tlsError`; the server then runs
	 * without TLS and every URL the adapter hands out says `http`.
	 */
	private async loadTlsOptions(): Promise<SharedHttpServerTls | undefined> {
		const cfg = this.config;
		this.tlsError = null;
		if (cfg.enableTls !== true) {
			return undefined;
		}
		try {
			const [certificates] = await this.getCertificatesAsync(cfg.certPublic, cfg.certPrivate, cfg.certChained);
			const key = asString(certificates?.key);
			let cert = asString(certificates?.cert);
			const chain = asString(certificates?.ca);
			if (!key || !cert) {
				throw new Error('certificate or private key is empty');
			}
			if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key) || !cert.includes('-----BEGIN CERTIFICATE-----')) {
				throw new Error('certificate or private key is not in PEM format');
			}
			if (chain && chain.includes('-----BEGIN CERTIFICATE-----') && !cert.includes(chain.trim())) {
				// the server has to present the intermediate certificates along with its own
				cert = `${cert.trim()}\n${chain.trim()}\n`;
			}
			// fails for a key that does not belong to the certificate or for unreadable PEM data
			createSecureContext({ key, cert });
			return { key, cert };
		} catch (err) {
			this.tlsError = errorText(err);
			this.log.error(
				`TLS is enabled for the built-in HTTP server, but the certificates (public "${cfg.certPublic ?? ''}", private "${cfg.certPrivate ?? ''}") ` +
					`could not be loaded: ${this.tlsError}. The server runs WITHOUT TLS (plain http) and all webhook/media URLs use http. ` +
					`Select valid certificates in the instance settings or disable TLS.`,
			);
			return undefined;
		}
	}

	/**
	 * Base URL of the built-in HTTP server as clients and the controller reach it. The scheme is taken
	 * from the running server — never from the configuration — and there is no URL while the server
	 * is not listening.
	 */
	private buildServerBaseUrl(): string | null {
		const server = this.httpServer;
		if (!server?.listening) {
			return null;
		}
		const cfg = this.config;
		const port = normalizePort(cfg.listenPort, 8095);
		const scheme = server.scheme;
		if (cfg.listenIp && cfg.listenIp !== '0.0.0.0') {
			return `${scheme}://${cfg.listenIp}:${port}`;
		}
		const ifaces = networkInterfaces();
		for (const iface of Object.values(ifaces)) {
			for (const addr of iface ?? []) {
				if (addr.family === 'IPv4' && !addr.internal) {
					return `${scheme}://${addr.address}:${port}`;
				}
			}
		}
		return null;
	}

	private buildWebhookPublicUrl(): string | null {
		const base = this.buildServerBaseUrl();
		return base ? `${base}${WEBHOOK_PATH}` : null;
	}

	private async startSharedHttpServer(): Promise<void> {
		const cfg = this.config;
		const port = normalizePort(cfg.listenPort, 8095);
		const ip = cfg.listenIp && cfg.listenIp !== '0.0.0.0' ? cfg.listenIp : undefined;
		const tls = await this.loadTlsOptions();

		const logger = {
			debug: (m: string) => this.log.debug(m),
			info: (m: string) => this.log.info(m),
			warn: (m: string) => this.log.warn(m),
		};

		const server = new SharedHttpServer({ port, ip, tls, logger });
		let webhookHandlerMounted = false;

		if (cfg.enableWebhooks === true) {
			if (!this.http) {
				this.log.warn('Webhook receiver not enabled: no HTTP client.');
			} else {
				const handler = new WebhookHandler({
					path: WEBHOOK_PATH,
					secret: () => this.webhookSecret,
					logger,
					onEvent: env => this.handleAccessEvent(env, 'webhook'),
				});
				server.registerHandler('unifi-webhook', handler.matches, handler.handle);
				webhookHandlerMounted = true;
			}
		}

		if (cfg.enableThumbnailServer === true) {
			const handler = new ThumbnailHandler({
				pathPrefix: `/unifi-access/${this.instance}/thumbnail`,
				http: () => this.http,
				resolvePath: async (deviceId: string) => {
					const state = await this.getStateAsync(`devices.${this.safeId(deviceId)}.lastThumbnailPath`);
					return typeof state?.val === 'string' && state.val ? state.val : null;
				},
				logger,
			});
			server.registerHandler('thumbnail', handler.matches, handler.handle);
		}

		if (cfg.enableProtect === true && cfg.protectUsername) {
			const snapshotPrefix = `/unifi-access/${this.instance}/protect-snapshot`;
			const videoPrefix = `/unifi-access/${this.instance}/protect-video`;
			// resolved per request: the client is dropped when the login turns out to be misconfigured
			const protect = {
				getSnapshot: (cameraId: string): Promise<Buffer> => this.requireProtect().getSnapshot(cameraId),
				getEventMeta: (eventId: string): Promise<{ clipUrl?: string } | null> =>
					this.requireProtect().getEventMeta(eventId),
				getClipStream: (clipPath: string): Promise<ProtectClipStream> =>
					this.requireProtect().getClipStream(clipPath),
			};
			const protectHandler = new ProtectMediaHandler({
				snapshotPathPrefix: snapshotPrefix,
				videoPathPrefix: videoPrefix,
				getSnapshot: (cameraId, ts) => this.protectSnapshotCache.get(`${cameraId}:${ts}`),
				fetchSnapshot: cameraId => protect.getSnapshot(cameraId),
				getEventMeta: eventId => protect.getEventMeta(eventId),
				// streamed: a clip is passed on chunk by chunk instead of being held in memory
				fetchClip: clipPath => protect.getClipStream(clipPath),
				logger,
			});
			server.registerHandler('protect-media', protectHandler.matches, protectHandler.handle);
		}

		if (cfg.enableGenericWebhook === true) {
			const handler = new GenericWebhookHandler({
				path: cfg.genericWebhookPath || '/webhook',
				auth: cfg.genericWebhookAuth || 'none',
				username: cfg.genericWebhookUsername || undefined,
				password: cfg.genericWebhookPassword || undefined,
				token: cfg.genericWebhookToken || undefined,
				logger,
				onRequest: async ({ body, method, url }) => {
					const raw = body.toString('utf8');
					// the one place the body is logged, at debug level only (it may carry personal data)
					this.log.debug(`[generic-webhook] ${method} ${url} | body: ${raw.slice(0, 2000)}`);
					let payload: unknown;
					try {
						payload = JSON.parse(raw);
					} catch {
						this.log.debug('[generic-webhook] body is not valid JSON — skipping state update');
						return;
					}
					await this.handleGenericAlarm(payload, raw);
				},
			});
			if (!handler.credentialsConfigured) {
				this.log.warn(
					`Generic webhook: authentication "${cfg.genericWebhookAuth}" is selected but no ${
						cfg.genericWebhookAuth === 'basic' ? 'user name and password are' : 'token is'
					} configured — every request will be rejected.`,
				);
			}
			server.registerHandler('generic-webhook', handler.matches, handler.handle);
		}

		if (server.handlerCount === 0) {
			// nothing to serve: do not occupy the port (a second instance could not start otherwise)
			this.log.debug('No receiver enabled — the built-in HTTP server is not started.');
			this.httpServer = null;
			return;
		}

		try {
			await server.start();
			this.httpServer = server;
			this.webhookReceiverActive = webhookHandlerMounted;
		} catch (err) {
			this.log.warn(`Shared HTTP server failed to start: ${(err as Error).message}`);
			this.httpServer = null;
			return;
		}
	}

	/**
	 * Name of this installation's webhook endpoint on the controller. It contains the ioBroker host
	 * name: two installations at the same controller (e.g. production and a dev-server, both with
	 * instance 0) get different names and never clean up each other's endpoint.
	 */
	private webhookEndpointName(): string {
		// host name plus the start of the installation UUID: two installations with the same host name
		// and instance number (e.g. two containers called "iobroker") still get different names
		const installation = this.installationId ? `#${this.installationId}` : '';
		return `ioBroker.unifi-access (${this.namespace}@${this.host || 'iobroker'}${installation})`;
	}

	private registrationLogger(): { debug: (m: string) => void; info: (m: string) => void; warn: (m: string) => void } {
		return {
			debug: (m: string) => this.log.debug(m),
			info: (m: string) => this.log.info(m),
			warn: (m: string) => this.log.warn(m),
		};
	}

	/**
	 * Register the webhook endpoint with the controller unless that already happened. Called when the
	 * receiver is listening and again after every successful (re)load of the controller state, so a
	 * registration that failed because the controller was not reachable at start is made up for.
	 */
	private async ensureWebhookRegistration(): Promise<void> {
		if (
			this.config.enableWebhooks !== true ||
			!this.http ||
			!this.webhookReceiverActive ||
			(this.webhookRegistered && !this.webhookRegistrationStale) ||
			this.webhookRegistrationRunning ||
			this.unloading
		) {
			return;
		}
		if (!this.bootstrapSucceededOnce) {
			this.log.debug('Webhook registration postponed until the controller is reachable.');
			return;
		}
		const publicUrl = this.buildWebhookPublicUrl();
		if (!publicUrl) {
			if (!this.webhookRegistrationFailureLog) {
				this.webhookRegistrationFailureLog = 'no-address';
				this.log.warn('Webhook registration skipped: no usable network address found.');
			}
			return;
		}
		this.webhookRegistrationRunning = true;
		try {
			const storedId = this.webhookEndpointId;
			const storedSecret = this.webhookSecret;
			const result = await ensureRegistration({
				http: this.http,
				publicUrl,
				name: this.webhookEndpointName(),
				storedId,
				storedSecret,
				events: DEFAULT_WEBHOOK_EVENTS,
				logger: this.registrationLogger(),
			});
			this.webhookEndpointId = result.id;
			this.webhookSecret = result.secret;
			this.webhookRegistered = true;
			this.webhookRegistrationStale = false;
			this.webhookRegistrationFailureLog = '';
			await this.setState('info.webhookRegistered', { val: true, ack: true });
			// Only write to native when credentials actually changed — extendForeignObjectAsync
			// triggers a js-controller restart, so we must not call it on every start.
			if (result.id !== storedId || result.secret !== storedSecret) {
				await this.persistWebhookCredentials(result.id, result.secret);
			}
			this.webhookRegistrationFailures = 0;
		} catch (err) {
			const text = `Webhook registration failed: ${errorText(err)}`;
			if (text !== this.webhookRegistrationFailureLog) {
				this.webhookRegistrationFailureLog = text;
				this.log.warn(text);
			} else {
				this.log.debug(text);
			}
			this.webhookRegistered = false;
			await this.setState('info.webhookRegistered', { val: false, ack: true });
			this.scheduleWebhookRegistrationRetry();
		} finally {
			this.webhookRegistrationRunning = false;
		}
	}

	/**
	 * Try the webhook registration again later (60 s, 2 min, 4 min, then every 5 min). Without this a
	 * single failed request would leave the webhooks off until the next reconnect or restart.
	 */
	private scheduleWebhookRegistrationRetry(): void {
		if (this.unloading || this.webhookRegistrationRetryTimer) {
			return;
		}
		this.webhookRegistrationFailures += 1;
		const delayMs = Math.min(60_000 * 2 ** Math.min(this.webhookRegistrationFailures - 1, 6), 5 * 60_000);
		this.webhookRegistrationRetryTimer = this.setTimeout(() => {
			this.webhookRegistrationRetryTimer = undefined;
			this.runDetached('webhook registration', this.ensureWebhookRegistration());
		}, delayMs);
	}

	/**
	 * Load devices, doors and users from the controller and mirror them into objects and states.
	 *
	 * @returns false when the controller could not be queried (logged, connection status set)
	 */
	private async loadControllerState(): Promise<boolean> {
		if (!this.http) {
			return false;
		}
		try {
			const [allDevices, allDoors, allUsers] = await Promise.all([
				this.http.listDevices(),
				this.http.listDoors(),
				this.http.listUsers().catch(() => []),
			]);
			// records without a usable id cannot be mapped to objects — skip them instead of failing the whole load
			const hasId = (entry: { id?: unknown } | null | undefined): boolean =>
				typeof entry?.id === 'string' && entry.id !== '';
			const devices = allDevices.filter(hasId);
			const doors = allDoors.filter(hasId);
			const users = allUsers.filter(hasId);
			this.userNameCache.clear();
			for (const u of users) {
				const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.user_email || u.id;
				this.userNameCache.set(u.id, name);
			}
			await this.applyBootstrap({ devices, doors });
			await this.refreshEmergencyStatus();
			this.lockRuleSupported = true;
			for (const door of doors) {
				await this.refreshLockRule(door.id);
			}
			if (this.bootstrapFailures > 0 || !this.bootstrapSucceededOnce) {
				this.log.info(
					`Connected to UniFi Access controller. ${devices.length} devices, ${doors.length} doors.`,
				);
			} else {
				this.log.debug(`Controller state refreshed: ${devices.length} devices, ${doors.length} doors.`);
			}
			this.bootstrapSucceededOnce = true;
			this.bootstrapFailures = 0;
			this.lastBootstrapFailureLog = '';
			return true;
		} catch (err) {
			const kind = classifyError(err);
			this.setConnectionStatus(false, kind);
			this.bootstrapFailures += 1;
			const axErr = err as { response?: { status?: number }; message?: string };
			const tlsCode = tlsCertificateErrorCode(err);
			let text: string;
			if (tlsCode) {
				text =
					`Bootstrap failed: the TLS certificate of the controller was rejected (${tlsCode}). ` +
					`Either disable "Verify TLS certificate" in the connection settings or store the CA certificate of the controller there.`;
			} else if (axErr.response?.status === 404) {
				text = `Bootstrap failed: 404 — verify that host and port point to a UniFi Access controller (${this.http.url}).`;
			} else {
				text = `Bootstrap failed (${kind}): ${errorText(err)}`;
			}
			// A controller that stays down fails the same way on every retry: warn once per distinct
			// failure, repeat only at debug level.
			if (text !== this.lastBootstrapFailureLog) {
				this.lastBootstrapFailureLog = text;
				this.log.warn(text);
			} else {
				this.log.debug(`${text} (attempt ${this.bootstrapFailures})`);
			}
			return false;
		}
	}

	/**
	 * (Re)load the controller state; on success make sure the WebSocket is running, on failure
	 * schedule the next attempt. Calls are serialised — a request during a running load triggers
	 * exactly one further load afterwards.
	 */
	private async bootstrapAndConnect(): Promise<void> {
		if (!this.http || this.unloading) {
			return;
		}
		if (this.bootstrapRunning) {
			this.bootstrapRequestedAgain = true;
			return;
		}
		this.bootstrapRunning = true;
		if (this.bootstrapRetryTimer) {
			this.clearTimeout(this.bootstrapRetryTimer);
			this.bootstrapRetryTimer = undefined;
		}
		try {
			const ok = await this.loadControllerState();
			if (this.unloading) {
				return;
			}
			if (!ok) {
				this.scheduleBootstrapRetry();
				return;
			}
			if (!this.ws) {
				this.setConnectionStatus(true, null);
				this.startWebSocket();
			} else if (this.ws.isOpen) {
				this.setConnectionStatus(true, null);
			}
			// a registration that could not be made at start (controller unreachable) is made up for here
			await this.ensureWebhookRegistration();
			// else: the WebSocket is reconnecting; its "open" sets the status and triggers a resync
		} finally {
			this.bootstrapRunning = false;
			if (this.bootstrapRequestedAgain && !this.unloading) {
				this.bootstrapRequestedAgain = false;
				this.runDetached('controller refresh', this.bootstrapAndConnect());
			}
		}
	}

	/** Delay before the next bootstrap attempt: 30 s, 60 s, 120 s, then every 5 min (rejected token: always 5 min). */
	private nextBootstrapRetryDelay(): number {
		if (this.lastErrorKind === 'unauthorized') {
			return 5 * 60_000;
		}
		return Math.min(30_000 * 2 ** Math.max(0, Math.min(this.bootstrapFailures - 1, 6)), 5 * 60_000);
	}

	private scheduleBootstrapRetry(): void {
		if (this.unloading) {
			return;
		}
		if (this.bootstrapRetryTimer) {
			this.clearTimeout(this.bootstrapRetryTimer);
		}
		const delayMs = this.nextBootstrapRetryDelay();
		this.log.debug(`Next bootstrap attempt in ${Math.round(delayMs / 1000)} s.`);
		this.bootstrapRetryTimer = this.setTimeout(() => {
			this.bootstrapRetryTimer = undefined;
			this.runDetached('bootstrap retry', this.bootstrapAndConnect());
		}, delayMs);
	}

	private async applyBootstrap(data: { devices: UnifiDeviceRaw[]; doors: UnifiDoorRaw[] }): Promise<void> {
		await this.library.applyBootstrap(data);
		// firmware and last-seen time are learned from events; keep them across a reload
		const previous = new Map(this.devices);
		this.devices.clear();
		this.doorNameCache.clear();
		for (const d of data.doors) {
			this.doorNameCache.set(d.id, d.name ?? d.full_name ?? d.id);
		}
		if (data.devices.length > 0) {
			// Helps diagnose missing fields when the controller's response is sparser than expected.
			this.log.debug(`[bootstrap] first device payload keys: ${Object.keys(data.devices[0]).join(', ')}`);
		}
		for (const d of data.devices) {
			const model = detectModel(d.type, d.type);
			this.devices.set(d.id, {
				id: d.id,
				name: d.name ?? d.alias ?? d.id,
				alias: d.alias,
				type: d.type,
				model,
				firmware: (typeof d.firmware === 'string' && d.firmware) || previous.get(d.id)?.firmware,
				// Only an explicit `online: false` means offline; if the field is missing the
				// device is at least known to the controller, so default to online.
				online: d.online !== false,
				capabilities: featuresFor(model),
				lastSeenAt: previous.get(d.id)?.lastSeenAt,
			});
		}
		// Pick a friendly controller name for the admin UI: prefer the alias of any UAH-like
		// device, otherwise fall back to its name. Best-effort — the API has no /self endpoint.
		const first = data.devices[0];
		this.controllerName = first?.alias ?? first?.name ?? null;

		if (this.config.enableProtect) {
			const connected = this.protectHttp?.isLoggedIn() === true;
			await this.setState('info.protectConnected', { val: connected, ack: true });
			this.log.debug(`[protect] info.protectConnected = ${String(connected)}`);
		}
	}

	/** The adapter's timer functions for helper classes (tracked by js-controller, cleared on unload). */
	private timerHost(): TimerHost {
		return {
			setTimeout: (callback, ms) => this.setTimeout(callback, ms),
			clearTimeout: handle => this.clearTimeout(handle as ioBroker.Timeout | undefined),
			setInterval: (callback, ms) => this.setInterval(callback, ms),
			clearInterval: handle => this.clearInterval(handle as ioBroker.Interval | undefined),
		};
	}

	private startWebSocket(): void {
		const cfg = this.config;
		const host = cfg.controllerHost ?? '';
		const port = normalizePort(cfg.controllerPort, 12_445);
		const token = cfg.apiToken ?? '';
		const verifyTLS = cfg.verifyTLS === true;
		const caCert = cfg.caCert || undefined;

		this.ws?.stop();
		this.wsNeedsResync = false;
		this.wsErrorLogged = false;
		const ws = new UnifiWebSocket({
			host,
			port,
			token,
			verifyTLS,
			caCert,
			reconnectDelaySeconds: normalizeReconnectDelay(cfg.wsReconnectDelay),
			timers: this.timerHost(),
			logger: {
				debug: (m: string) => this.log.debug(m),
				info: (m: string) => this.log.info(m),
				warn: (m: string) => this.log.warn(m),
			},
		});
		this.ws = ws;
		ws.on('open', () => {
			if (this.ws !== ws || this.unloading) {
				return;
			}
			this.wsErrorLogged = false;
			this.setConnectionStatus(true, null);
			if (this.wsNeedsResync) {
				// Events were missed while the connection was down: reload devices and doors.
				this.wsNeedsResync = false;
				// The controller may have come back without our webhook endpoint (restored backup, reset,
				// endpoint deleted by hand): check the registration again instead of trusting what was
				// true before the outage. An endpoint that is still there costs one GET and changes nothing.
				// Until the check says otherwise the endpoint keeps counting as registered.
				this.webhookRegistrationStale = true;
				this.log.info('UniFi Access WebSocket reconnected — refreshing devices and doors.');
				this.runDetached('resync after reconnect', this.bootstrapAndConnect());
			} else {
				this.log.info('UniFi Access WebSocket open.');
			}
		});
		ws.on('close', () => {
			if (this.ws !== ws || this.unloading) {
				return;
			}
			if (this.connectedToController) {
				this.log.info('UniFi Access WebSocket closed — connection to the controller lost.');
			} else {
				this.log.debug('UniFi Access WebSocket closed.');
			}
			this.wsNeedsResync = true;
			this.setConnectionStatus(false, 'network');
		});
		ws.on('error', err => {
			// one warning per outage, the repeats of the reconnect attempts only at debug level
			if (!this.wsErrorLogged) {
				this.wsErrorLogged = true;
				this.log.warn(`WebSocket error: ${err.message}`);
			} else {
				this.log.debug(`WebSocket error: ${err.message}`);
			}
		});
		ws.on('event', msg => {
			this.runDetached('WebSocket event', this.handleAccessEvent(msg, 'ws'));
		});
		ws.start();
	}

	/**
	 * Remove objects of earlier adapter versions. `info.webhookSecret` held the webhook signing secret
	 * in clear text, readable by everything that may read states — the secret now lives only in the
	 * encrypted instance configuration.
	 */
	private async removeObsoleteObjects(): Promise<void> {
		for (const id of ['info.webhookSecret']) {
			try {
				if (await this.getObjectAsync(id)) {
					await this.delObjectAsync(id);
					this.log.info(`Removed obsolete state ${id}.`);
				}
				// the state may exist without an object
				await this.delStateAsync(id);
			} catch (err) {
				this.log.debug(`Could not remove obsolete state ${id}: ${errorText(err)}`);
			}
		}
	}

	private async persistWebhookCredentials(id: string, secret: string): Promise<void> {
		await this.setState('info.webhookEndpointId', { val: id, ack: true });
		// webhookSecret ist `encryptedNative`: js-controller entschlüsselt es beim
		// Adapter-Start automatisch — daher hier symmetrisch verschlüsseln, sonst
		// landet beim nächsten Start Müll in cfg.webhookSecret.
		await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
			native: { webhookEndpointId: id, webhookSecret: this.encrypt(secret) },
		});
	}

	private async handleAccessEvent(msg: unknown, source: 'ws' | 'webhook'): Promise<void> {
		// Envelopes are untrusted input (a frame may be null, fields may have any type).
		const parsed = parseAccessEvent(msg, source, Date.now());
		if (!parsed) {
			this.log.debug(`Ignoring ${source} message that is not an event envelope.`);
			return;
		}
		const { event } = parsed;
		if (parsed.thumbnailPathRejected) {
			this.log.warn(`Ignoring invalid thumbnail path in ${event.type} event.`);
		}
		if (USER_RELEVANT_EVENTS.has(event.type)) {
			if (event.type === 'access.data.device.remote_unlock' && event.doorId) {
				// Delay push: door.unlock (webhook) may follow with richer data (door name, user)
				const doorId = event.doorId;
				const existing = this.unlockPendingTimers.get(doorId);
				if (existing) {
					this.clearTimeout(existing);
				}
				this.unlockPendingEvents.set(doorId, event);
				const t = this.setTimeout(() => {
					this.unlockPendingTimers.delete(doorId);
					const pending = this.unlockPendingEvents.get(doorId);
					if (pending) {
						this.unlockPendingEvents.delete(doorId);
						this.runDetached('event log', this.library.pushEvent(pending));
					}
				}, 4000);
				if (t) {
					this.unlockPendingTimers.set(doorId, t);
				}
			} else if (event.type === 'access.door.unlock' && event.doorId) {
				// Cancel pending remote_unlock for this door and push door.unlock instead
				const doorId = event.doorId;
				const t = this.unlockPendingTimers.get(doorId);
				if (t) {
					this.clearTimeout(t);
					this.unlockPendingTimers.delete(doorId);
					this.unlockPendingEvents.delete(doorId);
				}
				await this.library.pushEvent(event);
			} else {
				await this.library.pushEvent(event);
			}
		}
		await this.updateDeviceFromEventData(parsed.device, event.ts);
		await this.dispatchEvent(parsed);
		await this.applyForwardRules(event);
	}

	private async dispatchEvent(parsed: ParsedAccessEvent): Promise<void> {
		const { event } = parsed;
		switch (event.type) {
			case 'access.remote_view': {
				const callId = asString((event.raw as Record<string, unknown>).event_object_id) ?? parsed.requestId;
				await this.setActiveDoorbellCall(
					callId ?? null,
					parsed.requestId,
					event.doorName ?? event.deviceName ?? event.deviceId ?? null,
					event.ts,
					true,
				);
				await this.storeEventThumbnail(event);
				break;
			}

			case 'access.remote_view.change':
				// 105 timeout, 106 admin reject, 107 admin unlocked the door, 108 visitor cancel,
				// 400 answered elsewhere → the call is over in every documented case
				if (parsed.reasonCode !== undefined && parsed.reasonCode in DOORBELL_REASONS) {
					await this.clearActiveDoorbellCall();
				}
				break;

			case 'access.doorbell.incoming':
				// Webhook counterpart of access.remote_view: marks the call as active when the WebSocket
				// did not report it, but never replaces what the WebSocket event of the same call set.
				await this.setActiveDoorbellCall(
					parsed.requestId ?? asString((event.raw as Record<string, unknown>).event_object_id) ?? null,
					parsed.requestId,
					event.doorName ?? event.deviceName ?? event.deviceId ?? null,
					event.ts,
					false,
				);
				await this.storeEventThumbnail(event);
				break;

			case 'access.doorbell.incoming.REN':
				await this.storeEventThumbnail(event);
				break;

			case 'access.doorbell.completed':
				// "accepted, declined, or canceled" — the call is over, whatever the WebSocket delivered
				await this.clearActiveDoorbellCall();
				if (parsed.reasonCode === 107 && event.doorId) {
					this.scheduleDoorChecks(event.doorId, [DOOR_CHECK_AFTER_EVENT_MS]);
				}
				break;

			case 'access.data.device.remote_unlock':
				if (event.doorId) {
					await this.markDoorUnlocked(event.doorId);
				}
				await this.storeEventThumbnail(event);
				break;

			case 'access.door.unlock':
				// "Triggered on all door unlock events" — including denied attempts (result BLOCKED /
				// "Access Denied"). Only a granted access means the door was released.
				if (event.doorId) {
					if (isAccessGranted(parsed.result)) {
						await this.markDoorUnlocked(event.doorId);
					} else {
						this.log.debug(
							`[event] ${event.type} for doorId=${event.doorId} with result "${parsed.result}" — door stays locked`,
						);
					}
				}
				await this.storeEventThumbnail(event);
				this.logSystemLogs(event.ts);
				break;

			case 'access.device.dps_status':
				if (event.doorId) {
					// Documented location of the sensor state is data.object.status. An event without a usable
					// status must not overwrite the known position (it used to be set to "unknown" here).
					const value = extractDpsStatus(parsed.data);
					if (value !== undefined && this.doorNameCache.has(event.doorId)) {
						await this.library.setDoorPosition(event.doorId, value);
					} else if (value === undefined) {
						this.log.debug(`[event] ${event.type} for doorId=${event.doorId} without a status — ignored`);
					}
				}
				this.requestDoorRefresh();
				break;

			case 'access.device.emergency_status':
				this.runDetached('emergency status', this.refreshEmergencyStatus());
				break;

			case 'access.temporary_unlock.start':
				this.logSystemLogs(event.ts);
				this.requestDoorRefresh(true);
				break;

			case 'access.temporary_unlock.end':
			case 'access.unlock_schedule.activate':
			case 'access.unlock_schedule.deactivate':
				// The payloads of these events are not documented — ask the controller what the doors are now.
				this.requestDoorRefresh(true);
				break;
		}
	}

	private async storeEventThumbnail(event: NormalizedEvent): Promise<void> {
		if (!event.thumbnailPath) {
			return;
		}
		const deviceId = this.extractReaderIdFromPath(event.thumbnailPath) ?? event.deviceId;
		if (deviceId) {
			await this.setThumbnail(deviceId, event.thumbnailPath, event.ts);
		}
	}

	/**
	 * Mark a doorbell call as active.
	 *
	 * @param callId Value for doorbell.activeCallId
	 * @param requestId Request id of the call (shared by WebSocket and webhook events of one call)
	 * @param from Door or device the call comes from
	 * @param startedAt Event time (ms epoch)
	 * @param authoritative WebSocket event: always applies. Webhook: only when no call is active.
	 */
	private async setActiveDoorbellCall(
		callId: string | null,
		requestId: string | undefined,
		from: string | null,
		startedAt: number,
		authoritative: boolean,
	): Promise<void> {
		const current = this.activeDoorbellCall;
		if (current) {
			if (!authoritative) {
				// a call is already published — the webhook must not replace it
				return;
			}
			if (current.fromWebhook && requestId !== undefined && current.requestId === requestId) {
				// the WebSocket event of the call the webhook already announced: keep the published id
				return;
			}
		}
		this.activeDoorbellCall = { requestId, fromWebhook: !authoritative };
		await this.setState('doorbell.activeCallId', { val: callId, ack: true });
		await this.setState('doorbell.activeFromDevice', { val: from, ack: true });
		await this.setState('doorbell.activeStartedAt', { val: startedAt, ack: true });
	}

	private async clearActiveDoorbellCall(): Promise<void> {
		this.activeDoorbellCall = null;
		await this.setState('doorbell.activeCallId', { val: null, ack: true });
		await this.setState('doorbell.activeFromDevice', { val: null, ack: true });
		await this.setState('doorbell.activeStartedAt', { val: null, ack: true });
	}

	/**
	 * A door was released (event from the controller): publish it and check a little later what the
	 * controller reports, instead of leaving `locked=false` standing until the next restart.
	 *
	 * @param doorId Door id as used by the controller
	 */
	private async markDoorUnlocked(doorId: string): Promise<void> {
		if (!this.doorNameCache.has(doorId)) {
			// a door that appeared after the start: load it (creates its objects) instead of writing blind
			this.requestDoorRefresh();
			return;
		}
		await this.library.setDoorLocked(doorId, false);
		this.scheduleDoorChecks(doorId, [DOOR_CHECK_AFTER_EVENT_MS]);
	}

	/**
	 * Ask the controller for the status of all doors shortly (debounced: a burst of events leads to
	 * one request). Doors the adapter does not know yet get their objects created.
	 *
	 * @param withLockRules Also re-read the temporary lock rules
	 */
	private requestDoorRefresh(withLockRules = false): void {
		if (this.unloading || !this.http) {
			return;
		}
		this.doorRefreshWithLockRules ||= withLockRules;
		if (this.doorRefreshTimer) {
			return;
		}
		this.doorRefreshTimer = this.setTimeout(() => {
			this.doorRefreshTimer = undefined;
			const lockRules = this.doorRefreshWithLockRules;
			this.doorRefreshWithLockRules = false;
			this.runDetached('door refresh', this.refreshDoors(lockRules));
		}, DOOR_REFRESH_DEBOUNCE_MS);
	}

	/**
	 * Schedule status checks for one door, replacing checks still pending for it. Used after commands
	 * and unlock events in place of timers that assumed the door state.
	 *
	 * @param doorId Door id as used by the controller
	 * @param delaysMs Delays from now, one check each
	 */
	private scheduleDoorChecks(doorId: string, delaysMs: number[]): void {
		this.cancelDoorChecks(doorId);
		if (this.unloading || !this.http) {
			return;
		}
		const timers: ioBroker.Timeout[] = [];
		for (const delayMs of delaysMs) {
			const timer = this.setTimeout(() => {
				const pending = this.doorCheckTimers.get(doorId);
				if (pending) {
					const remaining = pending.filter(t => t !== timer);
					if (remaining.length > 0) {
						this.doorCheckTimers.set(doorId, remaining);
					} else {
						this.doorCheckTimers.delete(doorId);
					}
				}
				this.runDetached('door status check', this.refreshDoor(doorId));
			}, delayMs);
			if (timer) {
				timers.push(timer);
			}
		}
		if (timers.length > 0) {
			this.doorCheckTimers.set(doorId, timers);
		}
	}

	/**
	 * Check the door once more when a timed unlock runs out. Kept separately from the short checks:
	 * an unlock event for the same door in the meantime (which schedules its own short check) must not
	 * cancel it — without webhooks nothing else would report that the door locked again.
	 *
	 * @param doorId Door id as used by the controller
	 * @param delayMs Time until the rule ends
	 */
	private scheduleRuleEndCheck(doorId: string, delayMs: number): void {
		this.cancelRuleEndCheck(doorId);
		if (this.unloading || !this.http) {
			return;
		}
		const timer = this.setTimeout(() => {
			this.doorRuleEndTimers.delete(doorId);
			this.runDetached('door status check', this.refreshDoor(doorId));
		}, delayMs);
		if (timer) {
			this.doorRuleEndTimers.set(doorId, timer);
		}
	}

	private cancelRuleEndCheck(doorId: string): void {
		const timer = this.doorRuleEndTimers.get(doorId);
		if (timer) {
			this.clearTimeout(timer);
			this.doorRuleEndTimers.delete(doorId);
		}
	}

	private cancelDoorChecks(doorId: string): void {
		for (const timer of this.doorCheckTimers.get(doorId) ?? []) {
			this.clearTimeout(timer);
		}
		this.doorCheckTimers.delete(doorId);
	}

	/**
	 * Read one door from the controller (GET /doors/:id) and mirror its lock/position status and lock rule.
	 *
	 * @param doorId Door id as used by the controller
	 */
	private async refreshDoor(doorId: string): Promise<void> {
		if (!this.http || this.unloading) {
			return;
		}
		try {
			const door = await this.http.getDoor(doorId);
			if (door && !this.unloading) {
				await this.applyDoorStatus(door);
				await this.refreshLockRule(door.id);
			}
		} catch (err) {
			this.log.debug(`Door status refresh for ${doorId} failed: ${errorText(err)}`);
		}
	}

	/**
	 * Read all doors from the controller (GET /doors) and mirror their lock/position status.
	 *
	 * @param withLockRules Also re-read the temporary lock rules
	 */
	private async refreshDoors(withLockRules: boolean): Promise<void> {
		if (!this.http || this.unloading) {
			return;
		}
		try {
			const doors = await this.http.listDoors();
			for (const door of doors) {
				if (this.unloading) {
					return;
				}
				if (!door || typeof door.id !== 'string') {
					continue;
				}
				await this.applyDoorStatus(door);
				if (withLockRules) {
					await this.refreshLockRule(door.id);
				}
			}
		} catch (err) {
			this.log.debug(`Door status refresh failed: ${errorText(err)}`);
		}
	}

	private async applyDoorStatus(door: UnifiDoorRaw): Promise<void> {
		if (!this.doorNameCache.has(door.id)) {
			// new door: create its channel and states before anything is written
			await this.library.ensureDoor(door);
			this.doorNameCache.set(door.id, door.name ?? door.full_name ?? door.id);
			this.log.info(`New door "${door.name ?? door.id}" added.`);
			return;
		}
		await this.library.updateDoorStatus(door);
	}

	/**
	 * Mirror the temporary lock rule of a door into doors.<id>.lockRuleType / lockRuleEndsAt.
	 * The endpoint needs UniFi Access 1.24.6 or later; on a controller that does not offer it the
	 * adapter stops asking until the next (re)connect.
	 *
	 * @param doorId Door id as used by the controller
	 */
	private async refreshLockRule(doorId: string): Promise<void> {
		if (!this.http || this.unloading || !this.lockRuleSupported) {
			return;
		}
		try {
			await this.library.setDoorLockRule(doorId, await this.http.getDoorLockRule(doorId));
		} catch (err) {
			const status = (err as { response?: { status?: number } }).response?.status;
			const clientError =
				status !== undefined && status >= 400 && status < 500 && ![401, 403, 429].includes(status);
			// an API error code delivered with HTTP 200 (not an authentication problem) means the same
			const apiRefusal = err instanceof UnifiApiError && classifyError(err) !== 'unauthorized';
			if (clientError || apiRefusal) {
				this.lockRuleSupported = false;
				this.log.debug(
					`Lock rule status not available (requires UniFi Access >= 1.24.6): ${errorText(err)} — not asking again until the next reconnect.`,
				);
			} else {
				this.log.debug(`Lock rule refresh for ${doorId} failed: ${errorText(err)}`);
			}
		}
	}

	private async updateDeviceFromEventData(
		dataDevice: Record<string, unknown> | undefined,
		ts: number,
	): Promise<void> {
		const deviceId = asString(dataDevice?.id);
		if (!dataDevice || deviceId === undefined) {
			return;
		}
		const cached = this.devices.get(deviceId);
		if (!cached) {
			// A device that is not in the device list (added after the start): its objects do not exist
			// yet. Reload the list instead of writing states without objects.
			this.requestDeviceRefresh(deviceId);
			return;
		}
		const safe = this.safeId(deviceId);
		const isoTs = new Date(ts).toISOString();
		const firmware = asString(dataDevice.firmware);
		if (firmware !== undefined) {
			await this.setState(`devices.${safe}.firmware`, { val: firmware, ack: true });
			cached.firmware = firmware;
		}
		// `online` is deliberately not taken from event payloads: every documented webhook sample carries
		// `"online": false`, even for the reader that just rang. The online state comes from GET /devices.
		await this.setState(`devices.${safe}.lastSeenAt`, { val: isoTs, ack: true });
		cached.lastSeenAt = isoTs;
	}

	/**
	 * An event named a device the adapter does not know. Reload devices and doors once (creates the
	 * objects); an id that is still unknown afterwards is remembered and does not trigger further reloads.
	 *
	 * @param deviceId Device id from the event
	 */
	private requestDeviceRefresh(deviceId: string): void {
		if (this.unloading || !this.http || this.unknownDeviceIds.has(deviceId)) {
			return;
		}
		this.unknownDeviceIds.add(deviceId);
		if (this.unknownDeviceIds.size > 500) {
			this.unknownDeviceIds.clear();
		}
		this.log.debug(`Event for unknown device ${deviceId} — reloading the device list.`);
		this.runDetached('device refresh', this.bootstrapAndConnect());
	}

	private async setThumbnail(deviceId: string, path: string, ts: number): Promise<void> {
		if (sanitizeStaticPath(path) === null) {
			return;
		}
		if (!this.devices.has(deviceId)) {
			this.requestDeviceRefresh(deviceId);
			return;
		}
		// models without the thumbnail capability flag get their thumbnail states on first use
		await this.library.ensureThumbnailStates(deviceId);
		const safe = this.safeId(deviceId);
		await this.setState(`devices.${safe}.lastThumbnailPath`, { val: path, ack: true });
		await this.setState(`devices.${safe}.lastThumbnailAt`, { val: ts, ack: true });
		const cfg = this.config;
		if (cfg.enableThumbnailServer === true) {
			const base = this.buildServerBaseUrl();
			if (base) {
				const url = `${base}/unifi-access/${this.instance}/thumbnail/${encodeURIComponent(deviceId)}.jpg?ts=${ts}`;
				await this.setState(`devices.${safe}.lastThumbnailUrl`, { val: url, ack: true });
			}
		}
	}

	private async applyForwardRules(event: NormalizedEvent): Promise<void> {
		for (const rule of this.forwardRules) {
			if (!rule?.event || !rule?.targetState) {
				continue;
			}
			if (rule.event !== event.type) {
				continue;
			}
			// a rule with a device filter matches only events of exactly that device — not events
			// without any device id (e.g. REN doorbells with "device": null)
			if (rule.deviceId && rule.deviceId !== event.deviceId) {
				continue;
			}
			try {
				await this.setForeignStateAsync(rule.targetState, { val: JSON.stringify(event), ack: true });
			} catch (err) {
				this.log.debug(`Forward to ${rule.targetState} failed: ${(err as Error).message}`);
			}
		}
	}

	private setConnectionStatus(connected: boolean, lastError: LastError): void {
		const changed = this.connectedToController !== connected || !this.connectionStatusWritten;
		this.connectedToController = connected;
		this.lastErrorKind = lastError;
		if (changed) {
			this.connectionStatusWritten = true;
			this.runDetached('info.connection', this.setState('info.connection', connected, true));
		}
	}

	/**
	 * Let a promise run on its own while making sure a rejection is logged instead of terminating the
	 * adapter as an unhandled rejection.
	 *
	 * @param what Short description for the log
	 * @param promise The running operation
	 */
	private runDetached(what: string, promise: Promise<unknown>): void {
		promise.catch((err: unknown) => {
			this.log.warn(`${what} failed: ${errorText(err)}`);
		});
	}

	private safeId(raw: string): string {
		return raw.replace(/[^a-zA-Z0-9_-]/g, '_');
	}

	/**
	 * Extracts the reader device ID encoded in a thumbnail path like /preview/reader_<mac>_...
	 *
	 * @param path Static-resource path from the event payload
	 */
	private extractReaderIdFromPath(path: string): string | undefined {
		return /\/reader_([0-9a-fA-F]+)_/i.exec(path)?.[1];
	}

	/**
	 * Mirror an alarm-manager webhook body into notifications.*. The body is foreign input: every
	 * field is written only as the type its state declares, anything else becomes an empty string.
	 *
	 * @param payload Parsed JSON body (any shape)
	 * @param raw The body as received
	 */
	private async handleGenericAlarm(payload: unknown, raw: string): Promise<void> {
		const body = asRecord(payload) ?? {};
		const first = asRecord(Array.isArray(body.events) ? (body.events as unknown[])[0] : undefined) ?? {};
		const text = (value: unknown): string =>
			typeof value === 'string'
				? value
				: typeof value === 'number' && Number.isFinite(value)
					? String(value)
					: '';

		const locationId = text(first.location) || text(asRecord(first.scope)?.locations);
		const userId = text(first.user);
		const locationName =
			(locationId && this.doorNameCache.get(locationId)) || text(first.location_name) || locationId;
		const userName = (userId && this.userNameCache.get(userId)) || text(first.user_name) || userId;
		const time = text(first.time);

		await this.setState('notifications.lastRaw', { val: raw, ack: true });
		await this.setState('notifications.lastAlarmId', { val: text(body.alarm_id), ack: true });
		await this.setState('notifications.lastEventType', { val: text(first.id), ack: true });
		await this.setState('notifications.lastLocationId', { val: locationId, ack: true });
		await this.setState('notifications.lastLocationName', { val: locationName, ack: true });
		await this.setState('notifications.lastUserId', { val: userId, ack: true });
		await this.setState('notifications.lastUserName', { val: userName, ack: true });
		await this.setState('notifications.lastDirection', { val: text(first.direction), ack: true });
		await this.setState('notifications.lastUnlockMethod', { val: text(first.unlock_method_text), ack: true });
		await this.setState('notifications.lastTimestamp', {
			val: (time && Date.parse(time)) || Date.now(),
			ack: true,
		});
	}

	private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
		if (!state || state.ack) {
			return;
		}
		const localId = id.startsWith(`${this.namespace}.`) ? id.slice(this.namespace.length + 1) : id;
		const val: unknown = state.val;

		if (localId === 'doors.emergency.lockdown' || localId === 'doors.emergency.evacuation') {
			const field = localId === 'doors.emergency.lockdown' ? 'lockdown' : 'evacuation';
			this.runCommand(localId, this.handleEmergencyChange(field, val));
			return;
		}

		if (localId === 'admin.uiSettings') {
			this.runCommand(localId, this.handleUiSettings(val));
			return;
		}

		const match = /^doors\.([^.]+)\.(unlock|unlock_duration|lock_rule)$/.exec(localId);
		if (!match) {
			return;
		}
		const [, doorId, control] = match;
		if (!this.doorNameCache.has(doorId)) {
			// not a door of the controller (no objects): nothing to do and nothing to reset
			this.log.debug(`[${control}] ignoring write for unknown door id: ${doorId}`);
			return;
		}

		// A control state opens or locks a real door: only values of exactly the expected type and
		// range are acted upon. Everything else is rejected with a warning and the state is put back
		// (acknowledged) — it must never be "repaired" into a pulse unlock or a rule reset.
		if (control === 'unlock') {
			if (val === false) {
				return;
			}
			if (val !== true) {
				this.rejectControlValue(localId, val, 'expected the boolean true', false);
				return;
			}
			this.runCommand(localId, this.handleDoorUnlock(doorId));
			return;
		}
		if (control === 'unlock_duration') {
			const minutes = parseUnlockMinutes(val);
			if (minutes === null) {
				this.rejectControlValue(
					localId,
					val,
					`expected a number of minutes between 0 and ${MAX_UNLOCK_MINUTES}`,
					this.lastAckedControlValues.get(localId) ?? 0,
				);
				return;
			}
			this.runCommand(localId, this.handleDoorUnlockDuration(doorId, minutes));
			return;
		}
		const ruleType = parseLockRuleIndex(val);
		if (ruleType === null) {
			this.rejectControlValue(
				localId,
				val,
				`expected one of the rule indexes ${Object.keys(LOCK_RULE_BY_INDEX).join(', ')}`,
				this.lastAckedControlValues.get(localId) ?? 0,
			);
			return;
		}
		this.runCommand(localId, this.handleDoorLockRule(doorId, val as number, ruleType));
	}

	/**
	 * Run a command handler detached from the state-change callback. Handlers catch their own API
	 * errors; this is the safety net that keeps an unexpected rejection from terminating the adapter.
	 *
	 * @param what Short description for the log
	 * @param promise The running handler
	 */
	private runCommand(what: string, promise: Promise<void>): void {
		promise.catch((err: unknown) => {
			this.log.warn(`Command ${what} failed unexpectedly: ${errorText(err)}`);
		});
	}

	/**
	 * Refuse an invalid value written to a control state: warn and put the state back (acknowledged).
	 * No request is sent to the controller.
	 *
	 * @param localId State id without namespace
	 * @param val The rejected value
	 * @param expected Human-readable description of what would have been valid
	 * @param restore Value the state is reset to
	 */
	private rejectControlValue(localId: string, val: unknown, expected: string, restore: ioBroker.StateValue): void {
		this.log.warn(
			`Ignoring invalid value ${describeValue(val)} for ${localId}: ${expected}. No door action taken.`,
		);
		this.setState(localId, { val: restore, ack: true }).catch((err: unknown) => {
			this.log.debug(`Could not reset ${localId}: ${errorText(err)}`);
		});
	}

	/**
	 * `admin.uiSettings` is the storage of the www panel, not a command: a JSON object is confirmed
	 * (ack) as it is, anything else is replaced by the last valid value.
	 *
	 * @param val Value written by the panel
	 */
	private async handleUiSettings(val: unknown): Promise<void> {
		let valid = false;
		if (typeof val === 'string' && val.length <= UI_SETTINGS_MAX_LENGTH) {
			try {
				valid = asRecord(JSON.parse(val)) !== undefined;
			} catch {
				valid = false;
			}
		}
		if (valid) {
			this.lastValidUiSettings = val as string;
			await this.setState('admin.uiSettings', { val: val as string, ack: true });
			return;
		}
		this.log.warn(
			`Ignoring invalid value ${describeValue(val)} for admin.uiSettings: expected a JSON object (max. ${UI_SETTINGS_MAX_LENGTH} characters).`,
		);
		await this.setState('admin.uiSettings', { val: this.lastValidUiSettings, ack: true });
	}

	private async handleEmergencyChange(field: 'lockdown' | 'evacuation', val: unknown): Promise<void> {
		if (!this.http) {
			return;
		}
		const localId = `doors.emergency.${field}`;
		if (typeof val !== 'boolean') {
			this.log.warn(
				`Ignoring invalid value ${describeValue(val)} for ${localId}: expected a boolean. Emergency status not changed.`,
			);
			// put the state back to what the controller reports
			await this.refreshEmergencyStatus();
			return;
		}
		// Read-modify-write of two flags: commands are processed strictly one after the other. Two writes
		// in quick succession ("evacuation off", "lockdown off") would otherwise both read the old status
		// and the second PUT would switch the first flag back on.
		const run = this.emergencyQueue.then(() => this.applyEmergencyChange(field, val));
		this.emergencyQueue = run.catch(() => undefined);
		await run;
	}

	private async applyEmergencyChange(field: 'lockdown' | 'evacuation', val: boolean): Promise<void> {
		if (!this.http || this.unloading) {
			return;
		}
		const localId = `doors.emergency.${field}`;
		try {
			// The request carries both flags. The other one is read from the controller right now: the
			// local state may be stale or hold a command that never went through (ack=false), and
			// sending that along could switch evacuation/lockdown on by accident.
			const current = await this.http.readEmergencyStatus();
			if (!current) {
				// never send a guessed value for the other flag
				this.log.warn(
					'Set emergency status failed: the controller did not report the current emergency status.',
				);
				return;
			}
			const payload = { lockdown: current.lockdown, evacuation: current.evacuation };
			payload[field] = val;
			await this.http.setEmergencyStatus(payload);
			await this.setState(localId, { val, ack: true });
			const sibling = field === 'lockdown' ? 'evacuation' : 'lockdown';
			await this.setState(`doors.emergency.${sibling}`, { val: payload[sibling], ack: true });
			this.log.info(`Emergency status: lockdown=${payload.lockdown}, evacuation=${payload.evacuation}`);
		} catch (err) {
			this.log.warn(`Set emergency status failed: ${errorText(err)}`);
		}
	}

	private async refreshEmergencyStatus(): Promise<void> {
		if (!this.http) {
			return;
		}
		try {
			const emergency = await this.http.getEmergencyStatus();
			await this.setState('doors.emergency.lockdown', { val: emergency.lockdown, ack: true });
			await this.setState('doors.emergency.evacuation', { val: emergency.evacuation, ack: true });
		} catch {
			// Endpoint requires UniFi Access >= 1.24.6 — silently ignore on older firmware.
			this.log.debug('Emergency status endpoint not available (requires UniFi Access >= 1.24.6).');
		}
	}

	private unlockActor(): { id: string; name: string } | undefined {
		const actorId = this.config.unlockActorId || '';
		return actorId ? { id: actorId, name: this.userNameCache.get(actorId) ?? actorId } : undefined;
	}

	/**
	 * Unlock a door: pulse (minutes = 0) or timed via a custom lock rule. Afterwards the door status
	 * is read back from the controller instead of assuming when the door locks again.
	 *
	 * @param doorId Door id as used by the controller
	 * @param minutes Whole minutes, 0 = pulse
	 */
	private async unlockDoorFor(doorId: string, minutes: number): Promise<void> {
		if (!this.http) {
			throw new Error('no controller connection');
		}
		if (minutes > 0) {
			await this.http.setDoorLockRule(doorId, { type: 'custom', interval: minutes });
			this.log.info(`Door ${doorId} unlocked for ${minutes} min via lock_rule.`);
			await this.library.setDoorLocked(doorId, false);
			// verify shortly, and look again when the time is up
			this.scheduleDoorChecks(doorId, [DOOR_CHECK_AFTER_COMMAND_MS]);
			this.scheduleRuleEndCheck(doorId, minutes * 60_000 + DOOR_CHECK_AFTER_COMMAND_MS);
		} else {
			await this.http.unlockDoor(doorId, this.unlockActor());
			this.log.info(`Door ${doorId} unlocked (pulse).`);
			await this.library.setDoorLocked(doorId, false);
			this.scheduleDoorChecks(doorId, [DOOR_CHECK_AFTER_EVENT_MS]);
		}
	}

	private async handleDoorUnlock(safeDoorId: string): Promise<void> {
		if (!this.http) {
			return;
		}
		if (!this.doorNameCache.has(safeDoorId)) {
			this.log.debug(`[unlock] ignoring unlock for unknown door id: ${safeDoorId}`);
			return;
		}
		const minutes = normalizeDefaultUnlockMinutes(this.config.defaultUnlockDuration);
		try {
			await this.unlockDoorFor(safeDoorId, minutes);
			await this.setState(`doors.${safeDoorId}.unlock`, { val: true, ack: true });
		} catch (err) {
			this.log.warn(`Unlock door ${safeDoorId} failed: ${errorText(err)}`);
		}
	}

	private async handleDoorUnlockDuration(safeDoorId: string, minutes: number): Promise<void> {
		if (!this.http) {
			return;
		}
		if (!this.doorNameCache.has(safeDoorId)) {
			this.log.debug(`[unlock_duration] ignoring unknown door id: ${safeDoorId}`);
			return;
		}
		try {
			await this.unlockDoorFor(safeDoorId, minutes);
			await this.setState(`doors.${safeDoorId}.unlock_duration`, { val: minutes, ack: true });
			this.lastAckedControlValues.set(`doors.${safeDoorId}.unlock_duration`, minutes);
		} catch (err) {
			this.log.warn(`Unlock door ${safeDoorId} (duration) failed: ${errorText(err)}`);
		}
	}

	private async handleDoorLockRule(
		safeDoorId: string,
		ruleIndex: number,
		type: Exclude<UnifiLockRuleType, 'custom'>,
	): Promise<void> {
		if (!this.http) {
			return;
		}
		if (!this.doorNameCache.has(safeDoorId)) {
			this.log.debug(`[lock_rule] ignoring unknown door id: ${safeDoorId}`);
			return;
		}
		try {
			await this.http.setDoorLockRule(safeDoorId, { type });
			this.log.info(`Door ${safeDoorId} lock_rule set to ${type}.`);
			await this.setState(`doors.${safeDoorId}.lock_rule`, { val: ruleIndex, ack: true });
			this.lastAckedControlValues.set(`doors.${safeDoorId}.lock_rule`, ruleIndex);
			if (type === 'keep_unlock') {
				await this.library.setDoorLocked(safeDoorId, false);
			} else if (type === 'keep_lock' || type === 'lock_now') {
				await this.library.setDoorLocked(safeDoorId, true);
			}
			// `reset` only clears a temporary rule and `lock_early` ends an unlock schedule early: what the
			// door does then depends on its schedule, so nothing is assumed. In every case the status is
			// read back; the new rule replaces an earlier timed unlock, so its end-of-time check is dropped.
			this.cancelRuleEndCheck(safeDoorId);
			this.scheduleDoorChecks(safeDoorId, [DOOR_CHECK_AFTER_COMMAND_MS]);
		} catch (err) {
			this.log.warn(`Set lock_rule for door ${safeDoorId} failed: ${errorText(err)}`);
		}
	}

	/**
	 * sendTo commands of the admin UI and the www panel. Every message with a callback gets exactly
	 * one answer — also when the handler fails or the command is unknown — and failures are reported
	 * in a string field `error`.
	 *
	 * @param msg The message
	 */
	private onMessage(msg: ioBroker.Message): void {
		if (!msg || typeof msg !== 'object' || typeof msg.command !== 'string') {
			return;
		}
		this.log.debug(`Message: ${JSON.stringify({ command: msg.command })}`);
		let afterAnswer: (() => Promise<void>) | undefined;
		this.handleMessage(msg, task => {
			afterAnswer = task;
		})
			.catch((err: unknown) => {
				this.log.warn(`Message "${msg.command}" failed: ${errorText(err)}`);
				return { ok: false, error: errorText(err) };
			})
			.then(answer => {
				if (msg.callback) {
					this.sendTo(msg.from, msg.command, answer, msg.callback);
				}
				return afterAnswer?.();
			})
			.catch((err: unknown) => {
				this.log.warn(`Message "${msg.command}": ${errorText(err)}`);
			});
	}

	/**
	 * Compute the answer to a sendTo command.
	 *
	 * @param msg The message
	 * @param defer Register work that must run only after the answer was sent
	 */
	private async handleMessage(
		msg: ioBroker.Message,
		defer: (task: () => Promise<void>) => void,
	): Promise<Record<string, unknown>> {
		if (STATE_DEPENDENT_COMMANDS.has(msg.command)) {
			await this.waitForStartup();
		}
		switch (msg.command) {
			case 'getConnectionStatus':
				return {
					connected: this.connectedToController,
					lastError: this.lastErrorKind,
					hasToken: !!this.config.apiToken,
					controllerName: this.controllerName,
					webhookRegistered: this.webhookRegistered,
				};

			case 'listDevices':
				return {
					devices: Array.from(this.devices.values()).map(d => ({
						id: d.id,
						name: d.name,
						alias: d.alias,
						type: d.type,
						model: d.model,
						firmware: d.firmware,
						online: d.online,
						capabilities: d.capabilities,
						lastSeenAt: d.lastSeenAt,
					})),
				};

			case 'verifyToken':
				return this.handleVerifyToken(msg);

			case 'reregisterWebhook':
				return this.handleReregisterWebhook(defer);

			case 'listUsers': {
				if (!this.http) {
					return { users: [], error: 'not-configured' };
				}
				try {
					const users = await this.http.listUsers();
					return {
						users: users.map(u => ({
							id: u.id,
							name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.user_email || u.id,
						})),
					};
				} catch (err) {
					this.log.debug(`listUsers failed: ${errorText(err)}`);
					return { users: [], error: classifyError(err) };
				}
			}

			case 'getServerInfo': {
				// actual state of the built-in HTTP server (the UI must not derive it from the settings)
				const server = this.httpServer;
				const running = server?.listening === true;
				return {
					running,
					scheme: running ? server.scheme : null,
					port: normalizePort(this.config.listenPort, 8095),
					baseUrl: this.buildServerBaseUrl(),
					tlsEnabled: this.config.enableTls === true,
					tlsActive: running && server.scheme === 'https',
					tlsError: this.tlsError,
				};
			}

			case 'getNetworkInterfaces': {
				const addresses: string[] = [];
				for (const nets of Object.values(networkInterfaces())) {
					for (const net of nets ?? []) {
						if (net.family === 'IPv4' && !net.internal) {
							addresses.push(net.address);
						}
					}
				}
				return { addresses };
			}

			default:
				this.log.debug(`Unknown message command "${msg.command}".`);
				return { ok: false, error: 'unknown-command' };
		}
	}

	/**
	 * Wait until the start of the adapter is over. The admin sends its requests as soon as the instance
	 * is reported alive — before the HTTP client exists and the controller state is loaded. Answering
	 * right away told the settings page "no devices" and "host or token missing" for a correctly
	 * configured instance that was merely still starting.
	 *
	 * @param maxMs Give up waiting after this time (the controller may not answer at all)
	 */
	private async waitForStartup(maxMs = STARTUP_WAIT_MS): Promise<void> {
		if (this.startupFinished) {
			return;
		}
		await new Promise<void>(resolve => {
			const timer = this.setTimeout(resolve, maxMs);
			void this.startup.then(() => {
				if (timer) {
					this.clearTimeout(timer);
				}
				resolve();
			});
		});
	}

	private async handleVerifyToken(msg: ioBroker.Message): Promise<Record<string, unknown>> {
		const payload = asRecord(msg.message) ?? {};
		const host = asString(payload.host) ?? '';
		const port = normalizePort(payload.port, 12_445);
		const token = asString(payload.token) ?? '';
		const verifyTLS = payload.verifyTLS === true;
		if (!host || !token) {
			return { ok: false, error: 'missing-fields' };
		}
		// A probe with its own client: nothing of the running connection is touched.
		const probe = new UnifiHttp({ host, port, token, verifyTLS, caCert: this.config.caCert || undefined });
		try {
			const devices = await probe.listDevices();
			const first = devices[0];
			return { ok: true, controllerName: first?.alias ?? first?.name ?? null };
		} catch (err) {
			return { ok: false, error: classifyError(err) };
		}
	}

	private async handleReregisterWebhook(
		defer: (task: () => Promise<void>) => void,
	): Promise<Record<string, unknown>> {
		if (!this.http) {
			return { ok: false, error: 'not-configured' };
		}
		if (this.config.enableWebhooks !== true) {
			// registering an endpoint nothing listens on would only make the controller post into the void
			return { ok: false, error: 'webhooks-disabled' };
		}
		const publicUrl = this.webhookReceiverActive ? this.buildWebhookPublicUrl() : null;
		if (!publicUrl) {
			return { ok: false, error: 'receiver-not-running' };
		}
		try {
			const result = await reregister(
				{
					http: this.http,
					publicUrl,
					name: this.webhookEndpointName(),
					events: DEFAULT_WEBHOOK_EVENTS,
					logger: this.registrationLogger(),
				},
				this.webhookEndpointId,
			);
			this.webhookEndpointId = result.id;
			this.webhookSecret = result.secret;
			this.webhookRegistered = true;
			await this.setState('info.webhookRegistered', { val: true, ack: true });
			// Storing the credentials changes the instance object, which makes js-controller restart the
			// adapter — the answer has to be on its way before that.
			defer(() => this.persistWebhookCredentials(result.id, result.secret));
			return { ok: true, id: result.id };
		} catch (err) {
			// The old endpoint may already be deleted: do not keep claiming it is registered, and make
			// up for it with the regular registration.
			this.webhookRegistered = false;
			await this.setState('info.webhookRegistered', { val: false, ack: true });
			defer(() => {
				this.scheduleWebhookRegistrationRetry();
				return Promise.resolve();
			});
			return { ok: false, error: errorText(err) };
		}
	}

	/**
	 * The Protect client lost its session (a re-login after 401 failed, e.g. rate limit or timeout) and
	 * no retry is pending: start the login retry, otherwise the integration would stay off until restart.
	 */
	private recoverProtectSession(): void {
		if (
			this.config.enableProtect === true &&
			this.protectHttp &&
			!this.protectHttp.isLoggedIn() &&
			!this.protectRetryTimer &&
			!this.protectLoginRunning &&
			!this.unloading
		) {
			this.log.debug('[protect] session lost — logging in again');
			this.runDetached('protect login', this.tryProtectLogin(2));
		}
	}

	/** Whether the Protect integration is active and has a session — the only consumer of the system logs. */
	private protectReady(): boolean {
		return this.config.enableProtect === true && this.protectHttp?.isLoggedIn() === true;
	}

	/**
	 * Look up the system log entries around a door event to find the UniFi Protect camera event that
	 * belongs to it. Only runs when the Protect integration is active — the lookup needs the extra
	 * token permission `view:system_log` and has no other use.
	 *
	 * @param ts Event time (ms epoch)
	 */
	private logSystemLogs(ts: number): void {
		if (!this.http || !this.protectReady()) {
			this.recoverProtectSession();
			return;
		}
		const http = this.http;
		this.setTimeout(() => {
			this.runDetached('system log lookup', this.lookupSystemLogs(http, ts));
		}, 3000);
	}

	private async lookupSystemLogs(http: UnifiHttp, ts: number): Promise<void> {
		if (this.unloading || !this.protectReady()) {
			return;
		}
		const since = Math.floor(ts / 1000) - 10;
		const until = Math.floor(ts / 1000) + 30;
		// `door_openings` is a documented topic (API reference 9.2). `all` is listed in 9.1 but not in
		// the request enum of 9.2 — it is only tried when the documented topic yields no camera event.
		for (const topic of ['door_openings', 'all'] as const) {
			let raw: unknown;
			try {
				raw = await http.fetchSystemLogsRaw(topic, since, until);
			} catch (err) {
				const text = `[system-logs:${topic}] fetch failed: ${errorText(err)}`;
				if (topic === 'door_openings' && !this.systemLogFailureLogged) {
					this.systemLogFailureLogged = true;
					this.log.warn(
						`${text} — the API token needs the permission "view:system_log" for Protect snapshots.`,
					);
				} else {
					this.log.debug(text);
				}
				continue;
			}
			if (this.log.level === 'debug' || this.log.level === 'silly') {
				this.log.debug(`[system-logs:${topic}] ${JSON.stringify(raw)}`);
			}
			if (await this.processSystemLogForProtect(raw, ts)) {
				return;
			}
		}
	}

	/**
	 * Scan a system log response for Protect camera events and attach snapshot/clip URLs to the door event.
	 *
	 * @param raw Response of POST /system/logs
	 * @param eventTs Time of the door event (ms epoch)
	 * @returns true when at least one camera event was found
	 */
	private async processSystemLogForProtect(raw: unknown, eventTs: number): Promise<boolean> {
		const protect = this.protectHttp;
		if (!protect || !this.protectReady()) {
			return false;
		}
		const hits = (raw as { data?: { hits?: unknown[] } } | undefined)?.data?.hits;
		if (!Array.isArray(hits)) {
			this.log.debug('[protect] no hits array in system log response');
			return false;
		}
		this.log.debug(`[protect] scanning ${hits.length} system log hit(s) for camera events`);
		let found = false;

		for (const hit of hits) {
			const targets = (hit as { _source?: { target?: unknown[] } } | undefined)?._source?.target;
			if (!Array.isArray(targets)) {
				continue;
			}

			for (const target of targets) {
				const t = target as { type?: string; id?: string };
				if (t?.type !== 'camera event') {
					continue;
				}
				const id = t.id;
				if (typeof id !== 'string' || !id.startsWith('protect_')) {
					this.log.debug(`[protect] camera event with unexpected id format: ${String(id)}`);
					continue;
				}

				// Format: "protect_<cameraId>_<eventId>"
				const parts = id.split('_');
				if (parts.length < 2) {
					continue;
				}
				const cameraId = parts[1];
				const rawEventId = parts.length >= 3 ? parts.slice(2).join('_') : undefined;
				// both ids become part of request paths and of the media URLs handed to clients
				if (!/^[A-Za-z0-9]{1,64}$/.test(cameraId)) {
					this.log.debug('[protect] camera event with unusable camera id — skipped');
					continue;
				}
				const eventId = isSafeProtectId(rawEventId) ? rawEventId : undefined;
				this.log.debug(`[protect] camera event found: cameraId=${cameraId}, eventId=${eventId ?? 'none'}`);
				found = true;

				try {
					const buf = await protect.getSnapshot(cameraId);
					const cacheKey = `${cameraId}:${eventTs}`;
					this.cacheProtectSnapshot(cacheKey, buf);

					const base = this.buildServerBaseUrl();
					if (base === null) {
						this.log.debug('[protect] built-in HTTP server not running — no media URLs for this event');
						continue;
					}
					const snapshotUrl = `${base}/unifi-access/${this.instance}/protect-snapshot/${encodeURIComponent(cameraId)}/${eventTs}.jpg`;
					const videoUrl = eventId
						? `${base}/unifi-access/${this.instance}/protect-video/${encodeURIComponent(eventId)}.mp4`
						: undefined;

					await this.library.updateEventProtectData(eventTs, {
						protectCameraId: cameraId,
						protectEventId: eventId,
						protectSnapshotUrl: snapshotUrl,
						protectVideoUrl: videoUrl,
					});
					this.log.debug(`[protect] snapshot cached for camera ${cameraId} (${buf.length} bytes)`);
				} catch (err) {
					this.log.warn(`[protect] snapshot fetch for camera ${cameraId} failed: ${(err as Error).message}`);
				}
			}
		}
		return found;
	}

	/**
	 * Keep a camera snapshot for the media endpoint. The cache is bounded by entries and by bytes;
	 * the oldest snapshots are dropped first.
	 *
	 * @param cacheKey `<cameraId>:<event timestamp>`
	 * @param buf JPEG bytes
	 */
	private cacheProtectSnapshot(cacheKey: string, buf: Buffer): void {
		if (this.protectSnapshotCache.has(cacheKey) || buf.length > UnifiAccess.PROTECT_CACHE_MAX_BYTES) {
			return;
		}
		this.protectSnapshotCacheOrder.push(cacheKey);
		this.protectSnapshotCache.set(cacheKey, buf);
		this.protectSnapshotCacheBytes += buf.length;
		while (
			this.protectSnapshotCacheOrder.length > UnifiAccess.PROTECT_CACHE_MAX ||
			this.protectSnapshotCacheBytes > UnifiAccess.PROTECT_CACHE_MAX_BYTES
		) {
			const oldest = this.protectSnapshotCacheOrder.shift();
			if (oldest === undefined) {
				break;
			}
			this.protectSnapshotCacheBytes -= this.protectSnapshotCache.get(oldest)?.length ?? 0;
			this.protectSnapshotCache.delete(oldest);
		}
	}

	private async onUnload(callback: () => void): Promise<void> {
		this.unloading = true;
		try {
			this.ws?.stop();
			this.ws = null;
			if (this.bootstrapRetryTimer) {
				this.clearTimeout(this.bootstrapRetryTimer);
				this.bootstrapRetryTimer = undefined;
			}
			if (this.protectRetryTimer) {
				this.clearTimeout(this.protectRetryTimer);
				this.protectRetryTimer = undefined;
			}
			if (this.doorRefreshTimer) {
				this.clearTimeout(this.doorRefreshTimer);
				this.doorRefreshTimer = undefined;
			}
			for (const doorId of [...this.doorCheckTimers.keys()]) {
				this.cancelDoorChecks(doorId);
			}
			for (const doorId of [...this.doorRuleEndTimers.keys()]) {
				this.cancelRuleEndCheck(doorId);
			}
			if (this.webhookRegistrationRetryTimer) {
				this.clearTimeout(this.webhookRegistrationRetryTimer);
				this.webhookRegistrationRetryTimer = undefined;
			}
			for (const timer of this.unlockPendingTimers.values()) {
				this.clearTimeout(timer);
			}
			this.unlockPendingTimers.clear();
			this.unlockPendingEvents.clear();
			if (this.httpServer) {
				await this.httpServer.stop();
				this.httpServer = null;
			}
			callback();
		} catch (error) {
			this.log.error(`Error during unloading: ${(error as Error).message}`);
			callback();
		}
	}
}

if (require.main !== module) {
	module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new UnifiAccess(options);
} else {
	(() => new UnifiAccess())();
}
