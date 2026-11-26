import type React from 'react';
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
import { I18n } from '@iobroker/gui-components';
import { describeAdapterError, describeRequestError, requestAdapter } from './adapterRequest';

interface UnifiUser {
	id: string;
	name: string;
}

interface ActorSelectState extends ConfigGenericState {
	loaded: boolean;
	loading: boolean;
	error: string | null;
	users: UnifiUser[];
}

function normalizeUsers(raw: unknown): UnifiUser[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const users: UnifiUser[] = [];
	for (const entry of raw as unknown[]) {
		const user = entry as Partial<UnifiUser> | null;
		if (user && typeof user.id === 'string' && user.id) {
			users.push({ id: user.id, name: typeof user.name === 'string' && user.name ? user.name : user.id });
		}
	}
	return users;
}

class ActorSelect extends ConfigGeneric<ConfigGenericProps, ActorSelectState> {
	private unmounted = false;
	private requestCounter = 0;

	constructor(props: ConfigGenericProps) {
		super(props);
		Object.assign(this.state, {
			loaded: false,
			loading: false,
			error: null,
			users: [],
		} satisfies Partial<ActorSelectState>);
	}

	async componentDidMount(): Promise<void> {
		await super.componentDidMount();
		await this.loadUsers();
	}

	componentDidUpdate(prevProps: ConfigGenericProps): void {
		// The instance was started while the settings are open: fetch what could not be loaded before.
		if (!prevProps.alive && this.props.alive && !this.state.loading && this.state.error) {
			void this.loadUsers();
		}
	}

	componentWillUnmount(): void {
		this.unmounted = true;
		super.componentWillUnmount();
	}

	private async loadUsers(): Promise<void> {
		const requestId = ++this.requestCounter;
		this.setState({ loading: true, error: null });
		try {
			const answer = await requestAdapter<{ users?: unknown; error?: string } | undefined>(
				this.props,
				'listUsers',
			);
			if (this.unmounted || requestId !== this.requestCounter) {
				return;
			}
			this.setState({
				users: normalizeUsers(answer?.users),
				error: answer?.error ? ActorSelect.describeListError(answer.error) : null,
				loaded: true,
				loading: false,
			});
		} catch (err) {
			if (this.unmounted || requestId !== this.requestCounter) {
				return;
			}
			// Keep the list of an earlier successful request
			this.setState({
				error: describeRequestError(err, 'actor_select_error'),
				loaded: true,
				loading: false,
			});
		}
	}

	/**
	 * Why the adapter could not deliver the user list. A code without a text of its own (a message of
	 * the controller, for example) is not shown raw: the general text is more helpful.
	 *
	 * @param code value of `error` in the answer to `listUsers`
	 */
	private static describeListError(code: unknown): string {
		const text = describeAdapterError(code, 'actor_select_error');
		return text === code ? I18n.t('actor_select_error') : text;
	}

	/** The stored user id: the just selected one or the one from the configuration */
	private getSelectedId(): string {
		const value: unknown = this.state.value ?? ConfigGeneric.getValue(this.props.data, this.props.attr);
		return typeof value === 'string' ? value : '';
	}

	private handleChange(e: SelectChangeEvent): void {
		const value = e.target.value;
		this.setState({ value });
		const attr = this.props.attr;
		if (attr) {
			this.onChange(attr, value).catch((err: unknown) => this.onError(attr, String(err)));
		}
	}

	renderItem(_error: unknown, disabled: boolean): React.JSX.Element {
		const { loading, loaded, error, users } = this.state;
		const selectedId = this.getSelectedId();
		// A stored user that the controller does not report (deleted, or the list could not be loaded)
		// must stay selectable, otherwise the select would show an empty value and MUI complains.
		const selectedIsUnknown = !!selectedId && !users.some(u => u.id === selectedId);

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
					spacing={1}
					sx={{ alignItems: 'center' }}
				>
					{!loaded ? (
						<Stack
							direction="row"
							spacing={1}
							sx={{ alignItems: 'center' }}
						>
							<CircularProgress size={20} />
							<Typography variant="body2">{I18n.t('actor_select_loading')}</Typography>
						</Stack>
					) : (
						<FormControl
							size="small"
							sx={{ minWidth: 280 }}
							disabled={disabled}
						>
							<InputLabel id="unifi-access-actor-select-label">{I18n.t('actor_select_label')}</InputLabel>
							<Select
								labelId="unifi-access-actor-select-label"
								value={selectedId}
								label={I18n.t('actor_select_label')}
								onChange={e => this.handleChange(e)}
							>
								<MenuItem value="">
									<em>{I18n.t('actor_select_none')}</em>
								</MenuItem>
								{selectedIsUnknown ? (
									<MenuItem value={selectedId}>{I18n.t('actor_select_unknown', selectedId)}</MenuItem>
								) : null}
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
								aria-label={I18n.t('actor_select_refresh')}
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
