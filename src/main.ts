/*
 * ioBroker.unifi-access
 * Integration of Ubiquiti UniFi Access (UA Ultra and others) for ioBroker.
 * API integration follows the documented developer API: see .doc/api_reference.pdf.
 */

import * as utils from '@iobroker/adapter-core';

import { classifyError, UnifiHttp } from './lib/unifiHttp';
import { ProtectHttp } from './lib/protectHttp';
import { UnifiWebSocket } from './lib/unifiWebSocket';
import { Library } from './lib/library';
import { detectModel, featuresFor, type DeviceCapability, type UnifiDeviceModel } from './lib/deviceModels';
import type {
	GenericAlarmPayload,
	LastError,
	NormalizedEvent,
	UnifiAccessEventEnvelope,
	UnifiDeviceRaw,
	UnifiDoorRaw,
} from './lib/types';
import { networkInterfaces } from 'node:os';
import { WebhookHandler } from './webhooks/server';
import { DEFAULT_WEBHOOK_EVENTS, ensureRegistration, reregister } from './webhooks/registration';
import { ThumbnailHandler } from './webserver/snapshotEndpoint';
import { ProtectMediaHandler } from './webserver/protectSnapshotEndpoint';
import { GenericWebhookHandler } from './webhooks/genericWebhookServer';
import { SharedHttpServer } from './webserver/sharedHttpServer';

const WEBHOOK_PATH = '/unifi-access-webhook';

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

	private bootstrapRetryTimer: ioBroker.Timeout | undefined;

	private devices: Map<string, DeviceCacheEntry> = new Map();
	private userNameCache: Map<string, string> = new Map();
	private doorNameCache: Map<string, string> = new Map();
	private forwardRules: ForwardRule[] = [];

	private readonly protectSnapshotCache = new Map<string, Buffer>();
	private readonly protectSnapshotCacheOrder: string[] = [];
	private static readonly PROTECT_CACHE_MAX = 50;

	// Dedup: access.data.device.remote_unlock (WS) + access.door.unlock (webhook) describe the same action.
	// remote_unlock (no door/user data) is delayed 4 s; if door.unlock arrives in that window,
	// the pending remote_unlock is cancelled and door.unlock (richer data) is pushed instead.
	private readonly unlockPendingTimers = new Map<string, ioBroker.Timeout>();
	private readonly unlockPendingEvents = new Map<string, NormalizedEvent>();

	public constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({
			...options,
			name: 'unifi-access',
		});
		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	private async onReady(): Promise<void> {
		this.library = new Library(this);
		await this.setState('info.connection', false, true);

		const cfg = this.config;
		const host = cfg.controllerHost ?? '';
		const port = cfg.controllerPort || 12_445;
		const token = cfg.apiToken ?? '';
		const verifyTLS = cfg.verifyTLS === true;
		const caCert = cfg.caCert || undefined;

		this.forwardRules = Array.isArray(cfg.forwardEvents) ? cfg.forwardEvents : [];

		if (!host || !token) {
			this.log.warn('Controller host or API token missing — open the admin UI to configure.');
			this.setConnectionStatus(false, null);
			return;
		}

		this.http = new UnifiHttp({ host, port, token, verifyTLS, caCert, debugLog: (m: string) => this.log.debug(m) });

		if (cfg.enableProtect === true && cfg.protectUsername) {
			this.protectHttp = new ProtectHttp({
				host,
				username: cfg.protectUsername,
				password: cfg.protectPassword ?? '',
				verifyTLS,
			});
			try {
				await this.protectHttp.login();
				this.log.info('UniFi Protect API client initialized');
			} catch (err) {
				const msg = (err as Error).message;
				this.log.warn(`Protect login failed: ${msg}`);
				if (msg.includes('429')) {
					// Rate-limited — retry once after 30 s without blocking the adapter start.
					this.log.info('Protect rate-limited (429) — retrying in 30 s.');
					setTimeout(() => {
						void this.protectHttp
							?.login()
							.then(() => {
								this.log.info('Protect login retry succeeded.');
								void this.setState('info.protectConnected', { val: true, ack: true });
							})
							.catch(e => {
								this.log.warn(`Protect login retry failed: ${(e as Error).message}`);
								this.protectHttp = null;
								void this.setState('info.protectConnected', { val: false, ack: true });
							});
					}, 30_000);
				} else {
					this.protectHttp = null;
				}
			}
		} else if (cfg.enableProtect === true) {
			this.log.warn('[protect] integration enabled but no username configured — skipping');
		} else {
			this.log.debug('[protect] integration disabled');
		}

		this.subscribeStates('doors.*.unlock');
		this.subscribeStates('doors.*.unlock_duration');
		this.subscribeStates('doors.*.lock_rule');
		this.subscribeStates('doors.emergency.*');
		this.subscribeStates('admin.uiSettings');

		await this.bootstrapAndConnect();
		await this.startSharedHttpServer();
	}

	private buildTlsOptions(): { key: string; cert: string; ca?: string } | undefined {
		const cfg = this.config;
		if (cfg.enableTls !== true) {
			return undefined;
		}
		this.log.warn(
			'TLS is enabled but the adapter does not yet load certificates from the ioBroker certificate store — please configure a reverse proxy or extend loadCertificates().',
		);
		return undefined;
	}

	private buildServerBaseUrl(): string | null {
		const cfg = this.config;
		const port = cfg.listenPort || 8095;
		const scheme = cfg.enableTls === true ? 'https' : 'http';
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
		const port = cfg.listenPort || 8095;
		const ip = cfg.listenIp && cfg.listenIp !== '0.0.0.0' ? cfg.listenIp : undefined;
		const tls = this.buildTlsOptions();

		const logger = {
			debug: (m: string) => this.log.debug(m),
			info: (m: string) => this.log.info(m),
			warn: (m: string) => this.log.warn(m),
		};

		const server = new SharedHttpServer({ port, ip, tls, logger });

		if (cfg.enableWebhooks === true) {
			if (!this.http) {
				this.log.warn('Webhook receiver not enabled: no HTTP client.');
			} else {
				this.webhookEndpointId = cfg.webhookEndpointId || null;
				this.webhookSecret = cfg.webhookSecret || null;
				const handler = new WebhookHandler({
					path: WEBHOOK_PATH,
					secret: () => this.webhookSecret,
					logger,
					onEvent: env => this.handleAccessEvent(env, 'webhook'),
				});
				server.registerHandler('unifi-webhook', handler.matches, handler.handle);
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

		if (cfg.enableProtect === true && this.protectHttp !== null) {
			const snapshotPrefix = `/unifi-access/${this.instance}/protect-snapshot`;
			const videoPrefix = `/unifi-access/${this.instance}/protect-video`;
			const protect = this.protectHttp;
			const protectHandler = new ProtectMediaHandler({
				snapshotPathPrefix: snapshotPrefix,
				videoPathPrefix: videoPrefix,
				getSnapshot: (cameraId, ts) => this.protectSnapshotCache.get(`${cameraId}:${ts}`),
				fetchSnapshot: cameraId => protect.getSnapshot(cameraId),
				getEventMeta: eventId => protect.getEventMeta(eventId),
				fetchClip: clipPath => protect.getClipBuffer(clipPath),
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
					this.log.info(`[generic-webhook] ${method} ${url} | body: ${raw.slice(0, 2000)}`);
					let payload: GenericAlarmPayload;
					try {
						payload = JSON.parse(raw) as GenericAlarmPayload;
					} catch {
						this.log.debug('[generic-webhook] body is not valid JSON — skipping state update');
						return;
					}
					await this.handleGenericAlarm(payload, raw);
				},
			});
			server.registerHandler('generic-webhook', handler.matches, handler.handle);
		}

		try {
			await server.start();
			this.httpServer = server;
		} catch (err) {
			this.log.warn(`Shared HTTP server failed to start: ${(err as Error).message}`);
			this.httpServer = null;
			return;
		}

		if (cfg.enableWebhooks === true && this.http) {
			const publicUrl = this.buildWebhookPublicUrl();
			if (!publicUrl) {
				this.log.warn('Webhook registration skipped: no usable network address found.');
			} else {
				try {
					const result = await ensureRegistration({
						http: this.http,
						publicUrl,
						name: `ioBroker.unifi-access (${this.namespace})`,
						events: DEFAULT_WEBHOOK_EVENTS,
						logger,
					});
					this.webhookEndpointId = result.id;
					this.webhookSecret = result.secret;
					// Only write to native when credentials actually changed — extendForeignObjectAsync
					// triggers a js-controller restart, so we must not call it on every start.
					const idChanged = result.id !== (cfg.webhookEndpointId || null);
					const secretChanged = result.secret !== (cfg.webhookSecret || null);
					if (idChanged || secretChanged) {
						await this.persistWebhookCredentials(result.id, result.secret);
					}
					await this.setState('info.webhookRegistered', { val: true, ack: true });
				} catch (err) {
					this.log.warn(`Webhook registration failed: ${(err as Error).message}`);
					await this.setState('info.webhookRegistered', { val: false, ack: true });
				}
			}
		}
	}

	private async bootstrapAndConnect(): Promise<void> {
		if (!this.http) {
			return;
		}
		try {
			const [devices, doors, users] = await Promise.all([
				this.http.listDevices(),
				this.http.listDoors(),
				this.http.listUsers().catch(() => []),
			]);
			this.userNameCache.clear();
			for (const u of users) {
				const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.user_email || u.id;
				this.userNameCache.set(u.id, name);
			}
			await this.applyBootstrap({ devices, doors });
			await this.refreshEmergencyStatus();
			this.setConnectionStatus(true, null);
			this.log.info(`Connected to UniFi Access controller. ${devices.length} devices, ${doors.length} doors.`);

			this.startWebSocket();
		} catch (err) {
			const kind = classifyError(err);
			this.setConnectionStatus(false, kind);
			const axErr = err as { response?: { status?: number }; message?: string };
			if (axErr.response?.status === 404) {
				this.log.warn(
					`Bootstrap failed: 404 — verify that host and port point to a UniFi Access controller (${this.http.url}).`,
				);
			} else {
				this.log.warn(`Bootstrap failed (${kind}): ${(err as Error).message}`);
			}
			this.scheduleBootstrapRetry();
		}
	}

	private scheduleBootstrapRetry(): void {
		if (this.bootstrapRetryTimer) {
			this.clearTimeout(this.bootstrapRetryTimer);
		}
		this.bootstrapRetryTimer = this.setTimeout(() => {
			this.bootstrapRetryTimer = undefined;
			void this.bootstrapAndConnect();
		}, 30_000);
	}

	private async applyBootstrap(data: { devices: UnifiDeviceRaw[]; doors: UnifiDoorRaw[] }): Promise<void> {
		await this.library.applyBootstrap(data);
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
				firmware: d.firmware,
				// Only an explicit `online: false` means offline; if the field is missing the
				// device is at least known to the controller, so default to online.
				online: d.online !== false,
				capabilities: featuresFor(model),
				lastSeenAt: undefined,
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

	private startWebSocket(): void {
		const cfg = this.config;
		const host = cfg.controllerHost ?? '';
		const port = cfg.controllerPort || 12_445;
		const token = cfg.apiToken ?? '';
		const verifyTLS = cfg.verifyTLS === true;
		const caCert = cfg.caCert || undefined;

		this.ws?.stop();
		this.ws = new UnifiWebSocket({
			host,
			port,
			token,
			verifyTLS,
			caCert,
			reconnectDelaySeconds: cfg.wsReconnectDelay || 5,
			logger: {
				debug: (m: string) => this.log.debug(m),
				info: (m: string) => this.log.info(m),
				warn: (m: string) => this.log.warn(m),
			},
		});
		this.ws.on('open', () => {
			this.log.info('UniFi Access WebSocket open.');
			this.setConnectionStatus(true, null);
		});
		this.ws.on('close', () => {
			this.log.debug('UniFi Access WebSocket closed.');
		});
		this.ws.on('error', err => {
			this.log.warn(`WebSocket error: ${err.message}`);
		});
		this.ws.on('event', msg => {
			void this.handleAccessEvent(msg, 'ws');
		});
		this.ws.start();
	}

	private async persistWebhookCredentials(id: string, secret: string): Promise<void> {
		await this.setState('info.webhookEndpointId', { val: id, ack: true });
		await this.setState('info.webhookSecret', { val: secret, ack: true });
		// webhookSecret ist `encryptedNative`: js-controller entschlüsselt es beim
		// Adapter-Start automatisch — daher hier symmetrisch verschlüsseln, sonst
		// landet beim nächsten Start Müll in cfg.webhookSecret.
		await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
			native: { webhookEndpointId: id, webhookSecret: this.encrypt(secret) },
		});
	}

	private async handleAccessEvent(msg: UnifiAccessEventEnvelope, source: 'ws' | 'webhook'): Promise<void> {
		if (!msg.event) {
			return;
		}
		const ts =
			typeof msg.timestamp === 'number'
				? msg.timestamp
				: typeof msg.timestamp === 'string'
					? Date.parse(msg.timestamp) || Date.now()
					: Date.now();

		const data = msg.data ?? {};
		const dataDevice = (data.device as Record<string, unknown> | undefined) ?? undefined;
		// access.data.device.remote_unlock delivers the door's location object directly as `data`
		// (no nested `data.location`, no `data.door_id`). Detect that shape via location_type+unique_id
		// so doorId/doorName/thumbnail extraction below works for it.
		const dataIsLocation = typeof data.location_type === 'string' && typeof data.unique_id === 'string';
		const location = (data.location as Record<string, unknown> | undefined) ?? (dataIsLocation ? data : undefined);
		const extras = (location?.extras as Record<string, unknown> | undefined) ?? undefined;
		const actor = (data.actor as Record<string, unknown> | undefined) ?? undefined;
		const thumbnailPath =
			(extras?.door_thumbnail as string | undefined) ?? (data.door_thumbnail as string | undefined);

		const REMOTE_VIEW_CHANGE_REASONS: Record<number, string> = {
			105: 'timeout',
			106: 'admin_rejected',
			107: 'admin_unlocked',
			108: 'visitor_cancelled',
			400: 'answered_elsewhere',
		};
		let subtype: string | undefined;
		if (msg.event === 'access.remote_view.change') {
			const code = Number(data.reason_code ?? -1);
			subtype = REMOTE_VIEW_CHANGE_REASONS[code];
		} else if (msg.event === 'access.device.dps_status') {
			const val = data.dps_status ?? data.value;
			subtype = typeof val === 'string' ? val : undefined;
		}

		const event: NormalizedEvent = {
			ts,
			source,
			type: msg.event,
			subtype,
			deviceId:
				(data.device_id as string | undefined) ??
				(dataDevice?.id as string | undefined) ??
				(msg.event === 'access.data.device.remote_unlock' ? msg.event_object_id : undefined),
			deviceName:
				(data.device_name as string | undefined) ??
				(dataDevice?.name as string | undefined) ??
				(dataDevice?.alias as string | undefined),
			doorId:
				(data.door_id as string | undefined) ??
				(location?.id as string | undefined) ??
				(location?.unique_id as string | undefined),
			doorName: (data.door_name as string | undefined) ?? (location?.name as string | undefined),
			userName: (data.user_name as string | undefined) ?? (actor?.name as string | undefined),
			thumbnailPath,
			raw: msg,
		};
		if (USER_RELEVANT_EVENTS.has(event.type)) {
			if (event.type === 'access.data.device.remote_unlock' && event.doorId) {
				// Delay push: door.unlock (webhook) may follow with richer data (door name, user)
				const doorId = event.doorId;
				const existing = this.unlockPendingTimers.get(doorId);
				if (existing) {
					this.clearTimeout(existing);
				}
				this.unlockPendingEvents.set(doorId, event);
				const t = this.setTimeout(async () => {
					this.unlockPendingTimers.delete(doorId);
					const pending = this.unlockPendingEvents.get(doorId);
					if (pending) {
						this.unlockPendingEvents.delete(doorId);
						await this.library.pushEvent(pending);
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
		await this.updateDeviceFromEventData(dataDevice, ts);
		await this.dispatchEvent(event, msg);
		await this.applyForwardRules(event);
	}

	private async dispatchEvent(event: NormalizedEvent, raw: UnifiAccessEventEnvelope): Promise<void> {
		switch (event.type) {
			case 'access.remote_view':
				await this.setState('doorbell.activeCallId', {
					val: raw.event_object_id ?? null,
					ack: true,
				});
				await this.setState('doorbell.activeFromDevice', {
					val: event.doorName ?? event.deviceName ?? event.deviceId ?? null,
					ack: true,
				});
				await this.setState('doorbell.activeStartedAt', { val: event.ts, ack: true });
				if (event.thumbnailPath) {
					const tid = this.extractReaderIdFromPath(event.thumbnailPath) ?? event.deviceId;
					if (tid) {
						await this.setThumbnail(tid, event.thumbnailPath, event.ts);
					}
				}
				break;

			case 'access.remote_view.change': {
				const reason = Number((raw.data?.reason_code as number | undefined) ?? -1);
				// 105 timeout, 106 admin reject, 108 visitor cancel, 400 answered elsewhere → call ended
				if (reason === 105 || reason === 106 || reason === 108 || reason === 400) {
					await this.setState('doorbell.activeCallId', { val: null, ack: true });
					await this.setState('doorbell.activeFromDevice', { val: null, ack: true });
					await this.setState('doorbell.activeStartedAt', { val: null, ack: true });
				}
				break;
			}

			case 'access.data.device.remote_unlock':
				if (event.doorId) {
					const channelId = `doors.${this.safeId(event.doorId)}.locked`;
					await this.setState(channelId, { val: false, ack: true });
				}
				if (event.thumbnailPath) {
					const tid = this.extractReaderIdFromPath(event.thumbnailPath) ?? event.deviceId;
					if (tid) {
						await this.setThumbnail(tid, event.thumbnailPath, event.ts);
					}
				}
				break;

			case 'access.door.unlock':
				if (event.doorId) {
					const channelId = `doors.${this.safeId(event.doorId)}.locked`;
					await this.setState(channelId, { val: false, ack: true });
				}
				if (event.thumbnailPath) {
					const tid = this.extractReaderIdFromPath(event.thumbnailPath) ?? event.deviceId;
					if (tid) {
						await this.setThumbnail(tid, event.thumbnailPath, event.ts);
					}
				}
				this.log.debug(`[event] ${event.type} for doorId=${event.doorId}, setting locked=false`);
				this.logSystemLogs(event.ts);
				break;

			case 'access.doorbell.incoming':
			case 'access.doorbell.incoming.REN':
				if (event.thumbnailPath) {
					const tid = this.extractReaderIdFromPath(event.thumbnailPath) ?? event.deviceId;
					if (tid) {
						await this.setThumbnail(tid, event.thumbnailPath, event.ts);
					}
				}
				break;

			case 'access.device.dps_status':
				if (event.doorId) {
					const value = raw.data?.dps_status ?? raw.data?.value;
					await this.setState(`doors.${this.safeId(event.doorId)}.position`, {
						val: typeof value === 'string' ? value : 'unknown',
						ack: true,
					});
				}
				break;

			case 'access.device.emergency_status':
				void this.refreshEmergencyStatus();
				break;

			case 'access.temporary_unlock.start':
				this.logSystemLogs(event.ts);
				break;
		}
	}

	private async updateDeviceFromEventData(
		dataDevice: Record<string, unknown> | undefined,
		ts: number,
	): Promise<void> {
		if (!dataDevice?.id || typeof dataDevice.id !== 'string') {
			return;
		}
		const safe = this.safeId(dataDevice.id);
		const isoTs = new Date(ts).toISOString();
		if (typeof dataDevice.firmware === 'string' && dataDevice.firmware) {
			await this.setState(`devices.${safe}.firmware`, { val: dataDevice.firmware, ack: true });
		}
		if (typeof dataDevice.online === 'boolean') {
			await this.setState(`devices.${safe}.online`, { val: dataDevice.online, ack: true });
		}
		await this.setState(`devices.${safe}.lastSeenAt`, { val: isoTs, ack: true });
		const cached = this.devices.get(dataDevice.id);
		if (cached) {
			if (typeof dataDevice.firmware === 'string' && dataDevice.firmware) {
				cached.firmware = dataDevice.firmware;
			}
			if (typeof dataDevice.online === 'boolean') {
				cached.online = dataDevice.online;
			}
			cached.lastSeenAt = isoTs;
		}
	}

	private async setThumbnail(deviceId: string, path: string, ts: number): Promise<void> {
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
			if (rule.deviceId && event.deviceId && rule.deviceId !== event.deviceId) {
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
		this.connectedToController = connected;
		this.lastErrorKind = lastError;
		void this.setState('info.connection', connected, true);
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

	private async handleGenericAlarm(payload: GenericAlarmPayload, raw: string): Promise<void> {
		const first = payload.events?.[0];
		const locationId = first?.location ?? first?.scope?.locations ?? '';
		const userId = first?.user ?? '';

		const locationName =
			(typeof locationId === 'string' && locationId ? this.doorNameCache.get(locationId) : undefined) ??
			(typeof first?.location_name === 'string' && first.location_name ? first.location_name : undefined) ??
			locationId;

		const userName =
			(typeof userId === 'string' && userId ? this.userNameCache.get(userId) : undefined) ??
			(typeof first?.user_name === 'string' && first.user_name ? first.user_name : undefined) ??
			userId;

		await this.setState('notifications.lastRaw', { val: raw, ack: true });
		await this.setState('notifications.lastAlarmId', { val: payload.alarm_id ?? '', ack: true });
		await this.setState('notifications.lastEventType', { val: first?.id ?? '', ack: true });
		await this.setState('notifications.lastLocationId', { val: locationId, ack: true });
		await this.setState('notifications.lastLocationName', { val: locationName, ack: true });
		await this.setState('notifications.lastUserId', { val: userId, ack: true });
		await this.setState('notifications.lastUserName', { val: userName, ack: true });
		await this.setState('notifications.lastDirection', { val: first?.direction ?? '', ack: true });
		await this.setState('notifications.lastUnlockMethod', { val: first?.unlock_method_text ?? '', ack: true });
		const ts =
			first?.time && typeof first.time === 'string' && first.time
				? Date.parse(first.time) || Date.now()
				: Date.now();
		await this.setState('notifications.lastTimestamp', { val: ts, ack: true });
	}

	private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
		if (!state || state.ack) {
			return;
		}
		const localId = id.startsWith(`${this.namespace}.`) ? id.slice(this.namespace.length + 1) : id;

		if (localId.startsWith('doors.') && localId.endsWith('.unlock')) {
			if (state.val !== true) {
				return;
			}
			const doorId = localId.slice('doors.'.length, -'.unlock'.length);
			void this.handleDoorUnlock(doorId);
			return;
		}
		if (localId.startsWith('doors.') && localId.endsWith('.unlock_duration')) {
			const minutes = typeof state.val === 'number' ? Math.max(0, Math.floor(state.val)) : 0;
			const doorId = localId.slice('doors.'.length, -'.unlock_duration'.length);
			void this.handleDoorUnlockDuration(doorId, minutes);
			return;
		}
		if (localId.startsWith('doors.') && localId.endsWith('.lock_rule')) {
			const ruleIndex = typeof state.val === 'number' ? state.val : 0;
			const doorId = localId.slice('doors.'.length, -'.lock_rule'.length);
			void this.handleDoorLockRule(doorId, ruleIndex);
			return;
		}
		if (localId === 'doors.emergency.lockdown') {
			void this.handleEmergencyChange('lockdown', state.val === true);
			return;
		}
		if (localId === 'doors.emergency.evacuation') {
			void this.handleEmergencyChange('evacuation', state.val === true);
			return;
		}
	}

	private async handleEmergencyChange(field: 'lockdown' | 'evacuation', val: boolean): Promise<void> {
		if (!this.http) {
			return;
		}
		const sibling = field === 'lockdown' ? 'evacuation' : 'lockdown';
		const siblingState = await this.getStateAsync(`doors.emergency.${sibling}`);
		const siblingVal = siblingState?.val === true;
		const payload =
			field === 'lockdown'
				? { lockdown: val, evacuation: siblingVal }
				: { lockdown: siblingVal, evacuation: val };
		try {
			await this.http.setEmergencyStatus(payload);
			await this.setState(`doors.emergency.${field}`, { val, ack: true });
			this.log.info(`Emergency status: lockdown=${payload.lockdown}, evacuation=${payload.evacuation}`);
		} catch (err) {
			this.log.warn(`Set emergency status failed: ${(err as Error).message}`);
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

	private async handleDoorUnlock(safeDoorId: string): Promise<void> {
		if (!this.http) {
			return;
		}
		if (!this.doorNameCache.has(safeDoorId)) {
			this.log.debug(`[unlock] ignoring unlock for unknown door id: ${safeDoorId}`);
			return;
		}
		const cfg = this.config;
		const minutes = Math.max(0, Math.floor(cfg.defaultUnlockDuration || 0));
		const actorId = cfg.unlockActorId || '';
		const actor = actorId ? { id: actorId, name: this.userNameCache.get(actorId) ?? actorId } : undefined;
		try {
			if (minutes > 0) {
				await this.http.setDoorLockRule(safeDoorId, { type: 'custom', interval: minutes });
				this.log.info(`Door ${safeDoorId} unlocked for ${minutes} min via lock_rule.`);
			} else {
				await this.http.unlockDoor(safeDoorId, actor);
				this.log.info(`Door ${safeDoorId} unlocked (pulse).`);
			}
			await this.setState(`doors.${safeDoorId}.unlock`, { val: true, ack: true });
			await this.setState(`doors.${safeDoorId}.locked`, { val: false, ack: true });
			const resetMs = minutes > 0 ? minutes * 60 * 1000 : 5000;
			this.setTimeout(() => {
				void this.setState(`doors.${safeDoorId}.locked`, { val: true, ack: true });
			}, resetMs);
		} catch (err) {
			this.log.warn(`Unlock door ${safeDoorId} failed: ${(err as Error).message}`);
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
		const actorId = this.config.unlockActorId || '';
		const actor = actorId ? { id: actorId, name: this.userNameCache.get(actorId) ?? actorId } : undefined;
		try {
			if (minutes > 0) {
				await this.http.setDoorLockRule(safeDoorId, { type: 'custom', interval: minutes });
				this.log.info(`Door ${safeDoorId} unlocked for ${minutes} min via lock_rule.`);
			} else {
				await this.http.unlockDoor(safeDoorId, actor);
				this.log.info(`Door ${safeDoorId} unlocked (pulse) via unlock_duration.`);
			}
			await this.setState(`doors.${safeDoorId}.unlock_duration`, { val: minutes, ack: true });
			await this.setState(`doors.${safeDoorId}.locked`, { val: false, ack: true });
			const resetMs = minutes > 0 ? minutes * 60 * 1000 : 5000;
			this.setTimeout(() => {
				void this.setState(`doors.${safeDoorId}.locked`, { val: true, ack: true });
			}, resetMs);
		} catch (err) {
			this.log.warn(`Unlock door ${safeDoorId} (duration) failed: ${(err as Error).message}`);
		}
	}

	private async handleDoorLockRule(safeDoorId: string, ruleIndex: number): Promise<void> {
		if (!this.http) {
			return;
		}
		if (!this.doorNameCache.has(safeDoorId)) {
			this.log.debug(`[lock_rule] ignoring unknown door id: ${safeDoorId}`);
			return;
		}
		const ruleMap: Record<number, 'reset' | 'keep_unlock' | 'keep_lock' | 'lock_now'> = {
			0: 'reset',
			1: 'keep_unlock',
			2: 'keep_lock',
			3: 'lock_now',
		};
		const type = ruleMap[ruleIndex];
		if (!type) {
			this.log.warn(`[lock_rule] unknown rule index ${ruleIndex} for door ${safeDoorId}`);
			return;
		}
		try {
			await this.http.setDoorLockRule(safeDoorId, { type });
			this.log.info(`Door ${safeDoorId} lock_rule set to ${type}.`);
			await this.setState(`doors.${safeDoorId}.lock_rule`, { val: ruleIndex, ack: true });
			if (type === 'keep_unlock') {
				await this.setState(`doors.${safeDoorId}.locked`, { val: false, ack: true });
			} else if (type === 'keep_lock' || type === 'lock_now' || type === 'reset') {
				await this.setState(`doors.${safeDoorId}.locked`, { val: true, ack: true });
			}
		} catch (err) {
			this.log.warn(`Set lock_rule for door ${safeDoorId} failed: ${(err as Error).message}`);
		}
	}

	private onMessage(msg: ioBroker.Message): void {
		this.log.debug(`Message: ${JSON.stringify({ command: msg.command })}`);

		if (msg.command === 'getConnectionStatus') {
			this.sendTo(
				msg.from,
				msg.command,
				{
					connected: this.connectedToController,
					lastError: this.lastErrorKind,
					hasToken: !!this.config.apiToken,
					controllerName: this.controllerName,
					webhookRegistered: this.webhookEndpointId !== null && this.webhookSecret !== null,
				},
				msg.callback,
			);
			return;
		}
		if (msg.command === 'listDevices') {
			const devices = Array.from(this.devices.values()).map(d => ({
				id: d.id,
				name: d.name,
				alias: d.alias,
				type: d.type,
				model: d.model,
				firmware: d.firmware,
				online: d.online,
				capabilities: d.capabilities,
				lastSeenAt: d.lastSeenAt,
			}));
			this.sendTo(msg.from, msg.command, { devices }, msg.callback);
			return;
		}
		if (msg.command === 'verifyToken') {
			void this.handleVerifyToken(msg);
			return;
		}
		if (msg.command === 'reregisterWebhook') {
			void this.handleReregisterWebhook(msg);
			return;
		}
		if (msg.command === 'listUsers') {
			if (!this.http) {
				this.sendTo(msg.from, msg.command, { users: [] }, msg.callback);
				return;
			}
			void this.http
				.listUsers()
				.then(users => {
					this.sendTo(
						msg.from,
						msg.command,
						{
							users: users.map(u => ({
								id: u.id,
								name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.user_email || u.id,
							})),
						},
						msg.callback,
					);
				})
				.catch(() => {
					this.sendTo(msg.from, msg.command, { users: [] }, msg.callback);
				});
			return;
		}
		if (msg.command === 'getNetworkInterfaces') {
			const ifaces = networkInterfaces();
			const addresses: string[] = [];
			for (const nets of Object.values(ifaces)) {
				for (const net of nets ?? []) {
					if (net.family === 'IPv4' && !net.internal) {
						addresses.push(net.address);
					}
				}
			}
			this.sendTo(msg.from, msg.command, { addresses }, msg.callback);
			return;
		}
	}

	private async handleVerifyToken(msg: ioBroker.Message): Promise<void> {
		const payload = (msg.message ?? {}) as { host?: string; port?: number; token?: string; verifyTLS?: boolean };
		const host = payload.host ?? '';
		const port = payload.port ?? 12_445;
		const token = payload.token ?? '';
		const verifyTLS = payload.verifyTLS === true;
		if (!host || !token) {
			this.sendTo(msg.from, msg.command, { ok: false, error: 'missing-fields' }, msg.callback);
			return;
		}
		const probe = new UnifiHttp({ host, port, token, verifyTLS });
		try {
			const devices = await probe.listDevices();
			const first = devices[0];
			const name = first?.alias ?? first?.name ?? null;
			this.sendTo(msg.from, msg.command, { ok: true, controllerName: name }, msg.callback);
		} catch (err) {
			this.sendTo(msg.from, msg.command, { ok: false, error: classifyError(err) }, msg.callback);
		}
	}

	private async handleReregisterWebhook(msg: ioBroker.Message): Promise<void> {
		const publicUrl = this.buildWebhookPublicUrl();
		if (!this.http || !publicUrl) {
			this.sendTo(msg.from, msg.command, { ok: false, error: 'not-configured' }, msg.callback);
			return;
		}
		try {
			const result = await reregister(
				{
					http: this.http,
					publicUrl,
					name: `ioBroker.unifi-access (${this.namespace})`,
					events: DEFAULT_WEBHOOK_EVENTS,
					logger: {
						debug: (m: string) => this.log.debug(m),
						info: (m: string) => this.log.info(m),
						warn: (m: string) => this.log.warn(m),
					},
				},
				this.webhookEndpointId,
			);
			this.webhookEndpointId = result.id;
			this.webhookSecret = result.secret;
			await this.persistWebhookCredentials(result.id, result.secret);
			this.sendTo(msg.from, msg.command, { ok: true, id: result.id }, msg.callback);
		} catch (err) {
			this.sendTo(msg.from, msg.command, { ok: false, error: (err as Error).message }, msg.callback);
		}
	}

	private logSystemLogs(ts: number): void {
		if (!this.http) {
			return;
		}
		const http = this.http;
		this.setTimeout(async () => {
			const since = Math.floor(ts / 1000) - 10;
			const until = Math.floor(ts / 1000) + 30;
			for (const topic of ['door_openings', 'all'] as const) {
				try {
					const raw = await http.fetchSystemLogsRaw(topic, since, until);
					this.log.debug(`[system-logs:${topic}] ${JSON.stringify(raw)}`);
					if (topic === 'all') {
						await this.processSystemLogForProtect(raw, ts);
					}
				} catch (err) {
					this.log.warn(`[system-logs:${topic}] fetch failed: ${(err as Error).message}`);
				}
			}
		}, 3000);
	}

	private async processSystemLogForProtect(raw: unknown, eventTs: number): Promise<void> {
		const protect = this.protectHttp;
		if (!this.config.enableProtect || !protect?.isLoggedIn()) {
			this.log.debug(
				`[protect] skipping system log scan: enableProtect=${String(this.config.enableProtect)}, loggedIn=${String(protect?.isLoggedIn() ?? false)}`,
			);
			return;
		}
		const hits = (raw as { data?: { hits?: unknown[] } } | undefined)?.data?.hits;
		if (!Array.isArray(hits)) {
			this.log.debug('[protect] no hits array in system log response');
			return;
		}
		this.log.debug(`[protect] scanning ${hits.length} system log hit(s) for camera events`);

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
				const eventId = parts.length >= 3 ? parts.slice(2).join('_') : undefined;
				if (!cameraId) {
					continue;
				}
				this.log.debug(`[protect] camera event found: cameraId=${cameraId}, eventId=${eventId ?? 'none'}`);

				try {
					const buf = await protect.getSnapshot(cameraId);
					const cacheKey = `${cameraId}:${eventTs}`;
					if (!this.protectSnapshotCache.has(cacheKey)) {
						if (this.protectSnapshotCacheOrder.length >= UnifiAccess.PROTECT_CACHE_MAX) {
							const oldest = this.protectSnapshotCacheOrder.shift()!;
							this.protectSnapshotCache.delete(oldest);
						}
						this.protectSnapshotCacheOrder.push(cacheKey);
						this.protectSnapshotCache.set(cacheKey, buf);
					}

					const base = this.buildServerBaseUrl() ?? '';
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
	}

	private async onUnload(callback: () => void): Promise<void> {
		try {
			this.ws?.stop();
			this.ws = null;
			if (this.bootstrapRetryTimer) {
				this.clearTimeout(this.bootstrapRetryTimer);
				this.bootstrapRetryTimer = undefined;
			}
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
