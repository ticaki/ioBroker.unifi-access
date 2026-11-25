import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Utils } from '@iobroker/gui-components';
import GenericWebhookUrl, {
	blockedByTls,
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

	it('normalises the path like the adapter: blanks, query and repeated slashes', () => {
		expect(buildWebhookUrl('192.0.2.5', { genericWebhookPath: '  /alarm ' })).toBe('http://192.0.2.5:8095/alarm');
		expect(buildWebhookUrl('192.0.2.5', { genericWebhookPath: ' hook' })).toBe('http://192.0.2.5:8095/hook');
		expect(buildWebhookUrl('192.0.2.5', { genericWebhookPath: '   ' })).toBe('http://192.0.2.5:8095/webhook');
		expect(buildWebhookUrl('192.0.2.5', { genericWebhookPath: '//a//b?x=1' })).toBe('http://192.0.2.5:8095/a/b');
	});

	it('takes the port the adapter listens on', () => {
		expect(buildWebhookUrl('192.0.2.5', { listenPort: '9001' })).toBe('http://192.0.2.5:9001/webhook');
		// out of range: the adapter listens on the default port
		expect(buildWebhookUrl('192.0.2.5', { listenPort: 70000 })).toBe('http://192.0.2.5:8095/webhook');
		expect(buildWebhookUrl('192.0.2.5', { listenPort: 8095.5 })).toBe('http://192.0.2.5:8095/webhook');
	});

	it('uses the public base URL of the form instead of address, port and scheme', () => {
		const data = { listenPort: 9000, enableTls: false, genericWebhookPath: ' alarm ' };
		expect(buildWebhookUrl('192.0.2.5', { ...data, publicBaseUrl: ' https://proxy.example.com/iob/ ' })).toBe(
			'https://proxy.example.com/iob/alarm',
		);
		expect(buildWebhookUrl('192.0.2.5', { ...data, publicBaseUrl: 'http://203.0.113.4:18095' })).toBe(
			'http://203.0.113.4:18095/alarm',
		);
		// empty or not usable: the adapter builds the URLs from the listen address, so does the page
		for (const publicBaseUrl of ['', '   ', 'proxy.example.com', 'https://proxy.example.com/?a=1', null]) {
			expect(buildWebhookUrl('192.0.2.5', { ...data, publicBaseUrl }), String(publicBaseUrl)).toBe(
				'http://192.0.2.5:9000/alarm',
			);
		}
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
	publicBaseUrl: null,
};
const HTTPS_SERVER = {
	...HTTP_SERVER,
	scheme: 'https',
	baseUrl: 'https://192.0.2.77:8095',
	tlsEnabled: true,
	tlsActive: true,
};
const NOT_RUNNING = { ...HTTP_SERVER, running: false, scheme: null, baseUrl: null };
/** TLS enabled, certificates not loadable: the adapter does not start the server (fail closed) */
const TLS_FAILED = { ...NOT_RUNNING, tlsEnabled: true, tlsError: 'certificate or private key is empty' };
const BEHIND_PROXY = {
	...HTTP_SERVER,
	baseUrl: 'https://proxy.example.com/iob',
	publicBaseUrl: 'https://proxy.example.com/iob',
};

describe('parseServerInfo', () => {
	it('accepts the answer of the adapter', () => {
		expect(parseServerInfo(TLS_FAILED)).toEqual({
			running: false,
			scheme: null,
			port: 8095,
			tlsEnabled: true,
			tlsActive: false,
			tlsError: 'certificate or private key is empty',
			publicBaseUrl: null,
		});
		expect(parseServerInfo(NOT_RUNNING)).toMatchObject({ running: false, scheme: null });
		expect(parseServerInfo(BEHIND_PROXY)).toMatchObject({ publicBaseUrl: 'https://proxy.example.com/iob' });
	});

	it('treats anything else as unknown', () => {
		// an adapter version without the command
		expect(parseServerInfo({ ok: false, error: 'unknown-command' })).toBeNull();
		expect(parseServerInfo(undefined)).toBeNull();
		expect(parseServerInfo('timeout')).toBeNull();
		expect(parseServerInfo({ running: 'yes' })).toBeNull();
		expect(parseServerInfo({ running: true, scheme: 'ftp' })).toMatchObject({ scheme: null });
		expect(parseServerInfo({ running: true, publicBaseUrl: 42 })).toMatchObject({ publicBaseUrl: null });
		expect(parseServerInfo({ running: true, publicBaseUrl: '' })).toMatchObject({ publicBaseUrl: null });
	});
});

describe('blockedByTls', () => {
	it('is true only for a server that does not run because of its certificates', () => {
		expect(blockedByTls(parseServerInfo(TLS_FAILED))).toBe(true);
		expect(blockedByTls(parseServerInfo(NOT_RUNNING))).toBe(false);
		// TLS enabled, server not running for another reason (port in use)
		expect(blockedByTls(parseServerInfo({ ...NOT_RUNNING, tlsEnabled: true }))).toBe(false);
		expect(blockedByTls(parseServerInfo(HTTPS_SERVER))).toBe(false);
		expect(blockedByTls(null)).toBe(false);
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
		expect(effectiveScheme({ enableTls: false }, info(HTTP_SERVER))).toBe('http');
		// certificates could not be loaded: there is no running server - no fall-back to http
		expect(effectiveScheme({ enableTls: true }, info(TLS_FAILED))).toBe('https');
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

	it('shows only the reason, no URL to copy, if the certificates could not be loaded', async () => {
		const { props } = makeHarness({ data: DATA, answers: { getServerInfo: TLS_FAILED } });
		render(<GenericWebhookUrl {...props} />);

		expect((await screen.findByRole('alert')).textContent).toBe(
			'TLS is enabled, but the certificates could not be loaded (certificate or private key is empty). The built-in server is not started until this is fixed.',
		);
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Copy to clipboard' })).toBeNull();
		expect(screen.queryByText('The HTTP server of the adapter is not running', { exact: false })).toBeNull();
	});

	it('also with a public base URL there is nothing to copy while TLS blocks the server', async () => {
		const { props } = makeHarness({
			data: { ...DATA, publicBaseUrl: 'https://proxy.example.com' },
			answers: { getServerInfo: { ...TLS_FAILED, publicBaseUrl: 'https://proxy.example.com' } },
		});
		render(<GenericWebhookUrl {...props} />);

		expect((await screen.findByRole('alert')).textContent).toContain('certificates could not be loaded');
		expect(screen.queryByRole('textbox')).toBeNull();
	});

	it('previews the http URL once TLS is switched off in the form (not saved yet)', async () => {
		const { props } = makeHarness({ data: { ...DATA, enableTls: false }, answers: { getServerInfo: TLS_FAILED } });
		render(<GenericWebhookUrl {...props} />);

		await waitFor(() => expect(urls()).toEqual(['http://192.0.2.77:8095/webhook']));
		const alerts = screen.getAllByRole('alert').map(alert => alert.textContent ?? '');
		// the running instance has TLS on: the http URL only answers once the change is saved (R2F-03)
		expect(alerts[0]).toContain('differ from the saved settings');
		expect(alerts[1]).toContain('The HTTP server of the adapter is not running');
		expect(alerts).toHaveLength(2);
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

describe('GenericWebhookUrl with a public base URL', () => {
	const DATA = {
		enableGenericWebhook: true,
		listenIp: '0.0.0.0',
		listenPort: 8095,
		genericWebhookPath: '/alarm',
		publicBaseUrl: 'https://proxy.example.com/iob',
	};
	const ALERTS = (): string[] => screen.queryAllByRole('alert').map(alert => alert.textContent ?? '');
	const UNSAVED =
		'The public base URL in the form differs from the saved one. The URL shown follows the form; save the settings to apply it.';

	it('shows the one public URL instead of one per interface', async () => {
		const { props } = makeHarness({
			data: DATA,
			answers: {
				getNetworkInterfaces: { addresses: ['192.0.2.5', '198.51.100.9'] },
				getServerInfo: BEHIND_PROXY,
			},
		});
		render(<GenericWebhookUrl {...props} />);

		await waitFor(() => expect(urls()).toEqual(['https://proxy.example.com/iob/alarm']));
		await waitFor(() => expect(ALERTS()).toEqual([]));
	});

	it('does not need the network interfaces', async () => {
		const { props } = makeHarness({
			data: DATA,
			answers: { getNetworkInterfaces: { addresses: [] }, getServerInfo: BEHIND_PROXY },
		});
		render(<GenericWebhookUrl {...props} />);

		await waitFor(() => expect(urls()).toEqual(['https://proxy.example.com/iob/alarm']));
		expect(screen.queryByText('No network interface addresses found.')).toBeNull();
	});

	it('copies the public URL', async () => {
		const copy = vi.spyOn(Utils, 'copyToClipboard').mockReturnValue(true);
		const { props } = makeHarness({ data: DATA, answers: { getServerInfo: BEHIND_PROXY } });
		render(<GenericWebhookUrl {...props} />);

		fireEvent.click(await screen.findByRole('button', { name: 'Copy to clipboard' }));
		expect(copy).toHaveBeenCalledWith('https://proxy.example.com/iob/alarm');
	});

	it('takes a form value that normalises to the saved one as saved', async () => {
		const { props, socket } = makeHarness({
			data: { ...DATA, publicBaseUrl: '  https://PROXY.example.com:443/iob//  ' },
			answers: { getServerInfo: BEHIND_PROXY },
		});
		render(<GenericWebhookUrl {...props} />);

		await waitFor(() => expect(urls()).toEqual(['https://proxy.example.com/iob/alarm']));
		await waitFor(() => expect(socket.sendTo).toHaveBeenCalledWith('unifi-access.0', 'getServerInfo', {}));
		expect(ALERTS()).toEqual([]);
	});

	it('says that a changed public base URL is not saved yet', async () => {
		const { props } = makeHarness({
			data: { ...DATA, publicBaseUrl: 'https://other.example.com' },
			answers: { getServerInfo: BEHIND_PROXY },
		});
		render(<GenericWebhookUrl {...props} />);

		await waitFor(() => expect(ALERTS()).toEqual([UNSAVED]));
		expect(urls()).toEqual(['https://other.example.com/alarm']);
	});

	it('says so also for a public base URL that was set in the form but not saved', async () => {
		const { props } = makeHarness({
			data: DATA,
			answers: { getNetworkInterfaces: { addresses: ['192.0.2.5'] }, getServerInfo: HTTP_SERVER },
		});
		render(<GenericWebhookUrl {...props} />);

		await waitFor(() => expect(ALERTS()).toEqual([UNSAVED]));
		expect(urls()).toEqual(['https://proxy.example.com/iob/alarm']);
	});

	it('and for one that was removed in the form but is still saved', async () => {
		const { props } = makeHarness({
			data: { ...DATA, publicBaseUrl: '' },
			answers: { getNetworkInterfaces: { addresses: ['192.0.2.5'] }, getServerInfo: BEHIND_PROXY },
		});
		render(<GenericWebhookUrl {...props} />);

		await waitFor(() => expect(ALERTS()).toEqual([UNSAVED]));
		expect(urls()).toEqual(['http://192.0.2.5:8095/alarm']);
	});

	it('has no hint while the saved value is not known (instance stopped)', async () => {
		const { props } = makeHarness({ data: DATA, alive: false });
		render(<GenericWebhookUrl {...props} />);

		expect(await screen.findByText('Webhook URL(s)')).toBeTruthy();
		expect(urls()).toEqual(['https://proxy.example.com/iob/alarm']);
		expect(ALERTS()).toEqual(['The adapter instance is not running. Start it and try again.']);
	});
});

describe('GenericWebhookUrl: hints about the shown URL (RF-05, RF-06)', () => {
	const DATA = {
		enableGenericWebhook: true,
		listenIp: '0.0.0.0',
		listenPort: 8095,
		genericWebhookPath: '/alarm',
		publicBaseUrl: '',
	};
	const ALERTS = (): string[] => screen.queryAllByRole('alert').map(alert => alert.textContent ?? '');
	const UNSAVED =
		'Listen address, port, TLS or listen path in the form differ from the saved settings. The URL shown follows the form; save the settings to apply it.';
	const answers = { getNetworkInterfaces: { addresses: ['192.0.2.5'] }, getServerInfo: HTTP_SERVER };

	it('parseServerInfo takes the port of the running configuration', () => {
		expect(parseServerInfo(HTTP_SERVER)?.port).toBe(8095);
		expect(parseServerInfo({ ...HTTP_SERVER, port: '8095' })?.port).toBeNull();
		expect(parseServerInfo({ ...HTTP_SERVER, port: 70_000 })?.port).toBeNull();
	});

	it('an unsaved port: the URL follows the form and the page says it is not saved yet', async () => {
		const { props } = makeHarness({ data: { ...DATA, listenPort: 9000 }, originalData: DATA, answers });
		render(<GenericWebhookUrl {...props} />);
		await waitFor(() => expect(urls()).toEqual(['http://192.0.2.5:9000/alarm']));
		await waitFor(() => expect(ALERTS()).toEqual([UNSAVED]));
	});

	it('an unsaved listen path as well', async () => {
		const { props } = makeHarness({
			data: { ...DATA, genericWebhookPath: 'door/bell' },
			originalData: DATA,
			answers,
		});
		render(<GenericWebhookUrl {...props} />);
		await waitFor(() => expect(urls()).toEqual(['http://192.0.2.5:8095/door/bell']));
		await waitFor(() => expect(ALERTS()).toEqual([UNSAVED]));
	});

	it('no hint for the same port and a path that normalises to the saved one', async () => {
		const { props, socket } = makeHarness({
			data: { ...DATA, listenPort: '8095', genericWebhookPath: ' //alarm ' },
			originalData: DATA,
			answers,
		});
		render(<GenericWebhookUrl {...props} />);
		await waitFor(() => expect(socket.sendTo).toHaveBeenCalledWith('unifi-access.0', 'getServerInfo', {}));
		await waitFor(() => expect(urls()).toEqual(['http://192.0.2.5:8095/alarm']));
		expect(ALERTS()).toEqual([]);
	});

	it('the port of the running server counts: saved but not yet running with it is "not saved"', async () => {
		const { props } = makeHarness({
			data: { ...DATA, listenPort: 9000 },
			originalData: { ...DATA, listenPort: 9000 },
			answers,
		});
		render(<GenericWebhookUrl {...props} />);
		await waitFor(() => expect(ALERTS()).toEqual([UNSAVED]));
	});

	it('an unsaved listen IP: the URL follows the form and the page says it is not saved yet (R2F-03)', async () => {
		const saved = { ...DATA, listenIp: '192.0.2.5' };
		const { props } = makeHarness({ data: { ...saved, listenIp: '192.0.2.6' }, originalData: saved, answers });
		render(<GenericWebhookUrl {...props} />);
		await waitFor(() => expect(urls()).toEqual(['http://192.0.2.6:8095/alarm']));
		await waitFor(() => expect(ALERTS()).toEqual([UNSAVED]));
	});

	it('no hint for a listen IP written differently that means the same (empty = 0.0.0.0)', async () => {
		const { props, socket } = makeHarness({ data: { ...DATA, listenIp: '' }, originalData: DATA, answers });
		render(<GenericWebhookUrl {...props} />);
		await waitFor(() => expect(socket.sendTo).toHaveBeenCalledWith('unifi-access.0', 'getServerInfo', {}));
		await waitFor(() => expect(urls()).toEqual(['http://192.0.2.5:8095/alarm']));
		expect(ALERTS()).toEqual([]);
	});

	it('TLS switched on in the form: https is shown and the page says it is not saved yet (R2F-03)', async () => {
		const saved = { ...DATA, enableTls: false };
		const { props } = makeHarness({ data: { ...saved, enableTls: true }, originalData: saved, answers });
		render(<GenericWebhookUrl {...props} />);
		await waitFor(() => expect(urls()).toEqual(['https://192.0.2.5:8095/alarm']));
		await waitFor(() => expect(ALERTS()).toEqual([UNSAVED]));
	});

	it('TLS changed while the instance is stopped: compared with the saved setting (R2F-03)', async () => {
		const saved = { ...DATA, enableTls: true };
		const { props } = makeHarness({
			data: { ...saved, enableTls: false },
			originalData: saved,
			answers: { getNetworkInterfaces: { addresses: ['192.0.2.5'] } },
		});
		render(<GenericWebhookUrl {...props} />);
		await waitFor(() => expect(urls()).toEqual(['http://192.0.2.5:8095/alarm']));
		await waitFor(() => expect(ALERTS()).toContain(UNSAVED));
	});

	it('no TLS or listen IP hint with a public base URL: they are not part of the URL', async () => {
		const base = 'https://proxy.example.com';
		const saved = { ...DATA, publicBaseUrl: base, listenIp: '192.0.2.5', enableTls: false };
		const { props } = makeHarness({
			data: { ...saved, listenIp: '192.0.2.6', enableTls: true },
			originalData: saved,
			answers: { getServerInfo: { ...HTTP_SERVER, publicBaseUrl: base } },
		});
		render(<GenericWebhookUrl {...props} />);
		await waitFor(() => expect(urls()).toEqual(['https://proxy.example.com/alarm']));
		expect(ALERTS()).toEqual([]);
	});

	const UNUSABLE = 'is not usable';

	it('the warning about an unusable saved base URL is also shown when no listen address is known (R2F-04)', async () => {
		const data = { ...DATA, publicBaseUrl: 'https://user:pw@proxy.example.com' };
		const { props } = makeHarness({
			data,
			answers: { getNetworkInterfaces: { addresses: [] }, getServerInfo: HTTP_SERVER },
		});
		render(<GenericWebhookUrl {...props} />);
		await waitFor(() => expect(document.body.textContent).toContain('No network interface addresses found'));
		await waitFor(() => expect(ALERTS().some(a => a.includes(UNUSABLE))).toBe(true));
	});

	it('… and while the listen addresses are still loading (R2F-04)', async () => {
		const data = { ...DATA, publicBaseUrl: 'https://proxy.example.com:99999' };
		// getNetworkInterfaces is never answered
		const { props } = makeHarness({ data, answers: { getServerInfo: HTTP_SERVER } });
		render(<GenericWebhookUrl {...props} />);
		await waitFor(() => expect(document.body.textContent).toContain('Loading'));
		expect(ALERTS().some(a => a.includes(UNUSABLE))).toBe(true);
	});

	it.each(['https://user:pw@proxy.example.com', 'https://proxy.example.com:99999', 'https://%zz'])(
		'a saved public base URL the adapter cannot use (%s) is named instead of silently showing the listen URL',
		async saved => {
			const data = { ...DATA, publicBaseUrl: saved };
			const { props } = makeHarness({ data, answers });
			render(<GenericWebhookUrl {...props} />);
			await waitFor(() => expect(urls()).toEqual(['http://192.0.2.5:8095/alarm']));
			await waitFor(() =>
				expect(ALERTS()).toEqual([
					`The saved public base URL "${saved}" is not usable (expected http(s)://host[:port][/path], no user name or password, port 1-65535). The adapter builds the URLs from the listen address instead; correct it on the "HTTP server" tab.`,
				]),
			);
		},
	);

	it('no such hint for an empty or usable saved value', async () => {
		const { props, socket } = makeHarness({ data: { ...DATA, publicBaseUrl: '  /  ' }, answers });
		render(<GenericWebhookUrl {...props} />);
		await waitFor(() => expect(socket.sendTo).toHaveBeenCalledWith('unifi-access.0', 'getServerInfo', {}));
		await waitFor(() => expect(urls()).toEqual(['http://192.0.2.5:8095/alarm']));
		expect(ALERTS()).toEqual([]);
	});
});
