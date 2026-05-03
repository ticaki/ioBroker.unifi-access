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
var protectSnapshotEndpoint_exports = {};
__export(protectSnapshotEndpoint_exports, {
  ProtectMediaHandler: () => ProtectMediaHandler
});
module.exports = __toCommonJS(protectSnapshotEndpoint_exports);
class ProtectMediaHandler {
  constructor(options) {
    this.options = options;
  }
  matches = (req) => {
    var _a, _b;
    const url = (_b = (_a = req.url) == null ? void 0 : _a.split("?")[0]) != null ? _b : "";
    return url.startsWith(`${this.options.snapshotPathPrefix}/`) || url.startsWith(`${this.options.videoPathPrefix}/`);
  };
  handle = async (req, res) => {
    var _a, _b;
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.end();
      return true;
    }
    const url = (_b = (_a = req.url) == null ? void 0 : _a.split("?")[0]) != null ? _b : "";
    if (url.startsWith(`${this.options.snapshotPathPrefix}/`)) {
      return this.handleSnapshot(url, res);
    }
    return this.handleVideo(url, res);
  };
  async handleSnapshot(url, res) {
    const tail = url.slice(this.options.snapshotPathPrefix.length + 1);
    const match = /^([A-Za-z0-9]+)\/(\d+)\.jpg$/.exec(tail);
    if (!match) {
      res.statusCode = 400;
      res.end();
      return true;
    }
    const [, cameraId, ts] = match;
    let buf = this.options.getSnapshot(cameraId, ts);
    if (!buf) {
      try {
        buf = await this.options.fetchSnapshot(cameraId);
      } catch (err) {
        this.options.logger.warn(`Protect snapshot ${cameraId} failed: ${err.message}`);
        res.statusCode = 502;
        res.end();
        return true;
      }
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "no-store");
    res.end(buf);
    return true;
  }
  async handleVideo(url, res) {
    const tail = url.slice(this.options.videoPathPrefix.length + 1);
    const match = /^([A-Za-z0-9_-]+)\.mp4$/.exec(tail);
    if (!match) {
      res.statusCode = 400;
      res.end();
      return true;
    }
    const eventId = match[1];
    let meta;
    try {
      meta = await this.options.getEventMeta(eventId);
    } catch (err) {
      this.options.logger.warn(`Protect event meta ${eventId} failed: ${err.message}`);
      res.statusCode = 502;
      res.end();
      return true;
    }
    if (!(meta == null ? void 0 : meta.clipUrl)) {
      res.statusCode = 501;
      res.end("Video clip not available for this event");
      return true;
    }
    try {
      const buf = await this.options.fetchClip(meta.clipUrl);
      res.statusCode = 200;
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Cache-Control", "no-store");
      res.end(buf);
    } catch (err) {
      this.options.logger.warn(`Protect clip ${eventId} failed: ${err.message}`);
      res.statusCode = 502;
      res.end();
    }
    return true;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ProtectMediaHandler
});
//# sourceMappingURL=protectSnapshotEndpoint.js.map
