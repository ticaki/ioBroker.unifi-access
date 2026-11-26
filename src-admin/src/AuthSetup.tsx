import type React from 'react';
import { Alert, Box, Button, CircularProgress, Snackbar, Stack, Tooltip } from '@mui/material';
import WifiTetheringIcon from '@mui/icons-material/WifiTethering';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';
import { I18n } from '@iobroker/gui-components';
import { describeAdapterError, describeRequestError, requestAdapter } from './adapterRequest';

/** The adapter probes the controller with a 10 s HTTP timeout, so wait a bit longer than that */
const VERIFY_TIMEOUT_MS = 20_000;

/**
 * The password field of the admin shows this text instead of a stored secret. If the user types into
 * the field without clearing it first, the placeholder becomes a part of the value.
 */
const PASSWORD_PLACEHOLDER = '____ppp____';

/** Answer of the adapter to `verifyToken` */
interface VerifyTokenAnswer {
	ok?: boolean;
	/** `unauthorized`, `network`, `tls`, `missing-fields`, `not-configured`, `unknown-command` */
	error?: string;
	/** OpenSSL code of a TLS error, e.g. `DEPTH_ZERO_SELF_SIGNED_CERT` */
	detail?: string;
	/** Number of devices the controller reported; missing in answers of older adapter versions */
	deviceCount?: number;
}

interface AuthSetupState extends ConfigGenericState {
	testing: boolean;
	testStatusMsg: string;
	testStatusKind: 'info' | 'success' | 'error';

	snackbar: string | null;
}

class AuthSetup extends ConfigGeneric<ConfigGenericProps, AuthSetupState> {
	private unmounted = false;

	constructor(props: ConfigGenericProps) {
		super(props);
		Object.assign(this.state, {
			testing: false,
			testStatusMsg: '',
			testStatusKind: 'info',
			snackbar: null,
		} satisfies Partial<AuthSetupState>);
	}

	componentWillUnmount(): void {
		this.unmounted = true;
		super.componentWillUnmount();
	}

	private static describeVerifyError(answer: VerifyTokenAnswer | undefined): string {
		const code = answer?.error;
		if (code === 'missing-fields') {
			return I18n.t('auth_test_missingFields');
		}
		if (code === 'tls') {
			const detail = typeof answer?.detail === 'string' && answer.detail.trim() ? answer.detail.trim() : 'TLS';
			return I18n.t('auth_test_error_tls', detail);
		}
		return describeAdapterError(code, 'auth_test_error_unknown');
	}

	private static describeSuccess(answer: VerifyTokenAnswer): string {
		const count = answer.deviceCount;
		if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
			return I18n.t('auth_test_success');
		}
		if (count === 0) {
			return I18n.t('auth_test_success_no_devices');
		}
		if (count === 1) {
			return I18n.t('auth_test_success_one_device');
		}
		return I18n.t('auth_test_success_devices', String(count));
	}

	private async runConnectionTest(): Promise<void> {
		const data = this.props.data as Record<string, unknown> | undefined;
		const host = typeof data?.controllerHost === 'string' ? data.controllerHost : '';
		const port = Number(data?.controllerPort) || 12_445;
		const token = typeof data?.apiToken === 'string' ? data.apiToken : '';
		const verifyTLS = data?.verifyTLS === true;
		// the CA of the form, not the saved one: the test promises to use the values entered above
		const caCert = typeof data?.caCert === 'string' ? data.caCert : '';

		if (!host || !token) {
			this.setState({
				testStatusMsg: I18n.t('auth_test_missingFields'),
				testStatusKind: 'error',
			});
			return;
		}
		if (token.includes(PASSWORD_PLACEHOLDER)) {
			this.setState({
				testStatusMsg: I18n.t('auth_test_placeholder'),
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
			const r = await requestAdapter<VerifyTokenAnswer | undefined>(
				this.props,
				'verifyToken',
				{ host, port, token, verifyTLS, caCert },
				VERIFY_TIMEOUT_MS,
			);
			if (this.unmounted) {
				return;
			}
			if (r?.ok) {
				this.setState({
					testing: false,
					testStatusMsg: AuthSetup.describeSuccess(r),
					testStatusKind: 'success',
					snackbar: I18n.t('auth_test_success'),
				});
			} else {
				this.setState({
					testing: false,
					testStatusMsg: AuthSetup.describeVerifyError(r),
					testStatusKind: 'error',
				});
			}
		} catch (err) {
			if (this.unmounted) {
				return;
			}
			this.setState({
				testing: false,
				testStatusMsg: describeRequestError(err, 'auth_test_error_unknown'),
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
