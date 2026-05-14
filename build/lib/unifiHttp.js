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
var unifiHttp_exports = {};
__export(unifiHttp_exports, {
  UnifiHttp: () => UnifiHttp,
  classifyError: () => classifyError
});
module.exports = __toCommonJS(unifiHttp_exports);
var import_axios = __toESM(require("axios"));
var import_node_https = __toESM(require("node:https"));
class UnifiHttp {
  client;
  baseUrl;
  constructor(options) {
    this.baseUrl = `https://${options.host}:${options.port}`;
    this.client = import_axios.default.create({
      baseURL: this.baseUrl,
      timeout: 1e4,
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: "application/json"
      },
      httpsAgent: new import_node_https.default.Agent({
        rejectUnauthorized: options.verifyTLS === true,
        ca: options.caCert ? options.caCert : void 0
      })
    });
    if (options.debugLog) {
      const log = options.debugLog;
      this.client.interceptors.response.use((r) => {
        var _a, _b;
        if ((_a = r.config.url) == null ? void 0 : _a.includes("webhooks")) {
          log(`webhook response [${(_b = r.config.method) == null ? void 0 : _b.toUpperCase()} ${r.config.url}] status=${r.status} body=${JSON.stringify(r.data)}`);
        }
        return r;
      });
    }
  }
  get url() {
    return this.baseUrl;
  }
  /** Lightweight connectivity + token check — lists devices (read-only). */
  async verify() {
    await this.client.get("/api/v1/developer/devices");
  }
  async listDevices() {
    var _a;
    const r = await this.client.get(
      "/api/v1/developer/devices?refresh=true"
    );
    const data = (_a = r.data) == null ? void 0 : _a.data;
    if (!Array.isArray(data)) {
      return [];
    }
    const first = data[0];
    if (Array.isArray(first)) {
      return data.flat();
    }
    return data;
  }
  async listDoors() {
    var _a, _b;
    const r = await this.client.get("/api/v1/developer/doors");
    return (_b = (_a = r.data) == null ? void 0 : _a.data) != null ? _b : [];
  }
  async listUsers() {
    var _a, _b;
    const r = await this.client.get("/api/v1/developer/users");
    return (_b = (_a = r.data) == null ? void 0 : _a.data) != null ? _b : [];
  }
  /**
   * Pulse-unlock a door. Optionally pass actor to customize what appears in UniFi Access logs.
   * Both actor.id and actor.name must be provided together (API requirement).
   *
   * @param doorId UniFi door identifier
   * @param actor  Optional actor identity shown in system logs and webhooks
   */
  async unlockDoor(doorId, actor) {
    const body = {};
    if ((actor == null ? void 0 : actor.id) && (actor == null ? void 0 : actor.name)) {
      body.actor_id = actor.id;
      body.actor_name = actor.name;
    }
    await this.client.put(`/api/v1/developer/doors/${encodeURIComponent(doorId)}/unlock`, body);
  }
  /**
   * Set a door lock rule. Use type='custom' with interval (in MINUTES) for a timed unlock,
   * keep_lock/keep_unlock for indefinite states, reset/lock_early/lock_now to revert.
   *
   * @param doorId  UniFi door identifier
   * @param payload Lock-rule payload (type and optional interval in minutes)
   */
  async setDoorLockRule(doorId, payload) {
    await this.client.put(`/api/v1/developer/doors/${encodeURIComponent(doorId)}/lock_rule`, payload);
  }
  /**
   * Fetch a static resource (avatar, preview, capture thumbnail). The path is the
   * relative string returned in event payloads, e.g. /preview/reader_xxx.jpg.
   *
   * @param path Relative resource path from the event payload
   */
  async getStaticResource(path) {
    const cleaned = path.replace(/^\/+/, "");
    const r = await this.client.get(`/api/v1/developer/system/static/${cleaned}`, {
      responseType: "arraybuffer"
    });
    return Buffer.from(r.data);
  }
  async getEmergencyStatus() {
    var _a, _b;
    const r = await this.client.get("/api/v1/developer/doors/settings/emergency");
    return (_b = (_a = r.data) == null ? void 0 : _a.data) != null ? _b : { lockdown: false, evacuation: false };
  }
  async setEmergencyStatus(payload) {
    await this.client.put("/api/v1/developer/doors/settings/emergency", payload);
  }
  async listWebhookEndpoints() {
    var _a, _b;
    const r = await this.client.get("/api/v1/developer/webhooks/endpoints");
    return (_b = (_a = r.data) == null ? void 0 : _a.data) != null ? _b : [];
  }
  async createWebhookEndpoint(payload) {
    var _a, _b, _c;
    const r = await this.client.post(
      "/api/v1/developer/webhooks/endpoints",
      payload
    );
    return { code: (_b = (_a = r.data) == null ? void 0 : _a.code) != null ? _b : "SUCCESS", endpoint: (_c = r.data) == null ? void 0 : _c.data };
  }
  async deleteWebhookEndpoint(id) {
    await this.client.delete(`/api/v1/developer/webhooks/endpoints/${encodeURIComponent(id)}`);
  }
  async fetchSystemLogsRaw(topic, since, until) {
    const r = await this.client.post("/api/v1/developer/system/logs", { topic, since, until });
    return r.data;
  }
}
function classifyError(err) {
  var _a, _b;
  if (err instanceof import_axios.AxiosError) {
    if (((_a = err.response) == null ? void 0 : _a.status) === 401 || ((_b = err.response) == null ? void 0 : _b.status) === 403) {
      return "unauthorized";
    }
  }
  return "network";
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  UnifiHttp,
  classifyError
});
//# sourceMappingURL=unifiHttp.js.map
