import { extractDpsStatus } from './controlValues';
import { sanitizeStaticPath } from './pathSafety';
import type { NormalizedEvent } from './types';

/**
 * Turns a raw event envelope (WebSocket frame or webhook body) into the adapter's normalised event.
 *
 * Everything in the envelope is untrusted input: a frame may be `null`, `data` may be missing or of the
 * wrong type, ids may be numbers or objects. Nothing here throws — values of the wrong type are
 * treated as absent, and an envelope without a string `event` is rejected (`null`).
 */

/** Doorbell end reasons (API reference 11.1 `access.remote_view.change` and 11.7 `access.doorbell.completed`). */
export const DOORBELL_REASONS: Readonly<Record<number, string>> = {
	105: 'timeout',
	106: 'admin_rejected',
	107: 'admin_unlocked',
	108: 'visitor_cancelled',
	400: 'answered_elsewhere',
};

/** Keys of the WebRTC session of a doorbell call — credentials, never stored or forwarded. */
const WEBRTC_CREDENTIAL_KEYS = ['channel', 'token'];

export interface ParsedAccessEvent {
	event: NormalizedEvent;
	/** The envelope's `data` object (empty object when missing or not an object). */
	data: Record<string, unknown>;
	/** `data.device` when present. */
	device?: Record<string, unknown>;
	/** `data.object` when present. */
	object?: Record<string, unknown>;
	/** Request id of a doorbell call (`data.request_id` on the WebSocket, `data.object.request_id` in webhooks). */
	requestId?: string;
	/** Numeric `reason_code` of a doorbell status change / completion. */
	reasonCode?: number;
	/** `data.object.result` of an `access.door.unlock` event, e.g. "Access Granted". */
	result?: string;
	/** True when the event carried a thumbnail path that failed validation and was dropped. */
	thumbnailPathRejected: boolean;
}

/**
 * A plain object, or `undefined` for anything else (null, arrays, primitives).
 *
 * @param value Any value
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * A non-empty string, or `undefined` for anything else.
 *
 * @param value Any value
 */
export function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		const text = asString(value);
		if (text !== undefined) {
			return text;
		}
	}
	return undefined;
}

function toReasonCode(value: unknown): number | undefined {
	const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
	return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/**
 * Copy of the envelope for the event log / forward states with the WebRTC credentials of a doorbell
 * call (`data.channel`, `data.token`) removed.
 *
 * @param msg The envelope as received
 * @param data Its `data` object
 */
function redactEnvelope(msg: Record<string, unknown>, data: Record<string, unknown>): Record<string, unknown> {
	if (!WEBRTC_CREDENTIAL_KEYS.some(key => key in data)) {
		return msg;
	}
	const cleaned: Record<string, unknown> = { ...data };
	for (const key of WEBRTC_CREDENTIAL_KEYS) {
		delete cleaned[key];
	}
	return { ...msg, data: cleaned };
}

/**
 * Normalise an event envelope.
 *
 * @param msg Raw envelope (untrusted)
 * @param source Channel the envelope arrived on
 * @param now Fallback timestamp (ms epoch) when the envelope carries none
 * @returns The parsed event, or `null` when `msg` is not an envelope with a string `event`
 */
export function parseAccessEvent(msg: unknown, source: 'ws' | 'webhook', now: number): ParsedAccessEvent | null {
	const envelope = asRecord(msg);
	const type = asString(envelope?.event);
	if (!envelope || type === undefined) {
		return null;
	}

	let ts = now;
	if (typeof envelope.timestamp === 'number' && Number.isFinite(envelope.timestamp)) {
		ts = envelope.timestamp;
	} else if (typeof envelope.timestamp === 'string') {
		ts = Date.parse(envelope.timestamp) || now;
	}

	const data = asRecord(envelope.data) ?? {};
	const device = asRecord(data.device);
	const object = asRecord(data.object);
	const actor = asRecord(data.actor);
	// access.data.device.remote_unlock delivers the door's location object directly as `data`
	// (no nested `data.location`, no `data.door_id`). Detect that shape via location_type+unique_id.
	const dataIsLocation = typeof data.location_type === 'string' && typeof data.unique_id === 'string';
	const location = asRecord(data.location) ?? (dataIsLocation ? data : undefined);
	const extras = asRecord(location?.extras);

	// The thumbnail path ends up in a state and in the URL of the thumbnail proxy: only a plain
	// static-resource path is accepted, anything else is dropped.
	const rawThumbnailPath: unknown = extras?.door_thumbnail ?? data.door_thumbnail;
	let thumbnailPath: string | undefined;
	let thumbnailPathRejected = false;
	if (rawThumbnailPath !== undefined && rawThumbnailPath !== null && rawThumbnailPath !== '') {
		if (typeof rawThumbnailPath === 'string' && sanitizeStaticPath(rawThumbnailPath) !== null) {
			thumbnailPath = rawThumbnailPath;
		} else {
			thumbnailPathRejected = true;
		}
	}

	let subtype: string | undefined;
	let reasonCode: number | undefined;
	let result: string | undefined;
	let requestId: string | undefined;
	switch (type) {
		case 'access.remote_view':
			requestId = asString(data.request_id);
			break;
		case 'access.remote_view.change':
			reasonCode = toReasonCode(data.reason_code);
			subtype = reasonCode !== undefined ? DOORBELL_REASONS[reasonCode] : undefined;
			requestId = firstString(data.remote_call_request_id, data.request_id);
			break;
		case 'access.doorbell.incoming':
		case 'access.doorbell.incoming.REN':
			requestId = asString(object?.request_id);
			break;
		case 'access.doorbell.completed':
			// documented location of the reason is data.object.reason_code
			reasonCode = toReasonCode(object?.reason_code ?? data.reason_code);
			subtype = reasonCode !== undefined ? DOORBELL_REASONS[reasonCode] : undefined;
			requestId = asString(object?.request_id);
			break;
		case 'access.device.dps_status':
			subtype = extractDpsStatus(data);
			break;
		case 'access.door.unlock':
			result = asString(object?.result);
			subtype = result;
			break;
	}

	const event: NormalizedEvent = {
		ts,
		source,
		type,
		subtype,
		deviceId: firstString(
			data.device_id,
			device?.id,
			type === 'access.data.device.remote_unlock' ? envelope.event_object_id : undefined,
		),
		deviceName: firstString(data.device_name, device?.name, device?.alias),
		doorId: firstString(data.door_id, location?.id, location?.unique_id),
		doorName: firstString(data.door_name, location?.name),
		userName: firstString(data.user_name, actor?.name),
		thumbnailPath,
		raw: redactEnvelope(envelope, data),
	};
	return { event, data, device, object, requestId, reasonCode, result, thumbnailPathRejected };
}

/**
 * Whether an `access.door.unlock` result means the door was really released. The webhook is documented
 * as "triggered on all door unlock events" and the system-log sample of the same event type shows
 * `"result": "BLOCKED"` ("Access Denied"). A result that says denied/blocked/failed is not an unlock;
 * a missing result or any other text (documented: "Access Granted") is.
 *
 * @param result `data.object.result` of the event
 */
export function isAccessGranted(result: string | undefined): boolean {
	if (result === undefined) {
		return true;
	}
	return !/denied|blocked|reject|fail|invalid|unauthori[sz]ed/i.test(result);
}
