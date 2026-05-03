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
var deviceModels_exports = {};
__export(deviceModels_exports, {
  detectModel: () => detectModel,
  featuresFor: () => featuresFor,
  modelHas: () => modelHas
});
module.exports = __toCommonJS(deviceModels_exports);
const FULL_CAPABILITIES = ["event-thumbnail", "doorbell", "door-unlock", "live-events"];
const DOORBELL_CAPABILITIES = [
  "event-thumbnail",
  "doorbell",
  "door-unlock",
  "live-events"
];
const READER_CAPABILITIES = ["event-thumbnail", "door-unlock", "live-events"];
const HUB_CAPABILITIES = ["live-events"];
const UNKNOWN_CAPABILITIES = ["live-events"];
function detectModel(rawModel, deviceType) {
  const value = `${rawModel != null ? rawModel : ""} ${deviceType != null ? deviceType : ""}`.toLowerCase();
  if (value.includes("ultra")) {
    return "UA-Ultra";
  }
  if (value.includes("g3")) {
    return "UA-G3-Pro";
  }
  if (value.includes("g2")) {
    return "UA-G2-Pro";
  }
  if (value.includes("hub") || value.includes("uah")) {
    return "UA-Hub";
  }
  return "unknown";
}
function featuresFor(model) {
  switch (model) {
    case "UA-Ultra":
      return FULL_CAPABILITIES;
    case "UA-G3-Pro":
      return DOORBELL_CAPABILITIES;
    case "UA-G2-Pro":
      return READER_CAPABILITIES;
    case "UA-Hub":
      return HUB_CAPABILITIES;
    default:
      return UNKNOWN_CAPABILITIES;
  }
}
function modelHas(model, capability) {
  return featuresFor(model).includes(capability);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  detectModel,
  featuresFor,
  modelHas
});
//# sourceMappingURL=deviceModels.js.map
