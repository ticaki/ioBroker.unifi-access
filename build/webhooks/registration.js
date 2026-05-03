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
var registration_exports = {};
__export(registration_exports, {
  DEFAULT_WEBHOOK_EVENTS: () => DEFAULT_WEBHOOK_EVENTS,
  ensureRegistration: () => ensureRegistration,
  reregister: () => reregister
});
module.exports = __toCommonJS(registration_exports);
const DEFAULT_WEBHOOK_EVENTS = [
  "access.doorbell.incoming",
  "access.doorbell.completed",
  "access.doorbell.incoming.REN",
  "access.device.dps_status",
  "access.door.unlock",
  "access.device.emergency_status",
  "access.unlock_schedule.activate",
  "access.unlock_schedule.deactivate",
  "access.temporary_unlock.start",
  "access.temporary_unlock.end",
  "access.visitor.status.changed"
];
async function ensureRegistration(options, storedSecret, storedId) {
  var _a;
  const events = (_a = options.events) != null ? _a : DEFAULT_WEBHOOK_EVENTS;
  const list = await options.http.listWebhookEndpoints();
  const existing = list.find((e) => e.endpoint === options.publicUrl);
  if (existing) {
    if (storedId === existing.id && storedSecret) {
      options.logger.debug(`Webhook endpoint already registered: ${existing.id}`);
      return { id: existing.id, secret: storedSecret, endpoint: existing.endpoint };
    }
    options.logger.info(`Webhook endpoint exists but secret unknown \u2014 recreating to obtain a fresh secret.`);
    try {
      await options.http.deleteWebhookEndpoint(existing.id);
    } catch (err) {
      options.logger.warn(`Failed to delete stale webhook endpoint: ${err.message}`);
    }
  }
  const created = await options.http.createWebhookEndpoint({
    name: options.name,
    endpoint: options.publicUrl,
    events: [...events]
  });
  if (!(created == null ? void 0 : created.id) || !(created == null ? void 0 : created.secret)) {
    throw new Error("Webhook endpoint created but response did not include id/secret.");
  }
  options.logger.info(`Registered new webhook endpoint ${created.id} for ${options.publicUrl}.`);
  return { id: created.id, secret: created.secret, endpoint: created.endpoint };
}
async function reregister(options, storedId) {
  var _a;
  if (storedId) {
    try {
      await options.http.deleteWebhookEndpoint(storedId);
    } catch (err) {
      options.logger.warn(`Failed to delete previous webhook endpoint: ${err.message}`);
    }
  }
  const created = await options.http.createWebhookEndpoint({
    name: options.name,
    endpoint: options.publicUrl,
    events: [...(_a = options.events) != null ? _a : DEFAULT_WEBHOOK_EVENTS]
  });
  if (!(created == null ? void 0 : created.id) || !(created == null ? void 0 : created.secret)) {
    throw new Error("Webhook endpoint created but response did not include id/secret.");
  }
  return { id: created.id, secret: created.secret, endpoint: created.endpoint };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_WEBHOOK_EVENTS,
  ensureRegistration,
  reregister
});
//# sourceMappingURL=registration.js.map
