"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var unifiWebSocket_exports = {};
__export(unifiWebSocket_exports, {
  UnifiWebSocket: () => UnifiWebSocket
});
module.exports = __toCommonJS(unifiWebSocket_exports);
var import_node_events = require("node:events");
var import_ws = __toESM(require("ws"));
var import_caCert = require("./caCert");
const DEFAULT_HEARTBEAT_MS = 3e4;
const DEFAULT_STABLE_AFTER_MS = 3e4;
class UnifiWebSocket extends import_node_events.EventEmitter {
  options;
  socket = null;
  reconnectTimer;
  heartbeatTimer;
  stableTimer;
  awaitingPong = false;
  retryAttempt = 0;
  stopped = true;
  constructor(options) {
    super();
    this.options = options;
  }
  on(event, listener) {
    return super.on(event, listener);
  }
  emit(event, ...args) {
    return super.emit(event, ...args);
  }
  /** Whether the connection is currently established. */
  get isOpen() {
    var _a;
    return ((_a = this.socket) == null ? void 0 : _a.readyState) === import_ws.default.OPEN;
  }
  start() {
    this.dropConnection();
    this.stopped = false;
    this.retryAttempt = 0;
    this.connect();
  }
  stop() {
    this.stopped = true;
    this.dropConnection();
  }
  /** Cancel timers and terminate the current socket without scheduling a reconnect. */
  dropConnection() {
    if (this.reconnectTimer !== void 0) {
      this.options.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = void 0;
    }
    this.stopStableTimer();
    this.stopHeartbeat();
    const ws = this.socket;
    this.socket = null;
    if (ws) {
      try {
        ws.terminate();
      } catch {
      }
    }
  }
  connect() {
    const { host, port, token, verifyTLS, caCert, logger } = this.options;
    const url = `wss://${host}:${port}/api/v1/developer/devices/notifications`;
    logger == null ? void 0 : logger.debug(`opening WebSocket: ${url}`);
    const ws = new import_ws.default(url, {
      rejectUnauthorized: verifyTLS === true,
      ca: (0, import_caCert.trustedCertificates)(caCert),
      headers: { Authorization: `Bearer ${token}` },
      handshakeTimeout: 1e4
    });
    this.socket = ws;
    const isCurrent = () => this.socket === ws;
    ws.on("open", () => {
      if (!isCurrent()) {
        return;
      }
      this.startStableTimer(ws);
      this.startHeartbeat(ws);
      this.emit("open");
    });
    ws.on("pong", () => {
      if (isCurrent()) {
        this.awaitingPong = false;
      }
    });
    ws.on("message", (data) => {
      if (!isCurrent()) {
        return;
      }
      this.awaitingPong = false;
      let parsed;
      try {
        parsed = JSON.parse(rawDataToString(data));
      } catch (err) {
        logger == null ? void 0 : logger.debug(`WebSocket frame ignored (not JSON): ${err.message}`);
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.event !== "string") {
        logger == null ? void 0 : logger.debug("WebSocket frame ignored (not an event object).");
        return;
      }
      try {
        this.emit("event", parsed);
      } catch (err) {
        logger == null ? void 0 : logger.warn(`WebSocket event listener failed: ${err.message}`);
      }
    });
    ws.on("close", () => {
      if (!isCurrent()) {
        return;
      }
      this.stopStableTimer();
      this.stopHeartbeat();
      this.socket = null;
      this.emit("close");
      this.scheduleReconnect();
    });
    ws.on("error", (err) => {
      if (!isCurrent()) {
        return;
      }
      if (this.listenerCount("error") > 0) {
        this.emit("error", err);
      } else {
        logger == null ? void 0 : logger.debug(`WebSocket error: ${err.message}`);
      }
    });
  }
  startHeartbeat(ws) {
    var _a;
    this.stopHeartbeat();
    this.awaitingPong = false;
    const period = (_a = this.options.heartbeatIntervalMs) != null ? _a : DEFAULT_HEARTBEAT_MS;
    this.heartbeatTimer = this.options.timers.setInterval(() => {
      var _a2;
      if (this.socket !== ws || ws.readyState !== import_ws.default.OPEN) {
        return;
      }
      if (this.awaitingPong) {
        (_a2 = this.options.logger) == null ? void 0 : _a2.info(
          `WebSocket heartbeat: no answer within ${Math.round(period / 1e3)} s \u2014 dropping the connection.`
        );
        try {
          ws.terminate();
        } catch {
        }
        return;
      }
      this.awaitingPong = true;
      try {
        ws.ping();
      } catch {
      }
    }, period);
  }
  startStableTimer(ws) {
    var _a;
    this.stopStableTimer();
    this.stableTimer = this.options.timers.setTimeout(() => {
      this.stableTimer = void 0;
      if (this.socket === ws && ws.readyState === import_ws.default.OPEN) {
        this.retryAttempt = 0;
      }
    }, (_a = this.options.stableAfterMs) != null ? _a : DEFAULT_STABLE_AFTER_MS);
  }
  stopStableTimer() {
    if (this.stableTimer !== void 0) {
      this.options.timers.clearTimeout(this.stableTimer);
      this.stableTimer = void 0;
    }
  }
  stopHeartbeat() {
    if (this.heartbeatTimer !== void 0) {
      this.options.timers.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = void 0;
    }
    this.awaitingPong = false;
  }
  scheduleReconnect() {
    var _a, _b;
    if (this.stopped) {
      return;
    }
    this.retryAttempt += 1;
    const cap = this.options.reconnectDelaySeconds;
    const delaySeconds = Math.min(cap, 2 ** Math.min(this.retryAttempt, 6));
    const text = `WebSocket reconnect in ${delaySeconds}s (attempt ${this.retryAttempt})`;
    if (this.retryAttempt === 1) {
      (_a = this.options.logger) == null ? void 0 : _a.info(text);
    } else {
      (_b = this.options.logger) == null ? void 0 : _b.debug(text);
    }
    this.reconnectTimer = this.options.timers.setTimeout(() => {
      this.reconnectTimer = void 0;
      if (!this.stopped) {
        this.connect();
      }
    }, delaySeconds * 1e3);
  }
}
function rawDataToString(data) {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return "";
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  UnifiWebSocket
});
//# sourceMappingURL=unifiWebSocket.js.map
