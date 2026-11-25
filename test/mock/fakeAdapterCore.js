'use strict';

/**
 * In-process stand-in for `@iobroker/adapter-core`.
 *
 * It lets module tests run `src/lib/library.ts` and `src/main.ts` without a js-controller:
 * objects and states live in plain Maps, timers go through the (fake-able) global timer
 * functions and everything the adapter does is observable. It is deliberately small —
 * only the adapter API surface this adapter uses is implemented. The authoritative
 * adapter-level tests are the integration tests (test/integration.js) against a real
 * js-controller; this fake exists for the time-dependent paths (4 s / 5 s / 30 s timers)
 * that cannot be tested there without real waiting.
 */

const { createTestLogger } = require('./testLogger');

function isPlainObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeDeep(target, source) {
	for (const [key, value] of Object.entries(source)) {
		if (isPlainObject(value) && isPlainObject(target[key])) {
			mergeDeep(target[key], value);
		} else {
			target[key] = isPlainObject(value) ? mergeDeep({}, value) : value;
		}
	}
	return target;
}

class FakeAdapter {
	/**
	 * @param {{ name?: string }} [options] Adapter options as passed by the adapter's constructor
	 */
	constructor(options = {}) {
		this.name = options.name ?? 'unifi-access';
		this.instance = 0;
		this.namespace = `${this.name}.${this.instance}`;
		/** @type {Record<string, any>} */
		this.config = { ...FakeAdapter.pendingConfig };
		this.log = createTestLogger();
		/** @type {Map<string, any>} objects by full id */
		this.objects = new Map();
		/** @type {Map<string, { val: any, ack: boolean, ts: number }>} states by full id */
		this.states = new Map();
		/** @type {{ id: string, val: any, ack: boolean }[]} every state write in order */
		this.stateWrites = [];
		/** @type {string[]} */
		this.subscriptions = [];
		/** @type {{ to: string, command: string, message: any, callback: any }[]} */
		this.sentMessages = [];
		/** @type {Record<string, (...args: any[]) => any>} */
		this.handlers = {};
		/** @type {Set<any>} handles created via adapter.setTimeout that have not fired / been cleared */
		this.timers = new Set();
		/** @type {Set<any>} handles created via adapter.setInterval that have not been cleared */
		this.intervals = new Set();
		this.unloaded = false;
		FakeAdapter.instances.push(this);
	}

	on(event, handler) {
		this.handlers[event] = handler;
		return this;
	}

	fullId(id) {
		return id === this.namespace || id.startsWith(`${this.namespace}.`) ? id : `${this.namespace}.${id}`;
	}

	// ------------------------------------------------------------------ states

	async setState(id, state, ack) {
		return this.setForeignStateAsync(this.fullId(id), state, ack);
	}

	async setStateAsync(id, state, ack) {
		return this.setState(id, state, ack);
	}

	async setForeignStateAsync(id, state, ack) {
		const normalised =
			isPlainObject(state) && 'val' in state
				? { val: state.val, ack: state.ack === true }
				: { val: state, ack: ack === true };
		this.states.set(id, { ...normalised, ts: Date.now() });
		this.stateWrites.push({ id, ...normalised });
		return id;
	}

	async getStateAsync(id) {
		return this.getForeignStateAsync(this.fullId(id));
	}

	async getForeignStateAsync(id) {
		return this.states.get(id) ?? null;
	}

	subscribeStates(pattern) {
		this.subscriptions.push(pattern);
	}

	// ----------------------------------------------------------------- objects

	async extendObject(id, obj) {
		return this.extendForeignObjectAsync(this.fullId(id), obj);
	}

	async extendObjectAsync(id, obj) {
		return this.extendObject(id, obj);
	}

	async extendForeignObjectAsync(id, obj) {
		const current = this.objects.get(id) ?? { _id: id };
		this.objects.set(id, mergeDeep(current, obj));
		return { id };
	}

	async setObjectNotExistsAsync(id, obj) {
		const full = this.fullId(id);
		if (!this.objects.has(full)) {
			this.objects.set(full, mergeDeep({ _id: full }, obj));
		}
		return { id: full };
	}

	async getObjectAsync(id) {
		return this.getForeignObjectAsync(this.fullId(id));
	}

	async getForeignObjectAsync(id) {
		return this.objects.get(id) ?? null;
	}

	/** Like js-controller: deleting a state object also removes its state. */
	async delObjectAsync(id) {
		const full = this.fullId(id);
		this.objects.delete(full);
		this.states.delete(full);
	}

	async delStateAsync(id) {
		this.states.delete(this.fullId(id));
	}

	// ------------------------------------------------------------------ timers

	setTimeout(callback, ms, ...args) {
		if (this.unloaded) {
			return undefined;
		}
		const handle = globalThis.setTimeout(() => {
			this.timers.delete(handle);
			callback(...args);
		}, ms);
		this.timers.add(handle);
		return handle;
	}

	clearTimeout(handle) {
		if (handle !== undefined) {
			globalThis.clearTimeout(handle);
			this.timers.delete(handle);
		}
	}

	setInterval(callback, ms, ...args) {
		if (this.unloaded) {
			return undefined;
		}
		const handle = globalThis.setInterval(() => callback(...args), ms);
		this.intervals.add(handle);
		return handle;
	}

	clearInterval(handle) {
		if (handle !== undefined) {
			globalThis.clearInterval(handle);
			this.intervals.delete(handle);
		}
	}

	/** Like adapter.delay: resolves after `ms` through an adapter timer (never after unload). */
	delay(ms) {
		return new Promise(resolve => {
			this.setTimeout(() => resolve(undefined), ms);
		});
	}

	// -------------------------------------------------------------------- misc

	sendTo(to, command, message, callback) {
		this.sentMessages.push({ to, command, message, callback });
	}

	encrypt(value) {
		return `encrypted(${value})`;
	}

	decrypt(value) {
		const match = /^encrypted\((.*)\)$/s.exec(value);
		return match ? match[1] : value;
	}

	// ------------------------------------------------------------ test drivers

	/** Run the adapter's `ready` handler (like js-controller does after start). */
	async fireReady() {
		await this.handlers.ready?.();
	}

	/**
	 * Simulate a state change notification.
	 *
	 * @param {string} id State id, with or without namespace
	 * @param {any} val New value
	 * @param {boolean} [ack] Acknowledge flag (default false = command from a user/script)
	 */
	fireStateChange(id, val, ack = false) {
		const full = this.fullId(id);
		const state = { val, ack, ts: Date.now(), lc: Date.now(), from: 'system.adapter.test.0' };
		this.states.set(full, { val, ack, ts: state.ts });
		this.handlers.stateChange?.(full, state);
	}

	/**
	 * Deliver a sendTo message and resolve with the adapter's answer.
	 *
	 * @param {string} command Message command
	 * @param {any} [message] Message payload
	 * @param {number} [timeoutMs] Give up after this (real) time, default 2000 ms
	 * @returns {Promise<any>} The payload the adapter answered with
	 */
	request(command, message, timeoutMs = 2000) {
		const callback = { id: FakeAdapter.messageSeq++, ack: false, time: Date.now(), message };
		const startIndex = this.sentMessages.length;
		this.handlers.message?.({ command, message, from: 'system.adapter.test.0', callback, _id: callback.id });
		const deadline = Date.now() + timeoutMs;
		return new Promise((resolve, reject) => {
			const poll = () => {
				const answer = this.sentMessages.slice(startIndex).find(sent => sent.callback === callback);
				if (answer) {
					resolve(answer.message);
				} else if (Date.now() > deadline) {
					reject(new Error(`no answer to sendTo command "${command}" within ${timeoutMs} ms`));
				} else {
					setImmediate(poll);
				}
			};
			poll();
		});
	}

	/**
	 * Run the adapter's `unload` handler and — like js-controller — cancel the timers
	 * that were created through adapter.setTimeout.
	 *
	 * @returns {Promise<void>} Resolves when the adapter called the unload callback
	 */
	async fireUnload() {
		await new Promise(resolve => {
			if (!this.handlers.unload) {
				resolve(undefined);
				return;
			}
			this.handlers.unload(() => resolve(undefined));
		});
		this.unloaded = true;
		for (const handle of this.timers) {
			globalThis.clearTimeout(handle);
		}
		this.timers.clear();
		for (const handle of this.intervals) {
			globalThis.clearInterval(handle);
		}
		this.intervals.clear();
	}

	/** Value of a state (id with or without namespace), `undefined` when it was never written. */
	val(id) {
		return this.states.get(this.fullId(id))?.val;
	}

	/** Object by id (with or without namespace). */
	obj(id) {
		return this.objects.get(this.fullId(id));
	}
}

/** Config handed to the next adapter instance that gets constructed. */
FakeAdapter.pendingConfig = {};
/** @type {FakeAdapter[]} */
FakeAdapter.instances = [];
FakeAdapter.messageSeq = 1;

/**
 * Load an adapter main file with `@iobroker/adapter-core` replaced by the fake and create an instance.
 *
 * @param {string} mainFile Absolute path of the adapter main module (TypeScript is fine when a loader is registered)
 * @param {Record<string, any>} config The instance's `native` configuration
 * @returns {FakeAdapter} The adapter instance (the real adapter class, built on the fake base class)
 */
function createAdapterWithFakeCore(mainFile, config) {
	const coreId = require.resolve('@iobroker/adapter-core');
	const mainId = require.resolve(mainFile);
	const previousCore = require.cache[coreId];
	const previousMain = require.cache[mainId];
	require.cache[coreId] = /** @type {any} */ ({
		id: coreId,
		filename: coreId,
		loaded: true,
		exports: { Adapter: FakeAdapter },
		children: [],
		paths: [],
	});
	delete require.cache[mainId];
	try {
		FakeAdapter.pendingConfig = config;
		const factory = require(mainFile);
		if (typeof factory !== 'function') {
			throw new Error(`${mainFile} does not export an adapter factory`);
		}
		return factory({});
	} finally {
		FakeAdapter.pendingConfig = {};
		// never leave the fake behind for other test files
		delete require.cache[mainId];
		if (previousMain) {
			require.cache[mainId] = previousMain;
		}
		if (previousCore) {
			require.cache[coreId] = previousCore;
		} else {
			delete require.cache[coreId];
		}
	}
}

module.exports = { FakeAdapter, createAdapterWithFakeCore };
