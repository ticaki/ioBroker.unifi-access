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

export type UnifiDeviceModel =
	'UA-Ultra' | 'UA-G2-Pro' | 'UA-G3-Pro' | 'UA-Intercom' | 'UA-Lite' | 'UA-Hub' | 'unknown';

export type DeviceCapability = 'event-thumbnail' | 'doorbell' | 'door-unlock' | 'live-events';

const FULL_CAPABILITIES: readonly DeviceCapability[] = ['event-thumbnail', 'doorbell', 'door-unlock', 'live-events'];
/** Readers without camera (UA Lite). */
const PLAIN_READER_CAPABILITIES: readonly DeviceCapability[] = ['door-unlock', 'live-events'];
const HUB_CAPABILITIES: readonly DeviceCapability[] = ['live-events'];
const UNKNOWN_CAPABILITIES: readonly DeviceCapability[] = ['live-events'];

/**
 * Map the device type reported by the controller to an adapter model.
 *
 * Type strings found in the API reference: `UAH` and `UA-G2-PRO`, `UDA-LITE` (8.1), `UGT` = UA Hub
 * Gate (11.7), EAH8 / UA-Hub-Door-Mini / UA-Hub-Gate / UA-Ultra (changelog), Intercom and Reader Pro
 * (8.4). Anything else stays `unknown` and gets the minimal capability set.
 *
 * @param rawModel Model string of the device, if any
 * @param deviceType Device type as reported by the controller
 */
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
	if (value.includes('intercom')) {
		return 'UA-Intercom';
	}
	if (value.includes('lite')) {
		return 'UA-Lite';
	}
	if (/hub|uah|\bugt\b|eah/.test(value)) {
		return 'UA-Hub';
	}
	return 'unknown';
}

export function featuresFor(model: UnifiDeviceModel): readonly DeviceCapability[] {
	switch (model) {
		// UA-G2-Pro (Reader Pro) included: the documented WebSocket sample (11.1) shows a ringing UA-G2-PRO
		case 'UA-Ultra':
		case 'UA-G3-Pro':
		case 'UA-Intercom':
		case 'UA-G2-Pro':
			return FULL_CAPABILITIES;
		case 'UA-Lite':
			return PLAIN_READER_CAPABILITIES;
		case 'UA-Hub':
			return HUB_CAPABILITIES;
		default:
			return UNKNOWN_CAPABILITIES;
	}
}
