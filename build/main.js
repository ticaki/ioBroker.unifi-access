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
var import_unifiWebSocket = require("./lib/unifiWebSocket");
var import_library = require("./lib/library");
var import_deviceModels = require("./lib/deviceModels");
var import_node_os = require("node:os");
var import_server = require("./webhooks/server");
var import_registration = require("./webhooks/registration");
var import_snapshotEndpoint = require("./webserver/snapshotEndpoint");
var import_protectSnapshotEndpoint = require("./webserver/protectSnapshotEndpoint");
var import_genericWebhookServer = require("./webhooks/genericWebhookServer");
var import_sharedHttpServer = require("./webserver/sharedHttpServer");
const WEBHOOK_PATH = "/unifi-access-webhook";
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
  bootstrapRetryTimer;
  devices = /* @__PURE__ */ new Map();
  userNameCache = /* @__PURE__ */ new Map();
  doorNameCache = /* @__PURE__ */ new Map();
  forwardRules = [];
  protectSnapshotCache = /* @__PURE__ */ new Map();
  protectSnapshotCacheOrder = [];
  static PROTECT_CACHE_MAX = 50;
  // Dedup: access.data.device.remote_unlock (WS) + access.door.unlock (webhook) describe the same action.
  // remote_unlock (no door/user data) is delayed 4 s; if door.unlock arrives in that window,
  // the pending remote_unlock is cancelled and door.unlock (richer data) is pushed instead.
  unlockPendingTimers = /* @__PURE__ */ new Map();
  unlockPendingEvents = /* @__PURE__ */ new Map();
  constructor(options = {}) {
    super({
      ...options,
      name: "unifi-access"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
    var _a, _b, _c;
    this.library = new import_library.Library(this);
    await this.setState("info.connection", false, true);
    const cfg = this.config;
    const host = (_a = cfg.controllerHost) != null ? _a : "";
    const port = cfg.controllerPort || 12445;
    const token = (_b = cfg.apiToken) != null ? _b : "";
    const verifyTLS = cfg.verifyTLS === true;
    const caCert = cfg.caCert || void 0;
    this.forwardRules = Array.isArray(cfg.forwardEvents) ? cfg.forwardEvents : [];
    if (!host || !token) {
      this.log.warn("Controller host or API token missing \u2014 open the admin UI to configure.");
      this.setConnectionStatus(false, null);
      return;
    }
    this.http = new import_unifiHttp.UnifiHttp({ host, port, token, verifyTLS, caCert, debugLog: (m) => this.log.debug(m) });
    if (cfg.enableProtect === true && cfg.protectUsername) {
      this.protectHttp = new import_protectHttp.ProtectHttp({
        host,
        username: cfg.protectUsername,
        password: (_c = cfg.protectPassword) != null ? _c : "",
        verifyTLS
      });
      try {
        await this.protectHttp.login();
        this.log.info("UniFi Protect API client initialized");
      } catch (err) {
        this.log.warn(`Protect login failed: ${err.message}`);
        this.protectHttp = null;
      }
    } else if (cfg.enableProtect === true) {
      this.log.warn("[protect] integration enabled but no username configured \u2014 skipping");
    } else {
      this.log.debug("[protect] integration disabled");
    }
    this.subscribeStates("doors.*.unlock");
    this.subscribeStates("doors.emergency.*");
    this.subscribeStates("admin.uiSettings");
    await this.bootstrapAndConnect();
    await this.startSharedHttpServer();
  }
  buildTlsOptions() {
    const cfg = this.config;
    if (cfg.enableTls !== true) {
      return void 0;
    }
    this.log.warn(
      "TLS is enabled but the adapter does not yet load certificates from the ioBroker certificate store \u2014 please configure a reverse proxy or extend loadCertificates()."
    );
    return void 0;
  }
  buildServerBaseUrl() {
    const cfg = this.config;
    const port = cfg.listenPort || 8095;
    const scheme = cfg.enableTls === true ? "https" : "http";
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
  buildWebhookPublicUrl() {
    const base = this.buildServerBaseUrl();
    return base ? `${base}${WEBHOOK_PATH}` : null;
  }
  async startSharedHttpServer() {
    const cfg = this.config;
    const port = cfg.listenPort || 8095;
    const ip = cfg.listenIp && cfg.listenIp !== "0.0.0.0" ? cfg.listenIp : void 0;
    const tls = this.buildTlsOptions();
    const logger = {
      debug: (m) => this.log.debug(m),
      info: (m) => this.log.info(m),
      warn: (m) => this.log.warn(m)
    };
    const server = new import_sharedHttpServer.SharedHttpServer({ port, ip, tls, logger });
    if (cfg.enableWebhooks === true) {
      if (!this.http) {
        this.log.warn("Webhook receiver not enabled: no HTTP client.");
      } else {
        this.webhookEndpointId = cfg.webhookEndpointId || null;
        this.webhookSecret = cfg.webhookSecret || null;
        const handler = new import_server.WebhookHandler({
          path: WEBHOOK_PATH,
          secret: () => this.webhookSecret,
          logger,
          onEvent: (env) => this.handleAccessEvent(env, "webhook")
        });
        server.registerHandler("unifi-webhook", handler.matches, handler.handle);
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
    if (cfg.enableProtect === true && this.protectHttp !== null) {
      const snapshotPrefix = `/unifi-access/${this.instance}/protect-snapshot`;
      const videoPrefix = `/unifi-access/${this.instance}/protect-video`;
      const protect = this.protectHttp;
      const protectHandler = new import_protectSnapshotEndpoint.ProtectMediaHandler({
        snapshotPathPrefix: snapshotPrefix,
        videoPathPrefix: videoPrefix,
        getSnapshot: (cameraId, ts) => this.protectSnapshotCache.get(`${cameraId}:${ts}`),
        fetchSnapshot: (cameraId) => protect.getSnapshot(cameraId),
        getEventMeta: (eventId) => protect.getEventMeta(eventId),
        fetchClip: (clipPath) => protect.getClipBuffer(clipPath),
        logger
      });
      server.registerHandler("protect-media", protectHandler.matches, protectHandler.handle);
    }
    if (cfg.enableGenericWebhook === true) {
      const handler = new import_genericWebhookServer.GenericWebhookHandler({
        path: cfg.genericWebhookPath || "/webhook",
        auth: cfg.genericWebhookAuth || "none",
        username: cfg.genericWebhookUsername || void 0,
        password: cfg.genericWebhookPassword || void 0,
        token: cfg.genericWebhookToken || void 0,
        logger,
        onRequest: async ({ body, method, url }) => {
          const raw = body.toString("utf8");
          this.log.info(`[generic-webhook] ${method} ${url} | body: ${raw.slice(0, 2e3)}`);
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
      server.registerHandler("generic-webhook", handler.matches, handler.handle);
    }
    try {
      await server.start();
      this.httpServer = server;
    } catch (err) {
      this.log.warn(`Shared HTTP server failed to start: ${err.message}`);
      this.httpServer = null;
      return;
    }
    if (cfg.enableWebhooks === true && this.http) {
      const publicUrl = this.buildWebhookPublicUrl();
      if (!publicUrl) {
        this.log.warn("Webhook registration skipped: no usable network address found.");
      } else {
        try {
          const result = await (0, import_registration.ensureRegistration)({
            http: this.http,
            publicUrl,
            name: `ioBroker.unifi-access (${this.namespace})`,
            events: import_registration.DEFAULT_WEBHOOK_EVENTS,
            logger
          });
          this.webhookEndpointId = result.id;
          this.webhookSecret = result.secret;
          await this.persistWebhookCredentials(result.id, result.secret);
          await this.setState("info.webhookRegistered", { val: true, ack: true });
        } catch (err) {
          this.log.warn(`Webhook registration failed: ${err.message}`);
          await this.setState("info.webhookRegistered", { val: false, ack: true });
        }
      }
    }
  }
  async bootstrapAndConnect() {
    var _a;
    if (!this.http) {
      return;
    }
    try {
      const [devices, doors, users] = await Promise.all([
        this.http.listDevices(),
        this.http.listDoors(),
        this.http.listUsers().catch(() => [])
      ]);
      this.userNameCache.clear();
      for (const u of users) {
        const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.user_email || u.id;
        this.userNameCache.set(u.id, name);
      }
      await this.applyBootstrap({ devices, doors });
      await this.refreshEmergencyStatus();
      this.setConnectionStatus(true, null);
      this.log.info(`Connected to UniFi Access controller. ${devices.length} devices, ${doors.length} doors.`);
      this.startWebSocket();
    } catch (err) {
      const kind = (0, import_unifiHttp.classifyError)(err);
      this.setConnectionStatus(false, kind);
      const axErr = err;
      if (((_a = axErr.response) == null ? void 0 : _a.status) === 404) {
        this.log.warn(
          `Bootstrap failed: 404 \u2014 verify that host and port point to a UniFi Access controller (${this.http.url}).`
        );
      } else {
        this.log.warn(`Bootstrap failed (${kind}): ${err.message}`);
      }
      this.scheduleBootstrapRetry();
    }
  }
  scheduleBootstrapRetry() {
    if (this.bootstrapRetryTimer) {
      this.clearTimeout(this.bootstrapRetryTimer);
    }
    this.bootstrapRetryTimer = this.setTimeout(() => {
      this.bootstrapRetryTimer = void 0;
      void this.bootstrapAndConnect();
    }, 3e4);
  }
  async applyBootstrap(data) {
    var _a, _b, _c, _d, _e, _f, _g;
    await this.library.applyBootstrap(data);
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
        firmware: d.firmware,
        // Only an explicit `online: false` means offline; if the field is missing the
        // device is at least known to the controller, so default to online.
        online: d.online !== false,
        capabilities: (0, import_deviceModels.featuresFor)(model),
        lastSeenAt: void 0
      });
    }
    const first = data.devices[0];
    this.controllerName = (_f = (_e = first == null ? void 0 : first.alias) != null ? _e : first == null ? void 0 : first.name) != null ? _f : null;
    if (this.config.enableProtect) {
      const connected = ((_g = this.protectHttp) == null ? void 0 : _g.isLoggedIn()) === true;
      await this.setState("info.protectConnected", { val: connected, ack: true });
      this.log.debug(`[protect] info.protectConnected = ${String(connected)}`);
    }
  }
  startWebSocket() {
    var _a, _b, _c;
    const cfg = this.config;
    const host = (_a = cfg.controllerHost) != null ? _a : "";
    const port = cfg.controllerPort || 12445;
    const token = (_b = cfg.apiToken) != null ? _b : "";
    const verifyTLS = cfg.verifyTLS === true;
    const caCert = cfg.caCert || void 0;
    (_c = this.ws) == null ? void 0 : _c.stop();
    this.ws = new import_unifiWebSocket.UnifiWebSocket({
      host,
      port,
      token,
      verifyTLS,
      caCert,
      reconnectDelaySeconds: cfg.wsReconnectDelay || 5,
      logger: {
        debug: (m) => this.log.debug(m),
        info: (m) => this.log.info(m),
        warn: (m) => this.log.warn(m)
      }
    });
    this.ws.on("open", () => {
      this.log.info("UniFi Access WebSocket open.");
      this.setConnectionStatus(true, null);
    });
    this.ws.on("close", () => {
      this.log.debug("UniFi Access WebSocket closed.");
    });
    this.ws.on("error", (err) => {
      this.log.warn(`WebSocket error: ${err.message}`);
    });
    this.ws.on("event", (msg) => {
      void this.handleAccessEvent(msg, "ws");
    });
    this.ws.start();
  }
  async persistWebhookCredentials(id, secret) {
    await this.setState("info.webhookEndpointId", { val: id, ack: true });
    await this.setState("info.webhookSecret", { val: secret, ack: true });
    await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
      native: { webhookEndpointId: id, webhookSecret: this.encrypt(secret) }
    });
  }
  async handleAccessEvent(msg, source) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p;
    if (!msg.event) {
      return;
    }
    const ts = typeof msg.timestamp === "number" ? msg.timestamp : typeof msg.timestamp === "string" ? Date.parse(msg.timestamp) || Date.now() : Date.now();
    const data = (_a = msg.data) != null ? _a : {};
    const dataDevice = (_b = data.device) != null ? _b : void 0;
    const dataIsLocation = typeof data.location_type === "string" && typeof data.unique_id === "string";
    const location = (_c = data.location) != null ? _c : dataIsLocation ? data : void 0;
    const extras = (_d = location == null ? void 0 : location.extras) != null ? _d : void 0;
    const actor = (_e = data.actor) != null ? _e : void 0;
    const thumbnailPath = (_f = extras == null ? void 0 : extras.door_thumbnail) != null ? _f : data.door_thumbnail;
    const REMOTE_VIEW_CHANGE_REASONS = {
      105: "timeout",
      106: "admin_rejected",
      107: "admin_unlocked",
      108: "visitor_cancelled",
      400: "answered_elsewhere"
    };
    let subtype;
    if (msg.event === "access.remote_view.change") {
      const code = Number((_g = data.reason_code) != null ? _g : -1);
      subtype = REMOTE_VIEW_CHANGE_REASONS[code];
    } else if (msg.event === "access.device.dps_status") {
      const val = (_h = data.dps_status) != null ? _h : data.value;
      subtype = typeof val === "string" ? val : void 0;
    }
    const event = {
      ts,
      source,
      type: msg.event,
      subtype,
      deviceId: (_j = (_i = data.device_id) != null ? _i : dataDevice == null ? void 0 : dataDevice.id) != null ? _j : msg.event === "access.data.device.remote_unlock" ? msg.event_object_id : void 0,
      deviceName: (_l = (_k = data.device_name) != null ? _k : dataDevice == null ? void 0 : dataDevice.name) != null ? _l : dataDevice == null ? void 0 : dataDevice.alias,
      doorId: (_n = (_m = data.door_id) != null ? _m : location == null ? void 0 : location.id) != null ? _n : location == null ? void 0 : location.unique_id,
      doorName: (_o = data.door_name) != null ? _o : location == null ? void 0 : location.name,
      userName: (_p = data.user_name) != null ? _p : actor == null ? void 0 : actor.name,
      thumbnailPath,
      raw: msg
    };
    if (USER_RELEVANT_EVENTS.has(event.type)) {
      if (event.type === "access.data.device.remote_unlock" && event.doorId) {
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
        }, 4e3);
        if (t) {
          this.unlockPendingTimers.set(doorId, t);
        }
      } else if (event.type === "access.door.unlock" && event.doorId) {
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
  async dispatchEvent(event, raw) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m;
    switch (event.type) {
      case "access.remote_view":
        await this.setState("doorbell.activeCallId", {
          val: (_a = raw.event_object_id) != null ? _a : null,
          ack: true
        });
        await this.setState("doorbell.activeFromDevice", {
          val: (_d = (_c = (_b = event.doorName) != null ? _b : event.deviceName) != null ? _c : event.deviceId) != null ? _d : null,
          ack: true
        });
        await this.setState("doorbell.activeStartedAt", { val: event.ts, ack: true });
        if (event.thumbnailPath) {
          const tid = (_e = this.extractReaderIdFromPath(event.thumbnailPath)) != null ? _e : event.deviceId;
          if (tid) {
            await this.setThumbnail(tid, event.thumbnailPath, event.ts);
          }
        }
        break;
      case "access.remote_view.change": {
        const reason = Number((_g = (_f = raw.data) == null ? void 0 : _f.reason_code) != null ? _g : -1);
        if (reason === 105 || reason === 106 || reason === 108 || reason === 400) {
          await this.setState("doorbell.activeCallId", { val: null, ack: true });
          await this.setState("doorbell.activeFromDevice", { val: null, ack: true });
          await this.setState("doorbell.activeStartedAt", { val: null, ack: true });
        }
        break;
      }
      case "access.data.device.remote_unlock":
        if (event.doorId) {
          const channelId = `doors.${this.safeId(event.doorId)}.locked`;
          await this.setState(channelId, { val: false, ack: true });
        }
        if (event.thumbnailPath) {
          const tid = (_h = this.extractReaderIdFromPath(event.thumbnailPath)) != null ? _h : event.deviceId;
          if (tid) {
            await this.setThumbnail(tid, event.thumbnailPath, event.ts);
          }
        }
        break;
      case "access.door.unlock":
        if (event.doorId) {
          const channelId = `doors.${this.safeId(event.doorId)}.locked`;
          await this.setState(channelId, { val: false, ack: true });
        }
        if (event.thumbnailPath) {
          const tid = (_i = this.extractReaderIdFromPath(event.thumbnailPath)) != null ? _i : event.deviceId;
          if (tid) {
            await this.setThumbnail(tid, event.thumbnailPath, event.ts);
          }
        }
        this.log.debug(`[event] ${event.type} for doorId=${event.doorId}, setting locked=false`);
        this.logSystemLogs(event.ts);
        break;
      case "access.doorbell.incoming":
      case "access.doorbell.incoming.REN":
        if (event.thumbnailPath) {
          const tid = (_j = this.extractReaderIdFromPath(event.thumbnailPath)) != null ? _j : event.deviceId;
          if (tid) {
            await this.setThumbnail(tid, event.thumbnailPath, event.ts);
          }
        }
        break;
      case "access.device.dps_status":
        if (event.doorId) {
          const value = (_m = (_k = raw.data) == null ? void 0 : _k.dps_status) != null ? _m : (_l = raw.data) == null ? void 0 : _l.value;
          await this.setState(`doors.${this.safeId(event.doorId)}.position`, {
            val: typeof value === "string" ? value : "unknown",
            ack: true
          });
        }
        break;
      case "access.device.emergency_status":
        void this.refreshEmergencyStatus();
        break;
      case "access.temporary_unlock.start":
        this.logSystemLogs(event.ts);
        break;
    }
  }
  async updateDeviceFromEventData(dataDevice, ts) {
    if (!(dataDevice == null ? void 0 : dataDevice.id) || typeof dataDevice.id !== "string") {
      return;
    }
    const safe = this.safeId(dataDevice.id);
    const isoTs = new Date(ts).toISOString();
    if (typeof dataDevice.firmware === "string" && dataDevice.firmware) {
      await this.setState(`devices.${safe}.firmware`, { val: dataDevice.firmware, ack: true });
    }
    if (typeof dataDevice.online === "boolean") {
      await this.setState(`devices.${safe}.online`, { val: dataDevice.online, ack: true });
    }
    await this.setState(`devices.${safe}.lastSeenAt`, { val: isoTs, ack: true });
    const cached = this.devices.get(dataDevice.id);
    if (cached) {
      if (typeof dataDevice.firmware === "string" && dataDevice.firmware) {
        cached.firmware = dataDevice.firmware;
      }
      if (typeof dataDevice.online === "boolean") {
        cached.online = dataDevice.online;
      }
      cached.lastSeenAt = isoTs;
    }
  }
  async setThumbnail(deviceId, path, ts) {
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
  async applyForwardRules(event) {
    for (const rule of this.forwardRules) {
      if (!(rule == null ? void 0 : rule.event) || !(rule == null ? void 0 : rule.targetState)) {
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
        this.log.debug(`Forward to ${rule.targetState} failed: ${err.message}`);
      }
    }
  }
  setConnectionStatus(connected, lastError) {
    this.connectedToController = connected;
    this.lastErrorKind = lastError;
    void this.setState("info.connection", connected, true);
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
  async handleGenericAlarm(payload, raw) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m;
    const first = (_a = payload.events) == null ? void 0 : _a[0];
    const locationId = (_d = (_c = first == null ? void 0 : first.location) != null ? _c : (_b = first == null ? void 0 : first.scope) == null ? void 0 : _b.locations) != null ? _d : "";
    const userId = (_e = first == null ? void 0 : first.user) != null ? _e : "";
    const locationName = (_g = (_f = typeof locationId === "string" && locationId ? this.doorNameCache.get(locationId) : void 0) != null ? _f : typeof (first == null ? void 0 : first.location_name) === "string" && first.location_name ? first.location_name : void 0) != null ? _g : locationId;
    const userName = (_i = (_h = typeof userId === "string" && userId ? this.userNameCache.get(userId) : void 0) != null ? _h : typeof (first == null ? void 0 : first.user_name) === "string" && first.user_name ? first.user_name : void 0) != null ? _i : userId;
    await this.setState("notifications.lastRaw", { val: raw, ack: true });
    await this.setState("notifications.lastAlarmId", { val: (_j = payload.alarm_id) != null ? _j : "", ack: true });
    await this.setState("notifications.lastEventType", { val: (_k = first == null ? void 0 : first.id) != null ? _k : "", ack: true });
    await this.setState("notifications.lastLocationId", { val: locationId, ack: true });
    await this.setState("notifications.lastLocationName", { val: locationName, ack: true });
    await this.setState("notifications.lastUserId", { val: userId, ack: true });
    await this.setState("notifications.lastUserName", { val: userName, ack: true });
    await this.setState("notifications.lastDirection", { val: (_l = first == null ? void 0 : first.direction) != null ? _l : "", ack: true });
    await this.setState("notifications.lastUnlockMethod", { val: (_m = first == null ? void 0 : first.unlock_method_text) != null ? _m : "", ack: true });
    const ts = (first == null ? void 0 : first.time) && typeof first.time === "string" && first.time ? Date.parse(first.time) || Date.now() : Date.now();
    await this.setState("notifications.lastTimestamp", { val: ts, ack: true });
  }
  onStateChange(id, state) {
    if (!state || state.ack) {
      return;
    }
    const localId = id.startsWith(`${this.namespace}.`) ? id.slice(this.namespace.length + 1) : id;
    if (localId.startsWith("doors.") && localId.endsWith(".unlock")) {
      const doorId = localId.slice("doors.".length, -".unlock".length);
      void this.handleDoorUnlock(doorId);
      return;
    }
    if (localId === "doors.emergency.lockdown") {
      void this.handleEmergencyChange("lockdown", state.val === true);
      return;
    }
    if (localId === "doors.emergency.evacuation") {
      void this.handleEmergencyChange("evacuation", state.val === true);
      return;
    }
  }
  async handleEmergencyChange(field, val) {
    if (!this.http) {
      return;
    }
    const sibling = field === "lockdown" ? "evacuation" : "lockdown";
    const siblingState = await this.getStateAsync(`doors.emergency.${sibling}`);
    const siblingVal = (siblingState == null ? void 0 : siblingState.val) === true;
    const payload = field === "lockdown" ? { lockdown: val, evacuation: siblingVal } : { lockdown: siblingVal, evacuation: val };
    try {
      await this.http.setEmergencyStatus(payload);
      await this.setState(`doors.emergency.${field}`, { val, ack: true });
      this.log.info(`Emergency status: lockdown=${payload.lockdown}, evacuation=${payload.evacuation}`);
    } catch (err) {
      this.log.warn(`Set emergency status failed: ${err.message}`);
    }
  }
  async refreshEmergencyStatus() {
    if (!this.http) {
      return;
    }
    try {
      const emergency = await this.http.getEmergencyStatus();
      await this.setState("doors.emergency.lockdown", { val: emergency.lockdown, ack: true });
      await this.setState("doors.emergency.evacuation", { val: emergency.evacuation, ack: true });
    } catch {
      this.log.debug("Emergency status endpoint not available (requires UniFi Access >= 1.24.6).");
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
    const cfg = this.config;
    const minutes = Math.max(0, Math.floor(cfg.defaultUnlockDuration || 0));
    try {
      if (minutes > 0) {
        await this.http.setDoorLockRule(safeDoorId, { type: "custom", interval: minutes });
        this.log.info(`Door ${safeDoorId} unlocked for ${minutes} min via lock_rule.`);
      } else {
        await this.http.unlockDoor(safeDoorId);
        this.log.info(`Door ${safeDoorId} unlocked (pulse).`);
      }
      await this.setState(`doors.${safeDoorId}.unlock`, { val: true, ack: true });
      await this.setState(`doors.${safeDoorId}.locked`, { val: false, ack: true });
      const resetMs = minutes > 0 ? minutes * 60 * 1e3 : 5e3;
      this.setTimeout(() => {
        void this.setState(`doors.${safeDoorId}.locked`, { val: true, ack: true });
      }, resetMs);
    } catch (err) {
      this.log.warn(`Unlock door ${safeDoorId} failed: ${err.message}`);
    }
  }
  onMessage(msg) {
    this.log.debug(`Message: ${JSON.stringify({ command: msg.command })}`);
    if (msg.command === "getConnectionStatus") {
      this.sendTo(
        msg.from,
        msg.command,
        {
          connected: this.connectedToController,
          lastError: this.lastErrorKind,
          hasToken: !!this.config.apiToken,
          controllerName: this.controllerName,
          webhookRegistered: this.webhookEndpointId !== null && this.webhookSecret !== null
        },
        msg.callback
      );
      return;
    }
    if (msg.command === "listDevices") {
      const devices = Array.from(this.devices.values()).map((d) => ({
        id: d.id,
        name: d.name,
        alias: d.alias,
        type: d.type,
        model: d.model,
        firmware: d.firmware,
        online: d.online,
        capabilities: d.capabilities,
        lastSeenAt: d.lastSeenAt
      }));
      this.sendTo(msg.from, msg.command, { devices }, msg.callback);
      return;
    }
    if (msg.command === "verifyToken") {
      void this.handleVerifyToken(msg);
      return;
    }
    if (msg.command === "reregisterWebhook") {
      void this.handleReregisterWebhook(msg);
      return;
    }
    if (msg.command === "getNetworkInterfaces") {
      const ifaces = (0, import_node_os.networkInterfaces)();
      const addresses = [];
      for (const nets of Object.values(ifaces)) {
        for (const net of nets != null ? nets : []) {
          if (net.family === "IPv4" && !net.internal) {
            addresses.push(net.address);
          }
        }
      }
      this.sendTo(msg.from, msg.command, { addresses }, msg.callback);
      return;
    }
  }
  async handleVerifyToken(msg) {
    var _a, _b, _c, _d, _e, _f;
    const payload = (_a = msg.message) != null ? _a : {};
    const host = (_b = payload.host) != null ? _b : "";
    const port = (_c = payload.port) != null ? _c : 12445;
    const token = (_d = payload.token) != null ? _d : "";
    const verifyTLS = payload.verifyTLS === true;
    if (!host || !token) {
      this.sendTo(msg.from, msg.command, { ok: false, error: "missing-fields" }, msg.callback);
      return;
    }
    const probe = new import_unifiHttp.UnifiHttp({ host, port, token, verifyTLS });
    try {
      const devices = await probe.listDevices();
      const first = devices[0];
      const name = (_f = (_e = first == null ? void 0 : first.alias) != null ? _e : first == null ? void 0 : first.name) != null ? _f : null;
      this.sendTo(msg.from, msg.command, { ok: true, controllerName: name }, msg.callback);
    } catch (err) {
      this.sendTo(msg.from, msg.command, { ok: false, error: (0, import_unifiHttp.classifyError)(err) }, msg.callback);
    }
  }
  async handleReregisterWebhook(msg) {
    const publicUrl = this.buildWebhookPublicUrl();
    if (!this.http || !publicUrl) {
      this.sendTo(msg.from, msg.command, { ok: false, error: "not-configured" }, msg.callback);
      return;
    }
    try {
      const result = await (0, import_registration.reregister)(
        {
          http: this.http,
          publicUrl,
          name: `ioBroker.unifi-access (${this.namespace})`,
          events: import_registration.DEFAULT_WEBHOOK_EVENTS,
          logger: {
            debug: (m) => this.log.debug(m),
            info: (m) => this.log.info(m),
            warn: (m) => this.log.warn(m)
          }
        },
        this.webhookEndpointId
      );
      this.webhookEndpointId = result.id;
      this.webhookSecret = result.secret;
      await this.persistWebhookCredentials(result.id, result.secret);
      this.sendTo(msg.from, msg.command, { ok: true, id: result.id }, msg.callback);
    } catch (err) {
      this.sendTo(msg.from, msg.command, { ok: false, error: err.message }, msg.callback);
    }
  }
  logSystemLogs(ts) {
    if (!this.http) {
      return;
    }
    const http = this.http;
    this.setTimeout(async () => {
      const since = Math.floor(ts / 1e3) - 10;
      const until = Math.floor(ts / 1e3) + 30;
      for (const topic of ["door_openings", "all"]) {
        try {
          const raw = await http.fetchSystemLogsRaw(topic, since, until);
          this.log.debug(`[system-logs:${topic}] ${JSON.stringify(raw)}`);
          if (topic === "all") {
            await this.processSystemLogForProtect(raw, ts);
          }
        } catch (err) {
          this.log.warn(`[system-logs:${topic}] fetch failed: ${err.message}`);
        }
      }
    }, 3e3);
  }
  async processSystemLogForProtect(raw, eventTs) {
    var _a, _b, _c, _d;
    const protect = this.protectHttp;
    if (!this.config.enableProtect || !(protect == null ? void 0 : protect.isLoggedIn())) {
      this.log.debug(
        `[protect] skipping system log scan: enableProtect=${String(this.config.enableProtect)}, loggedIn=${String((_a = protect == null ? void 0 : protect.isLoggedIn()) != null ? _a : false)}`
      );
      return;
    }
    const hits = (_b = raw == null ? void 0 : raw.data) == null ? void 0 : _b.hits;
    if (!Array.isArray(hits)) {
      this.log.debug("[protect] no hits array in system log response");
      return;
    }
    this.log.debug(`[protect] scanning ${hits.length} system log hit(s) for camera events`);
    for (const hit of hits) {
      const targets = (_c = hit == null ? void 0 : hit._source) == null ? void 0 : _c.target;
      if (!Array.isArray(targets)) {
        continue;
      }
      for (const target of targets) {
        const t = target;
        if ((t == null ? void 0 : t.type) !== "camera event") {
          continue;
        }
        const id = t.id;
        if (typeof id !== "string" || !id.startsWith("protect_")) {
          this.log.debug(`[protect] camera event with unexpected id format: ${String(id)}`);
          continue;
        }
        const parts = id.split("_");
        if (parts.length < 2) {
          continue;
        }
        const cameraId = parts[1];
        const eventId = parts.length >= 3 ? parts.slice(2).join("_") : void 0;
        if (!cameraId) {
          continue;
        }
        this.log.debug(`[protect] camera event found: cameraId=${cameraId}, eventId=${eventId != null ? eventId : "none"}`);
        try {
          const buf = await protect.getSnapshot(cameraId);
          const cacheKey = `${cameraId}:${eventTs}`;
          if (!this.protectSnapshotCache.has(cacheKey)) {
            if (this.protectSnapshotCacheOrder.length >= UnifiAccess.PROTECT_CACHE_MAX) {
              const oldest = this.protectSnapshotCacheOrder.shift();
              this.protectSnapshotCache.delete(oldest);
            }
            this.protectSnapshotCacheOrder.push(cacheKey);
            this.protectSnapshotCache.set(cacheKey, buf);
          }
          const base = (_d = this.buildServerBaseUrl()) != null ? _d : "";
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
          this.log.warn(`[protect] snapshot fetch for camera ${cameraId} failed: ${err.message}`);
        }
      }
    }
  }
  async onUnload(callback) {
    var _a;
    try {
      (_a = this.ws) == null ? void 0 : _a.stop();
      this.ws = null;
      if (this.bootstrapRetryTimer) {
        this.clearTimeout(this.bootstrapRetryTimer);
        this.bootstrapRetryTimer = void 0;
      }
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
