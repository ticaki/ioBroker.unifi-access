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
var stopSignal_exports = {};
__export(stopSignal_exports, {
  StoppedError: () => StoppedError,
  isStoppedError: () => isStoppedError,
  throwIfStopped: () => throwIfStopped
});
module.exports = __toCommonJS(stopSignal_exports);
class StoppedError extends Error {
  constructor(message = "the instance is stopping") {
    super(message);
    this.name = "StoppedError";
  }
}
function isStoppedError(err) {
  return err instanceof StoppedError;
}
function throwIfStopped(isStopped) {
  if (isStopped == null ? void 0 : isStopped()) {
    throw new StoppedError();
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  StoppedError,
  isStoppedError,
  throwIfStopped
});
//# sourceMappingURL=stopSignal.js.map
