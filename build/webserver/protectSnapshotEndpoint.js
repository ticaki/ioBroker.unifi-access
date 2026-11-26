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
  DEFAULT_MAX_CLIP_BYTES: () => DEFAULT_MAX_CLIP_BYTES,
  ProtectMediaHandler: () => ProtectMediaHandler
});
module.exports = __toCommonJS(protectSnapshotEndpoint_exports);
var import_logThrottle = require("../lib/logThrottle");
const DEFAULT_MAX_CLIP_BYTES = 256 * 1024 * 1024;
class ProtectMediaHandler {
  constructor(options) {
    this.options = options;
    this.failures = new import_logThrottle.LogThrottle(options.logger);
  }
  /** Media URLs are polled by dashboards: at most one warning per kind and minute. */
  failures;
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
    const match = /^([A-Za-z0-9]{1,64})\/(\d{1,16})\.jpg$/.exec(tail);
    if (!match) {
      res.statusCode = 400;
      res.end();
      return true;
    }
    const [, cameraId, ts] = match;
    const buf = this.options.getSnapshot(cameraId, ts);
    if (!buf) {
      this.options.logger.debug(`Protect snapshot ${cameraId}/${ts} not available (not in the cache).`);
      res.statusCode = 404;
      res.end("Snapshot of this event is not available any more");
      return true;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "no-store");
    res.end(buf);
    return true;
  }
  async handleVideo(url, res) {
    var _a;
    const tail = url.slice(this.options.videoPathPrefix.length + 1);
    const match = /^([A-Za-z0-9_-]{1,128})\.mp4$/.exec(tail);
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
      this.failures.warn("event-meta", `Protect event meta ${eventId} failed: ${err.message}`);
      res.statusCode = 502;
      res.end();
      return true;
    }
    if (clientGone(res)) {
      return true;
    }
    if (!(meta == null ? void 0 : meta.clipUrl)) {
      res.statusCode = 501;
      res.end("Video clip not available for this event");
      return true;
    }
    const maxBytes = (_a = this.options.maxClipBytes) != null ? _a : DEFAULT_MAX_CLIP_BYTES;
    let clip;
    try {
      clip = await this.options.fetchClip(meta.clipUrl);
    } catch (err) {
      this.failures.warn("clip", `Protect clip ${eventId} failed: ${err.message}`);
      res.statusCode = 502;
      res.end();
      return true;
    }
    if (clientGone(res)) {
      if (!Buffer.isBuffer(clip)) {
        clip.stream.destroy();
      }
      return true;
    }
    const announced = Buffer.isBuffer(clip) ? clip.length : clip.contentLength;
    if (announced !== void 0 && announced > maxBytes) {
      if (!Buffer.isBuffer(clip)) {
        clip.stream.destroy();
      }
      this.options.logger.warn(
        `Protect clip ${eventId} not served: ${announced} bytes exceed the limit of ${maxBytes}.`
      );
      res.statusCode = 502;
      res.end();
      return true;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Cache-Control", "no-store");
    if (Buffer.isBuffer(clip)) {
      res.end(clip);
      return true;
    }
    if (clip.contentLength !== void 0) {
      res.setHeader("Content-Length", String(clip.contentLength));
    }
    await this.pipeClip(clip.stream, res, eventId, maxBytes);
    return true;
  }
  /**
   * Pass a clip stream on to the client with back-pressure. Ends early (connection closed) when the
   * source fails, the client goes away or more than `maxBytes` arrive.
   *
   * @param source Clip stream from Protect
   * @param res Response to the client
   * @param eventId Event id for the log
   * @param maxBytes Upper bound for the number of bytes passed on
   */
  pipeClip(source, res, eventId, maxBytes) {
    return new Promise((resolve) => {
      let sent = 0;
      let done = false;
      const finish = (problem) => {
        if (done) {
          return;
        }
        done = true;
        if (problem) {
          this.failures.warn("clip-aborted", `Protect clip ${eventId} aborted: ${problem}`);
          source.destroy();
          res.destroy();
        } else {
          res.end();
        }
        resolve();
      };
      const clientLeft = () => {
        if (!done) {
          done = true;
          source.destroy();
          resolve();
        }
      };
      res.on("close", clientLeft);
      if (clientGone(res)) {
        clientLeft();
        return;
      }
      source.on("data", (chunk) => {
        if (clientGone(res)) {
          clientLeft();
          return;
        }
        sent += chunk.length;
        if (sent > maxBytes) {
          finish(`more than ${maxBytes} bytes`);
          return;
        }
        if (!res.write(chunk)) {
          source.pause();
          res.once("drain", () => source.resume());
        }
      });
      source.on("end", () => finish());
      source.on("error", (err) => finish(err.message));
    });
  }
}
function clientGone(res) {
  return res.destroyed || res.writableEnded;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_MAX_CLIP_BYTES,
  ProtectMediaHandler
});
//# sourceMappingURL=protectSnapshotEndpoint.js.map
