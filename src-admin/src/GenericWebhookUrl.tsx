import type React from 'react';
import { Box, CircularProgress, IconButton, Stack, TextField, Tooltip, Typography } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';
import { I18n, Utils } from '@iobroker/gui-components';
import { describeRequestError, requestAdapter } from './adapterRequest';

interface GenericWebhookUrlState extends ConfigGenericState {
	addresses: string[];
	loading: boolean;
	error: string | null;
	copied: string | null;
}

/**
 * Builds the URL the Alarm Manager has to call. The fallbacks mirror the adapter (`startSharedHttpServer`):
 * an empty port or path means the default there, too.
 *
 * @param ip address the shared HTTP server is reachable at
 * @param data the adapter configuration that is currently edited
 */
export function buildWebhookUrl(ip: string, data: Record<string, unknown> | undefined): string {
	const port = Number(data?.listenPort) || 8095;
	const rawPath = (typeof data?.genericWebhookPath === 'string' && data.genericWebhookPath) || '/webhook';
	const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
	const scheme = data?.enableTls === true ? 'https' : 'http';
	return `${scheme}://${ip}:${port}${path}`;
}

class GenericWebhookUrl extends ConfigGeneric<ConfigGenericProps, GenericWebhookUrlState> {
	private unmounted = false;
	private requestCounter = 0;
	private copiedTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(props: ConfigGenericProps) {
		super(props);
		Object.assign(this.state, {
			addresses: [],
			loading: false,
			error: null,
			copied: null,
		} satisfies Partial<GenericWebhookUrlState>);
	}

	async componentDidMount(): Promise<void> {
		await super.componentDidMount();
		await this.fetchAddresses();
	}

	componentDidUpdate(prevProps: ConfigGenericProps): void {
		const prevIp = (prevProps.data as Record<string, unknown> | undefined)?.listenIp as string | undefined;
		const currIp = (this.props.data as Record<string, unknown> | undefined)?.listenIp as string | undefined;
		// Also retry if the instance was started while the settings are open.
		const becameAlive = !prevProps.alive && this.props.alive && !this.state.loading && !!this.state.error;
		if (prevIp !== currIp || becameAlive) {
			void this.fetchAddresses();
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

		const { addresses, loading, error, copied } = this.state;

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
						const url = buildWebhookUrl(ip, data);
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
			</Box>
		);
	}
}

export default GenericWebhookUrl;
