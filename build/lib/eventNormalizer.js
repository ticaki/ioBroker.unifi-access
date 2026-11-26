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
var eventNormalizer_exports = {};
__export(eventNormalizer_exports, {
  DOORBELL_REASONS: () => DOORBELL_REASONS,
  MASKED_VALUE: () => MASKED_VALUE,
  asRecord: () => asRecord,
  asString: () => asString,
  isAccessGranted: () => isAccessGranted,
  parseAccessEvent: () => parseAccessEvent
});
module.exports = __toCommonJS(eventNormalizer_exports);
var import_controlValues = require("./controlValues");
var import_pathSafety = require("./pathSafety");
const DOORBELL_REASONS = {
  105: "timeout",
  106: "admin_rejected",
  107: "admin_unlocked",
  108: "visitor_cancelled",
  400: "answered_elsewhere"
};
const WEBRTC_CREDENTIAL_KEYS = ["channel", "token"];
const CREDENTIAL_VALUE_KEYS = ["authentication_value"];
const MASKED_VALUE = "***";
function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function asString(value) {
  return typeof value === "string" && value !== "" ? value : void 0;
}
function firstString(...values) {
  for (const value of values) {
    const text = asString(value);
    if (text !== void 0) {
      return text;
    }
  }
  return void 0;
}
function toReasonCode(value) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : void 0;
}
function isFilled(value) {
  return value !== void 0 && value !== null && value !== "";
}
function maskCredentialValues(record) {
  if (!CREDENTIAL_VALUE_KEYS.some((key) => isFilled(record[key]))) {
    return record;
  }
  const masked = { ...record };
  for (const key of CREDENTIAL_VALUE_KEYS) {
    if (isFilled(masked[key])) {
      masked[key] = MASKED_VALUE;
    }
  }
  return masked;
}
function redactEnvelope(msg, data) {
  let cleaned = maskCredentialValues(data);
  const object = asRecord(data.object);
  if (object) {
    const maskedObject = maskCredentialValues(object);
    if (maskedObject !== object) {
      cleaned = { ...cleaned, object: maskedObject };
    }
  }
  if (WEBRTC_CREDENTIAL_KEYS.some((key) => key in cleaned)) {
    cleaned = { ...cleaned };
    for (const key of WEBRTC_CREDENTIAL_KEYS) {
      delete cleaned[key];
    }
  }
  return cleaned === data ? msg : { ...msg, data: cleaned };
}
function parseAccessEvent(msg, source, now) {
  var _a, _b, _c, _d;
  const envelope = asRecord(msg);
  const type = asString(envelope == null ? void 0 : envelope.event);
  if (!envelope || type === void 0) {
    return null;
  }
  let ts = now;
  if (typeof envelope.timestamp === "number" && Number.isFinite(envelope.timestamp)) {
    ts = envelope.timestamp;
  } else if (typeof envelope.timestamp === "string") {
    ts = Date.parse(envelope.timestamp) || now;
  }
  const data = (_a = asRecord(envelope.data)) != null ? _a : {};
  const device = asRecord(data.device);
  const object = asRecord(data.object);
  const actor = asRecord(data.actor);
  const dataIsLocation = typeof data.location_type === "string" && typeof data.unique_id === "string";
  const location = (_b = asRecord(data.location)) != null ? _b : dataIsLocation ? data : void 0;
  const extras = asRecord(location == null ? void 0 : location.extras);
  const rawThumbnailPath = (_c = extras == null ? void 0 : extras.door_thumbnail) != null ? _c : data.door_thumbnail;
  let thumbnailPath;
  let thumbnailPathRejected = false;
  if (rawThumbnailPath !== void 0 && rawThumbnailPath !== null && rawThumbnailPath !== "") {
    if (typeof rawThumbnailPath === "string" && (0, import_pathSafety.sanitizeStaticPath)(rawThumbnailPath) !== null) {
      thumbnailPath = rawThumbnailPath;
    } else {
      thumbnailPathRejected = true;
    }
  }
  let subtype;
  let reasonCode;
  let result;
  let requestId;
  switch (type) {
    case "access.remote_view":
      requestId = asString(data.request_id);
      break;
    case "access.remote_view.change":
      reasonCode = toReasonCode(data.reason_code);
      subtype = reasonCode !== void 0 ? DOORBELL_REASONS[reasonCode] : void 0;
      requestId = firstString(data.remote_call_request_id, data.request_id);
      break;
    case "access.doorbell.incoming":
    case "access.doorbell.incoming.REN":
      requestId = asString(object == null ? void 0 : object.request_id);
      break;
    case "access.doorbell.completed":
      reasonCode = toReasonCode((_d = object == null ? void 0 : object.reason_code) != null ? _d : data.reason_code);
      subtype = reasonCode !== void 0 ? DOORBELL_REASONS[reasonCode] : void 0;
      requestId = asString(object == null ? void 0 : object.request_id);
      break;
    case "access.device.dps_status":
      subtype = (0, import_controlValues.extractDpsStatus)(data);
      break;
    case "access.door.unlock":
      result = asString(object == null ? void 0 : object.result);
      subtype = result;
      break;
  }
  const event = {
    ts,
    source,
    type,
    subtype,
    deviceId: firstString(
      data.device_id,
      device == null ? void 0 : device.id,
      type === "access.data.device.remote_unlock" ? envelope.event_object_id : void 0
    ),
    deviceName: firstString(data.device_name, device == null ? void 0 : device.name, device == null ? void 0 : device.alias),
    doorId: firstString(data.door_id, location == null ? void 0 : location.id, location == null ? void 0 : location.unique_id),
    doorName: firstString(data.door_name, location == null ? void 0 : location.name),
    userName: firstString(data.user_name, actor == null ? void 0 : actor.name),
    // the result of an access attempt, decided here once — the panel shows "Access denied" for false
    ...type === "access.door.unlock" ? { granted: isAccessGranted(result) } : {},
    thumbnailPath,
    raw: redactEnvelope(envelope, data)
  };
  return { event, data, device, object, requestId, reasonCode, result, thumbnailPathRejected };
}
function isAccessGranted(result) {
  if (result === void 0) {
    return true;
  }
  return !/denied|blocked|reject|fail|invalid|unauthori[sz]ed/i.test(result);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DOORBELL_REASONS,
  MASKED_VALUE,
  asRecord,
  asString,
  isAccessGranted,
  parseAccessEvent
});
//# sourceMappingURL=eventNormalizer.js.map
