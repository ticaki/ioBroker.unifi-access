'use strict';

/**
 * Fixture data and event builders for the mock UniFi Access controller.
 *
 * Shapes and sample values follow `.doc/api_reference.md` (UniFi Access Developer API):
 *  - 8.1  Fetch Devices                → DEFAULT_DEVICES (nested arrays, one inner array per hub/group)
 *  - 7.8  Fetch All Doors              → DEFAULT_DOORS
 *  - 3.5  Fetch All Users              → DEFAULT_USERS
 *  - 11.1 Fetch Notifications [WS]     → remoteView / remoteViewChange / remoteUnlock
 *  - 11.7 Webhook payload samples      → doorUnlock / doorbellIncoming / doorbellCompleted / dpsStatus / ...
 */

const { randomUUID } = require('node:crypto');

/** Documented list of webhook event names (11.2). */
const WEBHOOK_EVENTS = [
	'access.doorbell.incoming',
	'access.doorbell.completed',
	'access.doorbell.incoming.REN',
	'access.device.dps_status',
	'access.door.unlock',
	'access.device.emergency_status',
	'access.unlock_schedule.activate',
	'access.unlock_schedule.deactivate',
	'access.temporary_unlock.start',
	'access.temporary_unlock.end',
	'access.visitor.status.changed',
];

/** Documented list of WebSocket notification names (11.1). */
const WEBSOCKET_EVENTS = ['access.remote_view', 'access.remote_view.change', 'access.data.device.remote_unlock'];

/** Documented `lock_rule` types for PUT (7.10). */
const LOCK_RULE_TYPES = ['keep_lock', 'keep_unlock', 'custom', 'reset', 'lock_early', 'lock_now'];

/** Documented system log topics (9.2). */
const SYSTEM_LOG_TOPICS = ['critical', 'door_openings', 'updates', 'device_events', 'admin_activity', 'visitor'];

const DOOR_A2 = '0ed545f8-2fcd-4839-9021-b39e707f6aa9';
const DOOR_3855 = '5785e97b-6123-4596-ba49-b6e51164db9b';

const DEVICE_HUB = '7483c2773855';
const DEVICE_LITE = 'f492bfd28ced';
const DEVICE_G2_PRO = '0418d6a2bb7a';
const DEVICE_ULTRA = '28704e11aa01';

/**
 * Devices as returned by GET /api/v1/developer/devices: an array of arrays (8.1).
 * The first group is the documented sample; the second group adds a UA Ultra so that
 * flattening of more than one group and the full capability set can be exercised.
 */
const DEFAULT_DEVICES = [
	[
		{ alias: 'UNVR - Main Floor', id: DEVICE_HUB, name: 'UA-HUB-3855', type: 'UAH' },
		{ alias: 'UNVR - Main Floor', id: DEVICE_LITE, name: 'UA-LITE-8CED', type: 'UDA-LITE' },
		{ alias: 'UNVR - Main Floor', id: DEVICE_G2_PRO, name: 'UA-G2-PRO-BB7A', type: 'UA-G2-PRO' },
	],
	[{ alias: 'Garden Gate', id: DEVICE_ULTRA, name: 'UA-ULTRA-AA01', type: 'UA-ULTRA' }],
];

/** Doors as returned by GET /api/v1/developer/doors (7.8). */
const DEFAULT_DOORS = [
	{
		door_lock_relay_status: 'unlock',
		door_position_status: 'open',
		floor_id: '23c5db06-b59b-494d-94f1-23e88fbe4909',
		full_name: 'UNVR - 2F - A2 Door',
		id: DOOR_A2,
		is_bind_hub: true,
		name: 'A2 Door',
		type: 'door',
	},
	{
		door_lock_relay_status: 'lock',
		door_position_status: 'close',
		floor_id: '7c62b4b3-692f-44ea-8eb8-e212833b4e0f',
		full_name: 'UNVR - 1F - Door 3855',
		id: DOOR_3855,
		is_bind_hub: true,
		name: 'Door 3855',
		type: 'door',
	},
];

/** Users as returned by GET /api/v1/developer/users (3.5, reduced to the fields the adapter reads). */
const DEFAULT_USERS = [
	{
		id: '17d2f099-99df-429b-becb-1399a6937e5a',
		first_name: 'Hong',
		last_name: 'Lu',
		user_email: 'hong.lu@example.com',
		employee_number: '100000',
		status: 'ACTIVE',
		nfc_cards: [],
		pin_code: null,
		onboard_time: 1_689_047_588,
	},
	{
		id: '3a3ba57a-796e-46e0-b8f3-478bb70a114d',
		first_name: 'Ttttt',
		last_name: 'Tttt',
		user_email: '',
		employee_number: '',
		status: 'ACTIVE',
		nfc_cards: [],
		pin_code: null,
		onboard_time: 1_689_048_000,
	},
];

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

/**
 * `data.location` block shared by the documented webhook payloads (11.7).
 *
 * @param {{ id: string, name?: string }} door Door the event refers to
 * @param {string} [readerId] Reader device id encoded into the thumbnail path
 * @param {number} [thumbnailTime] Unix seconds used for the thumbnail file name
 */
function locationBlock(door, readerId, thumbnailTime) {
	const time = thumbnailTime ?? 1_722_913_291;
	const extras = {
		'uah-input_state_dps': 'on',
		'uah-wiring_state_dps-neg': 'on',
		'uah-wiring_state_dps-pos': 'on',
	};
	if (readerId) {
		extras.door_thumbnail = `/preview/reader_${readerId}_${door.id}_${time}.jpg`;
		extras.door_thumbnail_last_update = time;
	}
	return {
		id: door.id,
		location_type: 'door',
		name: door.name ?? door.id,
		up_id: '62ff3aa1-ae96-4b6b-8eb5-44aadfd4aabd',
		extras,
		device_ids: null,
	};
}

/**
 * `data.device` block shared by the documented webhook payloads (11.7).
 *
 * @param {{ id: string, name?: string, alias?: string, type?: string }} device Device the event refers to
 * @param {string} locationId Door id the device is bound to
 * @param {object} [overrides] Fields overriding the documented sample values
 */
function deviceBlock(device, locationId, overrides = {}) {
	return {
		name: device.name ?? device.id,
		alias: device.alias ?? '',
		id: device.id,
		ip: '192.168.1.132',
		mac: device.id.replace(/(..)(?!$)/g, '$1:'),
		online: true,
		device_type: device.type ?? 'UAH',
		connected_hub_id: '',
		location_id: locationId,
		firmware: 'v4.6.1.0',
		version: 'v4.6.129',
		guid: '4a5e238f-4bae-48d5-84d7-dd2b0e919ab5',
		start_time: 1_721_988_528,
		hw_type: '',
		revision: '1722912520784126005',
		cap: null,
		...overrides,
	};
}

/** Builders for the three documented WebSocket notifications (11.1). */
const websocketEvents = {
	/**
	 * `access.remote_view` — a doorbell rings.
	 *
	 * @param {object} [options] Overrides
	 * @param {string} [options.eventObjectId] Call id (`event_object_id`)
	 * @param {object} [options.data] Fields merged into `data`
	 */
	remoteView(options = {}) {
		return {
			event: 'access.remote_view',
			receiver_id: '',
			event_object_id: options.eventObjectId ?? randomUUID(),
			save_to_history: false,
			data: {
				channel: '4513899f-0370-4116-9731-63a6b0feea23',
				token: '6dff120f-2688-497d-856f-0ca08b383d1d',
				device_id: DEVICE_G2_PRO,
				device_type: 'UA-G2-PRO',
				device_name: 'UA-G2-PRO-BB7A',
				door_name: 'Door 3855',
				controller_id: '68d79a1f494f',
				floor_name: '1F',
				request_id: 'J0FeDJc8ZNzHjxr1SUIP6GLQDjAkdZFp',
				clear_request_id: '',
				in_or_out: 'in',
				create_time: Math.floor(Date.now() / 1000),
				reason_code: 0,
				door_guard_ids: ['daa10301-7744-4623-a90e-372718af1d41'],
				connected_uah_id: DEVICE_HUB,
				room_id: `WR-${DEVICE_G2_PRO}-3YSCjtuV5VuyfLT46mUXnnY2q5KQfKxX`,
				host_device_mac: '68D79A1F494B',
				...options.data,
			},
		};
	},

	/**
	 * `access.remote_view.change` — doorbell status change.
	 *
	 * @param {number} reasonCode 105 timeout, 106 admin rejected, 107 admin unlocked, 108 visitor cancelled, 400 answered elsewhere
	 * @param {object} [options] Overrides
	 * @param {string} [options.eventObjectId] `event_object_id`
	 * @param {object} [options.data] Fields merged into `data`
	 */
	remoteViewChange(reasonCode, options = {}) {
		return {
			event: 'access.remote_view.change',
			receiver_id: '',
			event_object_id: options.eventObjectId ?? randomUUID(),
			save_to_history: false,
			data: {
				reason_code: reasonCode,
				remote_call_request_id: 'J0FeDJc8ZNzHjxr1SUIP6GLQDjAkdZFp',
				...options.data,
			},
		};
	},

	/**
	 * `access.data.device.remote_unlock` — an admin unlocked a door remotely.
	 * `data` is the door's location object, `event_object_id` the hub device id.
	 *
	 * @param {{ id: string, name?: string, full_name?: string }} door Door that was unlocked
	 * @param {object} [options] Overrides
	 * @param {string} [options.eventObjectId] Hub device id
	 * @param {object} [options.data] Fields merged into `data`
	 */
	remoteUnlock(door, options = {}) {
		return {
			event: 'access.data.device.remote_unlock',
			receiver_id: '',
			event_object_id: options.eventObjectId ?? DEVICE_HUB,
			save_to_history: false,
			data: {
				unique_id: door.id,
				name: door.name ?? door.id,
				up_id: '913a35bc-66c9-4293-a617-846dd2e285ed',
				timezone: '',
				location_type: 'door',
				extra_type: '',
				full_name: door.full_name ?? door.name ?? door.id,
				level: 0,
				work_time: '[]',
				work_time_id: '',
				extras: {
					'uah-input_state_dps': 'off',
					'uah-wiring_state_dps-neg': 'off',
					'uah-wiring_state_dps-pos': 'off',
				},
				...options.data,
			},
		};
	},
};

/** Builders for the documented webhook payload samples (11.7). */
const webhookEvents = {
	/**
	 * `access.door.unlock`
	 *
	 * @param {object} args Event subjects
	 * @param {{ id: string, name?: string }} args.door Door that was unlocked
	 * @param {{ id: string, name?: string, alias?: string, type?: string }} args.device Device reporting the unlock (hub)
	 * @param {string} [args.readerId] Reader id for the `door_thumbnail` path (omit for no thumbnail)
	 * @param {{ id: string, name: string, type?: string } | null} [args.actor] Who unlocked
	 * @param {object} [args.deviceOverrides] Overrides for the `data.device` block
	 * @param {object} [args.object] Overrides for the `data.object` block
	 * @param {number} [args.thumbnailTime] Unix seconds for the thumbnail name
	 */
	doorUnlock(args) {
		return {
			event: 'access.door.unlock',
			event_object_id: randomUUID(),
			data: {
				location: locationBlock(args.door, args.readerId, args.thumbnailTime),
				device: deviceBlock(args.device, args.door.id, args.deviceOverrides),
				actor:
					args.actor === undefined
						? { id: 'd62e92fd-91aa-44c2-9b36-6d674a4b74d0', name: 'Hon***', type: 'user' }
						: args.actor,
				object: {
					authentication_type: 'CALL',
					authentication_value: '',
					policy_id: '',
					policy_name: '',
					reader_id: '',
					result: 'Access Granted',
					...args.object,
				},
			},
		};
	},

	/**
	 * `access.doorbell.incoming`
	 *
	 * @param {object} args Event subjects
	 * @param {{ id: string, name?: string }} args.door Door the doorbell belongs to
	 * @param {{ id: string, name?: string, alias?: string, type?: string }} args.device Ringing reader
	 * @param {string} [args.requestId] Doorbell request id
	 * @param {number} [args.thumbnailTime] Unix seconds for the thumbnail name
	 */
	doorbellIncoming(args) {
		return {
			event: 'access.doorbell.incoming',
			event_object_id: randomUUID(),
			data: {
				location: locationBlock(args.door, args.device.id, args.thumbnailTime ?? 1_722_912_625),
				device: deviceBlock(args.device, args.door.id, {
					firmware: 'v1.5.33',
					version: 'v1.5.3543',
					hw_type: 'GA',
				}),
				actor: null,
				object: { request_id: args.requestId ?? 'Ed8XSsi4fLm6St7JOLLa26UcmzAZlGzn' },
			},
		};
	},

	/**
	 * `access.doorbell.completed`
	 *
	 * @param {object} args Event subjects
	 * @param {{ id: string, name?: string }} args.door Door the doorbell belongs to
	 * @param {{ id: string, name?: string, alias?: string, type?: string }} args.device Reader that rang
	 * @param {number} [args.reasonCode] 105 / 106 / 107 / 108 / 400
	 * @param {string} [args.requestId] Doorbell request id
	 */
	doorbellCompleted(args) {
		return {
			event: 'access.doorbell.completed',
			event_object_id: randomUUID(),
			data: {
				location: locationBlock(args.door, args.device.id),
				device: deviceBlock(args.device, args.door.id, {
					firmware: 'v1.5.33',
					version: 'v1.5.3543',
					hw_type: 'GA',
				}),
				actor: null,
				object: {
					host_device_mac: '',
					reason_code: args.reasonCode ?? 400,
					request_id: args.requestId ?? 'Ed8XSsi4fLm6St7JOLLa26UcmzAZlGzn',
				},
			},
		};
	},

	/**
	 * `access.doorbell.incoming.REN` — doorbell via Request-to-Enter button (`device` is null in the sample).
	 *
	 * @param {object} args Event subjects
	 * @param {{ id: string, name?: string }} args.door Door the button belongs to
	 * @param {string} [args.readerId] Reader id for the `door_thumbnail` path
	 */
	doorbellIncomingRen(args) {
		return {
			event: 'access.doorbell.incoming.REN',
			event_object_id: randomUUID(),
			data: {
				location: locationBlock(args.door, args.readerId, 1_722_912_625),
				device: null,
				actor: null,
				object: {
					host_device_mac: '74ACB95E28D5',
					reason_code: 0,
					request_id: '65d22fd2-29d7-43a8-b0f5-30a6722fcf1e',
				},
			},
		};
	},

	/**
	 * `access.device.dps_status` — door position sensor change (`data.object.status`: open | close).
	 *
	 * @param {object} args Event subjects
	 * @param {{ id: string, name?: string }} args.door Door whose sensor changed
	 * @param {{ id: string, name?: string, alias?: string, type?: string }} args.device Hub reporting the change
	 * @param {'open' | 'close'} args.status New sensor status
	 */
	dpsStatus(args) {
		return {
			event: 'access.device.dps_status',
			event_object_id: randomUUID(),
			data: {
				location: locationBlock(args.door, undefined),
				device: deviceBlock(args.device, args.door.id),
				actor: null,
				object: { event_type: 'dps_change', status: args.status },
			},
		};
	},

	/**
	 * `access.device.emergency_status`
	 *
	 * @param {object} args Event subjects
	 * @param {{ id: string, name?: string, alias?: string, type?: string }} args.device Device reporting the change
	 * @param {'lockdown' | 'evacuation'} args.mode Emergency mode
	 * @param {boolean} args.value Whether the mode is active
	 */
	emergencyStatus(args) {
		return {
			event: 'access.device.emergency_status',
			event_object_id: randomUUID(),
			data: {
				device: deviceBlock(args.device, '05b37c0f-f917-4cbb-b63c-3b4d8e5e35f7', {
					adopting: false,
					category: null,
				}),
				object: { glocal: false, mode: args.mode, value: args.value },
			},
		};
	},

	/**
	 * Events the documentation only lists by name (11.2) without a payload sample:
	 * unlock_schedule.activate/.deactivate, temporary_unlock.start/.end, visitor.status.changed.
	 * The builder uses the common location/device layout of the documented samples.
	 *
	 * @param {string} eventName Full event name, e.g. `access.temporary_unlock.start`
	 * @param {object} [args] Event subjects
	 * @param {{ id: string, name?: string }} [args.door] Door the event refers to
	 * @param {{ id: string, name?: string, alias?: string, type?: string }} [args.device] Device the event refers to
	 * @param {object} [args.object] `data.object` content
	 */
	generic(eventName, args = {}) {
		const data = { actor: null, object: args.object ?? {} };
		if (args.door) {
			data.location = locationBlock(args.door, undefined);
		}
		if (args.device) {
			data.device = deviceBlock(args.device, args.door?.id ?? '');
		}
		return { event: eventName, event_object_id: randomUUID(), data };
	},
};

/** Smallest valid JPEG-looking byte sequence (SOI + EOI) used as default thumbnail content. */
const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9]);

module.exports = {
	WEBHOOK_EVENTS,
	WEBSOCKET_EVENTS,
	LOCK_RULE_TYPES,
	SYSTEM_LOG_TOPICS,
	DEFAULT_DEVICES,
	DEFAULT_DOORS,
	DEFAULT_USERS,
	IDS: { DOOR_A2, DOOR_3855, DEVICE_HUB, DEVICE_LITE, DEVICE_G2_PRO, DEVICE_ULTRA },
	TINY_JPEG,
	clone,
	websocketEvents,
	webhookEvents,
};
