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
async function deleteAllMatching(http, url, extraId, logger) {
  let list;
  try {
    list = await http.listWebhookEndpoints();
  } catch (err) {
    logger.warn(`Could not list webhook endpoints before delete: ${err.message}`);
    return;
  }
  const toDelete = /* @__PURE__ */ new Set();
  for (const e of list) {
    if (e.endpoint === url || e.id === extraId) {
      toDelete.add(e.id);
    }
  }
  for (const id of toDelete) {
    try {
      await http.deleteWebhookEndpoint(id);
      logger.info(`Deleted webhook endpoint ${id}.`);
    } catch (err) {
      logger.warn(`Failed to delete webhook endpoint ${id}: ${err.message}`);
    }
  }
}
async function ensureRegistration(options) {
  var _a, _b, _c;
  const events = (_a = options.events) != null ? _a : DEFAULT_WEBHOOK_EVENTS;
  const list = await options.http.listWebhookEndpoints();
  const existing = list.find((e) => e.endpoint === options.publicUrl);
  for (const e of list) {
    if (e.endpoint !== options.publicUrl && e.name === options.name) {
      options.logger.info(`Removing stale webhook endpoint ${e.id} with outdated URL ${e.endpoint}.`);
      try {
        await options.http.deleteWebhookEndpoint(e.id);
      } catch (err) {
        options.logger.warn(`Could not remove stale endpoint ${e.id}: ${err.message}`);
      }
    }
  }
  if ((existing == null ? void 0 : existing.id) && (existing == null ? void 0 : existing.secret)) {
    options.logger.debug(`Webhook endpoint already registered: ${existing.id}`);
    return { id: existing.id, secret: existing.secret, endpoint: existing.endpoint };
  }
  if (existing) {
    options.logger.info(`Webhook endpoint exists but list did not return a secret \u2014 recreating.`);
    try {
      await options.http.deleteWebhookEndpoint(existing.id);
    } catch (err) {
      options.logger.warn(`Failed to delete stale webhook endpoint: ${err.message}`);
    }
  }
  const result = await options.http.createWebhookEndpoint({
    name: options.name,
    endpoint: options.publicUrl,
    events: [...events]
  });
  if (result.code === "CODE_DEVICE_WEBHOOK_ENDPOINT_DUPLICATED") {
    options.logger.info(`Webhook endpoint already exists on controller (race/stale) \u2014 fetching from list.`);
    const refreshed = await options.http.listWebhookEndpoints();
    const dup = refreshed.find((e) => e.endpoint === options.publicUrl);
    if ((dup == null ? void 0 : dup.id) && (dup == null ? void 0 : dup.secret)) {
      return { id: dup.id, secret: dup.secret, endpoint: dup.endpoint };
    }
    throw new Error("Webhook endpoint is duplicated on controller but could not be found in the list.");
  }
  if (!((_b = result.endpoint) == null ? void 0 : _b.id) || !((_c = result.endpoint) == null ? void 0 : _c.secret)) {
    throw new Error("Webhook endpoint created but response did not include id/secret.");
  }
  options.logger.info(`Registered new webhook endpoint ${result.endpoint.id} for ${options.publicUrl}.`);
  return { id: result.endpoint.id, secret: result.endpoint.secret, endpoint: result.endpoint.endpoint };
}
async function reregister(options, storedId) {
  var _a, _b, _c, _d, _e, _f;
  await deleteAllMatching(options.http, options.publicUrl, storedId, options.logger);
  const result = await options.http.createWebhookEndpoint({
    name: options.name,
    endpoint: options.publicUrl,
    events: [...(_a = options.events) != null ? _a : DEFAULT_WEBHOOK_EVENTS]
  });
  if (result.code === "CODE_DEVICE_WEBHOOK_ENDPOINT_DUPLICATED") {
    options.logger.warn(`Webhook endpoint still duplicated after delete \u2014 retrying cleanup.`);
    await deleteAllMatching(options.http, options.publicUrl, null, options.logger);
    const retry = await options.http.createWebhookEndpoint({
      name: options.name,
      endpoint: options.publicUrl,
      events: [...(_b = options.events) != null ? _b : DEFAULT_WEBHOOK_EVENTS]
    });
    if (!((_c = retry.endpoint) == null ? void 0 : _c.id) || !((_d = retry.endpoint) == null ? void 0 : _d.secret)) {
      throw new Error("Webhook endpoint re-registration failed: response did not include id/secret after duplicate cleanup.");
    }
    return { id: retry.endpoint.id, secret: retry.endpoint.secret, endpoint: retry.endpoint.endpoint };
  }
  if (!((_e = result.endpoint) == null ? void 0 : _e.id) || !((_f = result.endpoint) == null ? void 0 : _f.secret)) {
    throw new Error("Webhook endpoint created but response did not include id/secret.");
  }
  return { id: result.endpoint.id, secret: result.endpoint.secret, endpoint: result.endpoint.endpoint };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_WEBHOOK_EVENTS,
  ensureRegistration,
  reregister
});
//# sourceMappingURL=registration.js.map
