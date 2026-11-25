import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Utils } from '@iobroker/gui-components';
import GenericWebhookUrl, {
	buildWebhookUrl,
	effectiveScheme,
	parseServerInfo,
	type ServerInfo,
} from './GenericWebhookUrl';
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
		expect(socket.sendTo).not.toHaveBeenCalledWith('unifi-access.0', 'getNetworkInterfaces', {});
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

	it('loads the interfaces as soon as the instance is started', async () => {
		const DATA = { enableGenericWebhook: true, listenIp: '0.0.0.0', listenPort: 8095 };
		const first = makeHarness({ data: DATA, alive: false });
		const { rerender } = render(<GenericWebhookUrl {...first.props} />);
		expect(await screen.findByText('The adapter instance is not running. Start it and try again.')).toBeTruthy();

		const second = makeHarness({
			data: DATA,
			alive: true,
			answers: {
				getNetworkInterfaces: { addresses: ['192.0.2.5'] },
				getServerInfo: { running: true, scheme: 'http', port: 8095, tlsEnabled: false, tlsActive: false },
			},
		});
		rerender(<GenericWebhookUrl {...second.props} />);

		await waitFor(() => expect(urls()).toEqual(['http://192.0.2.5:8095/webhook']));
		expect(second.socket.sendTo).toHaveBeenCalledWith('unifi-access.0', 'getNetworkInterfaces', {});
		expect(screen.queryByText('The adapter instance is not running. Start it and try again.')).toBeNull();
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

/** Answers of the adapter to `getServerInfo`, see `handleMessage()` in src/main.ts */
const HTTP_SERVER = {
	running: true,
	scheme: 'http',
	port: 8095,
	baseUrl: 'http://192.0.2.77:8095',
	tlsEnabled: false,
	tlsActive: false,
	tlsError: null,
};
const HTTPS_SERVER = { ...HTTP_SERVER, scheme: 'https', tlsEnabled: true, tlsActive: true };
const TLS_FAILED = { ...HTTP_SERVER, tlsEnabled: true, tlsError: 'certificate or private key is empty' };
const NOT_RUNNING = { ...HTTP_SERVER, running: false, scheme: null, baseUrl: null };

describe('parseServerInfo', () => {
	it('accepts the answer of the adapter', () => {
		expect(parseServerInfo(TLS_FAILED)).toEqual({
			running: true,
			scheme: 'http',
			tlsEnabled: true,
			tlsActive: false,
			tlsError: 'certificate or private key is empty',
		});
		expect(parseServerInfo(NOT_RUNNING)).toMatchObject({ running: false, scheme: null });
	});

	it('treats anything else as unknown', () => {
		// an adapter version without the command
		expect(parseServerInfo({ ok: false, error: 'unknown-command' })).toBeNull();
		expect(parseServerInfo(undefined)).toBeNull();
		expect(parseServerInfo('timeout')).toBeNull();
		expect(parseServerInfo({ running: 'yes' })).toBeNull();
		expect(parseServerInfo({ running: true, scheme: 'ftp' })).toMatchObject({ scheme: null });
	});
});

describe('effectiveScheme', () => {
	const info = (answer: unknown): ServerInfo | null => parseServerInfo(answer);

	it('follows the configuration while the state of the server is not known', () => {
		expect(effectiveScheme({ enableTls: true }, null)).toBe('https');
		expect(effectiveScheme({ enableTls: false }, null)).toBe('http');
		expect(effectiveScheme(undefined, null)).toBe('http');
		expect(effectiveScheme({ enableTls: true }, info(NOT_RUNNING))).toBe('https');
	});

	it('takes the scheme of the running server, not of the setting', () => {
		expect(effectiveScheme({ enableTls: true }, info(HTTPS_SERVER))).toBe('https');
		// certificates could not be loaded: the server answers via http although TLS is enabled
		expect(effectiveScheme({ enableTls: true }, info(TLS_FAILED))).toBe('http');
		expect(effectiveScheme({ enableTls: false }, info(HTTP_SERVER))).toBe('http');
	});

	it('previews an unsaved change of the TLS setting', () => {
		expect(effectiveScheme({ enableTls: true }, info(HTTP_SERVER))).toBe('https');
		expect(effectiveScheme({ enableTls: false }, info(HTTPS_SERVER))).toBe('http');
	});
});

describe('GenericWebhookUrl and the running HTTP server', () => {
	const DATA = { enableGenericWebhook: true, listenIp: '192.0.2.77', listenPort: 8095, enableTls: true };

	it('asks the adapter for the state of its HTTP server', async () => {
		const { props, socket } = makeHarness({ data: DATA, answers: { getServerInfo: HTTPS_SERVER }, instance: 3 });
		render(<GenericWebhookUrl {...props} />);

		await waitFor(() => expect(urls()).toEqual(['https://192.0.2.77:8095/webhook']));
		expect(socket.sendTo).toHaveBeenCalledWith('unifi-access.3', 'getServerInfo', {});
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('shows http and the reason if TLS is enabled but the certificates could not be loaded', async () => {
		const { props } = makeHarness({ data: DATA, answers: { getServerInfo: TLS_FAILED } });
		render(<GenericWebhookUrl {...props} />);

		await waitFor(() => expect(urls()).toEqual(['http://192.0.2.77:8095/webhook']));
		expect(screen.getByRole('alert').textContent).toBe(
			'TLS is enabled, but the certificates could not be loaded (certificate or private key is empty). The server answers via plain http until this is fixed.',
		);
	});

	it('says so if the HTTP server is not running', async () => {
		const { props } = makeHarness({ data: { ...DATA, enableTls: false }, answers: { getServerInfo: NOT_RUNNING } });
		render(<GenericWebhookUrl {...props} />);

		expect((await screen.findByRole('alert')).textContent).toContain(
			'The HTTP server of the adapter is not running at the moment',
		);
		expect(urls()).toEqual(['http://192.0.2.77:8095/webhook']);
	});

	it('names a stopped instance below the URL of a fixed listen address', async () => {
		const { props, socket } = makeHarness({ data: { ...DATA, enableTls: false }, alive: false });
		render(<GenericWebhookUrl {...props} />);

		expect((await screen.findByRole('alert')).textContent).toBe(
			'The adapter instance is not running. Start it and try again.',
		);
		expect(urls()).toEqual(['http://192.0.2.77:8095/webhook']);
		expect(socket.sendTo).not.toHaveBeenCalled();
	});

	it('falls back to the configuration with an adapter version that does not know the command', async () => {
		const { props, socket } = makeHarness({
			data: DATA,
			answers: { getServerInfo: { ok: false, error: 'unknown-command' } },
		});
		render(<GenericWebhookUrl {...props} />);

		await waitFor(() => expect(socket.sendTo).toHaveBeenCalledWith('unifi-access.0', 'getServerInfo', {}));
		await waitFor(() => expect(urls()).toEqual(['https://192.0.2.77:8095/webhook']));
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('asks again after the instance was restarted (settings saved)', async () => {
		const first = makeHarness({ data: DATA, answers: { getServerInfo: TLS_FAILED } });
		const { rerender } = render(<GenericWebhookUrl {...first.props} />);
		await screen.findByRole('alert');

		const stopped = makeHarness({ data: DATA, alive: false });
		rerender(<GenericWebhookUrl {...stopped.props} />);
		const second = makeHarness({ data: DATA, answers: { getServerInfo: HTTPS_SERVER } });
		rerender(<GenericWebhookUrl {...second.props} />);

		await waitFor(() => expect(urls()).toEqual(['https://192.0.2.77:8095/webhook']));
		await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
	});
});
