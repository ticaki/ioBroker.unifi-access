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
var snapshotCache_exports = {};
__export(snapshotCache_exports, {
  PROTECT_SNAPSHOT_CACHE_MAX_BYTES: () => PROTECT_SNAPSHOT_CACHE_MAX_BYTES,
  PROTECT_SNAPSHOT_CACHE_MAX_ENTRIES: () => PROTECT_SNAPSHOT_CACHE_MAX_ENTRIES,
  SnapshotCache: () => SnapshotCache
});
module.exports = __toCommonJS(snapshotCache_exports);
const PROTECT_SNAPSHOT_CACHE_MAX_ENTRIES = 50;
const PROTECT_SNAPSHOT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
class SnapshotCache {
  /**
   * @param maxEntries Most snapshots kept
   * @param maxBytes Most bytes kept in total
   */
  constructor(maxEntries, maxBytes) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }
  entries = /* @__PURE__ */ new Map();
  order = [];
  totalBytes = 0;
  /** Number of snapshots kept. */
  get size() {
    return this.entries.size;
  }
  /** Bytes of all snapshots kept. */
  get bytes() {
    return this.totalBytes;
  }
  /**
   * The snapshot stored under the key.
   *
   * @param key Cache key
   */
  get(key) {
    return this.entries.get(key);
  }
  /**
   * Keep a snapshot. A key that is already present keeps its first snapshot.
   *
   * @param key Cache key (`<cameraId>:<event timestamp>`)
   * @param buf JPEG bytes
   */
  add(key, buf) {
    var _a, _b;
    if (this.entries.has(key) || buf.length > this.maxBytes) {
      return;
    }
    this.order.push(key);
    this.entries.set(key, buf);
    this.totalBytes += buf.length;
    while (this.order.length > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.order.shift();
      if (oldest === void 0) {
        break;
      }
      this.totalBytes -= (_b = (_a = this.entries.get(oldest)) == null ? void 0 : _a.length) != null ? _b : 0;
      this.entries.delete(oldest);
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PROTECT_SNAPSHOT_CACHE_MAX_BYTES,
  PROTECT_SNAPSHOT_CACHE_MAX_ENTRIES,
  SnapshotCache
});
//# sourceMappingURL=snapshotCache.js.map
