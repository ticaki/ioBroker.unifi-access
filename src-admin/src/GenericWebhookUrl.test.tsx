import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Utils } from '@iobroker/gui-components';
import GenericWebhookUrl, { buildWebhookUrl } from './GenericWebhookUrl';
import { initI18n, makeHarness } from './test/harness';

beforeAll(initI18n);

function urls(): string[] {
	return screen.getAllByRole('textbox').map(input => (input as HTMLInputElement).value);
}

describe('buildWebhookUrl', () => {
	it('uses the configured port, path and scheme', () => {
		expect(buildWebhookUrl('192.0.2.5', { listenPort: 9000, genericWebhookPath: '/alarm', enableTls: false })).toBe(
			'http://192.0.2.5:9000/alarm',
		);
		expect(buildWebhookUrl('192.0.2.5', { listenPort: 9000, genericWebhookPath: '/alarm', enableTls: true })).toBe(
			'https://192.0.2.5:9000/alarm',
		);
	});

	it('adds the missing leading slash', () => {
		expect(buildWebhookUrl('192.0.2.5', { listenPort: 8095, genericWebhookPath: 'hook' })).toBe(
			'http://192.0.2.5:8095/hook',
		);
	});

	it('falls back to the defaults of the adapter for empty values', () => {
		expect(buildWebhookUrl('192.0.2.5', undefined)).toBe('http://192.0.2.5:8095/webhook');
		expect(buildWebhookUrl('192.0.2.5', { listenPort: 0, genericWebhookPath: '' })).toBe(
			'http://192.0.2.5:8095/webhook',
		);
		expect(buildWebhookUrl('192.0.2.5', { listenPort: '', genericWebhookPath: null })).toBe(
			'http://192.0.2.5:8095/webhook',
		);
	});
});

describe('GenericWebhookUrl', () => {
	it('renders nothing while the generic webhook is disabled', async () => {
		const { props, socket } = makeHarness({
			data: { enableGenericWebhook: false, listenIp: '0.0.0.0' },
			answers: { getNetworkInterfaces: { addresses: ['192.0.2.5'] } },
		});
		render(<GenericWebhookUrl {...props} />);

		await waitFor(() => expect(socket.sendTo).toHaveBeenCalled());
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(screen.queryByText('Webhook URL(s)')).toBeNull();
	});

	it('shows the URL of a fixed listen address without asking the adapter', async () => {
		const { props, socket } = makeHarness({
			data: { enableGenericWebhook: true, listenIp: '192.0.2.77', listenPort: 8100, genericWebhookPath: '/am' },
		});
		render(<GenericWebhookUrl {...props} />);

		expect(await screen.findByText('Webhook URL(s)')).toBeTruthy();
		expect(urls()).toEqual(['http://192.0.2.77:8100/am']);
		expect(socket.sendTo).not.toHaveBeenCalled();
	});

	it('shows one URL per interface if the server listens on all addresses', async () => {
		const { props, socket } = makeHarness({
			data: { enableGenericWebhook: true, listenIp: '0.0.0.0', listenPort: 8095, genericWebhookPath: '/webhook' },
			answers: { getNetworkInterfaces: { addresses: ['192.0.2.5', '198.51.100.9', '192.0.2.5', 42] } },
		});
		render(<GenericWebhookUrl {...props} />);

		await screen.findByText('Webhook URL(s)');
		expect(urls()).toEqual(['http://192.0.2.5:8095/webhook', 'http://198.51.100.9:8095/webhook']);
		expect(socket.sendTo).toHaveBeenCalledWith('unifi-access.0', 'getNetworkInterfaces', {});
	});

	it('follows changes of port, path and listen address', async () => {
		const first = makeHarness({
			data: {
				enableGenericWebhook: true,
				listenIp: '192.0.2.77',
				listenPort: 8095,
				genericWebhookPath: '/webhook',
			},
		});
		const { rerender } = render(<GenericWebhookUrl {...first.props} />);
		await screen.findByText('Webhook URL(s)');

		const second = makeHarness({
			data: { enableGenericWebhook: true, listenIp: '192.0.2.88', listenPort: 9001, genericWebhookPath: 'x' },
		});
		rerender(<GenericWebhookUrl {...second.props} />);

		await waitFor(() => expect(urls()).toEqual(['http://192.0.2.88:9001/x']));
	});

	it('copies the URL without the async clipboard API', async () => {
		const copy = vi.spyOn(Utils, 'copyToClipboard').mockReturnValue(true);
		const { props } = makeHarness({ data: { enableGenericWebhook: true, listenIp: '192.0.2.77' } });
		render(<GenericWebhookUrl {...props} />);

		// jsdom has no navigator.clipboard, like a browser that opened the admin via http
		expect(navigator.clipboard).toBeUndefined();
		fireEvent.click(await screen.findByRole('button', { name: 'Copy to clipboard' }));

		expect(copy).toHaveBeenCalledWith('http://192.0.2.77:8095/webhook');
		expect(await screen.findByLabelText('Copied!')).toBeTruthy();
	});

	it('explains missing addresses', async () => {
		const empty = makeHarness({
			data: { enableGenericWebhook: true, listenIp: '0.0.0.0' },
			answers: { getNetworkInterfaces: { addresses: [] } },
		});
		const view = render(<GenericWebhookUrl {...empty.props} />);
		expect(await screen.findByText('No network interface addresses found.')).toBeTruthy();
		view.unmount();

		const stopped = makeHarness({ data: { enableGenericWebhook: true, listenIp: '0.0.0.0' }, alive: false });
		render(<GenericWebhookUrl {...stopped.props} />);
		expect(await screen.findByText('The adapter instance is not running. Start it and try again.')).toBeTruthy();
		expect(stopped.socket.sendTo).not.toHaveBeenCalled();
	});
});
