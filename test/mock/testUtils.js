'use strict';

/**
 * Small, dependency-free helpers shared by the module tests and the adapter integration tests.
 * The timer functions are captured when this module is loaded, so the helpers keep working
 * while a test has fake timers (sinon) installed.
 */

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/**
 * Wait for a real amount of time (not affected by fake timers).
 *
 * @param {number} ms Milliseconds to wait
 * @returns {Promise<void>}
 */
function delay(ms) {
	return new Promise(resolve => realSetTimeout(resolve, ms));
}

/**
 * Poll until `condition` returns a truthy value and hand that value back.
 * Rejects with a descriptive error after `timeoutMs` — never waits forever.
 *
 * @template T
 * @param {() => T | Promise<T>} condition Evaluated repeatedly; errors thrown by it count as "not yet"
 * @param {{ timeoutMs?: number, intervalMs?: number, description?: string }} [options] Timing and error text
 * @returns {Promise<NonNullable<T>>} The first truthy result
 */
async function waitFor(condition, options = {}) {
	const timeoutMs = options.timeoutMs ?? 2000;
	const intervalMs = options.intervalMs ?? 10;
	const deadline = Date.now() + timeoutMs;
	let lastError;
	for (;;) {
		try {
			const result = await condition();
			if (result) {
				return result;
			}
			lastError = undefined;
		} catch (err) {
			lastError = err;
		}
		if (Date.now() >= deadline) {
			const reason = lastError ? ` (last error: ${lastError.message ?? lastError})` : '';
			throw new Error(
				`timed out after ${timeoutMs} ms waiting for ${options.description ?? 'condition'}${reason}`,
			);
		}
		await delay(intervalMs);
	}
}

/**
 * Await a promise that is expected to reject and hand back the rejection reason.
 *
 * @param {Promise<unknown>} promise Promise expected to reject
 * @returns {Promise<any>} The rejection reason
 */
async function rejection(promise) {
	try {
		await promise;
	} catch (err) {
		return err;
	}
	throw new Error('expected the promise to reject, but it resolved');
}

/**
 * Resolve with the arguments of the next `event` emitted by `emitter`.
 *
 * @param {import('node:events').EventEmitter} emitter Event source
 * @param {string} event Event name
 * @param {number} [timeoutMs] Give up after this time (default 2000)
 * @returns {Promise<any[]>} Arguments of the event
 */
function nextEvent(emitter, event, timeoutMs = 2000) {
	return new Promise((resolve, reject) => {
		const onEvent = (...args) => {
			realClearTimeout(timer);
			resolve(args);
		};
		const timer = realSetTimeout(() => {
			emitter.removeListener(event, onEvent);
			reject(new Error(`timed out after ${timeoutMs} ms waiting for event "${event}"`));
		}, timeoutMs);
		emitter.once(event, onEvent);
	});
}

module.exports = { delay, waitFor, rejection, nextEvent };
