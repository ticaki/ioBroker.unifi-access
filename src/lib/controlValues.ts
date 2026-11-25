import type { UnifiLockRuleType } from './types';

/**
 * Validation of the values users/scripts write to the control states.
 *
 * A control state opens or locks a real door, so nothing here ever "repairs" a value:
 * whatever is not exactly the expected type and range is rejected (`null`) and the caller
 * must not send anything to the controller.
 */

/** Upper limit of `doors.<id>.unlock_duration` and of the configured default duration (minutes). */
export const MAX_UNLOCK_MINUTES = 600;

/** Index → rule type of `doors.<id>.lock_rule` (index 0-3 are established, do not renumber). */
export const LOCK_RULE_BY_INDEX: Readonly<Record<number, Exclude<UnifiLockRuleType, 'custom'>>> = {
	0: 'reset',
	1: 'keep_unlock',
	2: 'keep_lock',
	3: 'lock_now',
	4: 'lock_early',
};

/** `common.states` of `doors.<id>.lock_rule`. Index 0 keeps its historic label "default" (= reset). */
export const LOCK_RULE_STATES: Readonly<Record<number, string>> = {
	0: 'default',
	1: 'keep_unlock',
	2: 'keep_lock',
	3: 'lock_now',
	4: 'lock_early',
};

/**
 * Whole minutes for a timed unlock, `0` for a pulse — or `null` when the value is not a finite
 * number within 0 … {@link MAX_UNLOCK_MINUTES}. Fractions are rounded down (7.9 → 7).
 *
 * @param value Raw state value
 */
export function parseUnlockMinutes(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		return null;
	}
	const minutes = Math.floor(value);
	return minutes <= MAX_UNLOCK_MINUTES ? minutes : null;
}

/**
 * Lock-rule type for a `lock_rule` index, or `null` when the value is not one of the known integer indexes.
 *
 * @param value Raw state value
 */
export function parseLockRuleIndex(value: unknown): Exclude<UnifiLockRuleType, 'custom'> | null {
	if (typeof value !== 'number' || !Number.isInteger(value) || !Object.hasOwn(LOCK_RULE_BY_INDEX, value)) {
		return null;
	}
	return LOCK_RULE_BY_INDEX[value];
}

/**
 * The configured default unlock duration as whole minutes (0 = pulse). Anything that is not a
 * usable number counts as 0; values above the maximum are capped.
 *
 * @param value Raw `defaultUnlockDuration` from the instance configuration
 */
export function normalizeDefaultUnlockMinutes(value: unknown): number {
	const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
	if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
		return 0;
	}
	return Math.min(MAX_UNLOCK_MINUTES, Math.floor(n));
}

/**
 * A TCP port from the configuration: an integer from 1 to 65535, otherwise the fallback.
 *
 * @param value Raw configuration value (number or numeric string)
 * @param fallback Port used when the value is not a valid port
 */
export function normalizePort(value: unknown, fallback: number): number {
	const n = typeof value === 'string' && /^\d{1,5}$/.test(value.trim()) ? Number(value.trim()) : value;
	return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65_535 ? n : fallback;
}

/**
 * Short, log-safe description of a rejected value (type and a bounded rendering).
 *
 * @param value Any value
 */
export function describeValue(value: unknown): string {
	let text: string;
	try {
		text =
			typeof value === 'number' || typeof value === 'undefined' ? String(value) : (JSON.stringify(value) ?? '');
	} catch {
		text = '[unserializable]';
	}
	return `${text.length > 60 ? `${text.slice(0, 60)}…` : text} (${value === null ? 'null' : typeof value})`;
}

/**
 * Door position reported by an `access.device.dps_status` event. Documented location is
 * `data.object.status` (API reference 11.7); `data.dps_status` / `data.value` are tolerated as a
 * fallback for payloads of other firmware generations. Returns `undefined` when none of them
 * holds a non-empty string.
 *
 * @param data The event's `data` object
 */
export function extractDpsStatus(data: Record<string, unknown> | null | undefined): string | undefined {
	if (!data || typeof data !== 'object') {
		return undefined;
	}
	const object = data.object;
	const candidates: unknown[] = [
		object && typeof object === 'object' ? (object as Record<string, unknown>).status : undefined,
		data.dps_status,
		data.value,
	];
	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate !== '') {
			return candidate;
		}
	}
	return undefined;
}
