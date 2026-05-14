import type { UnifiAccess } from '../UnifiAccess';
import { detectModel, featuresFor, type UnifiDeviceModel } from './deviceModels';
import type { UnifiDeviceRaw, UnifiDoorRaw } from './types';

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

	async applyBootstrap(data: { devices: UnifiDeviceRaw[]; doors: UnifiDoorRaw[] }): Promise<void> {
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
		await this.ensureSimpleState('admin.uiSettings', 'string', 'Persistent UI settings (JSON)');
		await this.ensureSwitchState('doors.emergency.lockdown', 'Lockdown – all doors forced locked', 'boolean');
		await this.ensureSwitchState('doors.emergency.evacuation', 'Evacuation – all doors forced unlocked', 'boolean');

		await this.ensureSimpleState('info.webhookEndpointId', 'string', 'Registered webhook endpoint id');
		await this.ensureSimpleState('info.webhookSecret', 'string', 'Webhook signing secret');
		await this.ensureSimpleState(
			'info.webhookRegistered',
			'boolean',
			'Whether the webhook is registered with the controller',
		);
		await this.ensureSimpleState('info.protectConnected', 'boolean', 'UniFi Protect API connected');

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

		await this.adapter.extendObject(channelId, {
			type: 'channel',
			common: { name: device.name ?? device.alias ?? device.id },
			native: { rawType: device.type, model, capabilities },
		});

		await this.ensureSimpleState(`${channelId}.name`, 'string', 'Device name');
		await this.ensureSimpleState(`${channelId}.alias`, 'string', 'Device alias');
		await this.ensureSimpleState(`${channelId}.type`, 'string', 'Device type as reported by controller');
		await this.ensureSimpleState(`${channelId}.model`, 'string', 'Resolved adapter model');
		await this.ensureSimpleState(`${channelId}.firmware`, 'string', 'Firmware version');
		await this.ensureSimpleState(`${channelId}.online`, 'boolean', 'Device online');
		await this.ensureSimpleState(`${channelId}.lastSeenAt`, 'string', 'ISO timestamp of last received event');

		if (capabilities.includes('event-thumbnail')) {
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
		}

		await this.adapter.setState(`${channelId}.name`, { val: device.name ?? device.id, ack: true });
		await this.adapter.setState(`${channelId}.alias`, { val: device.alias ?? '', ack: true });
		await this.adapter.setState(`${channelId}.type`, { val: device.type ?? '', ack: true });
		await this.adapter.setState(`${channelId}.model`, { val: model, ack: true });
		await this.adapter.setState(`${channelId}.firmware`, { val: device.firmware ?? '', ack: true });
		await this.adapter.setState(`${channelId}.online`, { val: device.online !== false, ack: true });
		await this.adapter.setState(`${channelId}.lastSeenAt`, { val: '', ack: true });

		return { model };
	}

	async ensureDoor(door: UnifiDoorRaw): Promise<void> {
		const channelId = `doors.${this.safeId(door.id)}`;
		await this.adapter.extendObject(channelId, {
			type: 'channel',
			common: { name: door.name ?? door.full_name ?? door.id },
			native: {},
		});
		await this.ensureSimpleState(`${channelId}.name`, 'string', 'Door name');
		await this.ensureSimpleState(`${channelId}.fullName`, 'string', 'Full door path');
		await this.ensureSimpleState(`${channelId}.locked`, 'boolean', 'Locked');
		await this.ensureSimpleState(`${channelId}.position`, 'string', 'Door position (open|close|unknown)');
		await this.ensureSimpleState(
			`${channelId}.isBindHub`,
			'boolean',
			'Door is bound to a hub (required for remote unlock)',
		);
		await this.ensureControlState(`${channelId}.unlock`, 'Trigger door unlock', 'boolean');
		await this.adapter.extendObject(`${channelId}.unlock_duration`, {
			type: 'state',
			common: {
				name: 'Unlock for N minutes (0 = pulse)',
				type: 'number',
				role: 'level',
				unit: 'min',
				min: 0,
				read: true,
				write: true,
			},
			native: {},
		});
		await this.adapter.extendObject(`${channelId}.lock_rule`, {
			type: 'state',
			common: {
				name: 'Lock rule',
				type: 'number',
				role: 'value',
				read: true,
				write: true,
				states: { 0: 'default', 1: 'keep_unlock', 2: 'keep_lock', 3: 'lock_now' },
			},
			native: {},
		});

		await this.adapter.setState(`${channelId}.name`, { val: door.name ?? door.id, ack: true });
		await this.adapter.setState(`${channelId}.fullName`, { val: door.full_name ?? '', ack: true });
		const lockedFlag =
			door.door_lock_relay_status === 'lock' ? true : door.door_lock_relay_status === 'unlock' ? false : null;
		await this.adapter.setState(`${channelId}.locked`, { val: lockedFlag, ack: true });
		await this.adapter.setState(`${channelId}.position`, {
			val: door.door_position_status ?? 'unknown',
			ack: true,
		});
		await this.adapter.setState(`${channelId}.isBindHub`, { val: door.is_bind_hub === true, ack: true });
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

	async pushEvent(event: unknown): Promise<void> {
		const id = `${this.adapter.namespace}.events.last`;
		const current = await this.adapter.getStateAsync('events.last');
		let list: unknown[] = [];
		if (typeof current?.val === 'string' && current.val) {
			try {
				const parsed = JSON.parse(current.val);
				if (Array.isArray(parsed)) {
					list = parsed;
				}
			} catch {
				/* ignore */
			}
		}
		list.unshift(event);
		if (list.length > 50) {
			list.length = 50;
		}
		await this.adapter.setForeignStateAsync(id, { val: JSON.stringify(list), ack: true });
	}

	async updateEventProtectData(
		ts: number,
		data: {
			protectCameraId?: string;
			protectEventId?: string;
			protectSnapshotUrl?: string;
			protectVideoUrl?: string;
		},
	): Promise<void> {
		const id = `${this.adapter.namespace}.events.last`;
		const current = await this.adapter.getStateAsync('events.last');
		let list: Record<string, unknown>[] = [];
		if (typeof current?.val === 'string' && current.val) {
			try {
				const parsed = JSON.parse(current.val);
				if (Array.isArray(parsed)) {
					list = parsed as Record<string, unknown>[];
				}
			} catch {
				/* ignore */
			}
		}
		const idx = list.findIndex(e => e.ts === ts);
		if (idx < 0) {
			return;
		}
		list[idx] = { ...list[idx], ...data };
		await this.adapter.setForeignStateAsync(id, { val: JSON.stringify(list), ack: true });
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
