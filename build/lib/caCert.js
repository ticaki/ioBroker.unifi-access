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
var caCert_exports = {};
__export(caCert_exports, {
  parseCaCert: () => parseCaCert,
  trustedCertificates: () => trustedCertificates
});
module.exports = __toCommonJS(caCert_exports);
var import_node_crypto = require("node:crypto");
var import_node_tls = require("node:tls");
const BLOCK = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;
function parseCaCert(raw) {
  const result = { certificates: [], problems: [] };
  if (typeof raw !== "string" || raw.trim() === "") {
    return result;
  }
  const text = raw.replace(/\r\n?/g, "\n");
  const blocks = [...text.matchAll(BLOCK)];
  if (blocks.length === 0) {
    result.problems.push('no "-----BEGIN CERTIFICATE-----" \u2026 "-----END CERTIFICATE-----" block found');
    return result;
  }
  blocks.forEach((block, index) => {
    var _a;
    const label = blocks.length > 1 ? `certificate ${index + 1}: ` : "";
    const body = block[1].replace(/\s+/g, "");
    if (body === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) {
      result.problems.push(`${label}the content is not base64`);
      return;
    }
    const lines = (_a = body.match(/.{1,64}/g)) != null ? _a : [];
    const pem = `-----BEGIN CERTIFICATE-----
${lines.join("\n")}
-----END CERTIFICATE-----
`;
    try {
      new import_node_crypto.X509Certificate(pem);
    } catch (err) {
      result.problems.push(
        `${label}not a readable certificate (${err instanceof Error ? err.message : String(err)})`
      );
      return;
    }
    result.certificates.push(pem);
  });
  return result;
}
function trustedCertificates(raw) {
  const { certificates } = parseCaCert(raw);
  return certificates.length > 0 ? [...import_node_tls.rootCertificates, ...certificates] : void 0;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  parseCaCert,
  trustedCertificates
});
//# sourceMappingURL=caCert.js.map
