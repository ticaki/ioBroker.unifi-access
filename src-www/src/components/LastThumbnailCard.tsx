import { Box, Card, CardContent, MenuItem, Select, Stack, Typography } from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import { ADAPTER_NAMESPACE, useIobState, useIobStates } from '../socket';
import { useSettings } from '../settings';

interface ThumbnailDevice {
    id: string;
    name?: string;
    model?: string;
    capabilities?: string[];
}

export function LastThumbnailCard(): JSX.Element {
    const { settings } = useSettings();
    const states = useIobStates(`${ADAPTER_NAMESPACE}.devices.*`);

    const devices = useMemo<ThumbnailDevice[]>(() => {
        const map: Record<string, ThumbnailDevice> = {};
        const prefix = `${ADAPTER_NAMESPACE}.devices.`;
        for (const [stateId, s] of Object.entries(states)) {
            if (!stateId.startsWith(prefix)) {
                continue;
            }
            const rest = stateId.slice(prefix.length);
            const segs = rest.split('.');
            if (segs.length !== 2) {
                continue;
            }
            const [deviceId, leaf] = segs;
            map[deviceId] = map[deviceId] ?? { id: deviceId };
            if (leaf === 'name') {
                map[deviceId].name = (s?.val as string | undefined) ?? undefined;
            }
            if (leaf === 'model') {
                map[deviceId].model = (s?.val as string | undefined) ?? undefined;
            }
        }
        return Object.values(map).filter(d => d.model === 'UA-Ultra' || d.model === 'UA-G3-Pro');
    }, [states]);

    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [imgError, setImgError] = useState(false);

    useEffect(() => {
        if (!selectedId && devices.length > 0) {
            setSelectedId(devices[0].id);
        }
    }, [devices, selectedId]);

    const urlState = useIobState(selectedId ? `devices.${selectedId}.lastThumbnailUrl` : null);
    const tsState = useIobState(selectedId ? `devices.${selectedId}.lastThumbnailAt` : null);
    const url = (urlState?.val as string | undefined) || null;
    const ts = (tsState?.val as number | undefined) ?? null;

    useEffect(() => {
        setImgError(false);
    }, [url]);

    if (devices.length === 0) {
        return (
            <Card variant="outlined">
                <CardContent>
                    <Typography variant="h6">Last event image</Typography>
                    <Typography
                        variant="body2"
                        color="text.secondary"
                    >
                        No thumbnail-capable devices discovered (UA Ultra or UA G3 Pro required).
                    </Typography>
                </CardContent>
            </Card>
        );
    }

    return (
        <Card variant="outlined">
            <CardContent>
                <Stack
                    direction="row"
                    justifyContent="space-between"
                    alignItems="center"
                    sx={{ mb: 1 }}
                >
                    <Typography variant="h6">Last event image</Typography>
                    <Select
                        size="small"
                        value={selectedId ?? ''}
                        onChange={e => setSelectedId(e.target.value || null)}
                    >
                        {devices.map(d => (
                            <MenuItem
                                key={d.id}
                                value={d.id}
                            >
                                {d.name ?? d.id}
                                {d.model ? ` (${d.model})` : ''}
                            </MenuItem>
                        ))}
                    </Select>
                </Stack>
                {url && !imgError ? (
                    <>
                        <Box
                            component="img"
                            src={url}
                            alt="event thumbnail"
                            onError={() => setImgError(true)}
                            sx={{
                                width: '100%',
                                borderRadius: 1,
                                display: 'block',
                                ...(settings.snapshotHeight > 0
                                    ? { maxHeight: settings.snapshotHeight, objectFit: 'contain' }
                                    : {}),
                            }}
                        />
                        {ts ? (
                            <Typography
                                variant="caption"
                                color="text.secondary"
                            >
                                {new Date(ts).toLocaleString()}
                            </Typography>
                        ) : null}
                    </>
                ) : (
                    <Typography
                        variant="body2"
                        color="text.secondary"
                    >
                        No event image received yet — thumbnails appear after a doorbell ring or door unlock.
                    </Typography>
                )}
            </CardContent>
        </Card>
    );
}
