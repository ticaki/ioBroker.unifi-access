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
var secretMigration_exports = {};
__export(secretMigration_exports, {
  classifyStoredSecret: () => classifyStoredSecret
});
module.exports = __toCommonJS(secretMigration_exports);
const AES_PREFIX = "$/aes-192-cbc:";
function isPrintableAscii(value) {
  return /^[\x20-\x7e]*$/.test(value);
}
function classifyStoredSecret(input) {
  const { raw } = input;
  const decrypted = typeof input.decrypted === "string" ? input.decrypted : "";
  if (typeof raw !== "string" || raw === "") {
    return { kind: "empty", password: decrypted };
  }
  if (!input.isEncryptedAttribute) {
    return { kind: "unencrypted-attribute", password: raw };
  }
  if (raw.startsWith(AES_PREFIX)) {
    return { kind: "encrypted", password: decrypted };
  }
  let encrypted;
  try {
    encrypted = input.encrypt(raw);
  } catch {
    return { kind: "ambiguous", password: decrypted };
  }
  if (typeof encrypted !== "string" || encrypted === "" || encrypted === raw) {
    return { kind: "ambiguous", password: decrypted };
  }
  if (encrypted.startsWith(AES_PREFIX)) {
    return { kind: "plaintext", password: raw, encrypted };
  }
  const rawPrintable = isPrintableAscii(raw);
  if (!rawPrintable) {
    return { kind: "encrypted", password: decrypted };
  }
  if (!isPrintableAscii(encrypted)) {
    return { kind: "plaintext", password: raw, encrypted };
  }
  return { kind: "ambiguous", password: decrypted };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  classifyStoredSecret
});
//# sourceMappingURL=secretMigration.js.map
