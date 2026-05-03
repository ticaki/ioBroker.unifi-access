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
  Library: () => Library
});
module.exports = __toCommonJS(library_exports);
var import_deviceModels = require("./deviceModels");
class Library {
  adapter;
  constructor(adapter) {
    this.adapter = adapter;
  }
  async applyBootstrap(data) {
    var _a, _b;
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
    await this.ensureSimpleState("admin.uiSettings", "string", "Persistent UI settings (JSON)");
    await this.ensureSwitchState("doors.emergency.lockdown", "Lockdown \u2013 all doors forced locked", "boolean");
    await this.ensureSwitchState("doors.emergency.evacuation", "Evacuation \u2013 all doors forced unlocked", "boolean");
    await this.ensureSimpleState("info.webhookEndpointId", "string", "Registered webhook endpoint id");
    await this.ensureSimpleState("info.webhookSecret", "string", "Webhook signing secret");
    await this.ensureSimpleState(
      "info.webhookRegistered",
      "boolean",
      "Whether the webhook is registered with the controller"
    );
    await this.ensureSimpleState("info.protectConnected", "boolean", "UniFi Protect API connected");
    for (const device of (_a = data.devices) != null ? _a : []) {
      await this.ensureDevice(device);
    }
    for (const door of (_b = data.doors) != null ? _b : []) {
      await this.ensureDoor(door);
    }
  }
  async ensureDevice(device) {
    var _a, _b, _c, _d, _e, _f;
    const rawModel = typeof device.type === "string" ? device.type : void 0;
    const deviceType = typeof device.type === "string" ? device.type : void 0;
    const model = (0, import_deviceModels.detectModel)(rawModel, deviceType);
    const channelId = `devices.${this.safeId(device.id)}`;
    const capabilities = (0, import_deviceModels.featuresFor)(model);
    await this.adapter.extendObject(channelId, {
      type: "channel",
      common: { name: (_b = (_a = device.name) != null ? _a : device.alias) != null ? _b : device.id },
      native: { rawType: device.type, model, capabilities }
    });
    await this.ensureSimpleState(`${channelId}.name`, "string", "Device name");
    await this.ensureSimpleState(`${channelId}.alias`, "string", "Device alias");
    await this.ensureSimpleState(`${channelId}.type`, "string", "Device type as reported by controller");
    await this.ensureSimpleState(`${channelId}.model`, "string", "Resolved adapter model");
    await this.ensureSimpleState(`${channelId}.firmware`, "string", "Firmware version");
    await this.ensureSimpleState(`${channelId}.online`, "boolean", "Device online");
    await this.ensureSimpleState(`${channelId}.lastSeenAt`, "string", "ISO timestamp of last received event");
    if (capabilities.includes("event-thumbnail")) {
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
    }
    await this.adapter.setState(`${channelId}.name`, { val: (_c = device.name) != null ? _c : device.id, ack: true });
    await this.adapter.setState(`${channelId}.alias`, { val: (_d = device.alias) != null ? _d : "", ack: true });
    await this.adapter.setState(`${channelId}.type`, { val: (_e = device.type) != null ? _e : "", ack: true });
    await this.adapter.setState(`${channelId}.model`, { val: model, ack: true });
    await this.adapter.setState(`${channelId}.firmware`, { val: (_f = device.firmware) != null ? _f : "", ack: true });
    await this.adapter.setState(`${channelId}.online`, { val: device.online !== false, ack: true });
    await this.adapter.setState(`${channelId}.lastSeenAt`, { val: "", ack: true });
    return { model };
  }
  async ensureDoor(door) {
    var _a, _b, _c, _d, _e;
    const channelId = `doors.${this.safeId(door.id)}`;
    await this.adapter.extendObject(channelId, {
      type: "channel",
      common: { name: (_b = (_a = door.name) != null ? _a : door.full_name) != null ? _b : door.id },
      native: {}
    });
    await this.ensureSimpleState(`${channelId}.name`, "string", "Door name");
    await this.ensureSimpleState(`${channelId}.fullName`, "string", "Full door path");
    await this.ensureSimpleState(`${channelId}.locked`, "boolean", "Locked");
    await this.ensureSimpleState(`${channelId}.position`, "string", "Door position (open|close|unknown)");
    await this.ensureSimpleState(
      `${channelId}.isBindHub`,
      "boolean",
      "Door is bound to a hub (required for remote unlock)"
    );
    await this.ensureControlState(`${channelId}.unlock`, "Trigger door unlock", "boolean");
    await this.adapter.setState(`${channelId}.name`, { val: (_c = door.name) != null ? _c : door.id, ack: true });
    await this.adapter.setState(`${channelId}.fullName`, { val: (_d = door.full_name) != null ? _d : "", ack: true });
    const lockedFlag = door.door_lock_relay_status === "lock" ? true : door.door_lock_relay_status === "unlock" ? false : null;
    await this.adapter.setState(`${channelId}.locked`, { val: lockedFlag, ack: true });
    await this.adapter.setState(`${channelId}.position`, {
      val: (_e = door.door_position_status) != null ? _e : "unknown",
      ack: true
    });
    await this.adapter.setState(`${channelId}.isBindHub`, { val: door.is_bind_hub === true, ack: true });
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
  async pushEvent(event) {
    const id = `${this.adapter.namespace}.events.last`;
    const current = await this.adapter.getStateAsync("events.last");
    let list = [];
    if (typeof (current == null ? void 0 : current.val) === "string" && current.val) {
      try {
        const parsed = JSON.parse(current.val);
        if (Array.isArray(parsed)) {
          list = parsed;
        }
      } catch {
      }
    }
    list.unshift(event);
    if (list.length > 50) {
      list.length = 50;
    }
    await this.adapter.setForeignStateAsync(id, { val: JSON.stringify(list), ack: true });
  }
  async updateEventProtectData(ts, data) {
    const id = `${this.adapter.namespace}.events.last`;
    const current = await this.adapter.getStateAsync("events.last");
    let list = [];
    if (typeof (current == null ? void 0 : current.val) === "string" && current.val) {
      try {
        const parsed = JSON.parse(current.val);
        if (Array.isArray(parsed)) {
          list = parsed;
        }
      } catch {
      }
    }
    const idx = list.findIndex((e) => e.ts === ts);
    if (idx < 0) {
      return;
    }
    list[idx] = { ...list[idx], ...data };
    await this.adapter.setForeignStateAsync(id, { val: JSON.stringify(list), ack: true });
  }
  async ensureContainer(id, name) {
    await this.adapter.extendObject(id, { type: "channel", common: { name }, native: {} });
  }
  async ensureSimpleState(id, type, name) {
    await this.adapter.setObjectNotExistsAsync(id, {
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
  async ensureSwitchState(id, name, type = "boolean") {
    await this.adapter.setObjectNotExistsAsync(id, {
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
    await this.adapter.setObjectNotExistsAsync(id, {
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
  safeId(raw) {
    return raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Library
});
//# sourceMappingURL=library.js.map
