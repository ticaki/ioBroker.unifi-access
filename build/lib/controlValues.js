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
var controlValues_exports = {};
__export(controlValues_exports, {
  LOCK_RULE_BY_INDEX: () => LOCK_RULE_BY_INDEX,
  LOCK_RULE_STATES: () => LOCK_RULE_STATES,
  MAX_UNLOCK_MINUTES: () => MAX_UNLOCK_MINUTES,
  describeValue: () => describeValue,
  extractDpsStatus: () => extractDpsStatus,
  normalizeDefaultUnlockMinutes: () => normalizeDefaultUnlockMinutes,
  normalizePort: () => normalizePort,
  parseLockRuleIndex: () => parseLockRuleIndex,
  parseUnlockMinutes: () => parseUnlockMinutes
});
module.exports = __toCommonJS(controlValues_exports);
const MAX_UNLOCK_MINUTES = 600;
const LOCK_RULE_BY_INDEX = {
  0: "reset",
  1: "keep_unlock",
  2: "keep_lock",
  3: "lock_now",
  4: "lock_early"
};
const LOCK_RULE_STATES = {
  0: "default",
  1: "keep_unlock",
  2: "keep_lock",
  3: "lock_now",
  4: "lock_early"
};
function parseUnlockMinutes(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  const minutes = Math.floor(value);
  return minutes <= MAX_UNLOCK_MINUTES ? minutes : null;
}
function parseLockRuleIndex(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || !Object.hasOwn(LOCK_RULE_BY_INDEX, value)) {
    return null;
  }
  return LOCK_RULE_BY_INDEX[value];
}
function normalizeDefaultUnlockMinutes(value) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
    return 0;
  }
  return Math.min(MAX_UNLOCK_MINUTES, Math.floor(n));
}
function normalizePort(value, fallback) {
  const n = typeof value === "string" && /^\d{1,5}$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}
function describeValue(value) {
  var _a;
  let text;
  try {
    text = typeof value === "number" || typeof value === "undefined" ? String(value) : (_a = JSON.stringify(value)) != null ? _a : "";
  } catch {
    text = "[unserializable]";
  }
  return `${text.length > 60 ? `${text.slice(0, 60)}\u2026` : text} (${value === null ? "null" : typeof value})`;
}
function extractDpsStatus(data) {
  if (!data || typeof data !== "object") {
    return void 0;
  }
  const object = data.object;
  const candidates = [
    object && typeof object === "object" ? object.status : void 0,
    data.dps_status,
    data.value
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate !== "") {
      return candidate;
    }
  }
  return void 0;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  LOCK_RULE_BY_INDEX,
  LOCK_RULE_STATES,
  MAX_UNLOCK_MINUTES,
  describeValue,
  extractDpsStatus,
  normalizeDefaultUnlockMinutes,
  normalizePort,
  parseLockRuleIndex,
  parseUnlockMinutes
});
//# sourceMappingURL=controlValues.js.map
