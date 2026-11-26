"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var genericWebhookServer_exports = {};
__export(genericWebhookServer_exports, {
  DEFAULT_GENERIC_WEBHOOK_PATH: () => DEFAULT_GENERIC_WEBHOOK_PATH,
  GenericWebhookHandler: () => GenericWebhookHandler,
  normalizeWebhookPath: () => normalizeWebhookPath,
  reservedWebhookPathOwner: () => reservedWebhookPathOwner
});
module.exports = __toCommonJS(genericWebhookServer_exports);
var import_node_crypto = require("node:crypto");
const MAX_BODY_BYTES = 1e6;
const DEFAULT_GENERIC_WEBHOOK_PATH = "/webhook";
function normalizeWebhookPath(raw) {
  let path = typeof raw === "string" ? raw.trim() : "";
  path = path.split(/[?#]/)[0];
  if (path === "") {
    return DEFAULT_GENERIC_WEBHOOK_PATH;
  }
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  return path.replace(/\/{2,}/g, "/");
}
function reservedWebhookPathOwner(path) {
  if (path === "/unifi-access-webhook") {
    return "the UniFi Access webhook receiver";
  }
  if (path.startsWith("/unifi-access/")) {
    return "the thumbnail and Protect media server";
  }
  return null;
}
function requestPath(url) {
  const raw = (url != null ? url : "/").split("?")[0];
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
class GenericWebhookHandler {
  options;
  /** The normalised listen path (see {@link normalizeWebhookPath}). */
  path;
  constructor(options) {
    this.options = options;
    this.path = normalizeWebhookPath(options.path);
  }
  matches = (req) => {
    return requestPath(req.url) === this.path;
  };
  handle = async (req, res) => {
    var _a, _b;
    if (!this.checkAuth(req)) {
      res.setHeader(
        "WWW-Authenticate",
        this.options.auth === "basic" ? 'Basic realm="webhook", charset="UTF-8"' : 'Bearer realm="webhook"'
      );
      res.statusCode = 401;
      res.end("Unauthorized");
      return true;
    }
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      this.options.logger.warn(`Generic webhook body read failed: ${err.message}`);
      res.statusCode = 400;
      res.end();
      return true;
    }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k] = v;
    }
    this.options.logger.debug(`Generic webhook: ${req.method} ${req.url} (${body.length} bytes)`);
    await this.options.onRequest({ body, headers, method: (_a = req.method) != null ? _a : "POST", url: (_b = req.url) != null ? _b : "/" });
    res.statusCode = 200;
    res.end("OK");
    return true;
  };
  /**
   * Whether the handler can authenticate anybody at all: `basic` needs user name and password,
   * `bearer` needs a token. Without them every request is refused — an empty configuration must
   * never match empty credentials.
   */
  get credentialsConfigured() {
    const { auth, username, password, token } = this.options;
    if (auth === "none") {
      return true;
    }
    if (auth === "basic") {
      return !!username && !!password;
    }
    return auth === "bearer" && !!token;
  }
  checkAuth(req) {
    const { auth, username, password, token } = this.options;
    if (auth === "none") {
      return true;
    }
    if (!this.credentialsConfigured) {
      return false;
    }
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return false;
    }
    const credentials = credentialsOf(authHeader, auth);
    if (credentials === void 0) {
      return false;
    }
    if (auth === "basic") {
      const decoded = Buffer.from(credentials, "base64").toString("utf8");
      const colonIdx = decoded.indexOf(":");
      const u = colonIdx >= 0 ? decoded.slice(0, colonIdx) : decoded;
      const p = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : "";
      const userOk = safeEqual(u, username != null ? username : "");
      const passwordOk = safeEqual(p, password != null ? password : "");
      return userOk && passwordOk;
    }
    if (auth === "bearer") {
      return safeEqual(credentials, token != null ? token : "");
    }
    return false;
  }
}
function credentialsOf(header, scheme) {
  const match = /^([^\s]+) +(.*)$/s.exec(header);
  return match && match[1].toLowerCase() === scheme ? match[2] : void 0;
}
function safeEqual(provided, expected) {
  const a = (0, import_node_crypto.createHash)("sha256").update(provided, "utf8").digest();
  const b = (0, import_node_crypto.createHash)("sha256").update(expected, "utf8").digest();
  return (0, import_node_crypto.timingSafeEqual)(a, b);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_GENERIC_WEBHOOK_PATH,
  GenericWebhookHandler,
  normalizeWebhookPath,
  reservedWebhookPathOwner
});
//# sourceMappingURL=genericWebhookServer.js.map
