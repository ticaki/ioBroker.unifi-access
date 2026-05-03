import { Stack, Typography } from '@mui/material';
import { useMemo } from 'react';
import { useIobStates, ADAPTER_NAMESPACE } from '../socket';
import { DoorCard } from './DoorCard';

export function DoorList(): JSX.Element {
    const states = useIobStates(`${ADAPTER_NAMESPACE}.doors.*`);

    const doors = useMemo(() => {
        const map: Record<string, { id: string; locked?: boolean | null; name?: string }> = {};
        const prefix = `${ADAPTER_NAMESPACE}.doors.`;
        for (const [stateId, s] of Object.entries(states)) {
            if (!stateId.startsWith(prefix)) {
                continue;
            }
            const rest = stateId.slice(prefix.length);
            const segs = rest.split('.');
            if (segs.length !== 2) {
                continue;
            }
            const [doorId, leaf] = segs;
            map[doorId] = map[doorId] ?? { id: doorId };
            if (leaf === 'locked') {
                map[doorId].locked = (s?.val as boolean | null | undefined) ?? null;
            }
            if (leaf === 'name') {
                map[doorId].name = (s?.val as string | undefined) ?? undefined;
            }
        }
        return Object.values(map).sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
    }, [states]);

    return (
        <Stack spacing={1}>
            <Typography variant="h6">Doors</Typography>
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
