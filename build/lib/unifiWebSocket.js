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
class UnifiWebSocket extends import_node_events.EventEmitter {
  options;
  socket = null;
  reconnectTimer = null;
  heartbeatTimer = null;
  retryAttempt = 0;
  stopped = false;
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
  start() {
    this.stopped = false;
    this.connect();
  }
  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.terminate();
      } catch {
      }
      this.socket = null;
    }
  }
  connect() {
    const { host, port, token, verifyTLS, caCert, logger } = this.options;
    const url = `wss://${host}:${port}/api/v1/developer/devices/notifications`;
    logger == null ? void 0 : logger.debug(`opening WebSocket: ${url}`);
    const ws = new import_ws.default(url, {
      rejectUnauthorized: verifyTLS === true,
      ca: caCert ? caCert : void 0,
      headers: { Authorization: `Bearer ${token}` },
      handshakeTimeout: 1e4
    });
    this.socket = ws;
    ws.on("open", () => {
      this.retryAttempt = 0;
      this.startHeartbeat();
      this.emit("open");
    });
    ws.on("message", (data) => {
      try {
        let text;
        if (typeof data === "string") {
          text = data;
        } else if (Buffer.isBuffer(data)) {
          text = data.toString("utf8");
        } else if (data instanceof ArrayBuffer) {
          text = Buffer.from(data).toString("utf8");
        } else if (Array.isArray(data)) {
          text = Buffer.concat(data).toString("utf8");
        } else {
          text = "";
        }
        const parsed = JSON.parse(text);
        this.emit("event", parsed);
      } catch (err) {
        logger == null ? void 0 : logger.warn(`WebSocket parse error: ${err.message}`);
      }
    });
    ws.on("close", () => {
      this.cleanupSocket();
      this.emit("close");
      this.scheduleReconnect();
    });
    ws.on("error", (err) => {
      logger == null ? void 0 : logger.warn(`WebSocket error: ${err.message}`);
      this.emit("error", err);
    });
  }
  startHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    this.heartbeatTimer = setInterval(() => {
      var _a;
      if (((_a = this.socket) == null ? void 0 : _a.readyState) === import_ws.default.OPEN) {
        try {
          this.socket.ping();
        } catch {
        }
      }
    }, 3e4);
  }
  cleanupSocket() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.socket = null;
  }
  scheduleReconnect() {
    var _a;
    if (this.stopped) {
      return;
    }
    this.retryAttempt += 1;
    const cap = this.options.reconnectDelaySeconds;
    const wait = Math.min(cap, 2 ** Math.min(this.retryAttempt, 6));
    (_a = this.options.logger) == null ? void 0 : _a.info(`WebSocket reconnect in ${wait}s (attempt ${this.retryAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) {
        this.connect();
      }
    }, wait * 1e3);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  UnifiWebSocket
});
//# sourceMappingURL=unifiWebSocket.js.map
