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
var library_exports = {};
__export(library_exports, {
  Library: () => Library,
  doorLocked: () => doorLocked,
  doorPosition: () => doorPosition
});
module.exports = __toCommonJS(library_exports);
var import_deviceModels = require("./deviceModels");
var import_controlValues = require("./controlValues");
var import_stopSignal = require("./stopSignal");
function doorLocked(door) {
  return door.door_lock_relay_status === "lock" ? true : door.door_lock_relay_status === "unlock" ? false : null;
}
function doorPosition(door) {
  const value = door.door_position_status;
  return typeof value === "string" && value !== "" ? value : "unknown";
}
class Library {
  adapter;
  isStopped;
  /**
   * @param adapter The adapter instance
   * @param isStopped Stop signal: once it is true, every write is refused with `StoppedError`
   */
  constructor(adapter, isStopped = () => false) {
    this.adapter = adapter;
    this.isStopped = isStopped;
  }
  baseObjectsReady = false;
  /** Last value written per state through writeState() — lets status checks skip unchanged values. */
  lastWritten = /* @__PURE__ */ new Map();
  /** Serialises all changes of events.last. */
  eventQueue = Promise.resolve();
  thumbnailStatesReady = /* @__PURE__ */ new Set();
  /**
   * Create every object that does not depend on what the controller reports (channels, info,
   * doorbell, events and notification states). Called at adapter start, before anything writes a
   * state — also when the controller is not reachable yet — and again by applyBootstrap().
   */
  async ensureBaseObjects() {
    if (this.baseObjectsReady) {
      return;
    }
    await this.ensureContainer("devices", "Devices");
    await this.ensureContainer("doors", "Doors");
    await this.ensureNotificationsContainer();
    await this.ensureContainer("doors.emergency", "Door Emergency Status");
    await this.ensureContainer("events", "Events");
    await this.ensureContainer("doorbell", "Doorbell");
    await this.ensureContainer("admin", "Adapter UI state");
    await this.ensureContainer("info", "Adapter info");
    await this.ensureSimpleState("doorbell.activeCallId", "string", "Currently ringing call id");
    await this.ensureSimpleState("doorbell.activeFromDevice", "string", "Originating device of active call");
    await this.ensureSimpleState("doorbell.activeStartedAt", "number", "Start of active call (ms epoch)");
    await this.ensureSimpleState("events.last", "string", "Last 50 events as JSON");
    await this.extend("admin.uiSettings", {
      type: "state",
      common: { name: "Persistent UI settings (JSON)", type: "string", role: "json", read: true, write: true },
      native: {}
    });
    await this.ensureSwitchState("doors.emergency.lockdown", "Lockdown \u2013 all doors forced locked", "boolean");
    await this.ensureSwitchState("doors.emergency.evacuation", "Evacuation \u2013 all doors forced unlocked", "boolean");
    await this.ensureSimpleState("info.webhookEndpointId", "string", "Registered webhook endpoint id");
    await this.ensureSimpleState(
      "info.webhookRegistered",
      "boolean",
      "Whether the webhook is registered with the controller"
    );
    await this.ensureSimpleState("info.protectConnected", "boolean", "UniFi Protect API connected");
    this.baseObjectsReady = true;
  }
  async applyBootstrap(data) {
    var _a, _b;
    await this.ensureBaseObjects();
    for (const device of (_a = data.devices) != null ? _a : []) {
      await this.ensureDevice(device);
    }
    for (const door of (_b = data.doors) != null ? _b : []) {
      await this.ensureDoor(door);
    }
  }
  async ensureDevice(device) {
    var _a, _b, _c, _d, _e;
    const rawModel = typeof device.type === "string" ? device.type : void 0;
    const deviceType = typeof device.type === "string" ? device.type : void 0;
    const model = (0, import_deviceModels.detectModel)(rawModel, deviceType);
    const channelId = `devices.${this.safeId(device.id)}`;
    const capabilities = (0, import_deviceModels.featuresFor)(model);
    await this.ensureNamedChannel(channelId, (_b = (_a = device.name) != null ? _a : device.alias) != null ? _b : device.id, {
      rawType: device.type,
      model,
      capabilities
    });
    await this.ensureSimpleState(`${channelId}.name`, "string", "Device name");
    await this.ensureSimpleState(`${channelId}.alias`, "string", "Device alias");
    await this.ensureSimpleState(`${channelId}.type`, "string", "Device type as reported by controller");
    await this.ensureSimpleState(`${channelId}.model`, "string", "Resolved adapter model");
    await this.ensureSimpleState(`${channelId}.firmware`, "string", "Firmware version");
    await this.ensureSimpleState(`${channelId}.online`, "boolean", "Device online");
    await this.ensureSimpleState(`${channelId}.lastSeenAt`, "string", "ISO timestamp of last received event");
    if (capabilities.includes("event-thumbnail")) {
      await this.ensureThumbnailStates(device.id);
    }
    await this.set(`${channelId}.name`, { val: (_c = device.name) != null ? _c : device.id, ack: true });
    await this.set(`${channelId}.alias`, { val: (_d = device.alias) != null ? _d : "", ack: true });
    await this.set(`${channelId}.type`, { val: (_e = device.type) != null ? _e : "", ack: true });
    await this.set(`${channelId}.model`, { val: model, ack: true });
    if (typeof device.firmware === "string" && device.firmware !== "") {
      await this.set(`${channelId}.firmware`, { val: device.firmware, ack: true });
    } else if (await this.adapter.getStateAsync(`${channelId}.firmware`) === null) {
      await this.set(`${channelId}.firmware`, { val: "", ack: true });
    }
    await this.set(`${channelId}.online`, { val: device.online !== false, ack: true });
    if (await this.adapter.getStateAsync(`${channelId}.lastSeenAt`) === null) {
      await this.set(`${channelId}.lastSeenAt`, { val: "", ack: true });
    }
    return { model };
  }
  async ensureDoor(door) {
    var _a, _b, _c, _d;
    const channelId = `doors.${this.safeId(door.id)}`;
    await this.ensureNamedChannel(channelId, (_b = (_a = door.name) != null ? _a : door.full_name) != null ? _b : door.id, {});
    await this.ensureSimpleState(`${channelId}.name`, "string", "Door name");
    await this.ensureSimpleState(`${channelId}.fullName`, "string", "Full door path");
    await this.ensureSimpleState(`${channelId}.locked`, "boolean", "Locked");
    await this.ensureSimpleState(`${channelId}.position`, "string", "Door position (open|close|unknown)");
    await this.ensureSimpleState(
      `${channelId}.isBindHub`,
      "boolean",
      "Door is bound to a hub (required for remote unlock)"
    );
    await this.ensureState(`${channelId}.lockRuleType`, {
      name: "Active temporary lock rule (schedule, keep_lock, keep_unlock, custom, lock_early; empty = none)",
      type: "string",
      role: "text"
    });
    await this.ensureState(`${channelId}.lockRuleEndsAt`, {
      name: "End of the active temporary lock rule (ms epoch)",
      type: "number",
      role: "value.time"
    });
    await this.ensureControlState(`${channelId}.unlock`, "Trigger door unlock", "boolean");
    await this.extend(`${channelId}.unlock_duration`, {
      type: "state",
      common: {
        name: "Unlock for N minutes (0 = pulse)",
        type: "number",
        role: "level",
        unit: "min",
        min: 0,
        max: import_controlValues.MAX_UNLOCK_MINUTES,
        def: 0,
        read: true,
        write: true
      },
      native: {}
    });
    if (await this.adapter.getStateAsync(`${channelId}.unlock_duration`) === null) {
      await this.set(`${channelId}.unlock_duration`, { val: 0, ack: true });
    }
    await this.extend(`${channelId}.lock_rule`, {
      type: "state",
      common: {
        name: "Lock rule",
        type: "number",
        role: "value",
        def: 0,
        read: true,
        write: true,
        states: { ...import_controlValues.LOCK_RULE_STATES }
      },
      native: {}
    });
    if (await this.adapter.getStateAsync(`${channelId}.lock_rule`) === null) {
      await this.set(`${channelId}.lock_rule`, { val: 0, ack: true });
    }
    await this.set(`${channelId}.name`, { val: (_c = door.name) != null ? _c : door.id, ack: true });
    await this.set(`${channelId}.fullName`, { val: (_d = door.full_name) != null ? _d : "", ack: true });
    await this.writeState(`${channelId}.locked`, doorLocked(door), true);
    await this.writeState(`${channelId}.position`, doorPosition(door), true);
    await this.set(`${channelId}.isBindHub`, { val: door.is_bind_hub === true, ack: true });
  }
  /**
   * Write `doors.<id>.locked` (true/false/null = unknown) as reported by an event or assumed after a command.
   *
   * @param doorId Door id as used by the controller
   * @param locked New value
   */
  async setDoorLocked(doorId, locked) {
    await this.writeState(`doors.${this.safeId(doorId)}.locked`, locked);
  }
  /**
   * Write `doors.<id>.position` as reported by a door position sensor event.
   *
   * @param doorId Door id as used by the controller
   * @param position `open`, `close` or `unknown`
   */
  async setDoorPosition(doorId, position) {
    await this.writeState(`doors.${this.safeId(doorId)}.position`, position);
  }
  /**
   * Mirror the lock and position status of a door record read from the controller. Values that did
   * not change are not written again, so a periodic check does not produce state updates.
   *
   * @param door Door as returned by GET /doors or GET /doors/:id
   */
  async updateDoorStatus(door) {
    const channelId = `doors.${this.safeId(door.id)}`;
    await this.writeState(`${channelId}.locked`, doorLocked(door), true);
    await this.writeState(`${channelId}.position`, doorPosition(door), true);
  }
  /**
   * Mirror the temporary lock rule of a door (GET /doors/:id/lock_rule). What the controller answers
   * for a door without an active rule is not documented, so everything unusable maps to "no rule".
   *
   * @param doorId Door id as used by the controller
   * @param rule Rule as returned by the controller, `null` when there is none
   */
  async setDoorLockRule(doorId, rule) {
    const channelId = `doors.${this.safeId(doorId)}`;
    const type = typeof (rule == null ? void 0 : rule.type) === "string" ? rule.type : "";
    const ended = rule == null ? void 0 : rule.ended_time;
    const endsAt = typeof ended === "number" && Number.isFinite(ended) && ended > 0 ? Math.round(ended * 1e3) : null;
    await this.writeState(`${channelId}.lockRuleType`, type, true);
    await this.writeState(`${channelId}.lockRuleEndsAt`, endsAt, true);
  }
  /**
   * Write a state with ack and remember the value.
   *
   * @param id State id without namespace
   * @param val Value to write
   * @param onlyIfChanged Skip the write when this value was the last one written through this method
   */
  async writeState(id, val, onlyIfChanged = false) {
    if (onlyIfChanged && this.lastWritten.has(id) && this.lastWritten.get(id) === val) {
      return;
    }
    this.lastWritten.set(id, val);
    await this.set(id, { val, ack: true });
  }
  async ensureNotificationsContainer() {
    await this.ensureContainer("notifications", "Notifications");
    await this.ensureSimpleState("notifications.lastRaw", "string", "Last notification raw JSON body");
    await this.ensureSimpleState("notifications.lastAlarmId", "string", "Last alarm ID");
    await this.ensureSimpleState("notifications.lastEventType", "string", "Last notification event type");
    await this.ensureSimpleState("notifications.lastLocationId", "string", "Last location UUID");
    await this.ensureSimpleState("notifications.lastLocationName", "string", "Last location name (resolved)");
    await this.ensureSimpleState("notifications.lastUserId", "string", "Last user UUID");
    await this.ensureSimpleState("notifications.lastUserName", "string", "Last user name (resolved)");
    await this.ensureSimpleState("notifications.lastDirection", "string", "Last direction");
    await this.ensureSimpleState("notifications.lastUnlockMethod", "string", "Last unlock method text");
    await this.ensureSimpleState("notifications.lastTimestamp", "number", "Last notification timestamp (ms epoch)");
  }
  /**
   * Prepend an event to `events.last` (newest first, at most 50).
   *
   * Events arrive concurrently (WebSocket and webhook). The read-modify-write of the list is
   * therefore serialised: every change waits for the previous one, so no event overwrites another.
   *
   * @param event The normalised event
   */
  pushEvent(event) {
    return this.enqueueEventUpdate(async () => {
      const list = await this.readEventList();
      list.unshift(event);
      if (list.length > 50) {
        list.length = 50;
      }
      await this.writeEventList(list);
    });
  }
  /**
   * Add the UniFi Protect fields to the logged event with the given timestamp (serialised with pushEvent()).
   *
   * @param ts Timestamp of the event to extend
   * @param data Protect camera/event ids and media URLs
   * @param data.protectCameraId Protect camera id
   * @param data.protectEventId Protect event id
   * @param data.protectSnapshotUrl Adapter-served snapshot URL
   * @param data.protectVideoUrl Adapter-served clip URL
   */
  updateEventProtectData(ts, data) {
    return this.enqueueEventUpdate(async () => {
      const list = await this.readEventList();
      const idx = list.findIndex((e) => e !== null && typeof e === "object" && e.ts === ts);
      if (idx < 0) {
        return;
      }
      list[idx] = { ...list[idx], ...data };
      await this.writeEventList(list);
    });
  }
  enqueueEventUpdate(task) {
    const run = this.eventQueue.then(task);
    this.eventQueue = run.catch(() => void 0);
    return run;
  }
  async readEventList() {
    const current = await this.adapter.getStateAsync("events.last");
    if (typeof (current == null ? void 0 : current.val) === "string" && current.val) {
      try {
        const parsed = JSON.parse(current.val);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
      }
    }
    return [];
  }
  async writeEventList(list) {
    (0, import_stopSignal.throwIfStopped)(this.isStopped);
    await this.adapter.setForeignStateAsync(`${this.adapter.namespace}.events.last`, {
      val: JSON.stringify(list),
      ack: true
    });
  }
  /**
   * Create the thumbnail states of a device if they do not exist yet. Readers of every model can
   * deliver thumbnails, so the states are created on demand for models without the capability flag.
   *
   * @param deviceId Device id as used by the controller
   */
  async ensureThumbnailStates(deviceId) {
    const channelId = `devices.${this.safeId(deviceId)}`;
    if (this.thumbnailStatesReady.has(channelId)) {
      return;
    }
    await this.ensureSimpleState(`${channelId}.lastThumbnailPath`, "string", "Path of last event thumbnail");
    await this.ensureSimpleState(
      `${channelId}.lastThumbnailUrl`,
      "string",
      "Adapter-served URL for last event thumbnail"
    );
    await this.ensureSimpleState(
      `${channelId}.lastThumbnailAt`,
      "number",
      "Timestamp of last event thumbnail (ms epoch)"
    );
    this.thumbnailStatesReady.add(channelId);
  }
  /**
   * Create or update a device/door channel. The display name follows the controller as long as the
   * user did not rename the channel in ioBroker (the name last taken from the controller is kept in
   * `native.controllerName` to tell the two apart).
   *
   * @param id Channel id without namespace
   * @param name Name reported by the controller
   * @param native Additional native attributes
   */
  async ensureNamedChannel(id, name, native) {
    var _a, _b;
    const existing = await this.adapter.getObjectAsync(id);
    const existingName = (_a = existing == null ? void 0 : existing.common) == null ? void 0 : _a.name;
    const previous = (_b = existing == null ? void 0 : existing.native) == null ? void 0 : _b.controllerName;
    const userRenamed = existing !== null && existing !== void 0 && typeof previous === "string" && existingName !== previous;
    await this.extend(id, {
      type: "channel",
      common: userRenamed ? {} : { name },
      native: { ...native, controllerName: name }
    });
  }
  async ensureContainer(id, name) {
    await this.extend(id, { type: "channel", common: { name }, native: {} });
  }
  async ensureSimpleState(id, type, name) {
    await this.create(id, {
      type: "state",
      common: {
        name,
        type,
        role: "value",
        read: true,
        write: false
      },
      native: {}
    });
  }
  /**
   * Create a read-only state with an explicit role if it does not exist yet.
   *
   * @param id State id without namespace
   * @param common Name, type and role of the state
   * @param common.name Display name
   * @param common.type Value type
   * @param common.role ioBroker role
   */
  async ensureState(id, common) {
    await this.create(id, {
      type: "state",
      common: { ...common, read: true, write: false },
      native: {}
    });
  }
  async ensureSwitchState(id, name, type = "boolean") {
    await this.create(id, {
      type: "state",
      common: {
        name,
        type,
        role: "switch",
        read: true,
        write: true
      },
      native: {}
    });
  }
  async ensureControlState(id, name, type = "string") {
    await this.create(id, {
      type: "state",
      common: {
        name,
        type,
        role: "button",
        read: false,
        write: true
      },
      native: {}
    });
  }
  // The only places that write to ioBroker: after the stop they refuse (see stopSignal.ts).
  async set(id, state) {
    (0, import_stopSignal.throwIfStopped)(this.isStopped);
    await this.adapter.setState(id, state);
  }
  async extend(id, obj) {
    (0, import_stopSignal.throwIfStopped)(this.isStopped);
    await this.adapter.extendObject(id, obj);
  }
  async create(id, obj) {
    (0, import_stopSignal.throwIfStopped)(this.isStopped);
    await this.adapter.setObjectNotExistsAsync(id, obj);
  }
  safeId(raw) {
    return raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Library,
  doorLocked,
  doorPosition
});
//# sourceMappingURL=library.js.map
