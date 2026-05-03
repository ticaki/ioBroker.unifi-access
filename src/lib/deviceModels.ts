/**
 * UniFi Access device-model detection.
 *
 * Capabilities reflect what the documented developer API actually allows:
 * - door-unlock: pulse via PUT /doors/:id/unlock and timed via PUT /doors/:id/lock_rule
 * - live-events: WebSocket /devices/notifications and (when configured) webhook events
 * - doorbell: receives access.remote_view / access.doorbell.* events (passive display only;
 *   the documented API has no accept/reject endpoint, that path requires WebRTC which is out of scope)
 * - event-thumbnail: payloads include door_thumbnail paths fetchable via /system/static
 */

export type UnifiDeviceModel = 'UA-Ultra' | 'UA-G2-Pro' | 'UA-G3-Pro' | 'UA-Hub' | 'unknown';

export type DeviceCapability = 'event-thumbnail' | 'doorbell' | 'door-unlock' | 'live-events';

const FULL_CAPABILITIES: readonly DeviceCapability[] = ['event-thumbnail', 'doorbell', 'door-unlock', 'live-events'];
const DOORBELL_CAPABILITIES: readonly DeviceCapability[] = [
	'event-thumbnail',
	'doorbell',
	'door-unlock',
	'live-events',
];
const READER_CAPABILITIES: readonly DeviceCapability[] = ['event-thumbnail', 'door-unlock', 'live-events'];
const HUB_CAPABILITIES: readonly DeviceCapability[] = ['live-events'];
const UNKNOWN_CAPABILITIES: readonly DeviceCapability[] = ['live-events'];

export function detectModel(rawModel: string | undefined, deviceType: string | undefined): UnifiDeviceModel {
	const value = `${rawModel ?? ''} ${deviceType ?? ''}`.toLowerCase();
	if (value.includes('ultra')) {
		return 'UA-Ultra';
	}
	if (value.includes('g3')) {
		return 'UA-G3-Pro';
	}
	if (value.includes('g2')) {
		return 'UA-G2-Pro';
	}
	if (value.includes('hub') || value.includes('uah')) {
		return 'UA-Hub';
	}
	return 'unknown';
}

export function featuresFor(model: UnifiDeviceModel): readonly DeviceCapability[] {
	switch (model) {
		case 'UA-Ultra':
			return FULL_CAPABILITIES;
		case 'UA-G3-Pro':
			return DOORBELL_CAPABILITIES;
		case 'UA-G2-Pro':
			return READER_CAPABILITIES;
		case 'UA-Hub':
			return HUB_CAPABILITIES;
		default:
			return UNKNOWN_CAPABILITIES;
	}
}

export function modelHas(model: UnifiDeviceModel, capability: DeviceCapability): boolean {
	return featuresFor(model).includes(capability);
}
