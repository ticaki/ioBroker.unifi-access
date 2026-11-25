import { Alert, Stack, Typography } from '@mui/material';
import { type JSX, useMemo } from 'react';
import { useIobStates, ADAPTER_NAMESPACE } from '../socket';
import { DoorCard } from './DoorCard';

/** `doors.emergency.*` holds the site-wide lockdown/evacuation switches - it is a channel next to the doors, not a door */
const EMERGENCY_CHANNEL = 'emergency';

export interface DoorEntry {
    id: string;
    locked?: boolean | null;
    name?: string;
}

export interface DoorOverview {
    doors: DoorEntry[];
    emergency: { lockdown: boolean; evacuation: boolean };
}

/**
 * Groups the states below `<namespace>.doors.` by door.
 *
 * @param states all states matching `<namespace>.doors.*`
 * @param namespace adapter namespace, e.g. `unifi-access.0`
 */
export function collectDoors(states: Record<string, ioBroker.State | null | undefined>, namespace: string): DoorOverview {
    const map: Record<string, DoorEntry> = {};
    const emergency = { lockdown: false, evacuation: false };
    const prefix = `${namespace}.doors.`;
    for (const [stateId, s] of Object.entries(states)) {
        if (!stateId.startsWith(prefix)) {
            continue;
        }
        const segs = stateId.slice(prefix.length).split('.');
        if (segs.length !== 2) {
            continue;
        }
        const [doorId, leaf] = segs;
        if (doorId === EMERGENCY_CHANNEL) {
            if (leaf === 'lockdown' || leaf === 'evacuation') {
                emergency[leaf] = s?.val === true;
            }
            continue;
        }
        map[doorId] = map[doorId] ?? { id: doorId };
        if (leaf === 'locked') {
            map[doorId].locked = typeof s?.val === 'boolean' ? s.val : null;
        }
        if (leaf === 'name') {
            map[doorId].name = typeof s?.val === 'string' && s.val ? s.val : undefined;
        }
    }
    const doors = Object.values(map).sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
    return { doors, emergency };
}

export function DoorList(): JSX.Element {
    const states = useIobStates(`${ADAPTER_NAMESPACE}.doors.*`);

    const { doors, emergency } = useMemo(() => collectDoors(states, ADAPTER_NAMESPACE), [states]);

    return (
        <Stack spacing={1}>
            <Typography variant="h6">Doors</Typography>
            {emergency.lockdown ? <Alert severity="error">Lockdown active — all doors are forced locked.</Alert> : null}
            {emergency.evacuation ? (
                <Alert severity="warning">Evacuation active — all doors are forced unlocked.</Alert>
            ) : null}
            {doors.length === 0 ? (
                <Typography
                    variant="body2"
                    color="text.secondary"
                >
                    No doors discovered yet.
                </Typography>
            ) : (
                doors.map(d => (
                    <DoorCard
                        key={d.id}
                        doorId={d.id}
                        name={d.name ?? d.id}
                        locked={d.locked}
                    />
                ))
            )}
        </Stack>
    );
}
