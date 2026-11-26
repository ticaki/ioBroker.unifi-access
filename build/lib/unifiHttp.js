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
  InvalidStaticPathError: () => InvalidStaticPathError,
  UnexpectedResponseError: () => UnexpectedResponseError,
  UnifiApiError: () => UnifiApiError,
  UnifiHttp: () => UnifiHttp,
  apiErrorCode: () => apiErrorCode,
  classifyError: () => classifyError,
  redactSecrets: () => redactSecrets,
  requiredPermission: () => requiredPermission
});
module.exports = __toCommonJS(unifiHttp_exports);
var import_axios = __toESM(require("axios"));
var import_node_https = __toESM(require("node:https"));
var import_pathSafety = require("./pathSafety");
var import_caCert = require("./caCert");
var import_stopSignal = require("./stopSignal");
const STATIC_PREFIX = "/api/v1/developer/system/static/";
class InvalidStaticPathError extends Error {
  constructor() {
    super("invalid static resource path");
    this.name = "InvalidStaticPathError";
  }
}
class UnifiApiError extends Error {
  /** Error code of the envelope, e.g. `CODE_DEVICE_DEVICE_OFFLINE`. */
  code;
  /** `msg` of the envelope, if any. */
  apiMessage;
  httpStatus;
  constructor(code, apiMessage, httpStatus, request) {
    super(`UniFi Access API error ${code}${apiMessage ? `: ${apiMessage}` : ""} [${request}]`);
    this.name = "UnifiApiError";
    this.code = code;
    this.apiMessage = apiMessage;
    this.httpStatus = httpStatus;
  }
}
class UnexpectedResponseError extends Error {
  httpStatus;
  constructor(httpStatus, request, detail = "without the UniFi Access response envelope") {
    super(
      `unexpected response ${detail} (HTTP ${httpStatus}) [${request}] \u2014 do host and port point to the UniFi Access API?`
    );
    this.name = "UnexpectedResponseError";
    this.httpStatus = httpStatus;
  }
}
const API_PREFIX = "/api/v1/developer";
const AUTH_ERROR_CODES = /* @__PURE__ */ new Set(["CODE_AUTH_FAILED", "CODE_ACCESS_TOKEN_INVALID", "CODE_UNAUTHORIZED"]);
const USERS_PAGE_SIZE = 100;
const USERS_MAX_PAGES = 50;
function requiredPermission(method, path) {
  const write = method.toUpperCase() !== "GET";
  if (path.startsWith("/devices")) {
    return write ? "edit:device" : "view:device";
  }
  if (path.startsWith("/doors")) {
    return write ? "edit:space" : "view:space";
  }
  if (path.startsWith("/users")) {
    return write ? "edit:user" : "view:user";
  }
  if (path.startsWith("/system/")) {
    return "view:system_log";
  }
  if (path.startsWith("/webhooks")) {
    return write ? "edit:webhook" : "view:webhook";
  }
  return void 0;
}
function readEnvelope(data, contentType) {
  let body = data;
  if (data instanceof ArrayBuffer || Buffer.isBuffer(data)) {
    if (typeof contentType !== "string" || !contentType.toLowerCase().includes("json")) {
      return {};
    }
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (bytes.length > 65536) {
      return {};
    }
    try {
      body = JSON.parse(bytes.toString("utf8"));
    } catch {
      return {};
    }
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }
  const { code, msg } = body;
  return {
    code: typeof code === "string" && code !== "" ? code : void 0,
    msg: typeof msg === "string" && msg !== "" ? msg : void 0
  };
}
function describeRequest(config) {
  var _a, _b;
  const path = ((_a = config == null ? void 0 : config.url) != null ? _a : "").split("?")[0];
  return `${((_b = config == null ? void 0 : config.method) != null ? _b : "GET").toUpperCase()} ${path}`;
}
function apiErrorCode(err) {
  var _a, _b, _c;
  if (err instanceof UnifiApiError) {
    return err.code;
  }
  if (err instanceof import_axios.AxiosError) {
    return readEnvelope((_a = err.response) == null ? void 0 : _a.data, (_c = (_b = err.response) == null ? void 0 : _b.headers) == null ? void 0 : _c["content-type"]).code;
  }
  return void 0;
}
const REDACTED_KEYS = /secret|token|password|passwd|auth|cookie|key|credential|signature/i;
function redactSecrets(value, depth = 0) {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth > 8) {
    return "[\u2026]";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry, depth + 1));
  }
  const copy = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key.toLowerCase() === "headers" && entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      copy[key] = Object.fromEntries(Object.keys(entry).map((name) => [name, "***"]));
      continue;
    }
    copy[key] = REDACTED_KEYS.test(key) && entry !== null && entry !== void 0 ? "***" : redactSecrets(entry, depth + 1);
  }
  return copy;
}
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
        // system CAs plus the configured certificate(s), repaired if the admin field mangled them
        ca: (0, import_caCert.trustedCertificates)(options.caCert)
      })
    });
    this.client.interceptors.request.use((config) => {
      (0, import_stopSignal.throwIfStopped)(options.isStopped);
      return config;
    });
    this.client.interceptors.response.use(
      (r) => {
        var _a, _b, _c;
        const { code, msg } = readEnvelope(r.data, (_a = r.headers) == null ? void 0 : _a["content-type"]);
        if (code !== void 0 && code !== "SUCCESS") {
          throw new UnifiApiError(code, msg, r.status, describeRequest(r.config));
        }
        const binary = ((_b = r.config) == null ? void 0 : _b.responseType) === "arraybuffer" || ((_c = r.config) == null ? void 0 : _c.responseType) === "stream";
        if (code === void 0 && !binary) {
          throw new UnexpectedResponseError(r.status, describeRequest(r.config));
        }
        return r;
      },
      (err) => {
        var _a, _b;
        if (err instanceof import_axios.AxiosError && err.response) {
          const { code, msg } = readEnvelope(err.response.data, (_a = err.response.headers) == null ? void 0 : _a["content-type"]);
          const request = describeRequest(err.config);
          let text = err.message;
          if (code) {
            text += ` (${code}${msg ? `: ${msg}` : ""})`;
          }
          text += ` [${request}]`;
          if (err.response.status === 403) {
            const path = (_b = request.split(" ")[1]) != null ? _b : "";
            const permission = requiredPermission(
              request.split(" ")[0],
              path.startsWith(API_PREFIX) ? path.slice(API_PREFIX.length) : path
            );
            if (permission) {
              text += ` \u2014 the API token needs the permission "${permission}"`;
            }
          }
          err.message = text;
        }
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
    if (options.debugLog) {
      const log = options.debugLog;
      this.client.interceptors.response.use((r) => {
        var _a, _b;
        if ((_a = r.config.url) == null ? void 0 : _a.includes("webhooks")) {
          log(
            `webhook response [${(_b = r.config.method) == null ? void 0 : _b.toUpperCase()} ${r.config.url}] status=${r.status} body=${JSON.stringify(redactSecrets(r.data))}`
          );
        }
        return r;
      });
    }
  }
  get url() {
    return this.baseUrl;
  }
  async listDevices() {
    var _a;
    const r = await this.client.get(
      "/api/v1/developer/devices?refresh=true"
    );
    const data = (_a = r.data) == null ? void 0 : _a.data;
    if (!Array.isArray(data)) {
      throw new UnexpectedResponseError(r.status, "GET /api/v1/developer/devices", "without a device list");
    }
    const first = data[0];
    if (Array.isArray(first)) {
      return data.flat();
    }
    return data;
  }
  async listDoors() {
    var _a;
    const r = await this.client.get("/api/v1/developer/doors");
    const data = (_a = r.data) == null ? void 0 : _a.data;
    if (!Array.isArray(data)) {
      throw new UnexpectedResponseError(r.status, "GET /api/v1/developer/doors", "without a door list");
    }
    return data;
  }
  /**
   * Fetch a single door (API reference 7.7) — the current lock relay and position status.
   *
   * @param doorId UniFi door identifier
   * @returns The door, or `null` when the response carries no door object
   */
  async getDoor(doorId) {
    var _a;
    const r = await this.client.get(
      `/api/v1/developer/doors/${encodeURIComponent(doorId)}`
    );
    const door = (_a = r.data) == null ? void 0 : _a.data;
    return door && typeof door === "object" && typeof door.id === "string" ? door : null;
  }
  /**
   * Fetch the temporary locking rule of a door (API reference 7.11, UniFi Access 1.24.6 or later).
   *
   * @param doorId UniFi door identifier
   * @returns The rule, or `null` when the response carries no rule object
   */
  async getDoorLockRule(doorId) {
    var _a;
    const r = await this.client.get(
      `/api/v1/developer/doors/${encodeURIComponent(doorId)}/lock_rule`
    );
    const rule = (_a = r.data) == null ? void 0 : _a.data;
    return rule && typeof rule === "object" && !Array.isArray(rule) ? rule : null;
  }
  /**
   * Fetch all users (API reference 3.5) page by page with the documented `page_num` / `page_size`
   * parameters. The default page size without parameters is not documented, so relying on a single
   * request could silently truncate the list.
   *
   * Stops when `pagination.total` is reached, a page is not full, a page brings nothing new, or after
   * {@link USERS_MAX_PAGES} pages. Should the controller reject the parameters on the first request,
   * the plain request of earlier versions is used.
   */
  async listUsers() {
    var _a, _b, _c;
    const users = [];
    const seen = /* @__PURE__ */ new Set();
    for (let page = 1; page <= USERS_MAX_PAGES; page++) {
      let body;
      try {
        body = (await this.client.get("/api/v1/developer/users", {
          params: { page_num: page, page_size: USERS_PAGE_SIZE }
        })).data;
      } catch (err) {
        const status = err instanceof import_axios.AxiosError ? (_a = err.response) == null ? void 0 : _a.status : void 0;
        if (page === 1 && (status === 400 || apiErrorCode(err) === "CODE_PARAMS_INVALID")) {
          const plain = await this.client.get("/api/v1/developer/users");
          return Array.isArray((_b = plain.data) == null ? void 0 : _b.data) ? plain.data.data : [];
        }
        throw err;
      }
      const items = Array.isArray(body == null ? void 0 : body.data) ? body.data : [];
      let added = 0;
      for (const user of items) {
        const key = typeof (user == null ? void 0 : user.id) === "string" ? user.id : void 0;
        if (key !== void 0 && seen.has(key)) {
          continue;
        }
        if (key !== void 0) {
          seen.add(key);
        }
        users.push(user);
        added += 1;
      }
      const total = (_c = body == null ? void 0 : body.pagination) == null ? void 0 : _c.total;
      if (typeof total === "number" && Number.isFinite(total)) {
        if (users.length >= total || items.length === 0) {
          break;
        }
      } else if (items.length < USERS_PAGE_SIZE || added === 0) {
        break;
      }
    }
    return users;
  }
  /**
   * Pulse-unlock a door. Optionally pass actor to customize what appears in UniFi Access logs.
   * Both actor.id and actor.name must be provided together (API requirement).
   *
   * @param doorId UniFi door identifier
   * @param actor  Optional actor identity shown in system logs and webhooks
   * @param actor.id Id of the user the unlock is attributed to
   * @param actor.name Display name of that user
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
   * The path comes from outside (event payloads, a state). It is validated strictly and the request
   * can never leave `/system/static/`: anything with dot segments, encoded characters, a query, a
   * scheme or host is refused with {@link InvalidStaticPathError} before a request is sent.
   *
   * @param path Relative resource path from the event payload
   */
  async getStaticResource(path) {
    const cleaned = (0, import_pathSafety.sanitizeStaticPath)(path);
    if (cleaned === null) {
      throw new InvalidStaticPathError();
    }
    const target = `${STATIC_PREFIX}${cleaned}`;
    const resolved = new URL(target, this.baseUrl);
    if (resolved.origin !== new URL(this.baseUrl).origin || resolved.pathname !== target || resolved.search !== "") {
      throw new InvalidStaticPathError();
    }
    const r = await this.client.get(target, {
      responseType: "arraybuffer"
    });
    return Buffer.from(r.data);
  }
  async getEmergencyStatus() {
    var _a, _b;
    const r = await this.client.get("/api/v1/developer/doors/settings/emergency");
    return (_b = (_a = r.data) == null ? void 0 : _a.data) != null ? _b : { lockdown: false, evacuation: false };
  }
  /**
   * Read the emergency status for a read-modify-write: unlike {@link getEmergencyStatus} there is no
   * default — when the response does not carry both flags as booleans the result is `null`, so the
   * caller cannot send a guessed value back to the controller.
   */
  async readEmergencyStatus() {
    var _a;
    const r = await this.client.get(
      "/api/v1/developer/doors/settings/emergency"
    );
    const data = (_a = r.data) == null ? void 0 : _a.data;
    if (!data || typeof data.lockdown !== "boolean" || typeof data.evacuation !== "boolean") {
      return null;
    }
    return { lockdown: data.lockdown, evacuation: data.evacuation };
  }
  async setEmergencyStatus(payload) {
    await this.client.put("/api/v1/developer/doors/settings/emergency", payload);
  }
  async listWebhookEndpoints() {
    var _a, _b;
    const r = await this.client.get("/api/v1/developer/webhooks/endpoints");
    return (_b = (_a = r.data) == null ? void 0 : _a.data) != null ? _b : [];
  }
  /**
   * Register a webhook endpoint (API reference 11.4). A duplicate URL is reported as result
   * `{ code: 'CODE_DEVICE_WEBHOOK_ENDPOINT_DUPLICATED' }` — whether the controller sends that code with
   * HTTP 200 or with an error status — so the caller can adopt the existing endpoint.
   *
   * @param payload Name, URL and events of the endpoint
   */
  async createWebhookEndpoint(payload) {
    var _a, _b, _c;
    try {
      const r = await this.client.post(
        "/api/v1/developer/webhooks/endpoints",
        payload
      );
      return { code: (_b = (_a = r.data) == null ? void 0 : _a.code) != null ? _b : "SUCCESS", endpoint: (_c = r.data) == null ? void 0 : _c.data };
    } catch (err) {
      if (apiErrorCode(err) === "CODE_DEVICE_WEBHOOK_ENDPOINT_DUPLICATED") {
        return { code: "CODE_DEVICE_WEBHOOK_ENDPOINT_DUPLICATED", endpoint: void 0 };
      }
      throw err;
    }
  }
  /**
   * Update a webhook endpoint (API reference 11.5): name, URL, events and optional headers are
   * replaced, id and secret are kept by the controller.
   *
   * @param id Endpoint id
   * @param payload New name, URL, events (and headers)
   * @returns The updated endpoint as reported by the controller, if the response carries one
   */
  async updateWebhookEndpoint(id, payload) {
    var _a;
    const r = await this.client.put(
      `/api/v1/developer/webhooks/endpoints/${encodeURIComponent(id)}`,
      payload
    );
    const data = (_a = r.data) == null ? void 0 : _a.data;
    return data && typeof data === "object" ? data : void 0;
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
  const code = apiErrorCode(err);
  if (code !== void 0 && AUTH_ERROR_CODES.has(code)) {
    return "unauthorized";
  }
  return "network";
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  InvalidStaticPathError,
  UnexpectedResponseError,
  UnifiApiError,
  UnifiHttp,
  apiErrorCode,
  classifyError,
  redactSecrets,
  requiredPermission
});
//# sourceMappingURL=unifiHttp.js.map
