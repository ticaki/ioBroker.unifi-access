import React from 'react';
import { Alert, Box, Button, CircularProgress, Snackbar, Stack, Tooltip } from '@mui/material';
import WifiTetheringIcon from '@mui/icons-material/WifiTethering';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';
import { I18n } from '@iobroker/adapter-react-v5';

interface AuthSetupState extends ConfigGenericState {
	testing: boolean;
	testStatusMsg: string;
	testStatusKind: 'info' | 'success' | 'error';

	snackbar: string | null;
}

class AuthSetup extends ConfigGeneric<ConfigGenericProps, AuthSetupState> {
	constructor(props: ConfigGenericProps) {
		super(props);
		Object.assign(this.state, {
			testing: false,
			testStatusMsg: '',
			testStatusKind: 'info',
			snackbar: null,
		} satisfies Partial<AuthSetupState>);
	}

	private async runConnectionTest(): Promise<void> {
		const data = this.props.data as Record<string, unknown> | undefined;
		const host = (data?.controllerHost as string | undefined) ?? '';
		const port = (data?.controllerPort as number | undefined) ?? 12_445;
		const token = (data?.apiToken as string | undefined) ?? '';
		const verifyTLS = (data?.verifyTLS as boolean | undefined) ?? false;

		if (!host || !token) {
			this.setState({
				testStatusMsg: I18n.t('auth_test_missingFields'),
				testStatusKind: 'error',
			});
			return;
		}

		this.setState({
			testing: true,
			testStatusMsg: I18n.t('auth_test_running'),
			testStatusKind: 'info',
		});

		try {
			const raw: unknown = await this.props.oContext.socket.sendTo(
				`unifi-access.${this.props.oContext.instance}`,
				'verifyToken',
				{ host, port, token, verifyTLS },
			);
			const r = raw as
				| { ok?: boolean; error?: /*'unauthorized' | 'network' |*/ string; controllerName?: string }
				| undefined;
			if (r?.ok) {
				this.setState({
					testing: false,
					testStatusMsg: r.controllerName
						? I18n.t('auth_test_success_named').replace('%s', r.controllerName)
						: I18n.t('auth_test_success'),
					testStatusKind: 'success',
					snackbar: I18n.t('auth_test_success'),
				});
			} else {
				const reason =
					r?.error === 'unauthorized'
						? I18n.t('auth_test_error_unauthorized')
						: r?.error === 'network'
							? I18n.t('auth_test_error_network')
							: (r?.error ?? I18n.t('auth_test_error_unknown'));
				this.setState({
					testing: false,
					testStatusMsg: reason,
					testStatusKind: 'error',
				});
			}
		} catch (err) {
			this.setState({
				testing: false,
				testStatusMsg: (err as Error)?.message ?? I18n.t('auth_test_error_unknown'),
				testStatusKind: 'error',
			});
		}
	}

	renderItem(): React.JSX.Element {
		const { testing, testStatusMsg, testStatusKind } = this.state;

		return (
			<Box sx={{ width: '100%' }}>
				<Stack
					spacing={2}
					sx={{ mt: 1 }}
				>
					<Tooltip title={I18n.t('auth_test_tooltip')}>
						<span>
							<Button
								variant="contained"
								color="primary"
								startIcon={
									testing ? (
										<CircularProgress
											size={16}
											color="inherit"
										/>
									) : (
										<WifiTetheringIcon />
									)
								}
								onClick={() => void this.runConnectionTest()}
								disabled={testing}
							>
								{I18n.t('auth_test_button')}
							</Button>
						</span>
					</Tooltip>

					{testStatusMsg ? (
						<Alert
							severity={testStatusKind}
							variant="outlined"
						>
							{testStatusMsg}
						</Alert>
					) : null}
				</Stack>

				<Snackbar
					open={!!this.state.snackbar}
					autoHideDuration={2500}
					onClose={() => this.setState({ snackbar: null })}
					message={this.state.snackbar ?? ''}
					anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
				/>
			</Box>
		);
	}
}

export default AuthSetup;
