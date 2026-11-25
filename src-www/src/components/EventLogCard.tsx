import { Box, ButtonBase, Card, CardContent, List, ListItem, ListItemText, Stack, Typography } from '@mui/material';
import { type JSX, useEffect, useMemo, useState } from 'react';
import { ADAPTER_NAMESPACE, useIobState } from '../socket';
import { useSettings } from '../settings';
import { EventMediaModal } from './EventMediaModal';

// Adapter triggers the Protect snapshot fetch via system-log poll for these event types only.
// Countdown 3 → 2 → 1 over the first 3s; the 1 then lingers for another 1s while the URL
// usually lands a few hundred ms after the adapter's 3s system-log delay. After 4s without
// URL we declare "Not available".
const PROTECT_SNAPSHOT_EVENTS = new Set(['access.door.unlock', 'access.temporary_unlock.start']);
const SNAPSHOT_WAIT_MS = 4000;

const MAX_EVENTS = 50;

export interface EventEntry {
    ts: number;
    type: string;
    subtype?: string;
    /** `access.door.unlock`: false when the attempt was refused ("BLOCKED", "Access Denied"), decided by the adapter */
    granted?: boolean;
    deviceName?: string;
    doorName?: string;
    userName?: string;
    protectSnapshotUrl?: string;
    protectVideoUrl?: string;
    protectCameraId?: string;
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
}

/** Only absolute http(s) URLs are usable as image/video source of the panel */
function mediaUrl(value: unknown): string | undefined {
    return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : undefined;
}

/**
 * Reads the JSON list of `events.last`. The state can be empty, truncated or written by something else
 * than the adapter: whatever is not a usable event is skipped instead of crashing the whole page.
 *
 * @param raw value of the state
 */
export function parseEvents(raw: unknown): EventEntry[] {
    if (typeof raw !== 'string' || !raw) {
        return [];
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) {
        return [];
    }
    const events: EventEntry[] = [];
    for (const item of parsed as unknown[]) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const e = item as Record<string, unknown>;
        if (typeof e.ts !== 'number' || !Number.isFinite(e.ts) || typeof e.type !== 'string' || !e.type) {
            continue;
        }
        events.push({
            ts: e.ts,
            type: e.type,
            subtype: text(e.subtype),
            granted: typeof e.granted === 'boolean' ? e.granted : undefined,
            deviceName: text(e.deviceName),
            doorName: text(e.doorName),
            userName: text(e.userName),
            protectSnapshotUrl: mediaUrl(e.protectSnapshotUrl),
            protectVideoUrl: mediaUrl(e.protectVideoUrl),
            protectCameraId: text(e.protectCameraId),
        });
        if (events.length === MAX_EVENTS) {
            break;
        }
    }
    return events;
}

/** Monotonic clock of the browser: only differences of it are used, never its absolute value */
function browserClock(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/** An event together with the moment its waiting window started, on the clock of {@link browserClock} */
interface TimedEvent {
    event: EventEntry;
    startedAt: number;
}

function usableTs(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Places the events on the clock of the browser without trusting its date and time: a wall tablet whose
 * clock is minutes off must not count down for minutes or skip the countdown.
 *
 * How old an event was when the list arrived is measured from the event's own `ts` on the clock of
 * ioBroker. "Now" on that clock is the newest of two time stamps written by ioBroker: `ts` of the state
 * `events.last` (when the list was last written - only "now" for a list that was just written) and `ts`
 * of `system.adapter.<instance>.alive` (renewed by the running adapter every 15 s). The second one keeps
 * a list that was written long ago - the page is opened or reconnects later - from counting down again.
 * Never negative, so an event of a controller whose clock is ahead starts its window when it arrives -
 * every window ends at the latest {@link SNAPSHOT_WAIT_MS} after the list arrived in the browser.
 *
 * @param events events of the list
 * @param stateTs `ts` of the state `events.last`
 * @param receivedAt when the list arrived, see {@link browserClock}
 * @param aliveTs `ts` of the state `system.adapter.<instance>.alive` as known when the list arrived
 */
export function timeEvents(events: EventEntry[], stateTs: unknown, receivedAt: number, aliveTs?: unknown): TimedEvent[] {
    const known = [usableTs(stateTs), usableTs(aliveTs)].filter((ts): ts is number => ts !== undefined);
    const serverNow = known.length > 0 ? Math.max(...known) : undefined;
    return events.map(event => ({
        event,
        startedAt: receivedAt - (serverNow === undefined ? 0 : Math.max(0, serverNow - event.ts)),
    }));
}

function isSnapshotPending({ event, startedAt }: TimedEvent, now: number): boolean {
    return PROTECT_SNAPSHOT_EVENTS.has(event.type) && !event.protectSnapshotUrl && now - startedAt < SNAPSHOT_WAIT_MS;
}

/** Label lookup that does not fall for keys like `constructor` */
function labelOf(labels: Record<string, string>, key: string): string {
    // not Object.hasOwn(): the build targets Chrome 89 (old wall tablets), which does not have it
    return Object.prototype.hasOwnProperty.call(labels, key) ? labels[key] : key;
}

/** Label of a refused `access.door.unlock` (granted false) */
export const ACCESS_DENIED_LABEL = 'Access denied';

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
    // renewed by the running adapter every 15 s: tells how old a list is that was written long ago
    const alive = useIobState(`system.adapter.${ADAPTER_NAMESPACE}.alive`);
    const aliveKnown = alive !== undefined && alive !== null;
    // Camera snapshots only arrive while the adapter is logged in to UniFi Protect. Without it no
    // placeholder is shown - it would count down and end in "Not available" for every door opening.
    const protectConnected = useIobState('info.protectConnected')?.val === true;
    const { settings } = useSettings();
    const showThumbs = settings.thumbWidth > 0;
    const [modalEvent, setModalEvent] = useState<EventEntry | null>(null);
    const [now, setNow] = useState<number>(browserClock);
    const [brokenImages, setBrokenImages] = useState<ReadonlySet<string>>(() => new Set());

    // a new value of the state (new event, snapshot URL added) is a new arrival
    const receivedAt = useMemo(() => browserClock(), [last]);
    // Placed again only when the alive time stamp becomes known (both are read at the same time on load),
    // not on each of its 15-second renewals: those would shorten windows that are already running.
    const timed = useMemo<TimedEvent[]>(
        () => timeEvents(parseEvents(last?.val), last?.ts, receivedAt, alive?.ts),
        [last, receivedAt, aliveKnown],
    );

    useEffect(() => {
        // Tick while any access.door.unlock event is still in its waiting window.
        // Stop only once every pending event has either resolved (URL) or fully timed out —
        // otherwise the JSX never flips from countdown to "Not available" because `now` is stale.
        const tickNow = browserClock();
        // Always render once with a fresh `now`, so old events (loaded already past their timeout)
        // settle on showNoSnapshot reliably.
        setNow(tickNow);
        // no countdown is shown while the thumbnails are switched off: nothing to tick for
        if (!protectConnected || !showThumbs || !timed.some(t => isSnapshotPending(t, tickNow))) {
            return;
        }
        // ends on its own: every window is over SNAPSHOT_WAIT_MS after the list arrived (timeEvents)
        const id = setInterval(() => {
            const current = browserClock();
            setNow(current);
            if (!timed.some(t => isSnapshotPending(t, current))) {
                // Every waiting window is over: this was the last render that was needed.
                clearInterval(id);
            }
        }, 250);
        return () => clearInterval(id);
    }, [timed, protectConnected, showThumbs]);

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
                    {timed.length === 0 ? (
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
                            {timed.map(({ event: e, startedAt }, i) => {
                                const denied = e.type === 'access.door.unlock' && e.granted === false;
                                const label = denied ? ACCESS_DENIED_LABEL : labelOf(EVENT_LABELS, e.type);
                                // the result of an unlock is told by the label; its raw text ("Access Granted",
                                // "BLOCKED") is only shown for entries written before the adapter reported it
                                const subtypeLabel =
                                    e.subtype && !(e.type === 'access.door.unlock' && e.granted !== undefined)
                                        ? labelOf(SUBTYPE_LABELS, e.subtype)
                                        : undefined;
                                const context = [e.doorName, e.userName].filter(Boolean).join(' · ');
                                const elapsed = Math.max(0, now - startedAt);
                                const snapshotUrl =
                                    e.protectSnapshotUrl && !brokenImages.has(e.protectSnapshotUrl)
                                        ? e.protectSnapshotUrl
                                        : undefined;
                                const expectsSnapshot =
                                    !e.protectSnapshotUrl &&
                                    protectConnected &&
                                    PROTECT_SNAPSHOT_EVENTS.has(e.type) &&
                                    settings.thumbWidth > 0;
                                const remaining = SNAPSHOT_WAIT_MS - elapsed;
                                const showCountdown = expectsSnapshot && remaining > 0;
                                // Also if the image exists but cannot be loaded (adapter stopped, Protect
                                // switched off since, page served via https: mixed content).
                                const showNoSnapshot =
                                    (expectsSnapshot && remaining <= 0) ||
                                    (!!e.protectSnapshotUrl && !snapshotUrl && settings.thumbWidth > 0);
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
                                                    sx={{ alignItems: 'center', flexWrap: 'wrap' }}
                                                >
                                                    <Typography
                                                        variant="body2"
                                                        color={denied ? 'error' : undefined}
                                                    >
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
                                        {snapshotUrl && settings.thumbWidth > 0 ? (
                                            // a real button: reachable with the keyboard, opens with Enter / Space
                                            <ButtonBase
                                                onClick={() => setModalEvent(e)}
                                                aria-label={`Show camera image${e.doorName ? ` of ${e.doorName}` : ''}, ${new Date(e.ts).toLocaleString()}`}
                                                focusRipple
                                                sx={{ borderRadius: 0.5, flexShrink: 0, mt: 0.5 }}
                                            >
                                                <Box
                                                    component="img"
                                                    src={snapshotUrl}
                                                    alt=""
                                                    onError={() =>
                                                        setBrokenImages(prev => new Set(prev).add(snapshotUrl))
                                                    }
                                                    sx={{
                                                        width: settings.thumbWidth,
                                                        height: 'auto',
                                                        borderRadius: 0.5,
                                                        display: 'block',
                                                    }}
                                                />
                                            </ButtonBase>
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
