import { Box, Card, CardContent, List, ListItem, ListItemText, Stack, Typography } from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import { useIobState } from '../socket';
import { useSettings } from '../settings';
import { EventMediaModal } from './EventMediaModal';

// Adapter triggers the Protect snapshot fetch via system-log poll for these event types only.
// Countdown 3 → 2 → 1 over the first 3s; the 1 then lingers for another 1s while the URL
// usually lands a few hundred ms after the adapter's 3s system-log delay. After 4s without
// URL we declare "Not available".
const PROTECT_SNAPSHOT_EVENTS = new Set(['access.door.unlock', 'access.temporary_unlock.start']);
const SNAPSHOT_WAIT_MS = 4000;

interface EventEntry {
    ts: number;
    type: string;
    subtype?: string;
    deviceName?: string;
    doorName?: string;
    userName?: string;
    protectSnapshotUrl?: string;
    protectVideoUrl?: string;
    protectCameraId?: string;
}

const EVENT_LABELS: Record<string, string> = {
    'access.remote_view': 'Doorbell ringing',
    'access.remote_view.change': 'Doorbell call ended',
    'access.data.device.remote_unlock': 'Remote unlock',
    'access.door.unlock': 'Door unlocked',
    'access.doorbell.incoming': 'Doorbell incoming',
    'access.doorbell.incoming.REN': 'Doorbell incoming',
    'access.doorbell.completed': 'Doorbell completed',
    'access.device.dps_status': 'Door sensor',
    'access.device.emergency_status': 'Emergency alert',
    'access.unlock_schedule.activate': 'Unlock schedule active',
    'access.unlock_schedule.deactivate': 'Unlock schedule ended',
    'access.temporary_unlock.start': 'Temporary unlock started',
    'access.temporary_unlock.end': 'Temporary unlock ended',
    'access.visitor.status.changed': 'Visitor status changed',
};

const SUBTYPE_LABELS: Record<string, string> = {
    timeout: '(timeout)',
    admin_rejected: '(rejected)',
    admin_unlocked: '(unlocked by admin)',
    visitor_cancelled: '(cancelled)',
    answered_elsewhere: '(answered elsewhere)',
    open: '— open',
    close: '— closed',
    closed: '— closed',
};

export function EventLogCard(): JSX.Element {
    const last = useIobState('events.last');
    const { settings } = useSettings();
    const [modalEvent, setModalEvent] = useState<EventEntry | null>(null);
    const [now, setNow] = useState<number>(() => Date.now());

    const events = useMemo<EventEntry[]>(() => {
        if (typeof last?.val !== 'string' || !last.val) {
            return [];
        }
        try {
            const parsed = JSON.parse(last.val) as EventEntry[];
            return Array.isArray(parsed) ? parsed.slice(0, 50) : [];
        } catch {
            return [];
        }
    }, [last]);

    useEffect(() => {
        // Tick while any access.door.unlock event is still in its waiting window.
        // Stop only once every pending event has either resolved (URL) or fully timed out —
        // otherwise the JSX never flips from countdown to "Not available" because `now` is stale.
        const tickNow = Date.now();
        const hasPending = events.some(
            e =>
                PROTECT_SNAPSHOT_EVENTS.has(e.type) &&
                !e.protectSnapshotUrl &&
                tickNow - e.ts < SNAPSHOT_WAIT_MS,
        );
        if (!hasPending) {
            // No active waiting window — but force one render with a fresh `now` so old
            // events (loaded already past their timeout) settle on showNoSnapshot reliably.
            setNow(tickNow);
            return;
        }
        const id = setInterval(() => setNow(Date.now()), 250);
        return () => clearInterval(id);
    }, [events]);

    return (
        <>
            <Card variant="outlined">
                <CardContent>
                    <Typography
                        variant="h6"
                        sx={{ mb: 1 }}
                    >
                        Recent events
                    </Typography>
                    {events.length === 0 ? (
                        <Typography
                            variant="body2"
                            color="text.secondary"
                        >
                            No events yet.
                        </Typography>
                    ) : (
                        <List
                            dense
                            disablePadding
                        >
                            {events.map((e, i) => {
                                const label = EVENT_LABELS[e.type] ?? e.type;
                                const subtypeLabel = e.subtype ? (SUBTYPE_LABELS[e.subtype] ?? e.subtype) : undefined;
                                const context = [e.doorName, e.userName].filter(Boolean).join(' · ');
                                const elapsed = Math.max(0, now - e.ts);
                                const expectsSnapshot =
                                    !e.protectSnapshotUrl &&
                                    PROTECT_SNAPSHOT_EVENTS.has(e.type) &&
                                    settings.thumbWidth > 0;
                                const remaining = SNAPSHOT_WAIT_MS - elapsed;
                                const showCountdown = expectsSnapshot && remaining > 0;
                                const showNoSnapshot = expectsSnapshot && remaining <= 0;
                                // 3 → 2 → 1 in the first 3s, then lingers on 1 for the remainder.
                                const countdown = Math.max(1, 3 - Math.floor(elapsed / 1000));
                                return (
                                    <ListItem
                                        key={`${e.ts}-${i}`}
                                        disableGutters
                                        sx={{ gap: 1, alignItems: 'flex-start' }}
                                    >
                                        <ListItemText
                                            primary={
                                                <Stack
                                                    direction="row"
                                                    spacing={1}
                                                    alignItems="center"
                                                    flexWrap="wrap"
                                                >
                                                    <Typography variant="body2">
                                                        {label}
                                                        {subtypeLabel ? (
                                                            <Typography
                                                                component="span"
                                                                variant="body2"
                                                                color="text.secondary"
                                                                sx={{ ml: 0.5 }}
                                                            >
                                                                {subtypeLabel}
                                                            </Typography>
                                                        ) : null}
                                                    </Typography>
                                                    {context ? (
                                                        <Typography
                                                            variant="caption"
                                                            color="text.secondary"
                                                        >
                                                            @ {context}
                                                        </Typography>
                                                    ) : null}
                                                </Stack>
                                            }
                                            secondary={new Date(e.ts).toLocaleString()}
                                        />
                                        {e.protectSnapshotUrl && settings.thumbWidth > 0 ? (
                                            <Box
                                                component="img"
                                                src={e.protectSnapshotUrl}
                                                alt="camera"
                                                onClick={() => setModalEvent(e)}
                                                sx={{
                                                    width: settings.thumbWidth,
                                                    height: 'auto',
                                                    borderRadius: 0.5,
                                                    cursor: 'pointer',
                                                    flexShrink: 0,
                                                    mt: 0.5,
                                                }}
                                            />
                                        ) : showCountdown ? (
                                            <Box
                                                sx={{
                                                    width: settings.thumbWidth,
                                                    height: settings.thumbWidth * 0.75,
                                                    borderRadius: 0.5,
                                                    border: '1px dashed',
                                                    borderColor: 'divider',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    flexShrink: 0,
                                                    mt: 0.5,
                                                    bgcolor: 'action.hover',
                                                }}
                                            >
                                                <Typography
                                                    variant="h5"
                                                    color="text.secondary"
                                                    sx={{ fontVariantNumeric: 'tabular-nums' }}
                                                >
                                                    {countdown}
                                                </Typography>
                                            </Box>
                                        ) : showNoSnapshot ? (
                                            <Box
                                                sx={{
                                                    width: settings.thumbWidth,
                                                    height: settings.thumbWidth * 0.75,
                                                    borderRadius: 0.5,
                                                    border: '1px dashed',
                                                    borderColor: 'divider',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    flexShrink: 0,
                                                    mt: 0.5,
                                                    bgcolor: 'action.hover',
                                                    px: 0.5,
                                                }}
                                            >
                                                <Typography
                                                    variant="caption"
                                                    color="text.secondary"
                                                    align="center"
                                                >
                                                    Not available
                                                </Typography>
                                            </Box>
                                        ) : null}
                                    </ListItem>
                                );
                            })}
                        </List>
                    )}
                </CardContent>
            </Card>
            {modalEvent?.protectSnapshotUrl ? (
                <EventMediaModal
                    open
                    onClose={() => setModalEvent(null)}
                    snapshotUrl={modalEvent.protectSnapshotUrl}
                    videoUrl={modalEvent.protectVideoUrl}
                    title={[modalEvent.doorName, new Date(modalEvent.ts).toLocaleString()].filter(Boolean).join(' – ')}
                />
            ) : null}
        </>
    );
}
