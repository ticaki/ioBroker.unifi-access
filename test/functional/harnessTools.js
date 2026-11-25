'use strict';

/**
 * Thin helpers on top of the @iobroker/testing integration harness.
 * They only use the public harness surface (objects/states DB clients, sendTo, start/stop),
 * so they do not depend on internals of a particular @iobroker/testing version.
 */

const { waitFor, isPortFree } = require('../mock');

const ADAPTER = 'unifi-access';
const NAMESPACE = `${ADAPTER}.0`;
const INSTANCE_OBJECT = `system.adapter.${NAMESPACE}`;

function promisify(client, method, ...args) {
	if (typeof client[`${method}Async`] === 'function') {
		return client[`${method}Async`](...args);
	}
	return new Promise((resolve, reject) => {
		client[method](...args, (err, result) => (err ? reject(err) : resolve(result)));
	});
}

/** Full id of a state/object of the adapter instance under test. */
const id = localId => `${NAMESPACE}.${localId}`;

const getObject = (harness, objectId) => promisify(harness.objects, 'getObject', objectId);
const setObject = (harness, objectId, obj) => promisify(harness.objects, 'setObject', objectId, obj);
const getState = (harness, stateId) => promisify(harness.states, 'getState', stateId);

/** Value of a state of the adapter instance (`undefined` when the state does not exist). */
async function stateValue(harness, localId) {
	const state = await getState(harness, id(localId));
	return state ? state.val : undefined;
}

/**
 * Write a state the way a user / script / visualisation does (ack=false by default).
 *
 * @param {object} harness Integration test harness
 * @param {string} localId State id below the adapter namespace
 * @param {any} val Value to write
 * @param {boolean} [ack] Acknowledge flag (default false = command)
 */
function writeState(harness, localId, val, ack = false) {
	return promisify(harness.states, 'setState', id(localId), { val, ack, from: 'system.adapter.test.0' });
}

/**
 * Encrypt a value for an `encryptedNative` config field.
 * js-controller falls back to the legacy XOR scheme for values without the AES prefix,
 * so the classic algorithm works with every system secret.
 *
 * @param {object} harness Integration test harness
 * @param {string} value Plain text
 * @returns {Promise<string>} Encrypted value for the instance object
 */
async function encryptNative(harness, value) {
	const systemConfig = await getObject(harness, 'system.config');
	const secret = systemConfig?.native?.secret || 'Zgfr56gFe87jJOM';
	let result = '';
	for (let i = 0; i < value.length; i++) {
		result += String.fromCharCode(secret[i % secret.length].charCodeAt(0) ^ value.charCodeAt(i));
	}
	return result;
}

/**
 * Merge values into the `native` config of the adapter instance (before the adapter is started).
 * Fields listed in `encrypted` are encrypted like the admin UI would do it.
 *
 * @param {object} harness Integration test harness
 * @param {Record<string, any>} native Config values
 * @param {string[]} [encrypted] Names of encryptedNative fields contained in `native`
 */
async function configureAdapter(
	harness,
	native,
	encrypted = ['apiToken', 'genericWebhookToken', 'genericWebhookPassword'],
) {
	const values = { ...native };
	for (const key of encrypted) {
		if (typeof values[key] === 'string' && values[key] !== '') {
			values[key] = await encryptNative(harness, values[key]);
		}
	}
	const obj = await getObject(harness, INSTANCE_OBJECT);
	if (!obj) {
		throw new Error(`${INSTANCE_OBJECT} does not exist`);
	}
	obj.native = { ...obj.native, ...values };
	await setObject(harness, INSTANCE_OBJECT, obj);
}

/**
 * sendTo with a promise and a timeout.
 *
 * @param {object} harness Integration test harness
 * @param {string} command Message command
 * @param {any} [message] Message payload
 * @param {number} [timeoutMs] Give up after this time (default 5000)
 * @returns {Promise<any>} The adapter's answer
 */
function sendTo(harness, command, message = {}, timeoutMs = 5000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`no answer to sendTo("${command}") within ${timeoutMs} ms`)),
			timeoutMs,
		);
		harness.sendTo(NAMESPACE, command, message, answer => {
			clearTimeout(timer);
			resolve(answer);
		});
	});
}

/**
 * Wait until a state of the adapter instance fulfils the predicate; resolves with the state.
 *
 * @param {object} harness Integration test harness
 * @param {string} localId State id below the adapter namespace
 * @param {(state: { val: any, ack: boolean, ts: number }) => boolean} predicate Condition on the state
 * @param {number} [timeoutMs] Give up after this time (default 3000)
 */
function waitForState(harness, localId, predicate, timeoutMs = 3000) {
	return waitFor(
		async () => {
			const state = await getState(harness, id(localId));
			return state && predicate(state) ? state : undefined;
		},
		{ timeoutMs, intervalMs: 15, description: `state ${id(localId)}` },
	);
}

/** Parsed content of events.last (newest first). */
async function eventLog(harness) {
	const raw = await stateValue(harness, 'events.last');
	return typeof raw === 'string' && raw ? JSON.parse(raw) : [];
}

/**
 * Wait until events.last contains an event matching the predicate; resolves with that event.
 *
 * @param {object} harness Integration test harness
 * @param {(event: Record<string, any>) => boolean} predicate Condition on a logged event
 * @param {number} [timeoutMs] Give up after this time (default 3000)
 */
function waitForEvent(harness, predicate, timeoutMs = 3000) {
	return waitFor(async () => (await eventLog(harness)).find(predicate), {
		timeoutMs,
		intervalMs: 15,
		description: 'event in events.last',
	});
}

/**
 * Stop the adapter process through the regular js-controller stop signal and wait for its exit.
 *
 * @param {object} harness Integration test harness
 * @param {number} [timeoutMs] Fail when the process has not exited after this time (default 10000)
 * @returns {Promise<number | string | undefined>} Exit code (or signal) of the adapter process
 */
async function stopAdapter(harness, timeoutMs = 10_000) {
	if (!harness.isAdapterRunning()) {
		return harness.adapterExit;
	}
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`adapter did not terminate within ${timeoutMs} ms`)), timeoutMs);
	});
	try {
		await Promise.race([harness.stopAdapter(), timeout]);
	} finally {
		clearTimeout(timer);
	}
	return harness.adapterExit;
}

module.exports = {
	ADAPTER,
	NAMESPACE,
	INSTANCE_OBJECT,
	id,
	getObject,
	setObject,
	getState,
	stateValue,
	writeState,
	encryptNative,
	configureAdapter,
	sendTo,
	waitForState,
	eventLog,
	waitForEvent,
	isPortFree,
	stopAdapter,
};
