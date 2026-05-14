import React from 'react';
import {
    Alert,
    Box,
    CircularProgress,
    FormControl,
    IconButton,
    InputLabel,
    MenuItem,
    Select,
    type SelectChangeEvent,
    Stack,
    Tooltip,
    Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';
import { I18n } from '@iobroker/adapter-react-v5';

interface UnifiUser {
    id: string;
    name: string;
}

interface ActorSelectState extends ConfigGenericState {
    loaded: boolean;
    loading: boolean;
    error: string | null;
    users: UnifiUser[];
    selectedId: string;
}

class ActorSelect extends ConfigGeneric<ConfigGenericProps, ActorSelectState> {
    constructor(props: ConfigGenericProps) {
        super(props);
        const data = props.data as Record<string, unknown> | undefined;
        Object.assign(this.state, {
            loaded: false,
            loading: false,
            error: null,
            users: [],
            selectedId: (data?.unlockActorId as string | undefined) ?? '',
        } satisfies Partial<ActorSelectState>);
    }

    componentDidMount(): void {
        super.componentDidMount();
        void this.loadUsers();
    }

    private async loadUsers(): Promise<void> {
        this.setState({ loading: true, error: null });
        try {
            const raw: unknown = await this.props.oContext.socket.sendTo(
                `unifi-access.${this.props.oContext.instance}`,
                'listUsers',
                {},
            );
            const r = raw as { users?: UnifiUser[]; error?: string } | undefined;
            const users = r?.users ?? [];
            this.setState({ users, loaded: true, loading: false });
        } catch (err) {
            this.setState({
                error: (err as Error)?.message ?? I18n.t('actor_select_error'),
                loaded: true,
                loading: false,
            });
        }
    }

    private handleChange(e: SelectChangeEvent<string>): void {
        const id = e.target.value;
        if (!id) {
            this.setState({ selectedId: '' });
            this.onChange('unlockActorId', '');
            this.onChange('unlockActorName', '');
            return;
        }
        const user = this.state.users.find(u => u.id === id);
        if (!user) {
            return;
        }
        this.setState({ selectedId: user.id });
        this.onChange('unlockActorId', user.id);
        this.onChange('unlockActorName', user.name);
    }

    renderItem(): React.JSX.Element {
        const { loading, loaded, error, users, selectedId } = this.state;

        return (
            <Box sx={{ width: '100%', mt: 1 }}>
                <Typography
                    variant="subtitle2"
                    color="text.secondary"
                    sx={{ mb: 1 }}
                >
                    {I18n.t('actor_select_label')}
                </Typography>

                {error ? (
                    <Alert
                        severity="error"
                        variant="outlined"
                        sx={{ mb: 1 }}
                    >
                        {error}
                    </Alert>
                ) : null}

                <Stack
                    direction="row"
                    alignItems="center"
                    spacing={1}
                >
                    {!loaded ? (
                        <Stack
                            direction="row"
                            alignItems="center"
                            spacing={1}
                        >
                            <CircularProgress size={20} />
                            <Typography variant="body2">{I18n.t('actor_select_loading')}</Typography>
                        </Stack>
                    ) : (
                        <FormControl
                            size="small"
                            sx={{ minWidth: 280 }}
                        >
                            <InputLabel>{I18n.t('actor_select_label')}</InputLabel>
                            <Select
                                value={selectedId}
                                label={I18n.t('actor_select_label')}
                                onChange={e => this.handleChange(e)}
                            >
                                <MenuItem value="">
                                    <em>{I18n.t('actor_select_none')}</em>
                                </MenuItem>
                                {users.map(u => (
                                    <MenuItem
                                        key={u.id}
                                        value={u.id}
                                    >
                                        {u.name}
                                    </MenuItem>
                                ))}
                            </Select>
                        </FormControl>
                    )}

                    <Tooltip title={I18n.t('actor_select_refresh')}>
                        <span>
                            <IconButton
                                size="small"
                                onClick={() => void this.loadUsers()}
                                disabled={loading}
                            >
                                {loading ? <CircularProgress size={16} /> : <RefreshIcon fontSize="small" />}
                            </IconButton>
                        </span>
                    </Tooltip>
                </Stack>

                <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ mt: 0.5, display: 'block' }}
                >
                    {I18n.t('actor_select_help')}
                </Typography>
            </Box>
        );
    }
}

export default ActorSelect;
