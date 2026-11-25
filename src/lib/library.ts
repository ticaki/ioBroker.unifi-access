import type { UnifiAccess } from '../UnifiAccess';
import { detectModel, featuresFor, type UnifiDeviceModel } from './deviceModels';
import type { UnifiDeviceRaw, UnifiDoorLockRule, UnifiDoorRaw } from './types';
import { LOCK_RULE_STATES, MAX_UNLOCK_MINUTES } from './controlValues';

/**
 * `doors.<id>.locked` for a door record: true/false for the documented relay states, `null` when unknown.
 *
 * @param door Door as returned by the controller
 */
export function doorLocked(door: UnifiDoorRaw): boolean | null {
	return door.door_lock_relay_status === 'lock' ? true : door.door_lock_relay_status === 'unlock' ? false : null;
}

/**
 * `doors.<id>.position` for a door record: `open` / `close`, or `unknown` when no sensor is connected
 * (the controller reports `null` or — as in the documented sample — an empty string).
 *
 * @param door Door as returned by the controller
 */
export function doorPosition(door: UnifiDoorRaw): string {
	const value: unknown = door.door_position_status;
	return typeof value === 'string' && value !== '' ? value : 'unknown';
}

/**
 * Sets up and updates ioBroker objects/states for the UniFi Access bootstrap response.
 * Doors and devices have a fixed leaf-state set, so we create them inline rather than
 * building a generic schema engine.
 */
export class Library {
	private readonly adapter: UnifiAccess;

	constructor(adapter: UnifiAccess) {
		this.adapter = adapter;
	}

	private baseObjectsReady = false;
	/** Last value written per state through writeState() — lets status checks skip unchanged values. */
	private readonly lastWritten = new Map<string, ioBroker.StateValue>();
	/** Serialises all changes of events.last. */
	private eventQueue: Promise<void> = Promise.resolve();
	private readonly thumbnailStatesReady = new Set<string>();

	/**
	 * Create every object that does not depend on what the controller reports (channels, info,
	 * doorbell, events and notification states). Called at adapter start, before anything writes a
	 * state — also when the controller is not reachable yet — and again by applyBootstrap().
	 */
	async ensureBaseObjects(): Promise<void> {
		if (this.baseObjectsReady) {
			return;
		}
		await this.ensureContainer('devices', 'Devices');
		await this.ensureContainer('doors', 'Doors');
		await this.ensureNotificationsContainer();
		await this.ensureContainer('doors.emergency', 'Door Emergency Status');
		await this.ensureContainer('events', 'Events');
		await this.ensureContainer('doorbell', 'Doorbell');
		await this.ensureContainer('admin', 'Adapter UI state');
		await this.ensureContainer('info', 'Adapter info');

		await this.ensureSimpleState('doorbell.activeCallId', 'string', 'Currently ringing call id');
		await this.ensureSimpleState('doorbell.activeFromDevice', 'string', 'Originating device of active call');
		await this.ensureSimpleState('doorbell.activeStartedAt', 'number', 'Start of active call (ms epoch)');
		await this.ensureSimpleState('events.last', 'string', 'Last 50 events as JSON');
		// Written by the www panel (socket setState): must be writable. extendObject also corrects the
		// object of earlier versions, which was created read-only.
		await this.adapter.extendObject('admin.uiSettings', {
			type: 'state',
			common: { name: 'Persistent UI settings (JSON)', type: 'string', role: 'json', read: true, write: true },
			native: {},
		});
		await this.ensureSwitchState('doors.emergency.lockdown', 'Lockdown – all doors forced locked', 'boolean');
		await this.ensureSwitchState('doors.emergency.evacuation', 'Evacuation – all doors forced unlocked', 'boolean');

		await this.ensureSimpleState('info.webhookEndpointId', 'string', 'Registered webhook endpoint id');
		await this.ensureSimpleState(
			'info.webhookRegistered',
			'boolean',
			'Whether the webhook is registered with the controller',
		);
		await this.ensureSimpleState('info.protectConnected', 'boolean', 'UniFi Protect API connected');
		this.baseObjectsReady = true;
	}

	async applyBootstrap(data: { devices: UnifiDeviceRaw[]; doors: UnifiDoorRaw[] }): Promise<void> {
		await this.ensureBaseObjects();

		for (const device of data.devices ?? []) {
			await this.ensureDevice(device);
		}
		for (const door of data.doors ?? []) {
			await this.ensureDoor(door);
		}
	}

	async ensureDevice(device: UnifiDeviceRaw): Promise<{ model: UnifiDeviceModel }> {
		const rawModel = typeof device.type === 'string' ? device.type : undefined;
		const deviceType = typeof device.type === 'string' ? device.type : undefined;
		const model = detectModel(rawModel, deviceType);
		const channelId = `devices.${this.safeId(device.id)}`;
		const capabilities = featuresFor(model);

		await this.ensureNamedChannel(channelId, device.name ?? device.alias ?? device.id, {
			rawType: device.type,
			model,
			capabilities,
		});

		await this.ensureSimpleState(`${channelId}.name`, 'string', 'Device name');
		await this.ensureSimpleState(`${channelId}.alias`, 'string', 'Device alias');
		await this.ensureSimpleState(`${channelId}.type`, 'string', 'Device type as reported by controller');
		await this.ensureSimpleState(`${channelId}.model`, 'string', 'Resolved adapter model');
		await this.ensureSimpleState(`${channelId}.firmware`, 'string', 'Firmware version');
		await this.ensureSimpleState(`${channelId}.online`, 'boolean', 'Device online');
		await this.ensureSimpleState(`${channelId}.lastSeenAt`, 'string', 'ISO timestamp of last received event');

		if (capabilities.includes('event-thumbnail')) {
			await this.ensureThumbnailStates(device.id);
		}

		await this.adapter.setState(`${channelId}.name`, { val: device.name ?? device.id, ack: true });
		await this.adapter.setState(`${channelId}.alias`, { val: device.alias ?? '', ack: true });
		await this.adapter.setState(`${channelId}.type`, { val: device.type ?? '', ack: true });
		await this.adapter.setState(`${channelId}.model`, { val: model, ack: true });
		// `firmware` and `online` are not part of the documented response of GET /devices (API reference
		// 8.1 lists id, name, type, alias only). They are used when the controller sends them: firmware is
		// written only then (a value learned from an event is kept), and a device counts as online unless
		// the controller explicitly reports `online: false`.
		if (typeof device.firmware === 'string' && device.firmware !== '') {
			await this.adapter.setState(`${channelId}.firmware`, { val: device.firmware, ack: true });
		} else if ((await this.adapter.getStateAsync(`${channelId}.firmware`)) === null) {
			await this.adapter.setState(`${channelId}.firmware`, { val: '', ack: true });
		}
		await this.adapter.setState(`${channelId}.online`, { val: device.online !== false, ack: true });
		if ((await this.adapter.getStateAsync(`${channelId}.lastSeenAt`)) === null) {
			await this.adapter.setState(`${channelId}.lastSeenAt`, { val: '', ack: true });
		}

		return { model };
	}

	async ensureDoor(door: UnifiDoorRaw): Promise<void> {
		const channelId = `doors.${this.safeId(door.id)}`;
		await this.ensureNamedChannel(channelId, door.name ?? door.full_name ?? door.id, {});
		await this.ensureSimpleState(`${channelId}.name`, 'string', 'Door name');
		await this.ensureSimpleState(`${channelId}.fullName`, 'string', 'Full door path');
		await this.ensureSimpleState(`${channelId}.locked`, 'boolean', 'Locked');
		await this.ensureSimpleState(`${channelId}.position`, 'string', 'Door position (open|close|unknown)');
		await this.ensureSimpleState(
			`${channelId}.isBindHub`,
			'boolean',
			'Door is bound to a hub (required for remote unlock)',
		);
		await this.ensureState(`${channelId}.lockRuleType`, {
			name: 'Active temporary lock rule (schedule, keep_lock, keep_unlock, custom, lock_early; empty = none)',
			type: 'string',
			role: 'text',
		});
		await this.ensureState(`${channelId}.lockRuleEndsAt`, {
			name: 'End of the active temporary lock rule (ms epoch)',
			type: 'number',
			role: 'value.time',
		});
		await this.ensureControlState(`${channelId}.unlock`, 'Trigger door unlock', 'boolean');
		await this.adapter.extendObject(`${channelId}.unlock_duration`, {
			type: 'state',
			common: {
				name: 'Unlock for N minutes (0 = pulse)',
				type: 'number',
				role: 'level',
				unit: 'min',
				min: 0,
				max: MAX_UNLOCK_MINUTES,
				def: 0,
				read: true,
				write: true,
			},
			native: {},
		});
		if ((await this.adapter.getStateAsync(`${channelId}.unlock_duration`)) === null) {
			await this.adapter.setState(`${channelId}.unlock_duration`, { val: 0, ack: true });
		}
		await this.adapter.extendObject(`${channelId}.lock_rule`, {
			type: 'state',
			common: {
				name: 'Lock rule',
				type: 'number',
				role: 'value',
				def: 0,
				read: true,
				write: true,
				states: { ...LOCK_RULE_STATES },
			},
			native: {},
		});
		if ((await this.adapter.getStateAsync(`${channelId}.lock_rule`)) === null) {
			await this.adapter.setState(`${channelId}.lock_rule`, { val: 0, ack: true });
		}

		await this.adapter.setState(`${channelId}.name`, { val: door.name ?? door.id, ack: true });
		await this.adapter.setState(`${channelId}.fullName`, { val: door.full_name ?? '', ack: true });
		// a reload (reconnect) must not produce state updates for doors whose status did not change
		await this.writeState(`${channelId}.locked`, doorLocked(door), true);
		await this.writeState(`${channelId}.position`, doorPosition(door), true);
		await this.adapter.setState(`${channelId}.isBindHub`, { val: door.is_bind_hub === true, ack: true });
	}

	/**
	 * Write `doors.<id>.locked` (true/false/null = unknown) as reported by an event or assumed after a command.
	 *
	 * @param doorId Door id as used by the controller
	 * @param locked New value
	 */
	async setDoorLocked(doorId: string, locked: boolean | null): Promise<void> {
		await this.writeState(`doors.${this.safeId(doorId)}.locked`, locked);
	}

	/**
	 * Write `doors.<id>.position` as reported by a door position sensor event.
	 *
	 * @param doorId Door id as used by the controller
	 * @param position `open`, `close` or `unknown`
	 */
	async setDoorPosition(doorId: string, position: string): Promise<void> {
		await this.writeState(`doors.${this.safeId(doorId)}.position`, position);
	}

	/**
	 * Mirror the lock and position status of a door record read from the controller. Values that did
	 * not change are not written again, so a periodic check does not produce state updates.
	 *
	 * @param door Door as returned by GET /doors or GET /doors/:id
	 */
	async updateDoorStatus(door: UnifiDoorRaw): Promise<void> {
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
	async setDoorLockRule(doorId: string, rule: UnifiDoorLockRule | null): Promise<void> {
		const channelId = `doors.${this.safeId(doorId)}`;
		const type = typeof rule?.type === 'string' ? rule.type : '';
		const ended = rule?.ended_time;
		const endsAt =
			typeof ended === 'number' && Number.isFinite(ended) && ended > 0 ? Math.round(ended * 1000) : null;
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
	private async writeState(id: string, val: ioBroker.StateValue, onlyIfChanged = false): Promise<void> {
		if (onlyIfChanged && this.lastWritten.has(id) && this.lastWritten.get(id) === val) {
			return;
		}
		this.lastWritten.set(id, val);
		await this.adapter.setState(id, { val, ack: true });
	}

	async ensureNotificationsContainer(): Promise<void> {
		await this.ensureContainer('notifications', 'Notifications');
		await this.ensureSimpleState('notifications.lastRaw', 'string', 'Last notification raw JSON body');
		await this.ensureSimpleState('notifications.lastAlarmId', 'string', 'Last alarm ID');
		await this.ensureSimpleState('notifications.lastEventType', 'string', 'Last notification event type');
		await this.ensureSimpleState('notifications.lastLocationId', 'string', 'Last location UUID');
		await this.ensureSimpleState('notifications.lastLocationName', 'string', 'Last location name (resolved)');
		await this.ensureSimpleState('notifications.lastUserId', 'string', 'Last user UUID');
		await this.ensureSimpleState('notifications.lastUserName', 'string', 'Last user name (resolved)');
		await this.ensureSimpleState('notifications.lastDirection', 'string', 'Last direction');
		await this.ensureSimpleState('notifications.lastUnlockMethod', 'string', 'Last unlock method text');
		await this.ensureSimpleState('notifications.lastTimestamp', 'number', 'Last notification timestamp (ms epoch)');
	}

	/**
	 * Prepend an event to `events.last` (newest first, at most 50).
	 *
	 * Events arrive concurrently (WebSocket and webhook). The read-modify-write of the list is
	 * therefore serialised: every change waits for the previous one, so no event overwrites another.
	 *
	 * @param event The normalised event
	 */
	pushEvent(event: unknown): Promise<void> {
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
	updateEventProtectData(
		ts: number,
		data: {
			protectCameraId?: string;
			protectEventId?: string;
			protectSnapshotUrl?: string;
			protectVideoUrl?: string;
		},
	): Promise<void> {
		return this.enqueueEventUpdate(async () => {
			const list = (await this.readEventList()) as Record<string, unknown>[];
			const idx = list.findIndex(e => e !== null && typeof e === 'object' && e.ts === ts);
			if (idx < 0) {
				return;
			}
			list[idx] = { ...list[idx], ...data };
			await this.writeEventList(list);
		});
	}

	private enqueueEventUpdate(task: () => Promise<void>): Promise<void> {
		const run = this.eventQueue.then(task);
		// a failed update must not block the ones behind it
		this.eventQueue = run.catch(() => undefined);
		return run;
	}

	private async readEventList(): Promise<unknown[]> {
		const current = await this.adapter.getStateAsync('events.last');
		if (typeof current?.val === 'string' && current.val) {
			try {
				const parsed: unknown = JSON.parse(current.val);
				if (Array.isArray(parsed)) {
					return parsed;
				}
			} catch {
				/* start a fresh list */
			}
		}
		return [];
	}

	private async writeEventList(list: unknown[]): Promise<void> {
		await this.adapter.setForeignStateAsync(`${this.adapter.namespace}.events.last`, {
			val: JSON.stringify(list),
			ack: true,
		});
	}

	/**
	 * Create the thumbnail states of a device if they do not exist yet. Readers of every model can
	 * deliver thumbnails, so the states are created on demand for models without the capability flag.
	 *
	 * @param deviceId Device id as used by the controller
	 */
	async ensureThumbnailStates(deviceId: string): Promise<void> {
		const channelId = `devices.${this.safeId(deviceId)}`;
		if (this.thumbnailStatesReady.has(channelId)) {
			return;
		}
		await this.ensureSimpleState(`${channelId}.lastThumbnailPath`, 'string', 'Path of last event thumbnail');
		await this.ensureSimpleState(
			`${channelId}.lastThumbnailUrl`,
			'string',
			'Adapter-served URL for last event thumbnail',
		);
		await this.ensureSimpleState(
			`${channelId}.lastThumbnailAt`,
			'number',
			'Timestamp of last event thumbnail (ms epoch)',
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
	private async ensureNamedChannel(id: string, name: string, native: Record<string, unknown>): Promise<void> {
		const existing = await this.adapter.getObjectAsync(id);
		const existingName: unknown = existing?.common?.name;
		const previous: unknown = (existing?.native as Record<string, unknown> | undefined)?.controllerName;
		const userRenamed =
			existing !== null && existing !== undefined && typeof previous === 'string' && existingName !== previous;
		await this.adapter.extendObject(id, {
			type: 'channel',
			common: userRenamed ? {} : { name },
			native: { ...native, controllerName: name },
		});
	}

	private async ensureContainer(id: string, name: string): Promise<void> {
		await this.adapter.extendObject(id, { type: 'channel', common: { name }, native: {} });
	}

	private async ensureSimpleState(id: string, type: ioBroker.CommonType, name: string): Promise<void> {
		await this.adapter.setObjectNotExistsAsync(id, {
			type: 'state',
			common: {
				name,
				type,
				role: 'value',
				read: true,
				write: false,
			},
			native: {},
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
	private async ensureState(
		id: string,
		common: { name: string; type: ioBroker.CommonType; role: string },
	): Promise<void> {
		await this.adapter.setObjectNotExistsAsync(id, {
			type: 'state',
			common: { ...common, read: true, write: false },
			native: {},
		});
	}

	private async ensureSwitchState(id: string, name: string, type: ioBroker.CommonType = 'boolean'): Promise<void> {
		await this.adapter.setObjectNotExistsAsync(id, {
			type: 'state',
			common: {
				name,
				type,
				role: 'switch',
				read: true,
				write: true,
			},
			native: {},
		});
	}

	private async ensureControlState(id: string, name: string, type: ioBroker.CommonType = 'string'): Promise<void> {
		await this.adapter.setObjectNotExistsAsync(id, {
			type: 'state',
			common: {
				name,
				type,
				role: 'button',
				read: false,
				write: true,
			},
			native: {},
		});
	}

	private safeId(raw: string): string {
		return raw.replace(/[^a-zA-Z0-9_-]/g, '_');
	}
}
