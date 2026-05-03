/**
 * Shared types for the UniFi Access adapter.
 * Field names mirror the JSON shapes documented in the UniFi Access Developer API
 * (see .doc/api_reference.pdf in this repo). Optional fields not strictly required
 * by the documented schema are kept loose so undocumented fields the controller
 * happens to send (firmware, online flags, last-seen) flow through unchanged.
 */

export interface UnifiDeviceRaw {
	id: string;
	name?: string;
	type?: string;
	alias?: string;
	/** Field name as returned by the API: "firmware" (not firmware_version). */
	firmware?: string;
	/** Field name as returned by the API: "online" (not is_online). */
	online?: boolean;
	/** start_time is a Unix timestamp (seconds) indicating when the device came online. */
	start_time?: number;
	[key: string]: unknown;
}

export interface UnifiDoorRaw {
	id: string;
	name?: string;
	full_name?: string;
	type?: string;
	is_bind_hub?: boolean;
	door_lock_relay_status?: 'lock' | 'unlock';
	door_position_status?: 'open' | 'close' | null;
	[key: string]: unknown;
}

export interface UnifiUserRaw {
	id: string;
	first_name?: string;
	last_name?: string;
	user_email?: string;
	[key: string]: unknown;
}

export type UnifiLockRuleType = 'keep_lock' | 'keep_unlock' | 'custom' | 'reset' | 'lock_early' | 'lock_now';

export interface UnifiLockRulePayload {
	type: UnifiLockRuleType;
	interval?: number;
}

export interface UnifiWebhookEndpoint {
	id: string;
	name?: string;
	endpoint: string;
	events?: string[];
	secret?: string;
	headers?: Record<string, string>;
	[key: string]: unknown;
}

export interface UnifiWebhookEndpointCreate {
	name: string;
	endpoint: string;
	events: string[];
	headers?: Record<string, string>;
}

/**
 * Real-time messages: WebSocket frames from /api/v1/developer/devices/notifications,
 * and HTTPS POSTs from registered webhook endpoints. Both share the same envelope.
 * Documented event strings: access.remote_view, access.remote_view.change,
 * access.data.device.remote_unlock (WebSocket); access.doorbell.incoming/.completed/
 * .incoming.REN, access.device.dps_status, access.door.unlock,
 * access.device.emergency_status, access.unlock_schedule.activate/.deactivate,
 * access.temporary_unlock.start/.end, access.visitor.status.changed (Webhook).
 */
export interface UnifiAccessEventEnvelope {
	event: string;
	receiver_id?: string;
	event_object_id?: string;
	save_to_history?: boolean;
	timestamp?: string | number;
	data: Record<string, unknown>;
}

/** Backwards-compatible alias for code paths that still talk in WebSocket terms. */
export type UnifiWebSocketMessage = UnifiAccessEventEnvelope;

export interface UnifiEmergencyStatus {
	lockdown: boolean;
	evacuation: boolean;
}

export interface UnifiEmergencyStatusPayload {
	lockdown?: boolean;
	evacuation?: boolean;
}

export type LastError = 'unauthorized' | 'network' | null;

export interface GenericAlarmEvent {
	id?: string;
	scope?: { locations?: string; [key: string]: unknown };
	device?: string;
	location?: string;
	user?: string;
	user_name?: string;
	admin?: string;
	time?: string;
	device_name?: string;
	location_name?: string;
	direction?: string;
	unlock_method_text?: string;
	[key: string]: unknown;
}

export interface GenericAlarmPayload {
	alarm_id?: string;
	events?: GenericAlarmEvent[];
	data?: Record<string, unknown>;
}

export interface NormalizedEvent {
	ts: number;
	source: 'ws' | 'webhook';
	type: string;
	subtype?: string;
	deviceId?: string;
	deviceName?: string;
	doorId?: string;
	doorName?: string;
	userName?: string;
	thumbnailPath?: string;
	/** Protect camera ID extracted from the Access system log camera event target. */
	protectCameraId?: string;
	/** Protect event ID extracted from the Access system log camera event target. */
	protectEventId?: string;
	/** Adapter-served proxy URL for the Protect camera snapshot at event time. */
	protectSnapshotUrl?: string;
	/** Adapter-served proxy URL for the Protect video clip (may be absent). */
	protectVideoUrl?: string;
	raw?: unknown;
}
