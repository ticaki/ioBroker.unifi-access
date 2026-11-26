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
  RegistrationStoppedError: () => RegistrationStoppedError,
  ensureRegistration: () => ensureRegistration,
  reregister: () => reregister
});
module.exports = __toCommonJS(registration_exports);
var import_stopSignal = require("../lib/stopSignal");
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
class RegistrationStoppedError extends import_stopSignal.StoppedError {
  constructor() {
    super("Webhook registration abandoned: the instance is stopping");
    this.name = "RegistrationStoppedError";
  }
}
function stopCheck(options) {
  try {
    (0, import_stopSignal.throwIfStopped)(options.isStopped);
  } catch {
    throw new RegistrationStoppedError();
  }
}
function rethrowStop(err) {
  if ((0, import_stopSignal.isStoppedError)(err)) {
    throw err instanceof RegistrationStoppedError ? err : new RegistrationStoppedError();
  }
}
function sameEvents(a, b) {
  if (!Array.isArray(a)) {
    return false;
  }
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((event) => right.has(event));
}
function isOwn(endpoint, options) {
  return endpoint.name === options.name || !!options.storedId && endpoint.id === options.storedId;
}
async function deleteEndpoints(options, ids, what) {
  const { http, logger } = options;
  for (const id of ids) {
    stopCheck(options);
    try {
      await http.deleteWebhookEndpoint(id);
      logger.info(`Deleted ${what} ${id}.`);
    } catch (err) {
      rethrowStop(err);
      logger.warn(`Failed to delete ${what} ${id}: ${err.message}`);
    }
  }
}
async function createEndpoint(options, events) {
  var _a, _b;
  stopCheck(options);
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
  if (!((_a = result.endpoint) == null ? void 0 : _a.id) || !((_b = result.endpoint) == null ? void 0 : _b.secret)) {
    throw new Error("Webhook endpoint created but response did not include id/secret.");
  }
  options.logger.info(`Registered new webhook endpoint ${result.endpoint.id} for ${options.publicUrl}.`);
  return { id: result.endpoint.id, secret: result.endpoint.secret, endpoint: result.endpoint.endpoint };
}
async function updateEndpoint(options, endpoint, events) {
  stopCheck(options);
  const updated = await options.http.updateWebhookEndpoint(endpoint.id, {
    name: options.name,
    endpoint: options.publicUrl,
    events: [...events],
    ...endpoint.headers && Object.keys(endpoint.headers).length > 0 ? { headers: endpoint.headers } : {}
  });
  return typeof (updated == null ? void 0 : updated.secret) === "string" && updated.secret ? updated.secret : void 0;
}
async function ensureRegistration(options) {
  var _a, _b;
  const events = (_a = options.events) != null ? _a : DEFAULT_WEBHOOK_EVENTS;
  const { logger } = options;
  stopCheck(options);
  const list = await options.http.listWebhookEndpoints();
  let current = list.find((e) => e.endpoint === options.publicUrl);
  const staleOwn = list.filter((e) => e.endpoint !== options.publicUrl && isOwn(e, options));
  if (!current && staleOwn.length > 0) {
    const candidate = (_b = staleOwn.find((e) => e.id === options.storedId)) != null ? _b : staleOwn[0];
    const secret = candidate.secret || (candidate.id === options.storedId ? options.storedSecret : void 0);
    if (secret) {
      try {
        const updatedSecret = await updateEndpoint(options, candidate, events);
        logger.info(
          `Webhook endpoint ${candidate.id} moved from outdated URL ${candidate.endpoint} to ${options.publicUrl}.`
        );
        staleOwn.splice(staleOwn.indexOf(candidate), 1);
        current = {
          ...candidate,
          name: options.name,
          endpoint: options.publicUrl,
          events: [...events],
          secret: updatedSecret != null ? updatedSecret : secret
        };
      } catch (err) {
        rethrowStop(err);
        logger.warn(
          `Could not update webhook endpoint ${candidate.id} (${err.message}) \u2014 registering a new one.`
        );
      }
    }
  }
  for (const e of staleOwn) {
    stopCheck(options);
    logger.info(`Removing stale webhook endpoint ${e.id} with outdated URL ${e.endpoint}.`);
    try {
      await options.http.deleteWebhookEndpoint(e.id);
    } catch (err) {
      rethrowStop(err);
      logger.warn(`Could not remove stale endpoint ${e.id}: ${err.message}`);
    }
  }
  if (current) {
    const secret = current.secret || (current.id === options.storedId ? options.storedSecret : void 0);
    if (current.id && secret) {
      if (!sameEvents(current.events, events) || current.name !== options.name) {
        try {
          const updatedSecret = await updateEndpoint(options, current, events);
          logger.info(`Webhook endpoint ${current.id} updated (name / subscribed events).`);
          return { id: current.id, secret: updatedSecret != null ? updatedSecret : secret, endpoint: options.publicUrl };
        } catch (err) {
          rethrowStop(err);
          logger.warn(
            `Webhook endpoint ${current.id} could not be updated: ${err.message} \u2014 some event types may not be delivered.`
          );
        }
      } else {
        logger.debug(`Webhook endpoint already registered: ${current.id}`);
      }
      return { id: current.id, secret, endpoint: current.endpoint };
    }
    stopCheck(options);
    logger.info(`Webhook endpoint exists but its secret is not available \u2014 recreating.`);
    try {
      await options.http.deleteWebhookEndpoint(current.id);
    } catch (err) {
      rethrowStop(err);
      logger.warn(`Failed to delete stale webhook endpoint: ${err.message}`);
    }
  }
  return createEndpoint(options, events);
}
async function reregister(options, storedId) {
  var _a, _b, _c, _d, _e;
  const events = (_a = options.events) != null ? _a : DEFAULT_WEBHOOK_EVENTS;
  const scoped = { ...options, storedId };
  const cleanup = async () => {
    let list;
    try {
      list = await options.http.listWebhookEndpoints();
    } catch (err) {
      rethrowStop(err);
      options.logger.warn(`Could not list webhook endpoints before delete: ${err.message}`);
      return;
    }
    stopCheck(options);
    const ids = new Set(list.filter((e) => e.endpoint === options.publicUrl || isOwn(e, scoped)).map((e) => e.id));
    await deleteEndpoints(options, ids, "webhook endpoint");
  };
  stopCheck(options);
  await cleanup();
  stopCheck(options);
  const payload = { name: options.name, endpoint: options.publicUrl, events: [...events] };
  const result = await options.http.createWebhookEndpoint(payload);
  if (result.code === "CODE_DEVICE_WEBHOOK_ENDPOINT_DUPLICATED") {
    options.logger.warn(`Webhook endpoint still duplicated after delete \u2014 retrying cleanup.`);
    await cleanup();
    stopCheck(options);
    const retry = await options.http.createWebhookEndpoint(payload);
    if (!((_b = retry.endpoint) == null ? void 0 : _b.id) || !((_c = retry.endpoint) == null ? void 0 : _c.secret)) {
      throw new Error(
        "Webhook endpoint re-registration failed: response did not include id/secret after duplicate cleanup."
      );
    }
    return { id: retry.endpoint.id, secret: retry.endpoint.secret, endpoint: retry.endpoint.endpoint };
  }
  if (!((_d = result.endpoint) == null ? void 0 : _d.id) || !((_e = result.endpoint) == null ? void 0 : _e.secret)) {
    throw new Error("Webhook endpoint created but response did not include id/secret.");
  }
  return { id: result.endpoint.id, secret: result.endpoint.secret, endpoint: result.endpoint.endpoint };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_WEBHOOK_EVENTS,
  RegistrationStoppedError,
  ensureRegistration,
  reregister
});
//# sourceMappingURL=registration.js.map
