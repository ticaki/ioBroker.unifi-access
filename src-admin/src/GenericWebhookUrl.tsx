import type React from 'react';
import { Alert, Box, CircularProgress, IconButton, Stack, TextField, Tooltip, Typography } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';
import { I18n, Utils } from '@iobroker/gui-components';
import { AdapterRequestError, describeRequestError, requestAdapter } from './adapterRequest';

/** Answer of the adapter to `getServerInfo`: the actual state of its built-in HTTP server */
export interface ServerInfo {
	running: boolean;
	scheme: 'http' | 'https' | null;
	tlsEnabled: boolean;
	tlsActive: boolean;
	tlsError: string | null;
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
		tlsEnabled: info.tlsEnabled === true,
		tlsActive: info.tlsActive === true,
		tlsError: typeof info.tlsError === 'string' && info.tlsError ? info.tlsError : null,
	};
}

/**
 * The scheme of the displayed URL. `enableTls` only says what the user wants: with certificates that
 * cannot be loaded the server answers via plain http. So while the edited TLS setting is the one the
 * instance runs with, the scheme of the running server counts. An unsaved change of the setting - or
 * a server whose state is not known - is shown as configured.
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
 * Builds the URL the Alarm Manager has to call. The fallbacks mirror the adapter (`startSharedHttpServer`):
 * an empty port or path means the default there, too.
 *
 * @param ip address the shared HTTP server is reachable at
 * @param data the adapter configuration that is currently edited
 * @param info actual state of the HTTP server (from `getServerInfo`), if known
 */
export function buildWebhookUrl(
	ip: string,
	data: Record<string, unknown> | undefined,
	info: ServerInfo | null = null,
): string {
	const port = Number(data?.listenPort) || 8095;
	const rawPath = (typeof data?.genericWebhookPath === 'string' && data.genericWebhookPath) || '/webhook';
	const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
	return `${effectiveScheme(data, info)}://${ip}:${port}${path}`;
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
		// Only while the edited TLS setting is the one the instance runs with - see effectiveScheme()
		const tlsBroken = !!serverInfo?.running && serverInfo.tlsEnabled && wantsTls && !serverInfo.tlsActive;
		const notice = serverInfoError
			? serverInfoError
			: serverInfo && !serverInfo.running
				? I18n.t('generic_webhook_server_not_running')
				: tlsBroken
					? I18n.t('generic_webhook_tls_inactive', serverInfo.tlsError ?? '?')
					: null;

		if (loading) {
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

		if (addresses.length === 0) {
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

		return (
			<Box sx={{ width: '100%', mt: 1 }}>
				<Typography
					variant="subtitle2"
					sx={{ mb: 1 }}
				>
					{I18n.t('generic_webhook_urls')}
				</Typography>
				<Stack spacing={1}>
					{addresses.map(ip => {
						const url = buildWebhookUrl(ip, data, serverInfo);
						const isCopied = copied === url;
						return (
							<Stack
								key={ip}
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
