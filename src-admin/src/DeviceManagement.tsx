import type React from 'react';
import {
	Alert,
	Box,
	Button,
	Card,
	CardContent,
	Chip,
	CircularProgress,
	Snackbar,
	Stack,
	Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import ImageIcon from '@mui/icons-material/Image';
import DoorbellIcon from '@mui/icons-material/Doorbell';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import RssFeedIcon from '@mui/icons-material/RssFeed';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';
import { I18n } from '@iobroker/gui-components';
import { describeAdapterError, describeRequestError, requestAdapter } from './adapterRequest';

interface UnifiDeviceEntry {
	id: string;
	name: string;
	model: string;
	firmware?: string;
	online?: boolean;
	capabilities: string[];
	lastSeenAt?: string;
}

function normalizeDevices(raw: unknown[]): UnifiDeviceEntry[] {
	const devices: UnifiDeviceEntry[] = [];
	for (const entry of raw) {
		const device = entry as Partial<UnifiDeviceEntry> | null;
		if (!device || typeof device.id !== 'string' || !device.id) {
			continue;
		}
		devices.push({
			...device,
			id: device.id,
			name: typeof device.name === 'string' && device.name ? device.name : device.id,
			model: typeof device.model === 'string' ? device.model : '',
			capabilities: Array.isArray(device.capabilities)
				? device.capabilities.filter(c => typeof c === 'string')
				: [],
		});
	}
	return devices;
}

interface DeviceManagementState extends ConfigGenericState {
	loaded: boolean;
	loading: boolean;
	error: string | null;
	devices: UnifiDeviceEntry[];
	snackbar: string | null;
}

class DeviceManagement extends ConfigGeneric<ConfigGenericProps, DeviceManagementState> {
	private unmounted = false;
	private requestCounter = 0;

	constructor(props: ConfigGenericProps) {
		super(props);
		Object.assign(this.state, {
			loaded: false,
			loading: false,
			error: null,
			devices: [],
			snackbar: null,
		} satisfies Partial<DeviceManagementState>);
	}

	async componentDidMount(): Promise<void> {
		await super.componentDidMount();
		await this.loadDevices();
	}

	componentDidUpdate(prevProps: ConfigGenericProps): void {
		// The instance was started while the settings are open: fetch what could not be loaded before.
		if (!prevProps.alive && this.props.alive && !this.state.loading && this.state.error) {
			void this.loadDevices();
		}
	}

	componentWillUnmount(): void {
		this.unmounted = true;
		super.componentWillUnmount();
	}

	private async loadDevices(): Promise<void> {
		const requestId = ++this.requestCounter;
		this.setState({ loading: true, error: null });
		try {
			const r = await requestAdapter<{ devices?: unknown; error?: string } | undefined>(
				this.props,
				'listDevices',
			);
			if (this.unmounted || requestId !== this.requestCounter) {
				return;
			}
			if (Array.isArray(r?.devices)) {
				this.setState({
					devices: normalizeDevices(r.devices),
					loaded: true,
					loading: false,
				});
			} else {
				this.setState({
					error: describeAdapterError(r?.error, 'devices_error_load'),
					loaded: true,
					loading: false,
				});
			}
		} catch (err) {
			if (this.unmounted || requestId !== this.requestCounter) {
				return;
			}
			this.setState({
				error: describeRequestError(err, 'devices_error_load'),
				loaded: true,
				loading: false,
			});
		}
	}

	private renderCapabilityChip(capability: string): React.JSX.Element {
		const map: Record<string, { label: string; icon?: React.JSX.Element; color: 'primary' | 'default' }> = {
			'event-thumbnail': {
				label: I18n.t('devices_cap_event_thumbnail'),
				icon: <ImageIcon fontSize="small" />,
				// not "secondary": in the dark theme of the admin that is a dark blue on a dark background
				color: 'primary',
			},
			doorbell: {
				label: I18n.t('devices_cap_doorbell'),
				icon: <DoorbellIcon fontSize="small" />,
				color: 'primary',
			},
			'door-unlock': {
				label: I18n.t('devices_cap_door_unlock'),
				icon: <LockOpenIcon fontSize="small" />,
				color: 'default',
			},
			'live-events': {
				label: I18n.t('devices_cap_live_events'),
				icon: <RssFeedIcon fontSize="small" />,
				color: 'default',
			},
		};
		// No icon for a capability this version does not know: MUI clones the icon element to set a
		// class name, which React rejects for a fragment.
		const info = map[capability] ?? { label: capability, color: 'default' as const };
		return (
			<Chip
				key={capability}
				size="small"
				icon={info.icon}
				label={info.label}
				color={info.color}
				variant="outlined"
				sx={{ mr: 0.5, mb: 0.5 }}
			/>
		);
	}

	private renderDeviceCard(device: UnifiDeviceEntry): React.JSX.Element {
		const isUaUltra = device.model === 'UA-Ultra';
		return (
			<Card
				key={device.id}
				variant="outlined"
				sx={{
					borderColor: isUaUltra ? 'primary.main' : 'divider',
					borderWidth: isUaUltra ? 2 : 1,
				}}
			>
				<CardContent>
					<Stack
						direction="row"
						spacing={1}
						sx={{ justifyContent: 'space-between', alignItems: 'center' }}
					>
						<Stack>
							<Typography
								variant="subtitle1"
								sx={{ fontWeight: 'bold' }}
							>
								{device.name}
							</Typography>
							<Typography
								variant="caption"
								color="text.secondary"
							>
								{device.model}
								{device.firmware ? ` · ${device.firmware}` : ''}
							</Typography>
						</Stack>
						<Chip
							size="small"
							label={device.online ? I18n.t('devices_online') : I18n.t('devices_offline')}
							color={device.online ? 'success' : 'default'}
						/>
					</Stack>
					<Box sx={{ mt: 1 }}>{device.capabilities.map(c => this.renderCapabilityChip(c))}</Box>
				</CardContent>
			</Card>
		);
	}

	renderItem(): React.JSX.Element {
		const { loading, loaded, error, devices } = this.state;

		return (
			<Box sx={{ width: '100%' }}>
				<Stack
					direction="row"
					sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 2 }}
				>
					<Typography variant="h6">{I18n.t('devices_title')}</Typography>
					<Button
						variant="outlined"
						startIcon={
							loading ? (
								<CircularProgress
									size={16}
									color="inherit"
								/>
							) : (
								<RefreshIcon />
							)
						}
						onClick={() => void this.loadDevices()}
						disabled={loading}
					>
						{I18n.t('devices_refresh')}
					</Button>
				</Stack>

				{error ? (
					<Alert
						severity="error"
						variant="outlined"
						sx={{ mb: 2 }}
					>
						{error}
					</Alert>
				) : null}

				{!loaded ? (
					<Stack
						direction="row"
						spacing={1}
						sx={{ alignItems: 'center' }}
					>
						<CircularProgress size={20} />
						<Typography variant="body2">{I18n.t('devices_loading')}</Typography>
					</Stack>
				) : devices.length === 0 ? (
					<Typography
						variant="body2"
						color="text.secondary"
					>
						{I18n.t('devices_empty')}
					</Typography>
				) : (
					<Stack spacing={1}>{devices.map(d => this.renderDeviceCard(d))}</Stack>
				)}

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

export default DeviceManagement;
