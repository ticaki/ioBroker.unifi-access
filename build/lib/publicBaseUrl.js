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
var publicBaseUrl_exports = {};
__export(publicBaseUrl_exports, {
  PUBLIC_BASE_URL_PATTERN: () => PUBLIC_BASE_URL_PATTERN,
  normalizePublicBaseUrl: () => normalizePublicBaseUrl
});
module.exports = __toCommonJS(publicBaseUrl_exports);
const PUBLIC_BASE_URL_PATTERN = /^https?:\/\/[^\s/?#]+(\/[A-Za-z0-9._~-]+)*$/i;
function normalizePublicBaseUrl(raw) {
  if (typeof raw !== "string") {
    return { url: null };
  }
  const value = raw.trim().replace(/\/+$/, "");
  if (value === "") {
    return { url: null };
  }
  if (!PUBLIC_BASE_URL_PATTERN.test(value)) {
    return {
      url: null,
      problem: "expected http(s)://host[:port][/path] without query, fragment or blanks"
    };
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { url: null, problem: "not a valid URL" };
  }
  if (parsed.username || parsed.password) {
    return { url: null, problem: "credentials in the URL are not allowed" };
  }
  if (parsed.port === "0") {
    return { url: null, problem: "port 0 is not a usable port (1-65535)" };
  }
  const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  return { url: `${parsed.protocol}//${parsed.host}${path}` };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PUBLIC_BASE_URL_PATTERN,
  normalizePublicBaseUrl
});
//# sourceMappingURL=publicBaseUrl.js.map
