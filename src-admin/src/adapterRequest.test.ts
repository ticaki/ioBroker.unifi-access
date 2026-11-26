import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	AdapterRequestError,
	describeAdapterError,
	describeRequestError,
	REQUEST_TIMEOUT_MS,
	requestAdapter,
} from './adapterRequest';
import { initI18n, makeHarness } from './test/harness';

beforeAll(initI18n);

afterEach(() => {
	vi.useRealTimers();
});

describe('requestAdapter', () => {
	it('sends the command to the own instance and returns the answer', async () => {
		const { props, socket } = makeHarness({ instance: 2, answers: { listDevices: { devices: [] } } });

		await expect(requestAdapter(props, 'listDevices')).resolves.toEqual({ devices: [] });
		expect(socket.sendTo).toHaveBeenCalledWith('unifi-access.2', 'listDevices', {});
		expect(socket.getState).not.toHaveBeenCalled();
	});

	it('does not send anything if the instance is not running', async () => {
		const { props, socket } = makeHarness({ alive: false, aliveState: false });

		await expect(requestAdapter(props, 'listUsers')).rejects.toMatchObject({ reason: 'not-running' });
		expect(socket.getState).toHaveBeenCalledWith('system.adapter.unifi-access.0.alive');
		expect(socket.sendTo).not.toHaveBeenCalled();
	});

	it('trusts the alive state if the admin did not report the instance as alive yet', async () => {
		const { props, socket } = makeHarness({
			alive: false,
			aliveState: true,
			answers: { listUsers: { users: [] } },
		});

		await expect(requestAdapter(props, 'listUsers')).resolves.toEqual({ users: [] });
		expect(socket.sendTo).toHaveBeenCalledTimes(1);
	});

	it('treats an unreadable alive state as not running', async () => {
		const { props, socket } = makeHarness({ alive: false });
		socket.getState.mockRejectedValue(new Error('permissionError'));

		await expect(requestAdapter(props, 'listUsers')).rejects.toMatchObject({ reason: 'not-running' });
	});

	it('gives up if the adapter never answers', async () => {
		vi.useFakeTimers();
		const { props } = makeHarness(); // sendTo stays pending

		const result = requestAdapter(props, 'listUsers').catch((e: unknown) => e);
		await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);

		const error = await result;
		expect(error).toBeInstanceOf(AdapterRequestError);
		expect((error as AdapterRequestError).reason).toBe('no-response');
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(['timeout', 'disconnected'])('rejects the "%s" answer of the ws client itself', async answer => {
		const { props } = makeHarness({ answers: { listUsers: answer } });

		await expect(requestAdapter(props, 'listUsers')).rejects.toMatchObject({ reason: 'no-response' });
	});

	it('passes a rejection of the socket on and clears its timer', async () => {
		vi.useFakeTimers();
		const { props, socket } = makeHarness();
		socket.sendTo.mockRejectedValue(new Error('not connected'));

		await expect(requestAdapter(props, 'listUsers')).rejects.toThrow('not connected');
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('describeRequestError', () => {
	it('explains why the adapter could not be asked', () => {
		expect(describeRequestError(new AdapterRequestError('not-running'), 'devices_error_load')).toBe(
			'The adapter instance is not running. Start it and try again.',
		);
		expect(describeRequestError(new AdapterRequestError('no-response'), 'devices_error_load')).toBe(
			'The adapter did not respond in time.',
		);
	});

	it('uses the message of other errors and falls back to the given text', () => {
		expect(describeRequestError(new Error('boom'), 'devices_error_load')).toBe('boom');
		expect(describeRequestError('plain', 'devices_error_load')).toBe('plain');
		expect(describeRequestError(undefined, 'devices_error_load')).toBe(
			'Could not load devices. Is the adapter running?',
		);
	});
});

describe('describeAdapterError', () => {
	it('explains the error codes of the adapter', () => {
		expect(describeAdapterError('unknown-command', 'devices_error_load')).toBe(
			'The running adapter instance does not know this request. Adapter and settings page seem to have different versions — restart the instance.',
		);
		expect(describeAdapterError('not-configured', 'devices_error_load')).toBe(
			'The running instance has no controller host or API token yet. Enter both, save and try again.',
		);
		expect(describeAdapterError('unauthorized', 'devices_error_load')).toBe('Token rejected (unauthorized).');
		expect(describeAdapterError('network', 'devices_error_load')).toBe(
			'Cannot reach the controller (network error).',
		);
	});

	it('shows an unknown code as it is and uses the fallback without a code', () => {
		expect(describeAdapterError('controller says no', 'devices_error_load')).toBe('controller says no');
		expect(describeAdapterError('', 'devices_error_load')).toBe('Could not load devices. Is the adapter running?');
		expect(describeAdapterError(undefined, 'devices_error_load')).toBe(
			'Could not load devices. Is the adapter running?',
		);
		expect(describeAdapterError({ code: 1 }, 'devices_error_load')).toBe(
			'Could not load devices. Is the adapter running?',
		);
		// names of Object.prototype are not error codes
		expect(describeAdapterError('constructor', 'devices_error_load')).toBe('constructor');
	});
});
