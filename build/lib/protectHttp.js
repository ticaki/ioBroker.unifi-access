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
  ProtectHttp: () => ProtectHttp,
  classifyProtectError: () => classifyProtectError
});
module.exports = __toCommonJS(protectHttp_exports);
var import_axios = __toESM(require("axios"));
var import_node_https = __toESM(require("node:https"));
class ProtectHttp {
  client;
  username;
  password;
  sessionCookie = "";
  csrfToken = "";
  _loggedIn = false;
  constructor(options) {
    this.username = options.username;
    this.password = options.password;
    this.client = import_axios.default.create({
      baseURL: `https://${options.host}`,
      timeout: 15e3,
      httpsAgent: new import_node_https.default.Agent({
        rejectUnauthorized: options.verifyTLS === true
      })
    });
  }
  isLoggedIn() {
    return this._loggedIn;
  }
  async login() {
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
      throw new Error("Protect login failed: credentials rejected");
    }
    if (r.status >= 400) {
      this._loggedIn = false;
      throw new Error(`Protect login failed: HTTP ${r.status}`);
    }
    this.extractSession(r.headers);
    if (!this.sessionCookie) {
      this._loggedIn = false;
      throw new Error("Protect login failed: no session cookie in response");
    }
    this._loggedIn = true;
  }
  async getSnapshot(cameraId) {
    return this.withRetry(async (retry) => {
      const r = await this.client.get(
        `/proxy/protect/api/cameras/${encodeURIComponent(cameraId)}/snapshot`,
        { headers: this.authHeaders(), responseType: "arraybuffer", validateStatus: (s) => s < 500 }
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
    try {
      const r = await this.client.get(
        `/proxy/protect/api/events/${encodeURIComponent(eventId)}`,
        { headers: this.authHeaders(), validateStatus: (s) => s < 500 }
      );
      this.extractSession(r.headers);
      if (r.status === 401 || r.status === 403) {
        this._loggedIn = false;
        await this.login();
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
  async getClipBuffer(clipPath) {
    const path = clipPath.startsWith("/") ? clipPath : `/proxy/protect/api/${clipPath}`;
    const r = await this.client.get(path, {
      headers: this.authHeaders(),
      responseType: "arraybuffer",
      validateStatus: (s) => s < 500
    });
    this.extractSession(r.headers);
    if (r.status !== 200) {
      throw new Error(`Protect clip HTTP ${r.status}`);
    }
    return Buffer.from(r.data);
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
    await this.login();
    const retried = await fn(true);
    if (retried === null) {
      throw new Error("Protect auth failed after re-login");
    }
    return retried;
  }
}
function classifyProtectError(err) {
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
  ProtectHttp,
  classifyProtectError
});
//# sourceMappingURL=protectHttp.js.map
