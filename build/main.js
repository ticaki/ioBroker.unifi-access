"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_unifiHttp = require("./lib/unifiHttp");
var import_protectHttp = require("./lib/protectHttp");
var import_secretMigration = require("./lib/secretMigration");
var import_caCert = require("./lib/caCert");
var import_publicBaseUrl = require("./lib/publicBaseUrl");
var import_tlsErrors = require("./lib/tlsErrors");
var import_unifiWebSocket = require("./lib/unifiWebSocket");
var import_eventNormalizer = require("./lib/eventNormalizer");
var import_library = require("./lib/library");
var import_stopSignal = require("./lib/stopSignal");
var import_snapshotCache = require("./lib/snapshotCache");
var import_deviceModels = require("./lib/deviceModels");
var import_pathSafety = require("./lib/pathSafety");
var import_controlValues = require("./lib/controlValues");
var import_node_os = require("node:os");
var import_node_tls = require("node:tls");
var import_server = require("./webhooks/server");
var import_registration = require("./webhooks/registration");
var import_snapshotEndpoint = require("./webserver/snapshotEndpoint");
var import_protectSnapshotEndpoint = require("./webserver/protectSnapshotEndpoint");
var import_genericWebhookServer = require("./webhooks/genericWebhookServer");
var import_sharedHttpServer = require("./webserver/sharedHttpServer");
const WEBHOOK_PATH = "/unifi-access-webhook";
const DOOR_REFRESH_DEBOUNCE_MS = 2e3;
const DOOR_CHECK_AFTER_COMMAND_MS = 2e3;
const DOOR_CHECK_AFTER_EVENT_MS = 7e3;
const DOORBELL_CALL_MAX_MS = 3 * 6e4;
const RULE_END_CHECK_HORIZON_MS = 24 * 60 * 6e4;
const WEBHOOK_CHECK_INTERVAL_MS = 15 * 6e4;
const RESYNC_MIN_INTERVAL_MS = 6e4;
const RULE_END_TOLERANCE_MS = 5e3;
const TEMPORARY_API_CODES = /* @__PURE__ */ new Set(["CODE_DEVICE_DEVICE_OFFLINE", "CODE_SYSTEM_ERROR", "CODE_DEVICE_DEVICE_BUSY"]);
const UI_SETTINGS_MAX_LENGTH = 1e4;
const STARTUP_WAIT_MS = 8e3;
const STATE_DEPENDENT_COMMANDS = /* @__PURE__ */ new Set([
  "getConnectionStatus",
  "listDevices",
  "listUsers",
  "reregisterWebhook",
  "getServerInfo"
]);
const USER_RELEVANT_EVENTS = /* @__PURE__ */ new Set([
  "access.remote_view",
  "access.remote_view.change",
  "access.data.device.remote_unlock",
  "access.door.unlock",
  "access.doorbell.incoming",
  "access.doorbell.incoming.REN",
  "access.doorbell.completed",
  "access.device.dps_status",
  "access.device.emergency_status",
  "access.unlock_schedule.activate",
  "access.unlock_schedule.deactivate",
  "access.temporary_unlock.start",
  "access.temporary_unlock.end",
  "access.visitor.status.changed"
]);
function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}
function normalizeReconnectDelay(value) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.min(n, 3600) : 5;
}
class UnifiAccess extends utils.Adapter {
  http = null;
  protectHttp = null;
  ws = null;
  library;
  httpServer = null;
  connectedToController = false;
  lastErrorKind = null;
  controllerName = null;
  webhookSecret = null;
  webhookEndpointId = null;
  /** True once the endpoint is known to be registered with the controller in this run. */
  webhookRegistered = false;
  webhookRegistrationRunning = false;
  /** The registration step that is running (check/registration or re-registration), for serialising them. */
  webhookRegistrationTask = null;
  /** The registration was made before a connection outage and has to be checked again. */
  webhookRegistrationStale = false;
  webhookRegistrationFailureLog = "";
  /** The shared HTTP server is listening with the webhook receiver mounted. */
  webhookReceiverActive = false;
  bootstrapRetryTimer;
  bootstrapRunning = false;
  bootstrapRequestedAgain = false;
  bootstrapSucceededOnce = false;
  bootstrapFailures = 0;
  lastBootstrapFailureLog = "";
  connectionStatusWritten = false;
  unloading = false;
  /** Set when the WebSocket closed: the next "open" reloads devices and doors. */
  wsNeedsResync = false;
  wsErrorLogged = false;
  protectRetryTimer;
  protectLoginRunning = false;
  devices = /* @__PURE__ */ new Map();
  userNameCache = /* @__PURE__ */ new Map();
  doorNameCache = /* @__PURE__ */ new Map();
  forwardRules = [];
  /** Camera snapshots of door events for the media endpoint: at most 50 / 32 MiB, oldest dropped first. */
  protectSnapshotCache = new import_snapshotCache.SnapshotCache(
    import_snapshotCache.PROTECT_SNAPSHOT_CACHE_MAX_ENTRIES,
    import_snapshotCache.PROTECT_SNAPSHOT_CACHE_MAX_BYTES
  );
  /** Why TLS could not be activated although it is enabled (null: no problem). */
  tlsError = null;
  // Dedup: access.data.device.remote_unlock (WS) + access.door.unlock (webhook) describe the same action.
  // remote_unlock (no door/user data) is delayed 4 s; if door.unlock arrives in that window,
  // the pending remote_unlock is cancelled and door.unlock (richer data) is pushed instead.
  unlockPendingTimers = /* @__PURE__ */ new Map();
  unlockPendingEvents = /* @__PURE__ */ new Map();
  /**
   * When a granted door.unlock was logged per door (ms epoch): a remote_unlock that arrives after it
   * within the window describes the same action — the order of the two channels is not documented.
   */
  recentDoorUnlocks = /* @__PURE__ */ new Map();
  static UNLOCK_DEDUP_MS = 4e3;
  /** Upper bound of the memory of finished doorbell calls. */
  static FINISHED_DOORBELL_CALLS_MAX = 20;
  /** Last value the adapter acknowledged per control state — what an invalid write is reset to. */
  lastAckedControlValues = /* @__PURE__ */ new Map();
  /** Debounced refresh of all doors (GET /doors). */
  doorRefreshTimer;
  doorRefreshWithLockRules = false;
  /** Pending status checks per door (GET /doors/:id). */
  doorCheckTimers = /* @__PURE__ */ new Map();
  /** False once the controller turned out not to offer GET /doors/:id/lock_rule (route missing). */
  lockRuleSupported = true;
  /** Doors whose lock rule the controller refuses to report (e.g. not bound to a hub) — until the next load. */
  lockRuleUnavailableDoors = /* @__PURE__ */ new Set();
  /** The doorbell call currently published in doorbell.active*. */
  activeDoorbellCall = null;
  /**
   * Request ids of calls that are over (end event seen, time limit, or replaced by a newer call) →
   * when that was noted (ms epoch). A late webhook of such a call must not publish it again.
   */
  finishedDoorbellCalls = /* @__PURE__ */ new Map();
  /** Periodic check that the webhook endpoint is still registered at the controller. */
  webhookCheckInterval;
  /** Start of the last resync after a reconnect (ms epoch, 0 = none yet). */
  lastResyncAt = 0;
  /** A resync that waits for the minimum distance to the previous one. */
  resyncTimer;
  /** Clears the published doorbell call when its end event never arrives. */
  doorbellExpiryTimer;
  /** Emergency flags as last confirmed by the controller (what a failed command is put back to). */
  lastEmergency = {};
  /** Serialises emergency commands (read-modify-write of two flags). */
  emergencyQueue = Promise.resolve();
  /** One check per door at the end of a timed unlock — survives the short checks after later events. */
  doorRuleEndTimers = /* @__PURE__ */ new Map();
  webhookRegistrationRetryTimer;
  webhookRegistrationFailures = 0;
  /** First characters of the ioBroker installation UUID — part of the webhook endpoint name. */
  installationId = "";
  /** Device ids from events that are not in the controller's device list (already looked up once). */
  unknownDeviceIds = /* @__PURE__ */ new Set();
  systemLogFailureLogged = false;
  lastValidUiSettings = "{}";
  /** Legacy system secret: plain-text and encrypted Protect passwords cannot be told apart. */
  protectPasswordUncertain = false;
  /** Resolved when the first attempt to load the controller state is over (successful or not). */
  startup;
  startupFinished = false;
  finishStartup = () => void 0;
  constructor(options = {}) {
    super({
      ...options,
      name: "unifi-access"
    });
    this.startup = new Promise((resolve) => {
      this.finishStartup = () => {
        this.startupFinished = true;
        resolve();
      };
    });
    this.on(
      "ready",
      () => this.onReady().catch((err) => {
        if ((0, import_stopSignal.isStoppedError)(err) || this.unloading) {
          this.log.debug(`Adapter start ended by the stop: ${errorText(err)}`);
          return;
        }
        this.log.error(`Adapter start failed: ${errorText(err)}`);
      }).finally(() => this.finishStartup())
    );
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
    var _a, _b, _c, _d;
    this.library = new import_library.Library(this, () => this.unloading);
    await this.writeState("info.connection", { val: false, ack: true });
    await this.removeObsoleteObjects();
    await this.library.ensureBaseObjects();
    await this.writeState("info.webhookRegistered", { val: false, ack: true });
    await this.writeState("info.protectConnected", { val: false, ack: true });
    await this.clearActiveDoorbellCall();
    await this.loadInstallationId();
    if (this.unloading) {
      return;
    }
    const cfg = this.config;
    const host = (_a = cfg.controllerHost) != null ? _a : "";
    const port = (0, import_controlValues.normalizePort)(cfg.controllerPort, 12445);
    const token = (_b = cfg.apiToken) != null ? _b : "";
    const verifyTLS = cfg.verifyTLS === true;
    const caCert = cfg.caCert || void 0;
    this.forwardRules = Array.isArray(cfg.forwardEvents) ? cfg.forwardEvents : [];
    this.webhookEndpointId = (_c = (0, import_eventNormalizer.asString)(cfg.webhookEndpointId)) != null ? _c : null;
    this.webhookSecret = (_d = (0, import_eventNormalizer.asString)(cfg.webhookSecret)) != null ? _d : null;
    if (!host || !token) {
      this.log.warn("Controller host or API token missing \u2014 open the admin UI to configure.");
      this.setConnectionStatus(false, null);
      return;
    }
    this.checkCaCert();
    const publicBase = (0, import_publicBaseUrl.normalizePublicBaseUrl)(cfg.publicBaseUrl);
    if (publicBase.problem) {
      this.log.warn(
        `The public base URL "${String(cfg.publicBaseUrl)}" is not usable (${publicBase.problem}) \u2014 the URLs are built from the listen address instead.`
      );
    }
    this.http = new import_unifiHttp.UnifiHttp({
      host,
      port,
      token,
      verifyTLS,
      caCert,
      debugLog: (m) => this.log.debug(m),
      isStopped: () => this.unloading
    });
    this.subscribeStates("doors.*.unlock");
    this.subscribeStates("doors.*.unlock_duration");
    this.subscribeStates("doors.*.lock_rule");
    this.subscribeStates("doors.emergency.*");
    this.subscribeStates("admin.uiSettings");
    try {
      const stored = await this.getStateAsync("admin.uiSettings");
      if (typeof (stored == null ? void 0 : stored.val) === "string" && (0, import_eventNormalizer.asRecord)(JSON.parse(stored.val))) {
        this.lastValidUiSettings = stored.val;
      }
    } catch {
    }
    if (this.unloading) {
      return;
    }
    await this.startSharedHttpServer();
    if (this.unloading) {
      return;
    }
    this.startWebhookRegistrationCheck();
    await this.bootstrapAndConnect();
    this.finishStartup();
    if (this.unloading) {
      return;
    }
    await this.initProtect(host, caCert);
  }
  /**
   * Report a CA certificate that cannot be used. Node would ignore it silently and every strict TLS
   * check would fail without a visible reason. Repairable damage (lost line breaks) is repaired by the
   * clients and not reported.
   */
  checkCaCert() {
    const cfg = this.config;
    const { certificates, problems } = (0, import_caCert.parseCaCert)(cfg.caCert);
    if (problems.length === 0) {
      return;
    }
    const text = `The CA certificate in the connection settings is ${certificates.length > 0 ? "partly " : ""}not usable: ${problems.join("; ")}. ${certificates.length > 0 ? `Only ${certificates.length} certificate(s) are trusted.` : "It is ignored."} Paste the complete PEM text including the "-----BEGIN CERTIFICATE-----" and "-----END CERTIFICATE-----" lines.`;
    const used = cfg.verifyTLS === true || cfg.enableProtect === true && cfg.protectVerifyTLS === true;
    if (used) {
      this.log.warn(text);
    } else {
      this.log.debug(text);
    }
  }
  /** Read the first characters of the installation UUID (part of the webhook endpoint name). */
  async loadInstallationId() {
    var _a;
    try {
      const meta = await this.getForeignObjectAsync("system.meta.uuid");
      const uuid = (0, import_eventNormalizer.asString)((_a = meta == null ? void 0 : meta.native) == null ? void 0 : _a.uuid);
      this.installationId = uuid ? uuid.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) : "";
    } catch {
      this.installationId = "";
    }
  }
  /**
   * Set up the optional UniFi Protect client (camera snapshots for door events).
   *
   * @param host Console host (the same host as UniFi Access)
   * @param caCert CA certificate from the connection settings
   */
  async initProtect(host, caCert) {
    const cfg = this.config;
    if (cfg.enableProtect !== true) {
      this.log.debug("[protect] integration disabled");
      return;
    }
    if (!cfg.protectUsername) {
      this.log.warn("[protect] integration enabled but no username configured \u2014 skipping");
      return;
    }
    const password = await this.resolveProtectPassword();
    if (this.unloading) {
      return;
    }
    this.protectHttp = new import_protectHttp.ProtectHttp({
      host,
      port: (0, import_controlValues.normalizePort)(cfg.protectPort, 443),
      username: cfg.protectUsername,
      password,
      // exactly as configured — there is no silent fallback to an unverified connection
      verifyTLS: cfg.protectVerifyTLS === true,
      caCert,
      isStopped: () => this.unloading
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
  async resolveProtectPassword() {
    var _a, _b;
    const decrypted = typeof this.config.protectPassword === "string" ? this.config.protectPassword : "";
    const instanceId = `system.adapter.${this.namespace}`;
    let instance;
    try {
      instance = await this.getForeignObjectAsync(instanceId);
    } catch (err) {
      this.log.debug(`[protect] could not read the instance object: ${errorText(err)}`);
    }
    if (!instance) {
      return decrypted;
    }
    const encryptedNative = instance.encryptedNative;
    const stored = (0, import_secretMigration.classifyStoredSecret)({
      raw: (_a = instance.native) == null ? void 0 : _a.protectPassword,
      decrypted,
      isEncryptedAttribute: Array.isArray(encryptedNative) && encryptedNative.includes("protectPassword"),
      encrypt: (plain) => this.encrypt(plain)
    });
    if (stored.kind === "plaintext") {
      this.throwIfStopped();
      this.log.info("[protect] the stored Protect password is not encrypted yet \u2014 encrypting it now.");
      try {
        this.throwIfStopped();
        await this.extendForeignObjectAsync(instanceId, { native: { protectPassword: stored.encrypted } });
      } catch (err) {
        if ((0, import_stopSignal.isStoppedError)(err)) {
          throw err;
        }
        this.log.warn(`[protect] could not store the encrypted Protect password: ${errorText(err)}`);
      }
    } else if (stored.kind === "ambiguous") {
      this.protectPasswordUncertain = true;
    } else if (stored.kind === "encrypted") {
      const raw = (_b = instance.native) == null ? void 0 : _b.protectPassword;
      this.protectPasswordUncertain = typeof raw === "string" && !raw.startsWith("$/aes-192-cbc:");
    }
    return stored.password;
  }
  async tryProtectLogin(attempt) {
    const protect = this.protectHttp;
    if (!protect || this.protectLoginRunning || this.unloading) {
      return;
    }
    this.protectLoginRunning = true;
    try {
      await protect.login();
      this.protectLoginRunning = false;
      if (this.unloading) {
        this.protectHttp = null;
        return;
      }
      this.log.info(attempt === 1 ? "UniFi Protect API client initialized" : "Protect login retry succeeded.");
      await this.writeState("info.protectConnected", { val: true, ack: true });
      return;
    } catch (err) {
      this.protectLoginRunning = false;
      if (this.unloading) {
        this.protectHttp = null;
        return;
      }
      const kind = (0, import_protectHttp.classifyProtectError)(err);
      if (kind === "tls") {
        const code = (0, import_tlsErrors.tlsCertificateErrorCode)(err);
        this.log.warn(
          `Protect login failed: the TLS certificate of the console was rejected (${code}). ${(0, import_tlsErrors.tlsAdvice)(code, "protect")} The Protect integration stays off until the instance is restarted.`
        );
        this.protectHttp = null;
      } else if (kind === "credentials") {
        this.log.warn(
          `Protect login failed: user name or password rejected.${this.protectPasswordUncertain ? " The password was saved by an earlier adapter version and may need to be entered again: open the instance settings, re-enter the Protect password and save." : ""} The Protect integration stays off until the instance is restarted.`
        );
        this.protectHttp = null;
      } else {
        const delayMs = Math.min(3e4 * 2 ** Math.min(attempt - 1, 10), 10 * 6e4);
        const text = `Protect login failed (${kind}): ${errorText(err)} \u2014 retrying in ${Math.round(delayMs / 1e3)} s.`;
        if (attempt === 1) {
          this.log.warn(text);
        } else {
          this.log.debug(text);
        }
        this.protectRetryTimer = this.startTimer(() => {
          this.protectRetryTimer = void 0;
          this.tryProtectLogin(attempt + 1).catch((e) => {
            this.log.debug(`Protect login retry failed unexpectedly: ${errorText(e)}`);
          });
        }, delayMs);
      }
    }
    await this.writeState("info.protectConnected", { val: false, ack: true });
  }
  requireProtect() {
    if (!this.protectHttp) {
      throw new Error("UniFi Protect is not connected");
    }
    return this.protectHttp;
  }
  /**
   * Load key and certificate for the built-in HTTP server from the ioBroker certificate store.
   *
   * @returns The TLS options, or `undefined` when TLS is off or the certificates are not usable. In
   * the latter case the reason is logged as error and kept in `tlsError`; the server is then not
   * started at all (fail closed — no silent fall-back to plain http).
   */
  async loadTlsOptions() {
    var _a, _b;
    const cfg = this.config;
    this.tlsError = null;
    if (cfg.enableTls !== true) {
      return void 0;
    }
    try {
      const [certificates] = await this.getCertificatesAsync(cfg.certPublic, cfg.certPrivate, cfg.certChained);
      const key = (0, import_eventNormalizer.asString)(certificates == null ? void 0 : certificates.key);
      let cert = (0, import_eventNormalizer.asString)(certificates == null ? void 0 : certificates.cert);
      const chain = (0, import_eventNormalizer.asString)(certificates == null ? void 0 : certificates.ca);
      if (!key || !cert) {
        throw new Error("certificate or private key is empty");
      }
      if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key) || !cert.includes("-----BEGIN CERTIFICATE-----")) {
        throw new Error("certificate or private key is not in PEM format");
      }
      if (chain && chain.includes("-----BEGIN CERTIFICATE-----") && !cert.includes(chain.trim())) {
        cert = `${cert.trim()}
${chain.trim()}
`;
      }
      (0, import_node_tls.createSecureContext)({ key, cert });
      return { key, cert };
    } catch (err) {
      this.tlsError = errorText(err);
      this.log.error(
        `TLS is enabled for the built-in HTTP server, but the certificates (public "${(_a = cfg.certPublic) != null ? _a : ""}", private "${(_b = cfg.certPrivate) != null ? _b : ""}") could not be loaded: ${this.tlsError}. The server is NOT started (no fall-back to plain http): webhook receiver, thumbnail server and generic webhook are unavailable and no webhook URL is registered. Select valid certificates in the instance settings or disable TLS.`
      );
      return void 0;
    }
  }
  /**
   * Base URL of the built-in HTTP server as clients and the controller reach it. The scheme is taken
   * from the running server — never from the configuration — and there is no URL while the server
   * is not listening.
   */
  buildServerBaseUrl() {
    const server = this.httpServer;
    if (!(server == null ? void 0 : server.listening)) {
      return null;
    }
    const configured = this.publicBaseUrl();
    if (configured) {
      return configured;
    }
    const cfg = this.config;
    const port = (0, import_controlValues.normalizePort)(cfg.listenPort, 8095);
    const scheme = server.scheme;
    if (cfg.listenIp && cfg.listenIp !== "0.0.0.0") {
      return `${scheme}://${cfg.listenIp}:${port}`;
    }
    const ifaces = (0, import_node_os.networkInterfaces)();
    for (const iface of Object.values(ifaces)) {
      for (const addr of iface != null ? iface : []) {
        if (addr.family === "IPv4" && !addr.internal) {
          return `${scheme}://${addr.address}:${port}`;
        }
      }
    }
    return null;
  }
  /** The normalised `publicBaseUrl` setting, or null when it is empty (or unusable — warned at start). */
  publicBaseUrl() {
    return (0, import_publicBaseUrl.normalizePublicBaseUrl)(this.config.publicBaseUrl).url;
  }
  buildWebhookPublicUrl() {
    const base = this.buildServerBaseUrl();
    return base ? `${base}${WEBHOOK_PATH}` : null;
  }
  async startSharedHttpServer() {
    var _a;
    const cfg = this.config;
    const port = (0, import_controlValues.normalizePort)(cfg.listenPort, 8095);
    const ip = cfg.listenIp && cfg.listenIp !== "0.0.0.0" ? cfg.listenIp : void 0;
    const tls = await this.loadTlsOptions();
    if (this.unloading) {
      return;
    }
    if (cfg.enableTls === true && !tls) {
      this.httpServer = null;
      return;
    }
    const logger = this.helperLogger();
    const server = new import_sharedHttpServer.SharedHttpServer({ port, ip, tls, logger });
    let webhookHandlerMounted = false;
    if (cfg.enableWebhooks === true) {
      if (!this.http) {
        this.log.warn("Webhook receiver not enabled: no HTTP client.");
      } else {
        const handler = new import_server.WebhookHandler({
          path: WEBHOOK_PATH,
          secret: () => this.webhookSecret,
          logger,
          onEvent: (env) => this.handleAccessEvent(env, "webhook")
        });
        server.registerHandler("unifi-webhook", handler.matches, handler.handle);
        webhookHandlerMounted = true;
      }
    }
    if (cfg.enableThumbnailServer === true) {
      const handler = new import_snapshotEndpoint.ThumbnailHandler({
        pathPrefix: `/unifi-access/${this.instance}/thumbnail`,
        http: () => this.http,
        resolvePath: async (deviceId) => {
          const state = await this.getStateAsync(`devices.${this.safeId(deviceId)}.lastThumbnailPath`);
          return typeof (state == null ? void 0 : state.val) === "string" && state.val ? state.val : null;
        },
        logger
      });
      server.registerHandler("thumbnail", handler.matches, handler.handle);
    }
    if (cfg.enableProtect === true && cfg.protectUsername) {
      const snapshotPrefix = `/unifi-access/${this.instance}/protect-snapshot`;
      const videoPrefix = `/unifi-access/${this.instance}/protect-video`;
      const protect = {
        getEventMeta: (eventId) => this.requireProtect().getEventMeta(eventId),
        getClipStream: (clipPath) => this.requireProtect().getClipStream(clipPath)
      };
      const protectHandler = new import_protectSnapshotEndpoint.ProtectMediaHandler({
        snapshotPathPrefix: snapshotPrefix,
        videoPathPrefix: videoPrefix,
        getSnapshot: (cameraId, ts) => this.protectSnapshotCache.get(`${cameraId}:${ts}`),
        getEventMeta: (eventId) => protect.getEventMeta(eventId),
        // streamed: a clip is passed on chunk by chunk instead of being held in memory
        fetchClip: (clipPath) => protect.getClipStream(clipPath),
        logger
      });
      server.registerHandler("protect-media", protectHandler.matches, protectHandler.handle);
    }
    if (cfg.enableGenericWebhook === true) {
      const handler = new import_genericWebhookServer.GenericWebhookHandler({
        path: cfg.genericWebhookPath,
        auth: cfg.genericWebhookAuth || "none",
        username: cfg.genericWebhookUsername || void 0,
        password: cfg.genericWebhookPassword || void 0,
        token: cfg.genericWebhookToken || void 0,
        logger,
        onRequest: async ({ body, method, url }) => {
          const raw = body.toString("utf8");
          this.log.debug(`[generic-webhook] ${method} ${url} | body: ${raw.slice(0, 2e3)}`);
          let payload;
          try {
            payload = JSON.parse(raw);
          } catch {
            this.log.debug("[generic-webhook] body is not valid JSON \u2014 skipping state update");
            return;
          }
          await this.handleGenericAlarm(payload, raw);
        }
      });
      if (handler.path !== cfg.genericWebhookPath) {
        this.log.debug(
          `Generic webhook listens on ${handler.path} (setting: "${(_a = cfg.genericWebhookPath) != null ? _a : ""}").`
        );
      }
      const owner = (0, import_genericWebhookServer.reservedWebhookPathOwner)(handler.path);
      if (owner) {
        this.log.error(
          `Generic webhook NOT started: its path "${handler.path}" is reserved for ${owner} of this adapter \u2014 requests there would never reach the generic webhook. Choose another path (e.g. /webhook) on the generic webhook tab.`
        );
      } else if (!handler.credentialsConfigured) {
        this.log.warn(
          `Generic webhook: authentication "${cfg.genericWebhookAuth}" is selected but no ${cfg.genericWebhookAuth === "basic" ? "user name and password are" : "token is"} configured \u2014 every request will be rejected.`
        );
      }
      if (!owner) {
        server.registerHandler("generic-webhook", handler.matches, handler.handle);
      }
    }
    if (server.handlerCount === 0) {
      this.log.debug("No receiver enabled \u2014 the built-in HTTP server is not started.");
      this.httpServer = null;
      return;
    }
    try {
      await server.start();
      if (this.unloading) {
        await server.stop();
        return;
      }
      this.httpServer = server;
      this.webhookReceiverActive = webhookHandlerMounted;
    } catch (err) {
      this.log.warn(`Shared HTTP server failed to start: ${err.message}`);
      this.httpServer = null;
      return;
    }
  }
  /**
   * Name of this installation's webhook endpoint on the controller. It contains the ioBroker host
   * name: two installations at the same controller (e.g. production and a dev-server, both with
   * instance 0) get different names and never clean up each other's endpoint.
   */
  webhookEndpointName() {
    const installation = this.installationId ? `#${this.installationId}` : "";
    return `ioBroker.unifi-access (${this.namespace}@${this.host || "iobroker"}${installation})`;
  }
  registrationLogger() {
    return this.helperLogger();
  }
  /**
   * Register the webhook endpoint with the controller unless that already happened. Called when the
   * receiver is listening and again after every successful (re)load of the controller state, so a
   * registration that failed because the controller was not reachable at start is made up for.
   */
  async ensureWebhookRegistration() {
    if (this.config.enableWebhooks !== true || !this.http || !this.webhookReceiverActive || this.webhookRegistered && !this.webhookRegistrationStale || this.webhookRegistrationRunning || this.unloading) {
      return;
    }
    if (!this.bootstrapSucceededOnce) {
      this.log.debug("Webhook registration postponed until the controller is reachable.");
      return;
    }
    const publicUrl = this.buildWebhookPublicUrl();
    if (!publicUrl) {
      if (!this.webhookRegistrationFailureLog) {
        this.webhookRegistrationFailureLog = "no-address";
        this.log.warn("Webhook registration skipped: no usable network address found.");
      }
      return;
    }
    this.webhookRegistrationRunning = true;
    let done = () => void 0;
    this.webhookRegistrationTask = new Promise((resolve) => done = resolve);
    try {
      const storedId = this.webhookEndpointId;
      const storedSecret = this.webhookSecret;
      const result = await (0, import_registration.ensureRegistration)({
        http: this.http,
        publicUrl,
        name: this.webhookEndpointName(),
        storedId,
        storedSecret,
        events: import_registration.DEFAULT_WEBHOOK_EVENTS,
        logger: this.registrationLogger(),
        isStopped: () => this.unloading
      });
      this.webhookEndpointId = result.id;
      this.webhookSecret = result.secret;
      const changed = result.id !== storedId || result.secret !== storedSecret;
      if (this.unloading) {
        if (changed) {
          await this.persistWebhookCredentials(result.id, result.secret);
        }
        return;
      }
      this.webhookRegistered = true;
      this.webhookRegistrationStale = false;
      this.webhookRegistrationFailureLog = "";
      await this.writeState("info.webhookRegistered", { val: true, ack: true });
      if (changed) {
        await this.persistWebhookCredentials(result.id, result.secret);
      }
      this.webhookRegistrationFailures = 0;
    } catch (err) {
      if ((0, import_stopSignal.isStoppedError)(err) || this.unloading) {
        this.log.debug(`Webhook registration ended by the stop: ${errorText(err)}`);
        return;
      }
      const text = `Webhook registration failed: ${errorText(err)}`;
      if (text !== this.webhookRegistrationFailureLog) {
        this.webhookRegistrationFailureLog = text;
        this.log.warn(text);
      } else {
        this.log.debug(text);
      }
      this.webhookRegistered = false;
      await this.writeState("info.webhookRegistered", { val: false, ack: true });
      this.scheduleWebhookRegistrationRetry();
    } finally {
      this.webhookRegistrationRunning = false;
      this.webhookRegistrationTask = null;
      done();
    }
  }
  /**
   * Check the registration at the controller every {@link WEBHOOK_CHECK_INTERVAL_MS} while the receiver
   * runs: the endpoint may be deleted at the controller (by hand, restored backup, another integration)
   * or the address of this host may change without the WebSocket ever dropping. An endpoint that is
   * still in place costs one GET; nothing is written to the instance configuration then, so the check
   * can never cause a restart loop.
   */
  startWebhookRegistrationCheck() {
    if (this.config.enableWebhooks !== true || !this.webhookReceiverActive || this.webhookCheckInterval || this.unloading) {
      return;
    }
    this.webhookCheckInterval = this.startInterval(() => {
      if (this.unloading || !this.connectedToController || this.webhookRegistrationRunning) {
        return;
      }
      this.webhookRegistrationStale = true;
      this.runDetached("webhook registration check", this.ensureWebhookRegistration());
    }, WEBHOOK_CHECK_INTERVAL_MS);
  }
  /**
   * Try the webhook registration again later (60 s, 2 min, 4 min, then every 5 min). Without this a
   * single failed request would leave the webhooks off until the next reconnect or restart.
   */
  scheduleWebhookRegistrationRetry() {
    if (this.unloading || this.webhookRegistrationRetryTimer) {
      return;
    }
    this.webhookRegistrationFailures += 1;
    const delayMs = Math.min(6e4 * 2 ** Math.min(this.webhookRegistrationFailures - 1, 6), 5 * 6e4);
    this.webhookRegistrationRetryTimer = this.startTimer(() => {
      this.webhookRegistrationRetryTimer = void 0;
      this.runDetached("webhook registration", this.ensureWebhookRegistration());
    }, delayMs);
  }
  /**
   * Load devices, doors and users from the controller and mirror them into objects and states.
   *
   * @returns false when the controller could not be queried (logged, connection status set)
   */
  async loadControllerState() {
    var _a;
    if (!this.http) {
      return false;
    }
    try {
      const [allDevices, allDoors, allUsers] = await Promise.all([
        this.http.listDevices(),
        this.http.listDoors(),
        this.http.listUsers().catch(() => [])
      ]);
      const hasId = (entry) => typeof (entry == null ? void 0 : entry.id) === "string" && entry.id !== "";
      const devices = allDevices.filter(hasId);
      const doors = allDoors.filter(hasId);
      const users = allUsers.filter(hasId);
      this.userNameCache.clear();
      for (const u of users) {
        const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.user_email || u.id;
        this.userNameCache.set(u.id, name);
      }
      await this.applyBootstrap({ devices, doors });
      await this.refreshEmergencyStatus();
      this.lockRuleSupported = true;
      this.lockRuleUnavailableDoors.clear();
      for (const door of doors) {
        await this.refreshLockRule(door.id);
      }
      this.throwIfStopped();
      if (this.bootstrapFailures > 0 || !this.bootstrapSucceededOnce) {
        this.log.info(
          `Connected to UniFi Access controller. ${devices.length} devices, ${doors.length} doors.`
        );
      } else {
        this.log.debug(`Controller state refreshed: ${devices.length} devices, ${doors.length} doors.`);
      }
      if (!this.bootstrapSucceededOnce) {
        await this.refreshThumbnailUrls();
      }
      this.bootstrapSucceededOnce = true;
      this.bootstrapFailures = 0;
      this.lastBootstrapFailureLog = "";
      return true;
    } catch (err) {
      if ((0, import_stopSignal.isStoppedError)(err) || this.unloading) {
        return false;
      }
      const kind = (0, import_unifiHttp.classifyError)(err);
      this.setConnectionStatus(false, kind);
      this.bootstrapFailures += 1;
      const axErr = err;
      const tlsCode = (0, import_tlsErrors.tlsCertificateErrorCode)(err);
      let text;
      if (tlsCode) {
        text = `Bootstrap failed: the TLS certificate of the controller was rejected (${tlsCode}). ${(0, import_tlsErrors.tlsAdvice)(tlsCode, "controller")}`;
      } else if (((_a = axErr.response) == null ? void 0 : _a.status) === 404) {
        text = `Bootstrap failed: 404 \u2014 verify that host and port point to a UniFi Access controller (${this.http.url}).`;
      } else {
        text = `Bootstrap failed (${kind}): ${errorText(err)}`;
      }
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
  async bootstrapAndConnect() {
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
      this.bootstrapRetryTimer = void 0;
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
      await this.ensureWebhookRegistration();
    } finally {
      this.bootstrapRunning = false;
      if (this.bootstrapRequestedAgain && !this.unloading) {
        this.bootstrapRequestedAgain = false;
        this.runDetached("controller refresh", this.bootstrapAndConnect());
      }
    }
  }
  /** Delay before the next bootstrap attempt: 30 s, 60 s, 120 s, then every 5 min (rejected token: always 5 min). */
  nextBootstrapRetryDelay() {
    if (this.lastErrorKind === "unauthorized") {
      return 5 * 6e4;
    }
    return Math.min(3e4 * 2 ** Math.max(0, Math.min(this.bootstrapFailures - 1, 6)), 5 * 6e4);
  }
  scheduleBootstrapRetry() {
    if (this.unloading) {
      return;
    }
    if (this.bootstrapRetryTimer) {
      this.clearTimeout(this.bootstrapRetryTimer);
    }
    const delayMs = this.nextBootstrapRetryDelay();
    this.log.debug(`Next bootstrap attempt in ${Math.round(delayMs / 1e3)} s.`);
    this.bootstrapRetryTimer = this.startTimer(() => {
      this.bootstrapRetryTimer = void 0;
      this.runDetached("bootstrap retry", this.bootstrapAndConnect());
    }, delayMs);
  }
  async applyBootstrap(data) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i;
    await this.library.applyBootstrap(data);
    const previous = new Map(this.devices);
    this.devices.clear();
    this.doorNameCache.clear();
    for (const d of data.doors) {
      this.doorNameCache.set(d.id, (_b = (_a = d.name) != null ? _a : d.full_name) != null ? _b : d.id);
    }
    if (data.devices.length > 0) {
      this.log.debug(`[bootstrap] first device payload keys: ${Object.keys(data.devices[0]).join(", ")}`);
    }
    for (const d of data.devices) {
      const model = (0, import_deviceModels.detectModel)(d.type, d.type);
      this.devices.set(d.id, {
        id: d.id,
        name: (_d = (_c = d.name) != null ? _c : d.alias) != null ? _d : d.id,
        alias: d.alias,
        type: d.type,
        model,
        firmware: typeof d.firmware === "string" && d.firmware || ((_e = previous.get(d.id)) == null ? void 0 : _e.firmware),
        // Only an explicit `online: false` means offline; if the field is missing the
        // device is at least known to the controller, so default to online.
        online: d.online !== false,
        capabilities: (0, import_deviceModels.featuresFor)(model),
        lastSeenAt: (_f = previous.get(d.id)) == null ? void 0 : _f.lastSeenAt
      });
    }
    const first = data.devices[0];
    this.controllerName = (_h = (_g = first == null ? void 0 : first.alias) != null ? _g : first == null ? void 0 : first.name) != null ? _h : null;
    if (this.config.enableProtect) {
      const connected = ((_i = this.protectHttp) == null ? void 0 : _i.isLoggedIn()) === true;
      await this.writeState("info.protectConnected", { val: connected, ack: true });
      this.log.debug(`[protect] info.protectConnected = ${String(connected)}`);
    }
  }
  /** The adapter's timer functions for helper classes (tracked by js-controller, cleared on unload). */
  timerHost() {
    return {
      setTimeout: (callback, ms) => this.startTimer(callback, ms),
      clearTimeout: (handle) => this.clearTimeout(handle),
      setInterval: (callback, ms) => this.startInterval(callback, ms),
      clearInterval: (handle) => this.clearInterval(handle)
    };
  }
  /**
   * Reload devices and doors after a reconnect — at most once per {@link RESYNC_MIN_INTERVAL_MS}. A
   * connection that keeps flapping would otherwise trigger a full load (devices, doors, all user
   * pages, emergency status, one lock rule per door) every few seconds.
   */
  requestResync() {
    if (this.resyncTimer || this.unloading) {
      return;
    }
    const waitMs = this.lastResyncAt + RESYNC_MIN_INTERVAL_MS - Date.now();
    if (this.lastResyncAt === 0 || waitMs <= 0) {
      this.lastResyncAt = Date.now();
      this.log.info("UniFi Access WebSocket reconnected \u2014 refreshing devices and doors.");
      this.runDetached("resync after reconnect", this.bootstrapAndConnect());
      return;
    }
    this.log.debug(
      `UniFi Access WebSocket reconnected \u2014 refreshing devices and doors in ${Math.ceil(waitMs / 1e3)} s.`
    );
    this.resyncTimer = this.startTimer(() => {
      this.resyncTimer = void 0;
      this.lastResyncAt = Date.now();
      this.runDetached("resync after reconnect", this.bootstrapAndConnect());
    }, waitMs);
  }
  startWebSocket() {
    var _a, _b, _c;
    const cfg = this.config;
    const host = (_a = cfg.controllerHost) != null ? _a : "";
    const port = (0, import_controlValues.normalizePort)(cfg.controllerPort, 12445);
    const token = (_b = cfg.apiToken) != null ? _b : "";
    const verifyTLS = cfg.verifyTLS === true;
    const caCert = cfg.caCert || void 0;
    (_c = this.ws) == null ? void 0 : _c.stop();
    this.wsNeedsResync = false;
    this.wsErrorLogged = false;
    const ws = new import_unifiWebSocket.UnifiWebSocket({
      host,
      port,
      token,
      verifyTLS,
      caCert,
      reconnectDelaySeconds: normalizeReconnectDelay(cfg.wsReconnectDelay),
      timers: this.timerHost(),
      logger: {
        debug: (m) => this.log.debug(m),
        info: (m) => this.log.info(m),
        warn: (m) => this.log.warn(m)
      }
    });
    this.ws = ws;
    ws.on("open", () => {
      if (this.ws !== ws || this.unloading) {
        return;
      }
      this.wsErrorLogged = false;
      this.setConnectionStatus(true, null);
      if (this.wsNeedsResync) {
        this.wsNeedsResync = false;
        this.webhookRegistrationStale = true;
        this.requestResync();
      } else {
        this.log.info("UniFi Access WebSocket open.");
      }
    });
    ws.on("close", () => {
      if (this.ws !== ws || this.unloading) {
        return;
      }
      if (this.connectedToController) {
        this.log.info("UniFi Access WebSocket closed \u2014 connection to the controller lost.");
      } else {
        this.log.debug("UniFi Access WebSocket closed.");
      }
      this.wsNeedsResync = true;
      this.setConnectionStatus(false, "network");
    });
    ws.on("error", (err) => {
      if (!this.wsErrorLogged) {
        this.wsErrorLogged = true;
        this.log.warn(`WebSocket error: ${err.message}`);
      } else {
        this.log.debug(`WebSocket error: ${err.message}`);
      }
    });
    ws.on("event", (msg) => {
      if (this.ws !== ws || this.unloading) {
        return;
      }
      this.runDetached("WebSocket event", this.handleAccessEvent(msg, "ws"));
    });
    ws.start();
  }
  /**
   * Remove objects of earlier adapter versions. `info.webhookSecret` held the webhook signing secret
   * in clear text, readable by everything that may read states — the secret now lives only in the
   * encrypted instance configuration.
   */
  async removeObsoleteObjects() {
    for (const id of ["info.webhookSecret"]) {
      try {
        if (await this.getObjectAsync(id)) {
          this.throwIfStopped();
          await this.delObjectAsync(id);
          this.log.info(`Removed obsolete state ${id}.`);
        }
        this.throwIfStopped();
        await this.delStateAsync(id);
      } catch (err) {
        if ((0, import_stopSignal.isStoppedError)(err)) {
          throw err;
        }
        this.log.debug(`Could not remove obsolete state ${id}: ${errorText(err)}`);
      }
    }
  }
  /**
   * Store id and secret of the endpoint the controller has created. The one write that is still made
   * after the stop: the endpoint exists at the controller, and only with its secret do the webhooks of
   * the next start pass the signature check.
   *
   * @param id Endpoint id
   * @param secret Signing secret of the endpoint
   */
  async persistWebhookCredentials(id, secret) {
    await this.setState("info.webhookEndpointId", { val: id, ack: true });
    await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
      native: { webhookEndpointId: id, webhookSecret: this.encrypt(secret) }
    });
  }
  async handleAccessEvent(msg, source) {
    const parsed = (0, import_eventNormalizer.parseAccessEvent)(msg, source, Date.now());
    if (!parsed) {
      this.log.debug(`Ignoring ${source} message that is not an event envelope.`);
      return;
    }
    const { event } = parsed;
    if (parsed.thumbnailPathRejected) {
      this.log.warn(`Ignoring invalid thumbnail path in ${event.type} event.`);
    }
    if (USER_RELEVANT_EVENTS.has(event.type)) {
      if (event.type === "access.data.device.remote_unlock" && event.doorId) {
        const doorId = event.doorId;
        const loggedAt = this.recentDoorUnlocks.get(doorId);
        this.recentDoorUnlocks.delete(doorId);
        if (loggedAt !== void 0 && Math.abs(Date.now() - loggedAt) < UnifiAccess.UNLOCK_DEDUP_MS) {
          this.log.debug(`[event] remote_unlock for doorId=${doorId}: already logged as access.door.unlock`);
        } else {
          this.deferRemoteUnlock(doorId, event);
        }
      } else if (event.type === "access.door.unlock" && event.doorId) {
        const doorId = event.doorId;
        if (event.granted !== false) {
          const t = this.unlockPendingTimers.get(doorId);
          if (t) {
            this.clearTimeout(t);
            this.unlockPendingTimers.delete(doorId);
            this.unlockPendingEvents.delete(doorId);
          } else {
            this.recentDoorUnlocks.set(doorId, Date.now());
          }
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
  /**
   * Log a remote_unlock only after {@link UnifiAccess.UNLOCK_DEDUP_MS}: the door.unlock webhook of the
   * same action may follow with richer data (door name, user) and then replaces it.
   *
   * @param doorId Door of the event
   * @param event The remote_unlock event
   */
  deferRemoteUnlock(doorId, event) {
    const existing = this.unlockPendingTimers.get(doorId);
    if (existing) {
      this.clearTimeout(existing);
    }
    this.unlockPendingEvents.set(doorId, event);
    const t = this.startTimer(() => {
      this.unlockPendingTimers.delete(doorId);
      const pending = this.unlockPendingEvents.get(doorId);
      if (pending) {
        this.unlockPendingEvents.delete(doorId);
        this.runDetached("event log", this.library.pushEvent(pending));
      }
    }, UnifiAccess.UNLOCK_DEDUP_MS);
    if (t) {
      this.unlockPendingTimers.set(doorId, t);
    }
  }
  async dispatchEvent(parsed) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i;
    const { event } = parsed;
    switch (event.type) {
      case "access.remote_view": {
        const callId = (_a = (0, import_eventNormalizer.asString)(event.raw.event_object_id)) != null ? _a : parsed.requestId;
        await this.setActiveDoorbellCall(
          callId != null ? callId : null,
          parsed.requestId,
          (_d = (_c = (_b = event.doorName) != null ? _b : event.deviceName) != null ? _c : event.deviceId) != null ? _d : null,
          event.ts,
          true
        );
        await this.storeEventThumbnail(event);
        break;
      }
      case "access.remote_view.change":
        if (parsed.reasonCode !== void 0 && parsed.reasonCode in import_eventNormalizer.DOORBELL_REASONS) {
          await this.endDoorbellCall(parsed.requestId, event.type);
        }
        break;
      case "access.doorbell.incoming":
        await this.setActiveDoorbellCall(
          (_f = (_e = parsed.requestId) != null ? _e : (0, import_eventNormalizer.asString)(event.raw.event_object_id)) != null ? _f : null,
          parsed.requestId,
          (_i = (_h = (_g = event.doorName) != null ? _g : event.deviceName) != null ? _h : event.deviceId) != null ? _i : null,
          event.ts,
          false
        );
        await this.storeEventThumbnail(event);
        break;
      case "access.doorbell.incoming.REN":
        await this.storeEventThumbnail(event);
        break;
      case "access.doorbell.completed":
        await this.endDoorbellCall(parsed.requestId, event.type);
        if (parsed.reasonCode === 107 && event.doorId) {
          this.scheduleDoorChecks(event.doorId, [DOOR_CHECK_AFTER_EVENT_MS]);
        }
        break;
      case "access.data.device.remote_unlock":
        if (event.doorId) {
          await this.markDoorUnlocked(event.doorId);
        }
        await this.storeEventThumbnail(event);
        break;
      case "access.door.unlock":
        if (event.doorId) {
          if ((0, import_eventNormalizer.isAccessGranted)(parsed.result)) {
            await this.markDoorUnlocked(event.doorId);
          } else {
            this.log.debug(
              `[event] ${event.type} for doorId=${event.doorId} with result "${parsed.result}" \u2014 door stays locked`
            );
          }
        }
        await this.storeEventThumbnail(event);
        this.logSystemLogs(event.ts, event.doorId);
        break;
      case "access.device.dps_status":
        if (event.doorId) {
          const value = (0, import_controlValues.extractDpsStatus)(parsed.data);
          if (value !== void 0 && this.doorNameCache.has(event.doorId)) {
            await this.library.setDoorPosition(event.doorId, value);
          } else if (value === void 0) {
            this.log.debug(`[event] ${event.type} for doorId=${event.doorId} without a status \u2014 ignored`);
          }
        }
        this.requestDoorRefresh();
        break;
      case "access.device.emergency_status":
        this.runDetached("emergency status", this.refreshEmergencyStatus());
        break;
      case "access.temporary_unlock.start":
        this.logSystemLogs(event.ts, event.doorId);
        this.requestDoorRefresh(true);
        break;
      case "access.temporary_unlock.end":
      case "access.unlock_schedule.activate":
      case "access.unlock_schedule.deactivate":
        this.requestDoorRefresh(true);
        break;
    }
  }
  async storeEventThumbnail(event) {
    var _a;
    if (!event.thumbnailPath) {
      return;
    }
    const deviceId = (_a = this.extractReaderIdFromPath(event.thumbnailPath)) != null ? _a : event.deviceId;
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
  async setActiveDoorbellCall(callId, requestId, from, startedAt, authoritative) {
    const current = this.activeDoorbellCall;
    if (!authoritative && requestId !== void 0 && (current == null ? void 0 : current.requestId) !== requestId && this.isFinishedDoorbellCall(requestId)) {
      this.log.debug(`Doorbell: webhook for call ${requestId}, which is already over \u2014 not published.`);
      return;
    }
    if (authoritative && requestId !== void 0) {
      this.finishedDoorbellCalls.delete(requestId);
    }
    if (current) {
      const sameCall = requestId === void 0 || current.requestId === void 0 || current.requestId === requestId;
      if (!authoritative && sameCall) {
        return;
      }
      if (current.fromWebhook && requestId !== void 0 && current.requestId === requestId) {
        return;
      }
    }
    if ((current == null ? void 0 : current.requestId) !== void 0 && current.requestId !== requestId) {
      this.noteFinishedDoorbellCall(current.requestId);
    }
    this.activeDoorbellCall = { requestId, fromWebhook: !authoritative };
    await this.writeState("doorbell.activeCallId", { val: callId, ack: true });
    await this.writeState("doorbell.activeFromDevice", { val: from, ack: true });
    await this.writeState("doorbell.activeStartedAt", { val: startedAt, ack: true });
    this.scheduleDoorbellExpiry();
  }
  /** (Re)start the upper time limit of the published call. */
  scheduleDoorbellExpiry() {
    var _a;
    if (this.doorbellExpiryTimer) {
      this.clearTimeout(this.doorbellExpiryTimer);
    }
    const requestId = (_a = this.activeDoorbellCall) == null ? void 0 : _a.requestId;
    this.doorbellExpiryTimer = this.startTimer(() => {
      this.doorbellExpiryTimer = void 0;
      this.log.debug("Doorbell call without end event \u2014 cleared after the time limit.");
      this.runDetached("doorbell call expiry", this.endDoorbellCall(requestId, "time limit"));
    }, DOORBELL_CALL_MAX_MS);
  }
  /**
   * A doorbell call ended. The published call is only cleared when the end belongs to it: with two
   * readers ringing one after the other, the end of the earlier call must not clear the call that is
   * still ringing. An end without request id (or a published call without one) cannot be told apart
   * and clears the published call, as before — leaving a call standing would be worse than clearing
   * it once too often (it would hang until the time limit).
   *
   * @param requestId Request id from the end event
   * @param what Event type or reason, for the debug log
   */
  async endDoorbellCall(requestId, what) {
    const current = this.activeDoorbellCall;
    if (requestId !== void 0) {
      this.noteFinishedDoorbellCall(requestId);
    } else if ((current == null ? void 0 : current.requestId) !== void 0) {
      this.noteFinishedDoorbellCall(current.requestId);
    }
    if (current && requestId !== void 0 && current.requestId !== void 0 && current.requestId !== requestId) {
      this.log.debug(
        `Doorbell: ${what} for call ${requestId}, but call ${current.requestId} is published \u2014 it stays active.`
      );
      return;
    }
    await this.clearActiveDoorbellCall();
  }
  /**
   * Remember that a call is over. The memory is short (the time limit of a call) and small: a late
   * webhook arrives seconds after the WebSocket event, not minutes.
   *
   * @param requestId Request id of the call
   */
  noteFinishedDoorbellCall(requestId) {
    const now = Date.now();
    this.finishedDoorbellCalls.delete(requestId);
    this.finishedDoorbellCalls.set(requestId, now);
    for (const [id, at] of this.finishedDoorbellCalls) {
      if (now - at <= DOORBELL_CALL_MAX_MS && this.finishedDoorbellCalls.size <= UnifiAccess.FINISHED_DOORBELL_CALLS_MAX) {
        break;
      }
      this.finishedDoorbellCalls.delete(id);
    }
  }
  isFinishedDoorbellCall(requestId) {
    const at = this.finishedDoorbellCalls.get(requestId);
    return at !== void 0 && Date.now() - at <= DOORBELL_CALL_MAX_MS;
  }
  async clearActiveDoorbellCall() {
    if (this.doorbellExpiryTimer) {
      this.clearTimeout(this.doorbellExpiryTimer);
      this.doorbellExpiryTimer = void 0;
    }
    this.activeDoorbellCall = null;
    await this.writeState("doorbell.activeCallId", { val: null, ack: true });
    await this.writeState("doorbell.activeFromDevice", { val: null, ack: true });
    await this.writeState("doorbell.activeStartedAt", { val: null, ack: true });
  }
  /**
   * A door was released (event from the controller): publish it and check a little later what the
   * controller reports, instead of leaving `locked=false` standing until the next restart.
   *
   * @param doorId Door id as used by the controller
   */
  async markDoorUnlocked(doorId) {
    if (!this.doorNameCache.has(doorId)) {
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
  requestDoorRefresh(withLockRules = false) {
    if (this.unloading || !this.http) {
      return;
    }
    this.doorRefreshWithLockRules || (this.doorRefreshWithLockRules = withLockRules);
    if (this.doorRefreshTimer) {
      return;
    }
    this.doorRefreshTimer = this.startTimer(() => {
      this.doorRefreshTimer = void 0;
      const lockRules = this.doorRefreshWithLockRules;
      this.doorRefreshWithLockRules = false;
      this.runDetached("door refresh", this.refreshDoors(lockRules));
    }, DOOR_REFRESH_DEBOUNCE_MS);
  }
  /**
   * Schedule status checks for one door, replacing checks still pending for it. Used after commands
   * and unlock events in place of timers that assumed the door state.
   *
   * @param doorId Door id as used by the controller
   * @param delaysMs Delays from now, one check each
   */
  scheduleDoorChecks(doorId, delaysMs) {
    this.cancelDoorChecks(doorId);
    if (this.unloading || !this.http) {
      return;
    }
    const timers = [];
    for (const delayMs of delaysMs) {
      const timer = this.startTimer(() => {
        const pending = this.doorCheckTimers.get(doorId);
        if (pending) {
          const remaining = pending.filter((t) => t !== timer);
          if (remaining.length > 0) {
            this.doorCheckTimers.set(doorId, remaining);
          } else {
            this.doorCheckTimers.delete(doorId);
          }
        }
        this.runDetached("door status check", this.refreshDoor(doorId));
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
  scheduleRuleEndCheck(doorId, delayMs) {
    this.cancelRuleEndCheck(doorId);
    if (this.unloading || !this.http) {
      return;
    }
    const timer = this.startTimer(() => {
      this.doorRuleEndTimers.delete(doorId);
      this.runDetached("door status check", this.refreshDoor(doorId));
    }, delayMs);
    if (timer) {
      this.doorRuleEndTimers.set(doorId, { timer, at: Date.now() + delayMs });
    }
  }
  cancelRuleEndCheck(doorId) {
    const entry = this.doorRuleEndTimers.get(doorId);
    if (entry) {
      this.clearTimeout(entry.timer);
      this.doorRuleEndTimers.delete(doorId);
    }
  }
  cancelDoorChecks(doorId) {
    var _a;
    for (const timer of (_a = this.doorCheckTimers.get(doorId)) != null ? _a : []) {
      this.clearTimeout(timer);
    }
    this.doorCheckTimers.delete(doorId);
  }
  /**
   * Read one door from the controller (GET /doors/:id) and mirror its lock/position status and lock rule.
   *
   * @param doorId Door id as used by the controller
   */
  async refreshDoor(doorId) {
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
      this.rethrowIfStopped(err);
      this.log.debug(`Door status refresh for ${doorId} failed: ${errorText(err)}`);
    }
  }
  /**
   * Read all doors from the controller (GET /doors) and mirror their lock/position status.
   *
   * @param withLockRules Also re-read the temporary lock rules
   */
  async refreshDoors(withLockRules) {
    if (!this.http || this.unloading) {
      return;
    }
    try {
      const doors = await this.http.listDoors();
      for (const door of doors) {
        if (this.unloading) {
          return;
        }
        if (!door || typeof door.id !== "string") {
          continue;
        }
        await this.applyDoorStatus(door);
        if (withLockRules) {
          await this.refreshLockRule(door.id);
        }
      }
    } catch (err) {
      this.rethrowIfStopped(err);
      this.log.debug(`Door status refresh failed: ${errorText(err)}`);
    }
  }
  async applyDoorStatus(door) {
    var _a, _b, _c;
    if (!this.doorNameCache.has(door.id)) {
      await this.library.ensureDoor(door);
      this.doorNameCache.set(door.id, (_b = (_a = door.name) != null ? _a : door.full_name) != null ? _b : door.id);
      this.log.info(`New door "${(_c = door.name) != null ? _c : door.id}" added.`);
      return;
    }
    await this.library.updateDoorStatus(door);
  }
  /**
   * Mirror the temporary lock rule of a door into doors.<id>.lockRuleType / lockRuleEndsAt, and make
   * sure the door is checked again when a rule with an end time runs out — also for rules set in the
   * UniFi app or before an adapter restart; without webhooks nothing else reports the end.
   *
   * The endpoint needs UniFi Access 1.24.6 or later. A controller without the route (HTTP 404) is not
   * asked again until the next (re)load; a refusal for one door only stops the requests for that door.
   * Temporary failures (server error, device offline, network) stop nothing.
   *
   * @param doorId Door id as used by the controller
   */
  async refreshLockRule(doorId) {
    var _a, _b;
    if (!this.http || this.unloading || !this.lockRuleSupported || this.lockRuleUnavailableDoors.has(doorId)) {
      return;
    }
    try {
      const rule = await this.http.getDoorLockRule(doorId);
      await this.library.setDoorLockRule(doorId, rule);
      this.scheduleRuleEndFromController(doorId, rule == null ? void 0 : rule.ended_time);
    } catch (err) {
      this.rethrowIfStopped(err);
      const status = (_b = (_a = err.response) == null ? void 0 : _a.status) != null ? _b : err instanceof import_unifiHttp.UnifiApiError ? err.httpStatus : void 0;
      const code = (0, import_unifiHttp.apiErrorCode)(err);
      if (status === 404) {
        this.lockRuleSupported = false;
        this.log.debug(
          `Lock rule status not available (requires UniFi Access >= 1.24.6): ${errorText(err)} \u2014 not asking again until the next reconnect.`
        );
        return;
      }
      const temporary = status === void 0 || status >= 500 || [401, 403, 408, 429].includes(status) || code !== void 0 && TEMPORARY_API_CODES.has(code) || (0, import_unifiHttp.classifyError)(err) === "unauthorized";
      const refusal = !temporary && (status !== void 0 && status >= 400 && status < 500 || err instanceof import_unifiHttp.UnifiApiError);
      if (refusal) {
        this.lockRuleUnavailableDoors.add(doorId);
        this.log.debug(
          `Lock rule status of door ${doorId} not available: ${errorText(err)} \u2014 not asking again for this door until the next reconnect.`
        );
      } else {
        this.log.debug(`Lock rule refresh for ${doorId} failed: ${errorText(err)}`);
      }
    }
  }
  /**
   * Plan the end-of-rule check from the end time the controller reports.
   *
   * @param doorId Door id as used by the controller
   * @param endedTime `ended_time` of the rule (unix seconds), 0/absent = no end
   */
  scheduleRuleEndFromController(doorId, endedTime) {
    if (typeof endedTime !== "number" || !Number.isFinite(endedTime) || endedTime <= 0) {
      return;
    }
    const remainingMs = endedTime * 1e3 - Date.now();
    if (remainingMs <= 0 || remainingMs > RULE_END_CHECK_HORIZON_MS) {
      return;
    }
    const at = Date.now() + remainingMs + DOOR_CHECK_AFTER_COMMAND_MS;
    const planned = this.doorRuleEndTimers.get(doorId);
    if (planned && Math.abs(planned.at - at) <= RULE_END_TOLERANCE_MS) {
      return;
    }
    this.scheduleRuleEndCheck(doorId, remainingMs + DOOR_CHECK_AFTER_COMMAND_MS);
  }
  async updateDeviceFromEventData(dataDevice, ts) {
    const deviceId = (0, import_eventNormalizer.asString)(dataDevice == null ? void 0 : dataDevice.id);
    if (!dataDevice || deviceId === void 0) {
      return;
    }
    const cached = this.devices.get(deviceId);
    if (!cached) {
      this.requestDeviceRefresh(deviceId);
      return;
    }
    const safe = this.safeId(deviceId);
    const isoTs = new Date(ts).toISOString();
    const firmware = (0, import_eventNormalizer.asString)(dataDevice.firmware);
    if (firmware !== void 0) {
      await this.writeState(`devices.${safe}.firmware`, { val: firmware, ack: true });
      cached.firmware = firmware;
    }
    await this.writeState(`devices.${safe}.lastSeenAt`, { val: isoTs, ack: true });
    cached.lastSeenAt = isoTs;
  }
  /**
   * An event named a device the adapter does not know. Reload devices and doors once (creates the
   * objects); an id that is still unknown afterwards is remembered and does not trigger further reloads.
   *
   * @param deviceId Device id from the event
   */
  requestDeviceRefresh(deviceId) {
    if (this.unloading || !this.http || this.unknownDeviceIds.has(deviceId)) {
      return;
    }
    this.unknownDeviceIds.add(deviceId);
    if (this.unknownDeviceIds.size > 500) {
      this.unknownDeviceIds.clear();
    }
    this.log.debug(`Event for unknown device ${deviceId} \u2014 reloading the device list.`);
    this.runDetached("device refresh", this.bootstrapAndConnect());
  }
  async setThumbnail(deviceId, path, ts) {
    if ((0, import_pathSafety.sanitizeStaticPath)(path) === null) {
      return;
    }
    if (!this.devices.has(deviceId)) {
      this.requestDeviceRefresh(deviceId);
      return;
    }
    await this.library.ensureThumbnailStates(deviceId);
    const safe = this.safeId(deviceId);
    await this.writeState(`devices.${safe}.lastThumbnailPath`, { val: path, ack: true });
    await this.writeState(`devices.${safe}.lastThumbnailAt`, { val: ts, ack: true });
    await this.writeState(`devices.${safe}.lastThumbnailUrl`, { val: this.thumbnailUrl(deviceId, ts), ack: true });
  }
  /**
   * URL under which the built-in HTTP server delivers the last thumbnail of a device.
   *
   * @param deviceId Device id as used by the controller
   * @param ts Time of the thumbnail (ms epoch), only there to defeat browser caches
   * @returns The URL, or an empty string while the thumbnail server is off or not listening
   */
  thumbnailUrl(deviceId, ts) {
    const base = this.config.enableThumbnailServer === true ? this.buildServerBaseUrl() : null;
    return base ? `${base}/unifi-access/${this.instance}/thumbnail/${encodeURIComponent(deviceId)}.jpg?ts=${ts}` : "";
  }
  /**
   * Bring `lastThumbnailUrl` of every device in line with how the built-in HTTP server runs now. The
   * state survives restarts, the server settings may not: after the thumbnail server was switched
   * off, or port, listen address or TLS were changed, the stored URL would lead nowhere until the
   * next event with a thumbnail arrives.
   */
  async refreshThumbnailUrls() {
    var _a;
    for (const deviceId of this.devices.keys()) {
      const safe = this.safeId(deviceId);
      try {
        const stored = await this.getStateAsync(`devices.${safe}.lastThumbnailUrl`);
        if (!stored) {
          continue;
        }
        const path = await this.getStateAsync(`devices.${safe}.lastThumbnailPath`);
        const at = await this.getStateAsync(`devices.${safe}.lastThumbnailAt`);
        const hasThumbnail = typeof (path == null ? void 0 : path.val) === "string" && (0, import_pathSafety.sanitizeStaticPath)(path.val) !== null;
        const ts = typeof (at == null ? void 0 : at.val) === "number" && at.val > 0 ? at.val : 0;
        const url = hasThumbnail ? this.thumbnailUrl(deviceId, ts) : "";
        if (((_a = stored.val) != null ? _a : "") !== url) {
          await this.writeState(`devices.${safe}.lastThumbnailUrl`, { val: url, ack: true });
        }
      } catch (err) {
        this.rethrowIfStopped(err);
        this.log.debug(`Could not refresh the thumbnail URL of ${deviceId}: ${errorText(err)}`);
      }
    }
  }
  async applyForwardRules(event) {
    for (const rule of this.forwardRules) {
      if (!(rule == null ? void 0 : rule.event) || !(rule == null ? void 0 : rule.targetState)) {
        continue;
      }
      if (rule.event !== event.type) {
        continue;
      }
      if (rule.deviceId && rule.deviceId !== event.deviceId) {
        continue;
      }
      try {
        await this.writeForeignState(rule.targetState, { val: JSON.stringify(event), ack: true });
      } catch (err) {
        if ((0, import_stopSignal.isStoppedError)(err)) {
          throw err;
        }
        this.log.debug(`Forward to ${rule.targetState} failed: ${err.message}`);
      }
    }
  }
  setConnectionStatus(connected, lastError) {
    const changed = this.connectedToController !== connected || !this.connectionStatusWritten;
    this.connectedToController = connected;
    this.lastErrorKind = lastError;
    if (changed) {
      this.connectionStatusWritten = true;
      this.runDetached("info.connection", this.writeState("info.connection", { val: connected, ack: true }));
    }
  }
  /**
   * Let a promise run on its own while making sure a rejection is logged instead of terminating the
   * adapter as an unhandled rejection.
   *
   * @param what Short description for the log
   * @param promise The running operation
   */
  runDetached(what, promise) {
    promise.catch((err) => {
      if ((0, import_stopSignal.isStoppedError)(err) || this.unloading) {
        this.log.debug(`${what} ended by the stop: ${errorText(err)}`);
        return;
      }
      this.log.warn(`${what} failed: ${errorText(err)}`);
    });
  }
  // ----- effects that must not happen after the stop (see lib/stopSignal.ts) -----------------------
  // Every state/object write and every timer of this class goes through these wrappers (enforced by
  // the lint rule `no-restricted-syntax` for src/main.ts). The HTTP clients refuse requests by
  // themselves (`isStopped`).
  /** Throw {@link StoppedError} once the instance is stopping: the operation ends before its next effect. */
  throwIfStopped() {
    if (this.unloading) {
      throw new import_stopSignal.StoppedError();
    }
  }
  /**
   * First statement of a `catch` that would report or repair a failure: after the stop there is
   * nothing to report (a request that fails then failed because of the stop, or is of no interest any
   * more) and nothing to repair — the operation ends quietly.
   *
   * @param err The caught error
   */
  rethrowIfStopped(err) {
    if ((0, import_stopSignal.isStoppedError)(err)) {
      throw err;
    }
    if (this.unloading) {
      throw new import_stopSignal.StoppedError(`the instance is stopping (${errorText(err)})`);
    }
  }
  /** Logger for helpers (receivers, registration): what they report after the stop goes to debug only. */
  helperLogger() {
    return {
      debug: (m) => this.log.debug(m),
      info: (m) => this.unloading ? this.log.debug(m) : this.log.info(m),
      warn: (m) => this.unloading ? this.log.debug(m) : this.log.warn(m)
    };
  }
  /**
   * `setState` that refuses after the stop.
   *
   * @param id State id without namespace
   * @param state Value and ack
   */
  async writeState(id, state) {
    this.throwIfStopped();
    await this.setState(id, state);
  }
  /**
   * `setForeignStateAsync` that refuses after the stop.
   *
   * @param id Full state id
   * @param state Value and ack
   */
  async writeForeignState(id, state) {
    this.throwIfStopped();
    await this.setForeignStateAsync(id, state);
  }
  /**
   * Adapter timer that is not created after the stop and does not run its callback after it.
   *
   * @param callback What to run
   * @param ms Delay
   */
  startTimer(callback, ms) {
    if (this.unloading) {
      return void 0;
    }
    return this.setTimeout(() => {
      if (!this.unloading) {
        callback();
      }
    }, ms);
  }
  /**
   * Adapter interval that is not created after the stop and does not run its callback after it.
   *
   * @param callback What to run
   * @param ms Period
   */
  startInterval(callback, ms) {
    if (this.unloading) {
      return void 0;
    }
    return this.setInterval(() => {
      if (!this.unloading) {
        callback();
      }
    }, ms);
  }
  safeId(raw) {
    return raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  }
  /**
   * Extracts the reader device ID encoded in a thumbnail path like /preview/reader_<mac>_...
   *
   * @param path Static-resource path from the event payload
   */
  extractReaderIdFromPath(path) {
    var _a;
    return (_a = /\/reader_([0-9a-fA-F]+)_/i.exec(path)) == null ? void 0 : _a[1];
  }
  /**
   * Mirror an alarm-manager webhook body into notifications.*. The body is foreign input: every
   * field is written only as the type its state declares, anything else becomes an empty string.
   *
   * @param payload Parsed JSON body (any shape)
   * @param raw The body as received
   */
  async handleGenericAlarm(payload, raw) {
    var _a, _b, _c;
    const body = (_a = (0, import_eventNormalizer.asRecord)(payload)) != null ? _a : {};
    const first = (_b = (0, import_eventNormalizer.asRecord)(Array.isArray(body.events) ? body.events[0] : void 0)) != null ? _b : {};
    const text = (value) => typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
    const locationId = text(first.location) || text((_c = (0, import_eventNormalizer.asRecord)(first.scope)) == null ? void 0 : _c.locations);
    const userId = text(first.user);
    const locationName = locationId && this.doorNameCache.get(locationId) || text(first.location_name) || locationId;
    const userName = userId && this.userNameCache.get(userId) || text(first.user_name) || userId;
    const time = text(first.time);
    await this.writeState("notifications.lastRaw", { val: raw, ack: true });
    await this.writeState("notifications.lastAlarmId", { val: text(body.alarm_id), ack: true });
    await this.writeState("notifications.lastEventType", { val: text(first.id), ack: true });
    await this.writeState("notifications.lastLocationId", { val: locationId, ack: true });
    await this.writeState("notifications.lastLocationName", { val: locationName, ack: true });
    await this.writeState("notifications.lastUserId", { val: userId, ack: true });
    await this.writeState("notifications.lastUserName", { val: userName, ack: true });
    await this.writeState("notifications.lastDirection", { val: text(first.direction), ack: true });
    await this.writeState("notifications.lastUnlockMethod", { val: text(first.unlock_method_text), ack: true });
    await this.writeState("notifications.lastTimestamp", {
      val: time && Date.parse(time) || Date.now(),
      ack: true
    });
  }
  onStateChange(id, state) {
    var _a, _b, _c, _d;
    if (!state || state.ack) {
      return;
    }
    const localId = id.startsWith(`${this.namespace}.`) ? id.slice(this.namespace.length + 1) : id;
    const val = state.val;
    if (localId === "doors.emergency.lockdown" || localId === "doors.emergency.evacuation") {
      const field = localId === "doors.emergency.lockdown" ? "lockdown" : "evacuation";
      const blocked2 = this.commandBlocker();
      if (blocked2) {
        this.refuseCommand(localId, blocked2, (_a = this.lastEmergency[field]) != null ? _a : null);
        return;
      }
      this.runCommand(localId, this.handleEmergencyChange(field, val));
      return;
    }
    if (localId === "admin.uiSettings") {
      this.runCommand(localId, this.handleUiSettings(val));
      return;
    }
    const match = /^doors\.([^.]+)\.(unlock|unlock_duration|lock_rule)$/.exec(localId);
    if (!match) {
      return;
    }
    const [, doorId, control] = match;
    const neutral = control === "unlock" ? false : (_b = this.lastAckedControlValues.get(localId)) != null ? _b : 0;
    const blocked = this.commandBlocker();
    if (blocked) {
      this.refuseCommand(localId, blocked, neutral);
      return;
    }
    if (!this.doorNameCache.has(doorId)) {
      this.runCommand(localId, this.refuseUnknownDoor(localId, doorId, neutral));
      return;
    }
    if (control === "unlock") {
      if (val === false) {
        return;
      }
      if (val !== true) {
        this.rejectControlValue(localId, val, "expected the boolean true", false);
        return;
      }
      this.runCommand(localId, this.handleDoorUnlock(doorId));
      return;
    }
    if (control === "unlock_duration") {
      const minutes = (0, import_controlValues.parseUnlockMinutes)(val);
      if (minutes === null) {
        this.rejectControlValue(
          localId,
          val,
          `expected a number of minutes between 0 and ${import_controlValues.MAX_UNLOCK_MINUTES}`,
          (_c = this.lastAckedControlValues.get(localId)) != null ? _c : 0
        );
        return;
      }
      this.runCommand(localId, this.handleDoorUnlockDuration(doorId, minutes));
      return;
    }
    const ruleType = (0, import_controlValues.parseLockRuleIndex)(val);
    if (ruleType === null) {
      this.rejectControlValue(
        localId,
        val,
        `expected one of the rule indexes ${Object.keys(import_controlValues.LOCK_RULE_BY_INDEX).join(", ")}`,
        (_d = this.lastAckedControlValues.get(localId)) != null ? _d : 0
      );
      return;
    }
    this.runCommand(localId, this.handleDoorLockRule(doorId, val, ruleType));
  }
  /**
   * Why a switching command cannot be carried out right now, or `null` when it can. Commands are
   * refused — not queued — while the controller state has not been loaded (the door list is unknown,
   * e.g. the controller was not reachable at start) and while the connection to the controller is lost.
   */
  commandBlocker() {
    if (!this.http) {
      return "no controller is configured";
    }
    if (!this.bootstrapSucceededOnce) {
      return "the controller has not been reachable since the adapter start (doors not loaded yet)";
    }
    if (!this.connectedToController) {
      return "the connection to the controller is lost";
    }
    return null;
  }
  /**
   * Refuse a switching command: warn and put the state back (acknowledged). Nothing is sent and
   * nothing is remembered for later.
   *
   * @param localId State id without namespace
   * @param reason Why the command is not carried out
   * @param restore Value the state is reset to
   */
  refuseCommand(localId, reason, restore) {
    this.log.warn(
      `Command ${localId} not executed: ${reason}. The state was reset \u2014 write it again once the controller is connected.`
    );
    this.writeState(localId, { val: restore, ack: true }).catch((err) => {
      this.log.debug(`Could not reset ${localId}: ${errorText(err)}`);
    });
  }
  /**
   * A command for a door id the controller does not report (any more). Door objects are kept when a
   * door disappears; a write to such a leftover is refused visibly. A write to an id without objects
   * (nothing of this adapter) is only noted at debug level.
   *
   * @param localId State id without namespace
   * @param doorId Door id from the state id
   * @param restore Value the state is reset to
   */
  async refuseUnknownDoor(localId, doorId, restore) {
    if (!await this.getObjectAsync(localId)) {
      this.log.debug(`[${localId}] ignoring write for unknown door id: ${doorId}`);
      return;
    }
    this.throwIfStopped();
    this.refuseCommand(localId, `the controller does not report a door with the id ${doorId} (any more)`, restore);
  }
  /**
   * Run a command handler detached from the state-change callback. Handlers catch their own API
   * errors; this is the safety net that keeps an unexpected rejection from terminating the adapter.
   *
   * @param what Short description for the log
   * @param promise The running handler
   */
  runCommand(what, promise) {
    promise.catch((err) => {
      if ((0, import_stopSignal.isStoppedError)(err) || this.unloading) {
        this.log.debug(`Command ${what} ended by the stop: ${errorText(err)}`);
        return;
      }
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
  rejectControlValue(localId, val, expected, restore) {
    this.log.warn(
      `Ignoring invalid value ${(0, import_controlValues.describeValue)(val)} for ${localId}: ${expected}. No door action taken.`
    );
    this.writeState(localId, { val: restore, ack: true }).catch((err) => {
      this.log.debug(`Could not reset ${localId}: ${errorText(err)}`);
    });
  }
  /**
   * `admin.uiSettings` is the storage of the www panel, not a command: a JSON object is confirmed
   * (ack) as it is, anything else is replaced by the last valid value.
   *
   * @param val Value written by the panel
   */
  async handleUiSettings(val) {
    let valid = false;
    if (typeof val === "string" && val.length <= UI_SETTINGS_MAX_LENGTH) {
      try {
        valid = (0, import_eventNormalizer.asRecord)(JSON.parse(val)) !== void 0;
      } catch {
        valid = false;
      }
    }
    if (valid) {
      this.lastValidUiSettings = val;
      await this.writeState("admin.uiSettings", { val, ack: true });
      return;
    }
    this.log.warn(
      `Ignoring invalid value ${(0, import_controlValues.describeValue)(val)} for admin.uiSettings: expected a JSON object (max. ${UI_SETTINGS_MAX_LENGTH} characters).`
    );
    await this.writeState("admin.uiSettings", { val: this.lastValidUiSettings, ack: true });
  }
  async handleEmergencyChange(field, val) {
    if (!this.http) {
      return;
    }
    const localId = `doors.emergency.${field}`;
    if (typeof val !== "boolean") {
      this.log.warn(
        `Ignoring invalid value ${(0, import_controlValues.describeValue)(val)} for ${localId}: expected a boolean. Emergency status not changed.`
      );
      await this.restoreEmergencyStates();
      return;
    }
    const run = this.emergencyQueue.then(() => this.applyEmergencyChange(field, val));
    this.emergencyQueue = run.catch(() => void 0);
    await run;
  }
  async applyEmergencyChange(field, val) {
    if (!this.http || this.unloading) {
      return;
    }
    const localId = `doors.emergency.${field}`;
    try {
      const current = await this.http.readEmergencyStatus();
      this.throwIfStopped();
      if (!current) {
        this.log.warn(
          "Set emergency status failed: the controller did not report the current emergency status."
        );
        await this.restoreEmergencyStates();
        return;
      }
      const payload = { lockdown: current.lockdown, evacuation: current.evacuation };
      payload[field] = val;
      await this.http.setEmergencyStatus(payload);
      this.lastEmergency.lockdown = payload.lockdown;
      this.lastEmergency.evacuation = payload.evacuation;
      await this.writeState(localId, { val, ack: true });
      const sibling = field === "lockdown" ? "evacuation" : "lockdown";
      await this.writeState(`doors.emergency.${sibling}`, { val: payload[sibling], ack: true });
      this.log.info(`Emergency status: lockdown=${payload.lockdown}, evacuation=${payload.evacuation}`);
    } catch (err) {
      this.rethrowIfStopped(err);
      this.log.warn(`Set emergency status failed: ${errorText(err)}`);
      await this.restoreEmergencyStates();
    }
  }
  /**
   * After a failed emergency command the states must not keep showing the requested value (a
   * "lockdown active" that does not exist): read what the controller reports, or — if that is not
   * possible either — put back what it reported last.
   */
  async restoreEmergencyStates() {
    var _a, _b;
    if (await this.refreshEmergencyStatus()) {
      return;
    }
    await this.writeState("doors.emergency.lockdown", { val: (_a = this.lastEmergency.lockdown) != null ? _a : null, ack: true });
    await this.writeState("doors.emergency.evacuation", { val: (_b = this.lastEmergency.evacuation) != null ? _b : null, ack: true });
  }
  /** @returns false when the controller could not be asked */
  async refreshEmergencyStatus() {
    if (!this.http) {
      return false;
    }
    try {
      const emergency = await this.http.getEmergencyStatus();
      this.lastEmergency.lockdown = emergency.lockdown;
      this.lastEmergency.evacuation = emergency.evacuation;
      await this.writeState("doors.emergency.lockdown", { val: emergency.lockdown, ack: true });
      await this.writeState("doors.emergency.evacuation", { val: emergency.evacuation, ack: true });
      return true;
    } catch (err) {
      this.rethrowIfStopped(err);
      this.log.debug("Emergency status endpoint not available (requires UniFi Access >= 1.24.6).");
      return false;
    }
  }
  unlockActor() {
    var _a;
    const actorId = this.config.unlockActorId || "";
    return actorId ? { id: actorId, name: (_a = this.userNameCache.get(actorId)) != null ? _a : actorId } : void 0;
  }
  /**
   * Unlock a door: pulse (minutes = 0) or timed via a custom lock rule. Afterwards the door status
   * is read back from the controller instead of assuming when the door locks again.
   *
   * @param doorId Door id as used by the controller
   * @param minutes Whole minutes, 0 = pulse
   */
  async unlockDoorFor(doorId, minutes) {
    if (!this.http) {
      throw new Error("no controller connection");
    }
    if (minutes > 0) {
      await this.http.setDoorLockRule(doorId, { type: "custom", interval: minutes });
      this.log.info(`Door ${doorId} unlocked for ${minutes} min via lock_rule.`);
      await this.library.setDoorLocked(doorId, false);
      this.scheduleDoorChecks(doorId, [DOOR_CHECK_AFTER_COMMAND_MS]);
      this.scheduleRuleEndCheck(doorId, minutes * 6e4 + DOOR_CHECK_AFTER_COMMAND_MS);
    } else {
      await this.http.unlockDoor(doorId, this.unlockActor());
      this.log.info(`Door ${doorId} unlocked (pulse).`);
      await this.library.setDoorLocked(doorId, false);
      this.scheduleDoorChecks(doorId, [DOOR_CHECK_AFTER_EVENT_MS]);
    }
  }
  async handleDoorUnlock(safeDoorId) {
    if (!this.http) {
      return;
    }
    if (!this.doorNameCache.has(safeDoorId)) {
      this.log.debug(`[unlock] ignoring unlock for unknown door id: ${safeDoorId}`);
      return;
    }
    const minutes = (0, import_controlValues.normalizeDefaultUnlockMinutes)(this.config.defaultUnlockDuration);
    try {
      await this.unlockDoorFor(safeDoorId, minutes);
      await this.writeState(`doors.${safeDoorId}.unlock`, { val: true, ack: true });
    } catch (err) {
      this.rethrowIfStopped(err);
      this.log.warn(`Unlock door ${safeDoorId} failed: ${errorText(err)}`);
    }
  }
  async handleDoorUnlockDuration(safeDoorId, minutes) {
    if (!this.http) {
      return;
    }
    if (!this.doorNameCache.has(safeDoorId)) {
      this.log.debug(`[unlock_duration] ignoring unknown door id: ${safeDoorId}`);
      return;
    }
    try {
      await this.unlockDoorFor(safeDoorId, minutes);
      await this.writeState(`doors.${safeDoorId}.unlock_duration`, { val: minutes, ack: true });
      this.lastAckedControlValues.set(`doors.${safeDoorId}.unlock_duration`, minutes);
    } catch (err) {
      this.rethrowIfStopped(err);
      this.log.warn(`Unlock door ${safeDoorId} (duration) failed: ${errorText(err)}`);
    }
  }
  async handleDoorLockRule(safeDoorId, ruleIndex, type) {
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
      if (type === "keep_unlock") {
        await this.library.setDoorLocked(safeDoorId, false);
      } else if (type === "keep_lock" || type === "lock_now") {
        await this.library.setDoorLocked(safeDoorId, true);
      }
      this.cancelRuleEndCheck(safeDoorId);
      this.scheduleDoorChecks(safeDoorId, [DOOR_CHECK_AFTER_COMMAND_MS]);
      this.lastAckedControlValues.set(`doors.${safeDoorId}.lock_rule`, ruleIndex);
      await this.writeState(`doors.${safeDoorId}.lock_rule`, { val: ruleIndex, ack: true });
    } catch (err) {
      this.rethrowIfStopped(err);
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
  onMessage(msg) {
    if (!msg || typeof msg !== "object" || typeof msg.command !== "string") {
      return;
    }
    this.log.debug(`Message: ${JSON.stringify({ command: msg.command })}`);
    let afterAnswer;
    this.handleMessage(msg, (task) => {
      afterAnswer = task;
    }).catch((err) => {
      this.log.warn(`Message "${msg.command}" failed: ${errorText(err)}`);
      return { ok: false, error: errorText(err) };
    }).then((answer) => {
      if (msg.callback) {
        this.sendTo(msg.from, msg.command, answer, msg.callback);
      }
      return afterAnswer == null ? void 0 : afterAnswer();
    }).catch((err) => {
      this.log.warn(`Message "${msg.command}": ${errorText(err)}`);
    });
  }
  /**
   * Compute the answer to a sendTo command.
   *
   * @param msg The message
   * @param defer Register work that must run only after the answer was sent
   */
  async handleMessage(msg, defer) {
    if (STATE_DEPENDENT_COMMANDS.has(msg.command)) {
      await this.waitForStartup();
    }
    switch (msg.command) {
      case "getConnectionStatus":
        return {
          connected: this.connectedToController,
          lastError: this.lastErrorKind,
          hasToken: !!this.config.apiToken,
          controllerName: this.controllerName,
          webhookRegistered: this.webhookRegistered
        };
      case "listDevices":
        return {
          devices: Array.from(this.devices.values()).map((d) => ({
            id: d.id,
            name: d.name,
            alias: d.alias,
            type: d.type,
            model: d.model,
            firmware: d.firmware,
            online: d.online,
            capabilities: d.capabilities,
            lastSeenAt: d.lastSeenAt
          }))
        };
      case "verifyToken":
        return this.handleVerifyToken(msg);
      case "reregisterWebhook":
        return this.handleReregisterWebhook(defer);
      case "listUsers": {
        if (!this.http) {
          return { users: [], error: "not-configured" };
        }
        try {
          const users = await this.http.listUsers();
          return {
            users: users.map((u) => ({
              id: u.id,
              name: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.user_email || u.id
            }))
          };
        } catch (err) {
          this.log.debug(`listUsers failed: ${errorText(err)}`);
          return { users: [], error: (0, import_unifiHttp.classifyError)(err) };
        }
      }
      case "getServerInfo": {
        const server = this.httpServer;
        const running = (server == null ? void 0 : server.listening) === true;
        return {
          running,
          scheme: running ? server.scheme : null,
          port: (0, import_controlValues.normalizePort)(this.config.listenPort, 8095),
          baseUrl: this.buildServerBaseUrl(),
          tlsEnabled: this.config.enableTls === true,
          tlsActive: running && server.scheme === "https",
          tlsError: this.tlsError,
          // the configured public base URL (normalised; null = not set or unusable). baseUrl equals it
          // while the server runs.
          publicBaseUrl: this.publicBaseUrl()
        };
      }
      case "getNetworkInterfaces": {
        const addresses = [];
        for (const nets of Object.values((0, import_node_os.networkInterfaces)())) {
          for (const net of nets != null ? nets : []) {
            if (net.family === "IPv4" && !net.internal) {
              addresses.push(net.address);
            }
          }
        }
        return { addresses };
      }
      default:
        this.log.debug(`Unknown message command "${msg.command}".`);
        return { ok: false, error: "unknown-command" };
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
  async waitForStartup(maxMs = STARTUP_WAIT_MS) {
    if (this.startupFinished || this.unloading) {
      return;
    }
    await new Promise((resolve) => {
      const timer = this.startTimer(resolve, maxMs);
      void this.startup.then(() => {
        if (timer) {
          this.clearTimeout(timer);
        }
        resolve();
      });
    });
  }
  /**
   * "Test connection" of the admin: probe the controller with the values of the form (not saved yet).
   * `verifyTLS` and `caCert` of the form win over the stored configuration; without them in the
   * payload the stored values apply. The token is never logged.
   *
   * @param msg Message with `{host, port, token, verifyTLS?, caCert?}`
   * @returns `{ok:true, deviceCount}` or `{ok:false, error}` with error `missing-fields`, `unauthorized`,
   * `network` or `tls` (then with `detail`: the OpenSSL / Node.js code of the certificate failure)
   */
  async handleVerifyToken(msg) {
    var _a, _b, _c;
    const payload = (_a = (0, import_eventNormalizer.asRecord)(msg.message)) != null ? _a : {};
    const host = (_b = (0, import_eventNormalizer.asString)(payload.host)) != null ? _b : "";
    const port = (0, import_controlValues.normalizePort)(payload.port, 12445);
    const token = (_c = (0, import_eventNormalizer.asString)(payload.token)) != null ? _c : "";
    const verifyTLS = typeof payload.verifyTLS === "boolean" ? payload.verifyTLS : this.config.verifyTLS === true;
    const caCert = typeof payload.caCert === "string" ? payload.caCert : this.config.caCert;
    if (!host || !token) {
      return { ok: false, error: "missing-fields" };
    }
    const probe = new import_unifiHttp.UnifiHttp({
      host,
      port,
      token,
      verifyTLS,
      caCert: caCert || void 0,
      isStopped: () => this.unloading
    });
    try {
      const devices = await probe.listDevices();
      return { ok: true, deviceCount: devices.length };
    } catch (err) {
      const tlsCode = (0, import_tlsErrors.tlsCertificateErrorCode)(err);
      if (tlsCode) {
        return { ok: false, error: "tls", detail: tlsCode };
      }
      return { ok: false, error: (0, import_unifiHttp.classifyError)(err) };
    }
  }
  async handleReregisterWebhook(defer) {
    if (!this.http) {
      return { ok: false, error: "not-configured" };
    }
    if (this.config.enableWebhooks !== true) {
      return { ok: false, error: "webhooks-disabled" };
    }
    const publicUrl = this.webhookReceiverActive ? this.buildWebhookPublicUrl() : null;
    if (!publicUrl) {
      return { ok: false, error: "receiver-not-running" };
    }
    while (this.webhookRegistrationTask) {
      await this.webhookRegistrationTask;
    }
    if (this.unloading) {
      return { ok: false, error: "unloading" };
    }
    this.webhookRegistrationRunning = true;
    let done = () => void 0;
    this.webhookRegistrationTask = new Promise((resolve) => done = resolve);
    try {
      return await this.reregisterWebhookNow(publicUrl, defer);
    } finally {
      this.webhookRegistrationRunning = false;
      this.webhookRegistrationTask = null;
      done();
    }
  }
  async reregisterWebhookNow(publicUrl, defer) {
    const http = this.http;
    try {
      const result = await (0, import_registration.reregister)(
        {
          http,
          publicUrl,
          name: this.webhookEndpointName(),
          events: import_registration.DEFAULT_WEBHOOK_EVENTS,
          logger: this.registrationLogger(),
          isStopped: () => this.unloading
        },
        this.webhookEndpointId
      );
      this.webhookEndpointId = result.id;
      this.webhookSecret = result.secret;
      this.webhookRegistered = true;
      if (!this.unloading) {
        await this.writeState("info.webhookRegistered", { val: true, ack: true });
      }
      defer(() => this.persistWebhookCredentials(result.id, result.secret));
      return { ok: true, id: result.id };
    } catch (err) {
      this.webhookRegistered = false;
      if (this.unloading) {
        return { ok: false, error: "unloading" };
      }
      await this.writeState("info.webhookRegistered", { val: false, ack: true });
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
  recoverProtectSession() {
    if (this.config.enableProtect === true && this.protectHttp && !this.protectHttp.isLoggedIn() && !this.protectRetryTimer && !this.protectLoginRunning && !this.unloading) {
      this.log.debug("[protect] session lost \u2014 logging in again");
      this.runDetached("protect login", this.tryProtectLogin(2));
    }
  }
  /** Whether the Protect integration is active and has a session — the only consumer of the system logs. */
  protectReady() {
    var _a;
    return this.config.enableProtect === true && ((_a = this.protectHttp) == null ? void 0 : _a.isLoggedIn()) === true;
  }
  /**
   * Look up the system log entries around a door event to find the UniFi Protect camera event that
   * belongs to it. Only runs when the Protect integration is active — the lookup needs the extra
   * token permission `view:system_log` and has no other use.
   *
   * @param ts Event time (ms epoch)
   * @param doorId Door of the event — camera events are only attached when they belong to it
   */
  logSystemLogs(ts, doorId) {
    if (!this.http || !this.protectReady()) {
      this.recoverProtectSession();
      return;
    }
    if (!doorId) {
      this.log.debug("[protect] door event without door id \u2014 no camera lookup");
      return;
    }
    const http = this.http;
    this.startTimer(() => {
      this.runDetached("system log lookup", this.lookupSystemLogs(http, ts, doorId));
    }, 3e3);
  }
  async lookupSystemLogs(http, ts, doorId) {
    if (this.unloading || !this.protectReady()) {
      return;
    }
    const since = Math.floor(ts / 1e3) - 10;
    const until = Math.floor(ts / 1e3) + 30;
    for (const topic of ["door_openings", "all"]) {
      let raw;
      try {
        raw = await http.fetchSystemLogsRaw(topic, since, until);
      } catch (err) {
        this.rethrowIfStopped(err);
        const text = `[system-logs:${topic}] fetch failed: ${errorText(err)}`;
        if (topic === "door_openings" && !this.systemLogFailureLogged) {
          this.systemLogFailureLogged = true;
          this.log.warn(
            `${text} \u2014 the API token needs the permission "view:system_log" for Protect snapshots.`
          );
        } else {
          this.log.debug(text);
        }
        continue;
      }
      if (this.log.level === "debug" || this.log.level === "silly") {
        this.log.debug(
          `[system-logs:${topic}] ${JSON.stringify(
            raw,
            (key, value) => (key === "issuer" || key === "authentication_value") && value !== "" && value !== null ? import_eventNormalizer.MASKED_VALUE : value
          )}`
        );
      }
      if (await this.processSystemLogForProtect(raw, ts, doorId)) {
        return;
      }
    }
  }
  /**
   * Scan a system log response for the Protect camera event of a door event and attach snapshot and
   * clip URLs to it. Only log entries whose targets name the door of the event are considered — with
   * two doors opened within seconds the window also contains the entry of the other door. Of these the
   * one closest in time wins; exactly one snapshot is fetched.
   *
   * @param raw Response of POST /system/logs
   * @param eventTs Time of the door event (ms epoch)
   * @param doorId Door of the event
   * @returns true when a camera event of this door was found
   */
  async processSystemLogForProtect(raw, eventTs, doorId) {
    var _a, _b;
    const protect = this.protectHttp;
    if (!protect || !this.protectReady()) {
      return false;
    }
    const hits = (_a = raw == null ? void 0 : raw.data) == null ? void 0 : _a.hits;
    if (!Array.isArray(hits)) {
      this.log.debug("[protect] no hits array in system log response");
      return false;
    }
    this.log.debug(`[protect] scanning ${hits.length} system log hit(s) for camera events of door ${doorId}`);
    let best;
    for (const hit of hits) {
      const source = hit == null ? void 0 : hit._source;
      const targets = source == null ? void 0 : source.target;
      if (!Array.isArray(targets)) {
        continue;
      }
      const forThisDoor = targets.some((target) => {
        const t = target;
        return (t == null ? void 0 : t.type) === "door" && t.id === doorId;
      });
      const camera = targets.map((target) => this.parseCameraTarget(target)).find((c) => c !== void 0);
      if (!camera) {
        continue;
      }
      if (!forThisDoor) {
        this.log.debug(`[protect] camera event ${camera.cameraId} belongs to another door \u2014 skipped`);
        continue;
      }
      const published = (_b = source == null ? void 0 : source.event) == null ? void 0 : _b.published;
      const distance = typeof published === "number" ? Math.abs(published - eventTs) : Number.MAX_SAFE_INTEGER;
      if (!best || distance < best.distance) {
        best = { ...camera, distance };
      }
    }
    if (!best) {
      return false;
    }
    const { cameraId, eventId } = best;
    this.log.debug(`[protect] camera event found: cameraId=${cameraId}, eventId=${eventId != null ? eventId : "none"}`);
    try {
      const buf = await protect.getSnapshot(cameraId);
      this.protectSnapshotCache.add(`${cameraId}:${eventTs}`, buf);
      const base = this.buildServerBaseUrl();
      if (base === null) {
        this.log.debug("[protect] built-in HTTP server not running \u2014 no media URLs for this event");
        return true;
      }
      const snapshotUrl = `${base}/unifi-access/${this.instance}/protect-snapshot/${encodeURIComponent(cameraId)}/${eventTs}.jpg`;
      const videoUrl = eventId ? `${base}/unifi-access/${this.instance}/protect-video/${encodeURIComponent(eventId)}.mp4` : void 0;
      await this.library.updateEventProtectData(eventTs, {
        protectCameraId: cameraId,
        protectEventId: eventId,
        protectSnapshotUrl: snapshotUrl,
        protectVideoUrl: videoUrl
      });
      this.log.debug(`[protect] snapshot cached for camera ${cameraId} (${buf.length} bytes)`);
    } catch (err) {
      this.rethrowIfStopped(err);
      this.log.warn(`[protect] snapshot fetch for camera ${cameraId} failed: ${err.message}`);
    }
    return true;
  }
  /**
   * Camera and Protect event id from a system log target `{type: "camera event", id: "protect_<camera>_<event>"}`.
   * This format is not part of the documented API (observed on consoles with Protect).
   *
   * @param target One entry of `_source.target`
   * @returns undefined for any other target or an id that cannot be used safely
   */
  parseCameraTarget(target) {
    var _a;
    const t = target;
    if ((t == null ? void 0 : t.type) !== "camera event") {
      return void 0;
    }
    const id = t.id;
    if (typeof id !== "string" || !id.startsWith("protect_")) {
      this.log.debug(`[protect] camera event with unexpected id format: ${String(id)}`);
      return void 0;
    }
    const parts = id.split("_");
    const cameraId = (_a = parts[1]) != null ? _a : "";
    const rawEventId = parts.length >= 3 ? parts.slice(2).join("_") : void 0;
    if (!/^[A-Za-z0-9]{1,64}$/.test(cameraId)) {
      this.log.debug("[protect] camera event with unusable camera id \u2014 skipped");
      return void 0;
    }
    return { cameraId, eventId: (0, import_pathSafety.isSafeProtectId)(rawEventId) ? rawEventId : void 0 };
  }
  async onUnload(callback) {
    var _a;
    this.unloading = true;
    try {
      (_a = this.ws) == null ? void 0 : _a.stop();
      this.ws = null;
      if (this.bootstrapRetryTimer) {
        this.clearTimeout(this.bootstrapRetryTimer);
        this.bootstrapRetryTimer = void 0;
      }
      if (this.protectRetryTimer) {
        this.clearTimeout(this.protectRetryTimer);
        this.protectRetryTimer = void 0;
      }
      if (this.doorRefreshTimer) {
        this.clearTimeout(this.doorRefreshTimer);
        this.doorRefreshTimer = void 0;
      }
      for (const doorId of [...this.doorCheckTimers.keys()]) {
        this.cancelDoorChecks(doorId);
      }
      for (const doorId of [...this.doorRuleEndTimers.keys()]) {
        this.cancelRuleEndCheck(doorId);
      }
      if (this.webhookRegistrationRetryTimer) {
        this.clearTimeout(this.webhookRegistrationRetryTimer);
        this.webhookRegistrationRetryTimer = void 0;
      }
      if (this.doorbellExpiryTimer) {
        this.clearTimeout(this.doorbellExpiryTimer);
        this.doorbellExpiryTimer = void 0;
      }
      if (this.resyncTimer) {
        this.clearTimeout(this.resyncTimer);
        this.resyncTimer = void 0;
      }
      if (this.webhookCheckInterval) {
        this.clearInterval(this.webhookCheckInterval);
        this.webhookCheckInterval = void 0;
      }
      for (const timer of this.unlockPendingTimers.values()) {
        this.clearTimeout(timer);
      }
      this.unlockPendingTimers.clear();
      this.unlockPendingEvents.clear();
      this.recentDoorUnlocks.clear();
      if (this.httpServer) {
        await this.httpServer.stop();
        this.httpServer = null;
      }
      callback();
    } catch (error) {
      this.log.error(`Error during unloading: ${error.message}`);
      callback();
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new UnifiAccess(options);
} else {
  (() => new UnifiAccess())();
}
//# sourceMappingURL=main.js.map
