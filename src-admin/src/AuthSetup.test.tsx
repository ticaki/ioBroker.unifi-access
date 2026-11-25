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
			answers: { verifyToken: { ok: true, deviceCount: 3 } },
		});
		render(<AuthSetup {...props} />);
		await clickTest();

		expect((await screen.findByRole('alert')).textContent).toBe('Connection successful — 3 devices found');
		expect(socket.sendTo).toHaveBeenCalledTimes(1);
		expect(socket.sendTo).toHaveBeenCalledWith('unifi-access.0', 'verifyToken', {
			host: '192.0.2.10',
			port: 12445,
			token: 'secret-token',
			verifyTLS: false,
			caCert: '',
		});
		expect(screen.getByRole('button', { name: 'Test connection' })).toHaveProperty('disabled', false);
	});

	it('sends the CA certificate of the form, not the saved one', async () => {
		const pem = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';
		const { props, socket } = makeHarness({
			data: { ...CONFIG, verifyTLS: true, caCert: pem },
			answers: { verifyToken: { ok: true, deviceCount: 1 } },
		});
		render(<AuthSetup {...props} />);
		await clickTest();

		expect((await screen.findByRole('alert')).textContent).toBe('Connection successful — 1 device found');
		expect(socket.sendTo).toHaveBeenCalledWith('unifi-access.0', 'verifyToken', {
			host: '192.0.2.10',
			port: 12445,
			token: 'secret-token',
			verifyTLS: true,
			caCert: pem,
		});
	});

	it.each([
		[{ ok: true, deviceCount: 0 }, 'Connection successful — no devices found'],
		[{ ok: true, deviceCount: 1 }, 'Connection successful — 1 device found'],
		[{ ok: true, deviceCount: 12 }, 'Connection successful — 12 devices found'],
		// answers of an older adapter version and broken values: no number, no claim
		[{ ok: true }, 'Connection successful'],
		[{ ok: true, controllerName: 'Front door reader' }, 'Connection successful'],
		[{ ok: true, deviceCount: -1 }, 'Connection successful'],
		[{ ok: true, deviceCount: 2.5 }, 'Connection successful'],
		[{ ok: true, deviceCount: '3' }, 'Connection successful'],
	])('reports the success %j neutrally', async (answer, text) => {
		const { props } = makeHarness({ data: CONFIG, answers: { verifyToken: answer } });
		render(<AuthSetup {...props} />);
		await clickTest();

		// exact text: the name of a device is never presented as the name of the controller
		expect((await screen.findByRole('alert')).textContent).toBe(text);
	});

	it.each([
		[
			'DEPTH_ZERO_SELF_SIGNED_CERT',
			'The certificate of the controller could not be verified (DEPTH_ZERO_SELF_SIGNED_CERT). Enter the CA certificate or switch off "Verify TLS certificate".',
		],
		[
			'ERR_TLS_CERT_ALTNAME_INVALID',
			'The certificate of the controller could not be verified (ERR_TLS_CERT_ALTNAME_INVALID). Enter the CA certificate or switch off "Verify TLS certificate".',
		],
		[
			undefined,
			'The certificate of the controller could not be verified (TLS). Enter the CA certificate or switch off "Verify TLS certificate".',
		],
	])('explains a TLS error of the adapter (detail %s)', async (detail, text) => {
		const { props } = makeHarness({
			data: { ...CONFIG, verifyTLS: true },
			answers: { verifyToken: { ok: false, error: 'tls', detail } },
		});
		render(<AuthSetup {...props} />);
		await clickTest();

		await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(text));
		expect(screen.getByRole('alert').className).toContain('Error');
		expect(screen.getByRole('button', { name: 'Test connection' })).toHaveProperty('disabled', false);
	});

	it.each([
		['unauthorized', 'Token rejected (unauthorized).'],
		['network', 'Cannot reach the controller (network error).'],
		[
			'unknown-command',
			'The running adapter instance does not know this request. Adapter and settings page seem to have different versions — restart the instance.',
		],
		[
			'not-configured',
			'The running instance has no controller host or API token yet. Enter both, save and try again.',
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
			caCert: '',
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
