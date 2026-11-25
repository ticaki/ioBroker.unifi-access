import type { JSX } from 'react';
import { Alert, Card, CardContent, Chip, Stack, Typography } from '@mui/material';
import DoorbellIcon from '@mui/icons-material/Doorbell';
import { useIobState } from '../socket';

/** Text of a state; the adapter writes strings or null, anything else is not shown */
function textOf(state: ioBroker.State | null | undefined): string | null {
    return typeof state?.val === 'string' && state.val ? state.val : null;
}

/** Start of the call (ms epoch or ISO text) - null if it is no usable time */
function startOf(state: ioBroker.State | null | undefined): Date | null {
    const val = state?.val;
    if ((typeof val !== 'number' || val <= 0) && (typeof val !== 'string' || !val)) {
        return null;
    }
    const date = new Date(val);
    return Number.isNaN(date.getTime()) ? null : date;
}

export function DoorbellCallsCard(): JSX.Element {
    const activeCallId = useIobState('doorbell.activeCallId');
    const activeFromDevice = useIobState('doorbell.activeFromDevice');
    const activeStartedAt = useIobState('doorbell.activeStartedAt');

    const callId = textOf(activeCallId);
    const fromDevice = textOf(activeFromDevice);
    const startedAt = startOf(activeStartedAt);

    if (!callId) {
        return (
            <Card variant="outlined">
                <CardContent>
                    <Stack
                        direction="row"
                        spacing={1}
                        sx={{ alignItems: 'center' }}
                    >
                        <DoorbellIcon color="disabled" />
                        <Typography
                            variant="body2"
                            color="text.secondary"
                        >
                            No active doorbell call.
                        </Typography>
                    </Stack>
                </CardContent>
            </Card>
        );
    }

    return (
        <Card
            variant="outlined"
            sx={{ borderColor: 'primary.main', borderWidth: 2 }}
        >
            <CardContent>
                <Alert
                    severity="info"
                    icon={<DoorbellIcon />}
                    sx={{ mb: 1 }}
                >
                    Incoming doorbell call — answer it from the official UniFi Access app.
                </Alert>
                <Stack spacing={0.5}>
                    <Typography variant="subtitle2">Call: {callId}</Typography>
                    {fromDevice ? (
                        <Chip
                            size="small"
                            label={`from ${fromDevice}`}
                        />
                    ) : null}
                    {startedAt ? (
                        <Typography
                            variant="caption"
                            color="text.secondary"
                        >
                            started: {startedAt.toLocaleString()}
                        </Typography>
                    ) : null}
                </Stack>
            </CardContent>
        </Card>
    );
}
