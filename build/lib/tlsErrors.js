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
var tlsErrors_exports = {};
__export(tlsErrors_exports, {
  isHostnameMismatch: () => isHostnameMismatch,
  tlsAdvice: () => tlsAdvice,
  tlsCertificateErrorCode: () => tlsCertificateErrorCode
});
module.exports = __toCommonJS(tlsErrors_exports);
const TLS_CERTIFICATE_ERROR_CODES = /* @__PURE__ */ new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "CERT_SIGNATURE_FAILURE",
  "CERT_CHAIN_TOO_LONG",
  "INVALID_CA",
  "HOSTNAME_MISMATCH",
  "ERR_TLS_CERT_ALTNAME_INVALID"
]);
function tlsCertificateErrorCode(err) {
  let current = err;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const code = current.code;
    if (typeof code === "string" && TLS_CERTIFICATE_ERROR_CODES.has(code)) {
      return code;
    }
    current = current.cause;
  }
  return void 0;
}
function isHostnameMismatch(code) {
  return code === "ERR_TLS_CERT_ALTNAME_INVALID" || code === "HOSTNAME_MISMATCH";
}
function tlsAdvice(code, where) {
  const toggle = where === "controller" ? '"Verify TLS certificate" in the connection settings' : '"Verify TLS certificate" on the Protect tab';
  if (isHostnameMismatch(code)) {
    return `The certificate is not issued for the configured host name / IP address. Enter the controller host exactly as it appears in the certificate (subject alternative name), or disable ${toggle}.`;
  }
  const device = where === "controller" ? "controller" : "console";
  return `Either disable ${toggle} or store the CA certificate of the ${device} in the connection settings.`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  isHostnameMismatch,
  tlsAdvice,
  tlsCertificateErrorCode
});
//# sourceMappingURL=tlsErrors.js.map
