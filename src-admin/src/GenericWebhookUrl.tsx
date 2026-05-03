import React from 'react';
import { Box, CircularProgress, IconButton, Stack, TextField, Tooltip, Typography } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';
import { I18n } from '@iobroker/adapter-react-v5';

interface GenericWebhookUrlState extends ConfigGenericState {
	addresses: string[];
	loading: boolean;
	copied: string | null;
}

class GenericWebhookUrl extends ConfigGeneric<ConfigGenericProps, GenericWebhookUrlState> {
	constructor(props: ConfigGenericProps) {
		super(props);
		Object.assign(this.state, {
			addresses: [],
			loading: false,
			copied: null,
		} satisfies Partial<GenericWebhookUrlState>);
	}

	async componentDidMount(): Promise<void> {
		await this.fetchAddresses();
	}

	async componentDidUpdate(prevProps: ConfigGenericProps): Promise<void> {
		const prevIp = (prevProps.data as Record<string, unknown> | undefined)?.listenIp as string | undefined;
		const currIp = (this.props.data as Record<string, unknown> | undefined)?.listenIp as string | undefined;
		if (prevIp !== currIp) {
			await this.fetchAddresses();
		}
	}

	private async fetchAddresses(): Promise<void> {
		const data = this.props.data as Record<string, unknown> | undefined;
		const ip = (data?.listenIp as string | undefined) ?? '0.0.0.0';

		if (ip && ip !== '0.0.0.0') {
			this.setState({ addresses: [ip], loading: false });
			return;
		}

		this.setState({ loading: true });
		try {
			const raw: unknown = await this.props.oContext.socket.sendTo(
				`unifi-access.${this.props.oContext.instance}`,
				'getNetworkInterfaces',
				{},
			);
			const r = raw as { addresses?: string[] } | undefined;
			this.setState({ addresses: r?.addresses ?? [], loading: false });
		} catch {
			this.setState({ addresses: [], loading: false });
		}
	}

	private buildUrl(ip: string): string {
		const data = this.props.data as Record<string, unknown> | undefined;
		const port = (data?.listenPort as number | undefined) ?? 8095;
		const rawPath = (data?.genericWebhookPath as string | undefined) ?? '/webhook';
		const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
		const scheme = (data?.enableTls as boolean | undefined) === true ? 'https' : 'http';
		return `${scheme}://${ip}:${port}${path}`;
	}

	private copyToClipboard(url: string): void {
		void navigator.clipboard.writeText(url).then(() => {
			this.setState({ copied: url });
			setTimeout(() => this.setState({ copied: null }), 2000);
		});
	}

	renderItem(): React.JSX.Element {
		const data = this.props.data as Record<string, unknown> | undefined;
		const enabled = (data?.enableGenericWebhook as boolean | undefined) ?? false;

		if (!enabled) {
			return <></>;
		}

		const { addresses, loading, copied } = this.state;

		if (loading) {
			return (
				<Stack
					direction="row"
					alignItems="center"
					spacing={1}
					sx={{ mt: 1 }}
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
					{I18n.t('generic_webhook_url_no_addresses')}
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
						const url = this.buildUrl(ip);
						const isCopied = copied === url;
						return (
							<Stack
								key={ip}
								direction="row"
								alignItems="center"
								spacing={1}
							>
								<TextField
									value={url}
									size="small"
									slotProps={{ input: { readOnly: true } }}
									fullWidth
									variant="outlined"
								/>
								<Tooltip title={isCopied ? I18n.t('generic_webhook_copied') : I18n.t('generic_webhook_copy')}>
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
