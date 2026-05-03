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
  GenericWebhookHandler: () => GenericWebhookHandler
});
module.exports = __toCommonJS(genericWebhookServer_exports);
const MAX_BODY_BYTES = 1e6;
class GenericWebhookHandler {
  options;
  constructor(options) {
    this.options = options;
  }
  matches = (req) => {
    var _a, _b;
    return ((_b = (_a = req.url) == null ? void 0 : _a.split("?")[0]) != null ? _b : "/") === this.options.path;
  };
  handle = async (req, res) => {
    var _a, _b;
    if (!this.checkAuth(req)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="webhook"');
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
    this.options.logger.info(
      `Generic webhook: ${req.method} ${req.url} \u2014 body: ${body.toString("utf8").slice(0, 2e3)}`
    );
    await this.options.onRequest({ body, headers, method: (_a = req.method) != null ? _a : "POST", url: (_b = req.url) != null ? _b : "/" });
    res.statusCode = 200;
    res.end("OK");
    return true;
  };
  checkAuth(req) {
    const { auth, username, password, token } = this.options;
    if (auth === "none") {
      return true;
    }
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return false;
    }
    if (auth === "basic") {
      if (!authHeader.startsWith("Basic ")) {
        return false;
      }
      const decoded = Buffer.from(authHeader.slice("Basic ".length), "base64").toString("utf8");
      const colonIdx = decoded.indexOf(":");
      const u = colonIdx >= 0 ? decoded.slice(0, colonIdx) : decoded;
      const p = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : "";
      return u === (username != null ? username : "") && p === (password != null ? password : "");
    }
    if (auth === "bearer") {
      if (!authHeader.startsWith("Bearer ")) {
        return false;
      }
      return authHeader.slice("Bearer ".length) === (token != null ? token : "");
    }
    return false;
  }
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
  GenericWebhookHandler
});
//# sourceMappingURL=genericWebhookServer.js.map
