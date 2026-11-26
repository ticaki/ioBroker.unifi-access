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
var logThrottle_exports = {};
__export(logThrottle_exports, {
  LogThrottle: () => LogThrottle
});
module.exports = __toCommonJS(logThrottle_exports);
class LogThrottle {
  /**
   * @param logger Target logger
   * @param windowMs Minimum distance between two warnings of the same key (default 60 s)
   * @param now Clock (tests)
   */
  constructor(logger, windowMs = 6e4, now = Date.now) {
    this.logger = logger;
    this.windowMs = windowMs;
    this.now = now;
  }
  last = /* @__PURE__ */ new Map();
  /**
   * Warn, unless the same kind of warning was given within the window.
   *
   * @param key Kind of the warning (e.g. "signature")
   * @param message Text of the warning
   */
  warn(key, message) {
    var _a, _b;
    const now = this.now();
    const entry = this.last.get(key);
    if (entry && now - entry.at < this.windowMs) {
      entry.suppressed += 1;
      this.logger.debug(message);
      return;
    }
    const suppressed = (_a = entry == null ? void 0 : entry.suppressed) != null ? _a : 0;
    if (this.last.size >= 100 && !entry) {
      this.last.clear();
    }
    this.last.set(key, { at: now, suppressed: 0 });
    this.logger.warn(
      suppressed > 0 ? `${message} (${suppressed} more like this in the last ${Math.round((now - ((_b = entry == null ? void 0 : entry.at) != null ? _b : now)) / 1e3)} s, logged at debug level)` : message
    );
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  LogThrottle
});
//# sourceMappingURL=logThrottle.js.map
