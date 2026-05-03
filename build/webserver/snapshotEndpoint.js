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
var snapshotEndpoint_exports = {};
__export(snapshotEndpoint_exports, {
  ThumbnailHandler: () => ThumbnailHandler
});
module.exports = __toCommonJS(snapshotEndpoint_exports);
class ThumbnailHandler {
  options;
  constructor(options) {
    this.options = options;
  }
  matches = (req) => {
    var _a, _b;
    const url = (_b = (_a = req.url) == null ? void 0 : _a.split("?")[0]) != null ? _b : "";
    return url.startsWith(`${this.options.pathPrefix}/`);
  };
  handle = async (req, res) => {
    var _a, _b;
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.end();
      return true;
    }
    const url = (_b = (_a = req.url) == null ? void 0 : _a.split("?")[0]) != null ? _b : "";
    const tail = url.slice(this.options.pathPrefix.length + 1);
    const match = /^([A-Za-z0-9_-]+)\.jpg$/.exec(tail);
    if (!match) {
      res.statusCode = 404;
      res.end();
      return true;
    }
    const deviceId = match[1];
    const http = this.options.http();
    if (!http) {
      res.statusCode = 503;
      res.end("no controller connection");
      return true;
    }
    let path;
    try {
      path = await this.options.resolvePath(deviceId);
    } catch (err) {
      this.options.logger.warn(`Thumbnail path lookup failed: ${err.message}`);
      res.statusCode = 500;
      res.end();
      return true;
    }
    if (!path) {
      res.statusCode = 404;
      res.end("no thumbnail seen");
      return true;
    }
    try {
      const buf = await http.getStaticResource(path);
      res.statusCode = 200;
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "no-store");
      res.end(buf);
    } catch (err) {
      this.options.logger.warn(`Thumbnail fetch for ${deviceId} failed: ${err.message}`);
      res.statusCode = 502;
      res.end();
    }
    return true;
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ThumbnailHandler
});
//# sourceMappingURL=snapshotEndpoint.js.map
