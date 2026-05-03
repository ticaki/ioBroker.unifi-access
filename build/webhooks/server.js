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
var server_exports = {};
__export(server_exports, {
  WebhookHandler: () => WebhookHandler
});
module.exports = __toCommonJS(server_exports);
var import_node_crypto = require("node:crypto");
const MAX_BODY_BYTES = 1e6;
const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;
class WebhookHandler {
  options;
  constructor(options) {
    this.options = options;
  }
  matches = (req) => {
    var _a;
    return ((_a = req.url) == null ? void 0 : _a.split("?")[0]) === this.options.path;
  };
  handle = async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return true;
    }
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      this.options.logger.warn(`Webhook body read failed: ${err.message}`);
      res.statusCode = 400;
      res.end();
      return true;
    }
    const secret = this.options.secret();
    if (!secret) {
      this.options.logger.warn("Webhook received but no secret configured \u2014 rejecting.");
      res.statusCode = 401;
      res.end();
      return true;
    }
    const sigHeader = req.headers.signature;
    const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    if (!sig || !verifySignature(body, sig, secret)) {
      this.options.logger.warn("Webhook signature verification failed.");
      res.statusCode = 401;
      res.end();
      return true;
    }
    let parsed;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch (err) {
      this.options.logger.warn(`Webhook JSON parse failed: ${err.message}`);
      res.statusCode = 400;
      res.end();
      return true;
    }
    try {
      await this.options.onEvent(parsed);
    } catch (err) {
      this.options.logger.warn(`Webhook handler error: ${err.message}`);
    }
    res.statusCode = 200;
    res.end("OK");
    return true;
  };
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
function verifySignature(payload, header, secret) {
  let timestampStr = null;
  let signatureHex = null;
  for (const pair of header.split(",")) {
    const idx = pair.indexOf("=");
    if (idx === -1) {
      continue;
    }
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key === "t") {
      timestampStr = value;
    } else if (key === "v1") {
      signatureHex = value;
    }
  }
  if (!timestampStr || !signatureHex) {
    return false;
  }
  const timestamp = Number.parseInt(timestampStr, 10);
  if (!Number.isFinite(timestamp)) {
    return false;
  }
  const skew = Math.abs(Math.floor(Date.now() / 1e3) - timestamp);
  if (skew > MAX_TIMESTAMP_SKEW_SECONDS) {
    return false;
  }
  const expected = (0, import_node_crypto.createHmac)("sha256", secret).update(`${timestamp}.`).update(payload).digest();
  let provided;
  try {
    provided = Buffer.from(signatureHex, "hex");
  } catch {
    return false;
  }
  if (provided.length !== expected.length) {
    return false;
  }
  return (0, import_node_crypto.timingSafeEqual)(provided, expected);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  WebhookHandler
});
//# sourceMappingURL=server.js.map
