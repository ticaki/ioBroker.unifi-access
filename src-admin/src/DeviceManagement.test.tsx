import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import DeviceManagement from './DeviceManagement';
import { initI18n, makeHarness } from './test/harness';

const ULTRA = {
	id: 'aabbccddeeff',
	name: 'Front door',
	alias: 'Front',
	type: 'UA-Ultra',
	model: 'UA-Ultra',
	firmware: '1.4.2',
	online: true,
	capabilities: ['event-thumbnail', 'doorbell', 'door-unlock', 'live-events'],
};
const HUB = { id: '112233445566', name: 'Garage hub', model: 'UA-Hub', online: false, capabilities: ['live-events'] };

beforeAll(initI18n);

describe('DeviceManagement', () => {
	it('lists the devices with model, firmware, state and capability chips', async () => {
		const { props, socket } = makeHarness({ answers: { listDevices: { devices: [ULTRA, HUB] } } });
		render(<DeviceManagement {...props} />);

		expect(await screen.findByText('Front door')).toBeTruthy();
		expect(socket.sendTo).toHaveBeenCalledWith('unifi-access.0', 'listDevices', {});
		expect(screen.getByText('UA-Ultra · 1.4.2')).toBeTruthy();
		expect(screen.getByText('Garage hub')).toBeTruthy();
		expect(screen.getByText('UA-Hub')).toBeTruthy();
		expect(screen.getByText('online')).toBeTruthy();
		expect(screen.getByText('offline')).toBeTruthy();
		expect(screen.getByText('event thumbnail')).toBeTruthy();
		expect(screen.getByText('doorbell')).toBeTruthy();
		expect(screen.getByText('door-unlock')).toBeTruthy();
		// one chip per device
		expect(screen.getAllByText('live events')).toHaveLength(2);
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('uses colours for the chips that are readable in the dark theme, too', async () => {
		const { props } = makeHarness({ answers: { listDevices: { devices: [ULTRA] } } });
		const view = render(<DeviceManagement {...props} />);

		const chip = (await screen.findByText('event thumbnail')).closest('.MuiChip-root');
		expect(chip?.className).toContain('MuiChip-colorPrimary');
		expect(screen.getByText('doorbell').closest('.MuiChip-root')?.className).toContain('MuiChip-colorPrimary');
		// the secondary colour of the admin's dark theme has too little contrast on its background
		expect(view.container.querySelector('.MuiChip-colorSecondary')).toBeNull();
	});

	it('explains an empty list', async () => {
		const { props } = makeHarness({ answers: { listDevices: { devices: [] } } });
		render(<DeviceManagement {...props} />);

		expect(
			await screen.findByText('No devices yet — make sure the adapter is running and connected.'),
		).toBeTruthy();
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('shows the error of the adapter', async () => {
		const { props } = makeHarness({ answers: { listDevices: { error: 'controller unreachable' } } });
		render(<DeviceManagement {...props} />);

		expect((await screen.findByRole('alert')).textContent).toBe('controller unreachable');
	});

	it('explains the answer of an adapter version that does not know the command', async () => {
		const { props } = makeHarness({ answers: { listDevices: { ok: false, error: 'unknown-command' } } });
		render(<DeviceManagement {...props} />);

		expect((await screen.findByRole('alert')).textContent).toContain(
			'The running adapter instance does not know this request.',
		);
	});

	it('shows the models and capabilities of the current adapter (UA Lite, UA Intercom, UA G2 Pro)', async () => {
		// as `featuresFor()` in src/lib/deviceModels.ts reports them
		const full = ['event-thumbnail', 'doorbell', 'door-unlock', 'live-events'];
		const devices = [
			{
				id: 'lite',
				name: 'Side reader',
				model: 'UA-Lite',
				online: true,
				capabilities: ['door-unlock', 'live-events'],
			},
			{ id: 'intercom', name: 'Gate intercom', model: 'UA-Intercom', online: true, capabilities: full },
			{ id: 'g2', name: 'Lobby reader', model: 'UA-G2-Pro', firmware: '2.1.0', online: true, capabilities: full },
		];
		const { props } = makeHarness({ answers: { listDevices: { devices } } });
		render(<DeviceManagement {...props} />);

		expect(await screen.findByText('Side reader')).toBeTruthy();
		expect(screen.getByText('UA-Lite')).toBeTruthy();
		expect(screen.getByText('UA-Intercom')).toBeTruthy();
		expect(screen.getByText('UA-G2-Pro · 2.1.0')).toBeTruthy();
		// UA Lite has no camera and no doorbell; the reader pro got the doorbell capability
		expect(screen.getAllByText('doorbell')).toHaveLength(2);
		expect(screen.getAllByText('event thumbnail')).toHaveLength(2);
		expect(screen.getAllByText('door-unlock')).toHaveLength(3);
		expect(screen.getAllByText('live events')).toHaveLength(3);
	});

	it('shows an error for an answer without devices', async () => {
		const { props } = makeHarness({ answers: { listDevices: {} } });
		render(<DeviceManagement {...props} />);

		expect((await screen.findByRole('alert')).textContent).toBe('Could not load devices. Is the adapter running?');
	});

	it('shows an error instead of a spinner if the instance is not running', async () => {
		const { props, socket } = makeHarness({ alive: false, aliveState: false });
		render(<DeviceManagement {...props} />);

		expect((await screen.findByRole('alert')).textContent).toBe(
			'The adapter instance is not running. Start it and try again.',
		);
		expect(socket.sendTo).not.toHaveBeenCalled();
		expect(screen.queryByText('Loading devices…')).toBeNull();
		expect(screen.getByRole('button', { name: 'Refresh' })).toHaveProperty('disabled', false);
	});

	it('reloads the list with the refresh button', async () => {
		const { props, socket } = makeHarness({ answers: { listDevices: { devices: [] } } });
		render(<DeviceManagement {...props} />);
		await screen.findByText('No devices yet — make sure the adapter is running and connected.');

		socket.sendTo.mockResolvedValueOnce({ devices: [HUB] });
		fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

		expect(await screen.findByText('Garage hub')).toBeTruthy();
		expect(socket.sendTo).toHaveBeenCalledTimes(2);
	});

	it('survives incomplete device entries and unknown capabilities', async () => {
		const error = vi.spyOn(console, 'error');
		const { props } = makeHarness({
			answers: {
				listDevices: {
					devices: [
						null,
						{ name: 'no id' },
						{ id: 'dev-without-caps' },
						{ id: 'dev-new', name: 'Future reader', model: 'unknown', capabilities: ['face-unlock', 7] },
					],
				},
			},
		});
		render(<DeviceManagement {...props} />);

		expect(await screen.findByText('Future reader')).toBeTruthy();
		expect(screen.getByText('dev-without-caps')).toBeTruthy();
		expect(screen.getByText('face-unlock')).toBeTruthy();
		expect(screen.queryByText('no id')).toBeNull();
		await waitFor(() => expect(screen.getAllByText('offline')).toHaveLength(2));
		expect(error).not.toHaveBeenCalled();
	});
});
