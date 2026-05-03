import React from 'react';
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
import { I18n } from '@iobroker/adapter-react-v5';

interface UnifiDeviceEntry {
    id: string;
    name: string;
    model: string;
    firmware?: string;
    online?: boolean;
    capabilities: string[];
    lastSeenAt?: string;
}

interface DeviceManagementState extends ConfigGenericState {
    loaded: boolean;
    loading: boolean;
    error: string | null;
    devices: UnifiDeviceEntry[];
    snackbar: string | null;
}

class DeviceManagement extends ConfigGeneric<ConfigGenericProps, DeviceManagementState> {
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

    componentDidMount(): void {
        super.componentDidMount();
        void this.loadDevices();
    }

    private async loadDevices(): Promise<void> {
        this.setState({ loading: true, error: null });
        try {
            const raw: unknown = await this.props.oContext.socket.sendTo(
                `unifi-access.${this.props.oContext.instance}`,
                'listDevices',
                {},
            );
            const r = raw as { devices?: UnifiDeviceEntry[]; error?: string } | undefined;
            if (r?.devices) {
                this.setState({
                    devices: r.devices,
                    loaded: true,
                    loading: false,
                });
            } else {
                this.setState({
                    error: r?.error ?? I18n.t('devices_error_load'),
                    loaded: true,
                    loading: false,
                });
            }
        } catch (err) {
            this.setState({
                error: (err as Error)?.message ?? I18n.t('devices_error_load'),
                loaded: true,
                loading: false,
            });
        }
    }

    private renderCapabilityChip(capability: string): React.JSX.Element {
        const map: Record<string, { label: string; icon: React.JSX.Element; color: 'primary' | 'secondary' | 'default' }> = {
            'event-thumbnail': {
                label: I18n.t('devices_cap_event_thumbnail'),
                icon: <ImageIcon fontSize="small" />,
                color: 'secondary',
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
        const info = map[capability] ?? { label: capability, icon: <></>, color: 'default' as const };
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
                        justifyContent="space-between"
                        alignItems="center"
                        spacing={1}
                    >
                        <Stack>
                            <Typography
                                variant="subtitle1"
                                fontWeight="bold"
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
                    justifyContent="space-between"
                    alignItems="center"
                    sx={{ mb: 2 }}
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
                        alignItems="center"
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
