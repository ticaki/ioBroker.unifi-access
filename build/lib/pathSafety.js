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
var pathSafety_exports = {};
__export(pathSafety_exports, {
  isSafeProtectId: () => isSafeProtectId,
  sanitizeProtectClipPath: () => sanitizeProtectClipPath,
  sanitizeStaticPath: () => sanitizeStaticPath
});
module.exports = __toCommonJS(pathSafety_exports);
const STATIC_ROOTS = ["avatar", "capture", "preview", "activities_resource"];
const STATIC_PATH_MAX_LENGTH = 512;
const STATIC_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function sanitizeStaticPath(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > STATIC_PATH_MAX_LENGTH) {
    return null;
  }
  const relative = raw.replace(/^\/+/, "");
  const segments = relative.split("/");
  if (segments.length < 2 || !STATIC_ROOTS.includes(segments[0])) {
    return null;
  }
  for (const segment of segments) {
    if (!STATIC_SEGMENT.test(segment)) {
      return null;
    }
  }
  return segments.join("/");
}
function isSafeProtectId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}
const PROTECT_API_PREFIX = "/proxy/protect/api/";
function sanitizeProtectClipPath(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
    return null;
  }
  if (!/^[A-Za-z0-9\-._~/?&=%:+,@!*'()]+$/.test(raw)) {
    return null;
  }
  const candidate = raw.startsWith("/") ? raw : `${PROTECT_API_PREFIX}${raw}`;
  const queryStart = candidate.indexOf("?");
  const path = queryStart === -1 ? candidate : candidate.slice(0, queryStart);
  if (!path.startsWith(PROTECT_API_PREFIX) || path.includes("//") || path.includes(":")) {
    return null;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (decoded.includes("\\") || decoded.includes("%")) {
    return null;
  }
  for (const segment of decoded.split("/")) {
    if (segment === "." || segment === "..") {
      return null;
    }
  }
  return candidate;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  isSafeProtectId,
  sanitizeProtectClipPath,
  sanitizeStaticPath
});
//# sourceMappingURL=pathSafety.js.map
