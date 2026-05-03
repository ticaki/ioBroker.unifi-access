import { Alert, Card, CardContent, Chip, Stack, Typography } from '@mui/material';
import DoorbellIcon from '@mui/icons-material/Doorbell';
import { useIobState } from '../socket';

export function DoorbellCallsCard(): JSX.Element {
    const activeCallId = useIobState('doorbell.activeCallId');
    const activeFromDevice = useIobState('doorbell.activeFromDevice');
    const activeStartedAt = useIobState('doorbell.activeStartedAt');

    const callId = (activeCallId?.val as string | undefined) ?? null;
    const fromDevice = (activeFromDevice?.val as string | undefined) ?? null;
    const startedAt = (activeStartedAt?.val as number | string | undefined) ?? null;

    if (!callId) {
        return (
            <Card variant="outlined">
                <CardContent>
                    <Stack
                        direction="row"
                        spacing={1}
                        alignItems="center"
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
                            started: {new Date(startedAt).toLocaleString()}
                        </Typography>
                    ) : null}
                </Stack>
            </CardContent>
        </Card>
    );
}
