import type React from 'react';
import { Alert, Box, CircularProgress, IconButton, Stack, TextField, Tooltip, Typography } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';
import { I18n, Utils } from '@iobroker/gui-components';
import { AdapterRequestError, describeRequestError, requestAdapter } from './adapterRequest';
import { normalizePort, normalizePublicBaseUrl, normalizeWebhookPath } from './serverUrl';

/** Answer of the adapter to `getServerInfo`: the actual state of its built-in HTTP server */
export interface ServerInfo {
	running: boolean;
	scheme: 'http' | 'https' | null;
	/** Port of the running configuration (normalised setting); `null` if not reported */
	port: number | null;
	tlsEnabled: boolean;
	tlsActive: boolean;
	tlsError: string | null;
	/** The saved public base URL as the adapter normalised it; `null` = not set or not usable */
	publicBaseUrl: string | null;
}

interface GenericWebhookUrlState extends ConfigGenericState {
	addresses: string[];
	loading: boolean;
	error: string | null;
	copied: string | null;
	/** `null`: not known (instance stopped, no answer, adapter version without `getServerInfo`) */
	serverInfo: ServerInfo | null;
	/** Why `serverInfo` is not known, if the reason is worth telling */
	serverInfoError: string | null;
}

/**
 * Checks the answer to `getServerInfo`. Anything that is not the documented shape - also the
 * `{ok: false, error: 'unknown-command'}` of an adapter version without the command - counts as unknown.
 *
 * @param answer what the adapter sent
 */
export function parseServerInfo(answer: unknown): ServerInfo | null {
	const info = answer as Partial<Record<keyof ServerInfo, unknown>> | null | undefined;
	if (!info || typeof info !== 'object' || typeof info.running !== 'boolean') {
		return null;
	}
	return {
		running: info.running,
		scheme: info.scheme === 'http' || info.scheme === 'https' ? info.scheme : null,
		port:
			typeof info.port === 'number' && Number.isInteger(info.port) && info.port >= 1 && info.port <= 65_535
				? info.port
				: null,
		tlsEnabled: info.tlsEnabled === true,
		tlsActive: info.tlsActive === true,
		tlsError: typeof info.tlsError === 'string' && info.tlsError ? info.tlsError : null,
		publicBaseUrl: typeof info.publicBaseUrl === 'string' && info.publicBaseUrl ? info.publicBaseUrl : null,
	};
}

/**
 * Whether the server does not run because TLS is enabled and its certificates could not be loaded.
 * The adapter does not fall back to plain http then (fail closed), so there is no URL that answers.
 *
 * @param info actual state of the HTTP server, if known
 */
export function blockedByTls(info: ServerInfo | null): info is ServerInfo & { tlsError: string } {
	return !!info && !info.running && info.tlsEnabled && info.tlsError !== null;
}

/**
 * The scheme of the displayed URL. While the edited TLS setting is the one the instance runs with,
 * the scheme of the running server counts (with TLS enabled the adapter only starts the server with
 * loaded certificates, i.e. as https). An unsaved change of the setting - or a server that does not
 * run or whose state is not known - is shown as configured.
 *
 * @param data the adapter configuration that is currently edited
 * @param info actual state of the HTTP server, if known
 */
export function effectiveScheme(data: Record<string, unknown> | undefined, info: ServerInfo | null): 'http' | 'https' {
	const wanted = data?.enableTls === true;
	if (info?.running && info.scheme && info.tlsEnabled === wanted) {
		return info.scheme;
	}
	return wanted ? 'https' : 'http';
}

/**
 * Builds the URL the Alarm Manager has to call, with the rules of the adapter (`startSharedHttpServer`,
 * `normalizeWebhookPath`): an empty or invalid port or an empty path means the default there, too. A
 * public base URL in the form replaces scheme, address and port (reverse proxy / port forwarding).
 *
 * @param ip address the shared HTTP server is reachable at (not used with a public base URL)
 * @param data the adapter configuration that is currently edited
 * @param info actual state of the HTTP server (from `getServerInfo`), if known
 */
export function buildWebhookUrl(
	ip: string,
	data: Record<string, unknown> | undefined,
	info: ServerInfo | null = null,
): string {
	const path = normalizeWebhookPath(data?.genericWebhookPath);
	const publicBase = normalizePublicBaseUrl(data?.publicBaseUrl);
	if (publicBase) {
		return `${publicBase}${path}`;
	}
	return `${effectiveScheme(data, info)}://${ip}:${normalizePort(data?.listenPort)}${path}`;
}

/**
 * Whether a saved public base URL is not empty but unusable (credentials, port out of range, broken
 * host …). The adapter ignores it then and builds the URLs from the listen address - without this hint
 * the page would show that URL as if nothing was wrong.
 *
 * @param saved the saved value of `publicBaseUrl`
 */
export function unusablePublicBaseUrl(saved: unknown): boolean {
	return (
		typeof saved === 'string' && saved.trim().replace(/\/+$/, '') !== '' && normalizePublicBaseUrl(saved) === null
	);
}

/**
 * Which parts of the displayed URL come from form values that are not saved (and therefore not in use).
 *
 * @param data the adapter configuration that is currently edited
 * @param saved the configuration as it is saved
 * @param info actual state of the HTTP server, if known
 */
export function unsavedUrlParts(
	data: Record<string, unknown> | undefined,
	saved: Record<string, unknown> | undefined,
	info: ServerInfo | null,
): { publicBase: boolean; portOrPath: boolean } {
	const formBase = normalizePublicBaseUrl(data?.publicBaseUrl);
	// the saved value as the adapter reports it, otherwise as saved
	const publicBase =
		info !== null
			? formBase !== info.publicBaseUrl
			: !!saved && formBase !== normalizePublicBaseUrl(saved.publicBaseUrl);
	const formPort = normalizePort(data?.listenPort);
	// with a public base URL the port is not part of the URL
	const port =
		!formBase &&
		(info?.port != null ? formPort !== info.port : !!saved && formPort !== normalizePort(saved.listenPort));
	const path =
		!!saved && normalizeWebhookPath(data?.genericWebhookPath) !== normalizeWebhookPath(saved.genericWebhookPath);
	return { publicBase, portOrPath: port || path };
}

class GenericWebhookUrl extends ConfigGeneric<ConfigGenericProps, GenericWebhookUrlState> {
	private unmounted = false;
	private requestCounter = 0;
	private serverInfoCounter = 0;
	private copiedTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(props: ConfigGenericProps) {
		super(props);
		Object.assign(this.state, {
			addresses: [],
			loading: false,
			error: null,
			copied: null,
			serverInfo: null,
			serverInfoError: null,
		} satisfies Partial<GenericWebhookUrlState>);
	}

	async componentDidMount(): Promise<void> {
		await super.componentDidMount();
		await Promise.all([this.fetchAddresses(), this.fetchServerInfo()]);
	}

	componentDidUpdate(prevProps: ConfigGenericProps): void {
		const prevIp = (prevProps.data as Record<string, unknown> | undefined)?.listenIp as string | undefined;
		const currIp = (this.props.data as Record<string, unknown> | undefined)?.listenIp as string | undefined;
		// Also retry if the instance was started while the settings are open.
		const aliveChanged = !!prevProps.alive !== !!this.props.alive;
		const becameAlive = aliveChanged && !!this.props.alive && !this.state.loading && !!this.state.error;
		if (prevIp !== currIp || becameAlive) {
			void this.fetchAddresses();
		}
		// Saving the settings restarts the instance: the server may run differently afterwards.
		if (aliveChanged) {
			void this.fetchServerInfo();
		}
	}

	componentWillUnmount(): void {
		this.unmounted = true;
		if (this.copiedTimer) {
			clearTimeout(this.copiedTimer);
			this.copiedTimer = null;
		}
		super.componentWillUnmount();
	}

	private async fetchAddresses(): Promise<void> {
		const requestId = ++this.requestCounter;
		const data = this.props.data as Record<string, unknown> | undefined;
		const ip = (data?.listenIp as string | undefined) ?? '0.0.0.0';

		if (ip && ip !== '0.0.0.0') {
			this.setState({ addresses: [ip], loading: false, error: null });
			return;
		}

		this.setState({ loading: true, error: null });
		try {
			const r = await requestAdapter<{ addresses?: unknown } | undefined>(this.props, 'getNetworkInterfaces');
			if (this.unmounted || requestId !== this.requestCounter) {
				return;
			}
			const addresses = Array.isArray(r?.addresses)
				? (r.addresses as unknown[]).filter((a): a is string => typeof a === 'string' && !!a)
				: [];
			this.setState({ addresses: Array.from(new Set(addresses)), loading: false });
		} catch (err) {
			if (this.unmounted || requestId !== this.requestCounter) {
				return;
			}
			this.setState({
				addresses: [],
				loading: false,
				error: describeRequestError(err, 'generic_webhook_url_no_addresses'),
			});
		}
	}

	/** Ask the adapter how its HTTP server really runs (scheme, TLS problems, not started at all) */
	private async fetchServerInfo(): Promise<void> {
		const requestId = ++this.serverInfoCounter;
		try {
			const answer = await requestAdapter<unknown>(this.props, 'getServerInfo');
			if (this.unmounted || requestId !== this.serverInfoCounter) {
				return;
			}
			this.setState({ serverInfo: parseServerInfo(answer), serverInfoError: null });
		} catch (err) {
			if (this.unmounted || requestId !== this.serverInfoCounter) {
				return;
			}
			this.setState({
				serverInfo: null,
				// A stopped instance explains why the URL does not answer; a missing answer does not.
				serverInfoError:
					err instanceof AdapterRequestError && err.reason === 'not-running'
						? describeRequestError(err, 'adapter_not_running')
						: null,
			});
		}
	}

	private copyToClipboard(url: string): void {
		// Not `navigator.clipboard`: it does not exist if the admin is opened via plain http on a LAN address.
		if (!Utils.copyToClipboard(url)) {
			return;
		}
		this.setState({ copied: url });
		if (this.copiedTimer) {
			clearTimeout(this.copiedTimer);
		}
		this.copiedTimer = setTimeout(() => {
			this.copiedTimer = null;
			this.setState({ copied: null });
		}, 2000);
	}

	renderItem(): React.JSX.Element {
		const data = this.props.data as Record<string, unknown> | undefined;
		const enabled = (data?.enableGenericWebhook as boolean | undefined) ?? false;

		if (!enabled) {
			return <></>;
		}

		const { addresses, loading, error, copied, serverInfo, serverInfoError } = this.state;
		const wantsTls = data?.enableTls === true;

		// TLS is enabled, but the certificates could not be loaded: the adapter does not start the server
		// at all. No URL would answer - so none is offered for copying, only the reason. (With TLS switched
		// off in the form, the URL is previewed below like any unsaved change.)
		if (blockedByTls(serverInfo) && wantsTls) {
			return (
				<Box sx={{ width: '100%', mt: 1 }}>
					<Alert
						severity="warning"
						variant="outlined"
					>
						{I18n.t('generic_webhook_tls_inactive', serverInfo.tlsError)}
					</Alert>
				</Box>
			);
		}

		const notice = serverInfoError
			? serverInfoError
			: serverInfo && !serverInfo.running
				? I18n.t('generic_webhook_server_not_running')
				: null;
		// With a public base URL the listen addresses do not matter for the URL.
		const publicBase = normalizePublicBaseUrl(data?.publicBaseUrl);
		const saved = this.props.originalData as Record<string, unknown> | undefined;
		const unsaved = unsavedUrlParts(data, saved, serverInfo);
		// A saved but unusable value is reported as such; the unsaved hint is about form changes only.
		const savedBaseUnusable = unusablePublicBaseUrl(saved?.publicBaseUrl);
		const publicBaseUnsaved = unsaved.publicBase;

		if (!publicBase && loading) {
			return (
				<Stack
					direction="row"
					spacing={1}
					sx={{ alignItems: 'center', mt: 1 }}
				>
					<CircularProgress size={16} />
					<Typography variant="body2">{I18n.t('generic_webhook_url_loading')}</Typography>
				</Stack>
			);
		}

		if (!publicBase && addresses.length === 0) {
			return (
				<Typography
					variant="body2"
					color="text.secondary"
					sx={{ mt: 1 }}
				>
					{error ?? I18n.t('generic_webhook_url_no_addresses')}
				</Typography>
			);
		}

		const urls = publicBase
			? [buildWebhookUrl('', data, serverInfo)]
			: Array.from(new Set(addresses.map(ip => buildWebhookUrl(ip, data, serverInfo))));

		return (
			<Box sx={{ width: '100%', mt: 1 }}>
				<Typography
					variant="subtitle2"
					sx={{ mb: 1 }}
				>
					{I18n.t('generic_webhook_urls')}
				</Typography>
				<Stack spacing={1}>
					{urls.map(url => {
						const isCopied = copied === url;
						return (
							<Stack
								key={url}
								direction="row"
								spacing={1}
								sx={{ alignItems: 'center' }}
							>
								<TextField
									value={url}
									size="small"
									slotProps={{ input: { readOnly: true } }}
									fullWidth
									variant="outlined"
								/>
								<Tooltip
									title={isCopied ? I18n.t('generic_webhook_copied') : I18n.t('generic_webhook_copy')}
								>
									<IconButton
										onClick={() => this.copyToClipboard(url)}
										color={isCopied ? 'success' : 'default'}
									>
										<ContentCopyIcon fontSize="small" />
									</IconButton>
								</Tooltip>
							</Stack>
						);
					})}
				</Stack>
				{savedBaseUnusable ? (
					<Alert
						severity="warning"
						variant="outlined"
						sx={{ mt: 1 }}
					>
						{I18n.t(
							'generic_webhook_public_base_invalid',
							typeof saved?.publicBaseUrl === 'string' ? saved.publicBaseUrl.trim() : '',
						)}
					</Alert>
				) : null}
				{publicBaseUnsaved ? (
					<Alert
						severity="info"
						variant="outlined"
						sx={{ mt: 1 }}
					>
						{I18n.t('generic_webhook_public_base_unsaved')}
					</Alert>
				) : null}
				{unsaved.portOrPath ? (
					<Alert
						severity="info"
						variant="outlined"
						sx={{ mt: 1 }}
					>
						{I18n.t('generic_webhook_unsaved')}
					</Alert>
				) : null}
				{notice ? (
					<Alert
						severity="warning"
						variant="outlined"
						sx={{ mt: 1 }}
					>
						{notice}
					</Alert>
				) : null}
			</Box>
		);
	}
}

export default GenericWebhookUrl;
