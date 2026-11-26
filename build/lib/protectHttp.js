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
var protectHttp_exports = {};
__export(protectHttp_exports, {
  DEFAULT_RELOGIN_INTERVAL_MS: () => DEFAULT_RELOGIN_INTERVAL_MS,
  MAX_BUFFERED_CLIP_BYTES: () => MAX_BUFFERED_CLIP_BYTES,
  MAX_SNAPSHOT_BYTES: () => MAX_SNAPSHOT_BYTES,
  ProtectHttp: () => ProtectHttp,
  ProtectLoginError: () => ProtectLoginError,
  classifyProtectError: () => classifyProtectError
});
module.exports = __toCommonJS(protectHttp_exports);
var import_axios = __toESM(require("axios"));
var import_node_https = __toESM(require("node:https"));
var import_pathSafety = require("./pathSafety");
var import_tlsErrors = require("./tlsErrors");
var import_caCert = require("./caCert");
var import_stopSignal = require("./stopSignal");
const DEFAULT_RELOGIN_INTERVAL_MS = 3e4;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_BUFFERED_CLIP_BYTES = 64 * 1024 * 1024;
class ProtectLoginError extends Error {
  kind;
  status;
  constructor(kind, message, status) {
    super(message);
    this.name = "ProtectLoginError";
    this.kind = kind;
    this.status = status;
  }
}
class ProtectHttp {
  client;
  username;
  password;
  sessionCookie = "";
  csrfToken = "";
  _loggedIn = false;
  /** The login that is running — every caller waits for the same one (single flight). */
  loginInFlight = null;
  /** When the last login attempt failed (ms, own clock); 0 = the last attempt succeeded or none was made. */
  lastLoginFailureAt = 0;
  reloginIntervalMs;
  now;
  constructor(options) {
    var _a, _b;
    this.username = options.username;
    this.password = options.password;
    this.reloginIntervalMs = (_a = options.reloginIntervalMs) != null ? _a : DEFAULT_RELOGIN_INTERVAL_MS;
    this.now = (_b = options.now) != null ? _b : Date.now;
    const port = options.port && options.port !== 443 ? `:${options.port}` : "";
    this.client = import_axios.default.create({
      baseURL: `https://${options.host}${port}`,
      timeout: 15e3,
      httpsAgent: new import_node_https.default.Agent({
        rejectUnauthorized: options.verifyTLS === true,
        // in addition to the system CAs (Node's `ca` alone would replace them)
        ca: (0, import_caCert.trustedCertificates)(options.caCert)
      })
    });
    this.client.interceptors.request.use((config) => {
      (0, import_stopSignal.throwIfStopped)(options.isStopped);
      return config;
    });
  }
  isLoggedIn() {
    return this._loggedIn;
  }
  /**
   * Log in. Concurrent calls share one attempt. This is the explicit login of the adapter (start and
   * its own retry with back-off); logins that media requests need go through {@link relogin}.
   */
  login() {
    if (!this.loginInFlight) {
      this.loginInFlight = this.performLogin().then(
        () => {
          this.lastLoginFailureAt = 0;
          this.loginInFlight = null;
        },
        (err) => {
          this.lastLoginFailureAt = this.now();
          this.loginInFlight = null;
          throw err;
        }
      );
    }
    return this.loginInFlight;
  }
  /**
   * Login on behalf of a media request (session missing or expired). Joins a running login; refuses
   * without contacting the console when the last attempt failed less than `reloginIntervalMs` ago
   * (rate limit, console not reachable — another attempt right away would only prolong it).
   */
  relogin() {
    if (this.loginInFlight) {
      return this.loginInFlight;
    }
    const waitMs = this.lastLoginFailureAt + this.reloginIntervalMs - this.now();
    if (this.lastLoginFailureAt > 0 && waitMs > 0) {
      return Promise.reject(
        new ProtectLoginError(
          "no-session",
          `Protect session not available \u2014 next login attempt possible in ${Math.ceil(waitMs / 1e3)} s`
        )
      );
    }
    return this.login();
  }
  /** Before a media request: without a session, log in first (or fail fast while logins are on hold). */
  async ensureSession() {
    if (!this._loggedIn) {
      await this.relogin();
    }
  }
  async performLogin() {
    let initialCsrf = "";
    try {
      const r2 = await this.client.get("/", { validateStatus: () => true, maxRedirects: 0 });
      const raw = r2.headers["x-csrf-token"];
      initialCsrf = typeof raw === "string" ? raw : "";
    } catch {
    }
    const loginHeaders = { "Content-Type": "application/json" };
    if (initialCsrf) {
      loginHeaders["x-csrf-token"] = initialCsrf;
    }
    const r = await this.client.post(
      "/api/auth/login",
      { username: this.username, password: this.password, rememberMe: true, token: "" },
      { headers: loginHeaders, validateStatus: (s) => s < 500 }
    );
    if (r.status === 401 || r.status === 403) {
      this._loggedIn = false;
      throw new ProtectLoginError("credentials", "Protect login failed: credentials rejected", r.status);
    }
    if (r.status >= 400) {
      this._loggedIn = false;
      throw new ProtectLoginError(
        r.status === 429 ? "rate-limited" : "http",
        `Protect login failed: HTTP ${r.status}`,
        r.status
      );
    }
    this.extractSession(r.headers);
    if (!this.sessionCookie) {
      this._loggedIn = false;
      throw new ProtectLoginError("no-session", "Protect login failed: no session cookie in response");
    }
    this._loggedIn = true;
  }
  async getSnapshot(cameraId) {
    if (!(0, import_pathSafety.isSafeProtectId)(cameraId)) {
      throw new Error("Protect camera id rejected");
    }
    await this.ensureSession();
    return this.withRetry(async (retry) => {
      const r = await this.client.get(
        `/proxy/protect/api/cameras/${encodeURIComponent(cameraId)}/snapshot`,
        {
          headers: this.authHeaders(),
          responseType: "arraybuffer",
          maxContentLength: MAX_SNAPSHOT_BYTES,
          validateStatus: (s) => s < 500
        }
      );
      this.extractSession(r.headers);
      if ((r.status === 401 || r.status === 403) && !retry) {
        return null;
      }
      if (r.status !== 200) {
        throw new Error(`Protect snapshot HTTP ${r.status}`);
      }
      return Buffer.from(r.data);
    });
  }
  async getEventMeta(eventId) {
    var _a, _b, _c, _d, _e, _f;
    if (!(0, import_pathSafety.isSafeProtectId)(eventId)) {
      return null;
    }
    try {
      await this.ensureSession();
      const r = await this.client.get(
        `/proxy/protect/api/events/${encodeURIComponent(eventId)}`,
        { headers: this.authHeaders(), validateStatus: (s) => s < 500 }
      );
      this.extractSession(r.headers);
      if (r.status === 401 || r.status === 403) {
        this._loggedIn = false;
        await this.relogin();
        const r2 = await this.client.get(
          `/proxy/protect/api/events/${encodeURIComponent(eventId)}`,
          { headers: this.authHeaders(), validateStatus: (s) => s < 500 }
        );
        if (r2.status !== 200) {
          return null;
        }
        return { clipUrl: (_c = (_a = r2.data) == null ? void 0 : _a.clipUrl) != null ? _c : (_b = r2.data) == null ? void 0 : _b.clip };
      }
      if (r.status !== 200) {
        return null;
      }
      return { clipUrl: (_f = (_d = r.data) == null ? void 0 : _d.clipUrl) != null ? _f : (_e = r.data) == null ? void 0 : _e.clip };
    } catch {
      return null;
    }
  }
  /**
   * Fetch a clip into memory. Limited to {@link MAX_BUFFERED_CLIP_BYTES}; prefer
   * {@link getClipStream} for serving clips.
   *
   * @param clipPath Clip location reported by Protect
   */
  async getClipBuffer(clipPath) {
    const r = await this.client.get(this.clipRequestPath(clipPath), {
      headers: this.authHeaders(),
      responseType: "arraybuffer",
      maxContentLength: MAX_BUFFERED_CLIP_BYTES,
      validateStatus: (s) => s < 500
    });
    this.extractSession(r.headers);
    if (r.status !== 200) {
      throw new Error(`Protect clip HTTP ${r.status}`);
    }
    return Buffer.from(r.data);
  }
  /**
   * Open a clip as a stream: the bytes are passed on as they arrive instead of holding a whole
   * video in memory.
   *
   * @param clipPath Clip location reported by Protect
   */
  async getClipStream(clipPath) {
    const path = this.clipRequestPath(clipPath);
    await this.ensureSession();
    const r = await this.client.get(path, {
      headers: this.authHeaders(),
      responseType: "stream",
      validateStatus: (s) => s < 500
    });
    this.extractSession(r.headers);
    if (r.status !== 200) {
      r.data.destroy();
      throw new Error(`Protect clip HTTP ${r.status}`);
    }
    const length = Number(r.headers["content-length"]);
    return { stream: r.data, contentLength: Number.isFinite(length) && length >= 0 ? length : void 0 };
  }
  /**
   * The clip location is taken from a Protect response and requested with the session cookie
   * attached: it must stay a path below /proxy/protect/api/ on this host.
   *
   * @param clipPath Clip location reported by Protect
   */
  clipRequestPath(clipPath) {
    const path = (0, import_pathSafety.sanitizeProtectClipPath)(clipPath);
    if (path === null) {
      throw new Error("Protect clip location rejected");
    }
    return path;
  }
  authHeaders() {
    const h = { Cookie: this.sessionCookie };
    if (this.csrfToken) {
      h["x-csrf-token"] = this.csrfToken;
    }
    return h;
  }
  extractSession(headers) {
    const updatedCsrf = headers["x-updated-csrf-token"];
    if (typeof updatedCsrf === "string" && updatedCsrf) {
      this.csrfToken = updatedCsrf;
    }
    const setCookie = headers["set-cookie"];
    if (Array.isArray(setCookie)) {
      this.sessionCookie = setCookie.map((c) => c.split(";")[0]).join("; ");
    } else if (typeof setCookie === "string") {
      this.sessionCookie = setCookie.split(";")[0];
    }
  }
  async withRetry(fn) {
    const result = await fn(false);
    if (result !== null) {
      return result;
    }
    this._loggedIn = false;
    await this.relogin();
    const retried = await fn(true);
    if (retried === null) {
      throw new Error("Protect auth failed after re-login");
    }
    return retried;
  }
}
function classifyProtectError(err) {
  var _a, _b, _c;
  if (err instanceof ProtectLoginError) {
    if (err.kind === "credentials") {
      return "credentials";
    }
    return err.kind === "rate-limited" ? "rate-limited" : "network";
  }
  if ((0, import_tlsErrors.tlsCertificateErrorCode)(err) !== void 0) {
    return "tls";
  }
  if (err instanceof import_axios.AxiosError) {
    if (((_a = err.response) == null ? void 0 : _a.status) === 401 || ((_b = err.response) == null ? void 0 : _b.status) === 403) {
      return "credentials";
    }
    if (((_c = err.response) == null ? void 0 : _c.status) === 429) {
      return "rate-limited";
    }
  }
  return "network";
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_RELOGIN_INTERVAL_MS,
  MAX_BUFFERED_CLIP_BYTES,
  MAX_SNAPSHOT_BYTES,
  ProtectHttp,
  ProtectLoginError,
  classifyProtectError
});
//# sourceMappingURL=protectHttp.js.map
