import { beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AuthSetup from './AuthSetup';
import { initI18n, makeHarness } from './test/harness';

const CONFIG = { controllerHost: '192.0.2.10', controllerPort: 12445, apiToken: 'secret-token', verifyTLS: false };

beforeAll(initI18n);

async function clickTest(): Promise<void> {
	fireEvent.click(await screen.findByRole('button', { name: 'Test connection' }));
}

describe('AuthSetup', () => {
	it('probes the controller with the values of the form and reports success', async () => {
		const { props, socket } = makeHarness({
			data: CONFIG,
			answers: { verifyToken: { ok: true, controllerName: 'Mock Controller' } },
		});
		render(<AuthSetup {...props} />);
		await clickTest();

		expect((await screen.findByRole('alert')).textContent).toBe(
			'Connection successful — controller: Mock Controller',
		);
		expect(socket.sendTo).toHaveBeenCalledWith('unifi-access.0', 'verifyToken', {
			host: '192.0.2.10',
			port: 12445,
			token: 'secret-token',
			verifyTLS: false,
		});
		expect(screen.getByRole('button', { name: 'Test connection' })).toHaveProperty('disabled', false);
	});

	it('reports success without a controller name', async () => {
		const { props } = makeHarness({ data: CONFIG, answers: { verifyToken: { ok: true, controllerName: null } } });
		render(<AuthSetup {...props} />);
		await clickTest();

		expect((await screen.findByRole('alert')).textContent).toBe('Connection successful');
	});

	it.each([
		['unauthorized', 'Token rejected (unauthorized).'],
		['network', 'Cannot reach the controller (network error).'],
		[
			'unknown-command',
			'The running adapter instance does not know this request. Adapter and settings page seem to have different versions — restart the instance.',
		],
		['missing-fields', 'Please enter host and API token first.'],
		[undefined, 'Connection test failed.'],
	])('explains the error "%s" of the adapter', async (error, text) => {
		const { props } = makeHarness({ data: CONFIG, answers: { verifyToken: { ok: false, error } } });
		render(<AuthSetup {...props} />);
		await clickTest();

		await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(text));
		expect(screen.getByRole('button', { name: 'Test connection' })).toHaveProperty('disabled', false);
	});

	it('uses the instance number of the opened settings and the default port', async () => {
		const { props, socket } = makeHarness({
			instance: 3,
			data: { ...CONFIG, controllerPort: '', verifyTLS: true },
			answers: { verifyToken: { ok: true } },
		});
		render(<AuthSetup {...props} />);
		await clickTest();

		await waitFor(() => expect(socket.sendTo).toHaveBeenCalled());
		expect(socket.sendTo).toHaveBeenCalledWith('unifi-access.3', 'verifyToken', {
			host: '192.0.2.10',
			port: 12445,
			token: 'secret-token',
			verifyTLS: true,
		});
	});

	it('does not ask the adapter without host or token', async () => {
		const { props, socket } = makeHarness({ data: { ...CONFIG, apiToken: '' } });
		render(<AuthSetup {...props} />);
		await clickTest();

		expect((await screen.findByRole('alert')).textContent).toBe('Please enter host and API token first.');
		expect(socket.sendTo).not.toHaveBeenCalled();
	});

	it('refuses a token that still contains the placeholder of the password field', async () => {
		const { props, socket } = makeHarness({ data: { ...CONFIG, apiToken: '____ppp____abc' } });
		render(<AuthSetup {...props} />);
		await clickTest();

		expect((await screen.findByRole('alert')).textContent).toContain('still contains the masked placeholder');
		expect(socket.sendTo).not.toHaveBeenCalled();
	});

	it('reports a stopped instance and releases the button', async () => {
		const { props, socket } = makeHarness({ data: CONFIG, alive: false, aliveState: false });
		render(<AuthSetup {...props} />);
		await clickTest();

		await waitFor(() =>
			expect(screen.getByRole('alert').textContent).toBe(
				'The adapter instance is not running. Start it and try again.',
			),
		);
		expect(socket.sendTo).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: 'Test connection' })).toHaveProperty('disabled', false);
	});

	it('reports a failed request', async () => {
		const { props, socket } = makeHarness({ data: CONFIG });
		socket.sendTo.mockRejectedValue(new Error('socket closed'));
		render(<AuthSetup {...props} />);
		await clickTest();

		await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('socket closed'));
	});
});
