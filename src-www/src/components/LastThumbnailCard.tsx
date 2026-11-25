import { Box, Card, CardContent, MenuItem, Select, Stack, Typography } from '@mui/material';
import { type JSX, useEffect, useMemo, useState } from 'react';
import { ADAPTER_NAMESPACE, useIobState, useIobStates } from '../socket';
import { useSettings } from '../settings';

export interface ThumbnailDevice {
    id: string;
    name?: string;
    model?: string;
}

/** Models the adapter gives the `event-thumbnail` capability, see `featuresFor()` in src/lib/deviceModels.ts */
export const THUMBNAIL_MODELS = new Set(['UA-Ultra', 'UA-G3-Pro', 'UA-G2-Pro', 'UA-Intercom']);
const THUMBNAIL_STATES = new Set(['lastThumbnailPath', 'lastThumbnailUrl', 'lastThumbnailAt']);

/**
 * Devices that can show an event image: by model, or because the adapter already stored a thumbnail for
 * them (it files a thumbnail under the reader id taken from the image path).
 *
 * @param states all states matching `<namespace>.devices.*`
 * @param namespace adapter namespace, e.g. `unifi-access.0`
 */
export function collectThumbnailDevices(
    states: Record<string, ioBroker.State | null | undefined>,
    namespace: string,
): ThumbnailDevice[] {
    const map: Record<string, ThumbnailDevice & { hasThumbnail?: boolean }> = {};
    const prefix = `${namespace}.devices.`;
    for (const [stateId, s] of Object.entries(states)) {
        if (!stateId.startsWith(prefix)) {
            continue;
        }
        const segs = stateId.slice(prefix.length).split('.');
        if (segs.length !== 2) {
            continue;
        }
        const [deviceId, leaf] = segs;
        map[deviceId] = map[deviceId] ?? { id: deviceId };
        if (leaf === 'name') {
            map[deviceId].name = typeof s?.val === 'string' && s.val ? s.val : undefined;
        }
        if (leaf === 'model') {
            map[deviceId].model = typeof s?.val === 'string' && s.val ? s.val : undefined;
        }
        if (THUMBNAIL_STATES.has(leaf) && s?.val) {
            map[deviceId].hasThumbnail = true;
        }
    }
    return Object.values(map)
        .filter(d => d.hasThumbnail || (d.model !== undefined && THUMBNAIL_MODELS.has(d.model)))
        .map(({ id, name, model }) => ({ id, name, model }));
}

export type ThumbnailView = 'image' | 'load-error' | 'server-disabled' | 'none';

/**
 * What to show for the selected device.
 *
 * @param url value of `lastThumbnailUrl` - only set while the thumbnail server of the adapter is enabled
 * @param ts value of `lastThumbnailAt` - set with every thumbnail the controller reports
 * @param imgError the browser could not load `url`
 */
export function thumbnailView(url: string | null, ts: number | null, imgError: boolean): ThumbnailView {
    if (url) {
        return imgError ? 'load-error' : 'image';
    }
    return ts ? 'server-disabled' : 'none';
}

const PLACEHOLDER_TEXT: Record<Exclude<ThumbnailView, 'image'>, string> = {
    none: 'No event image received yet — thumbnails appear after a doorbell ring or door unlock.',
    'server-disabled':
        'An event image is available, but the thumbnail server is switched off — enable it in the adapter settings (HTTP server tab).',
    'load-error': 'The event image could not be loaded — check that the HTTP server of the adapter is reachable from this browser.',
};

export function LastThumbnailCard(): JSX.Element {
    const { settings } = useSettings();
    const states = useIobStates(`${ADAPTER_NAMESPACE}.devices.*`);

    const devices = useMemo(() => collectThumbnailDevices(states, ADAPTER_NAMESPACE), [states]);

    const [chosenId, setChosenId] = useState<string | null>(null);
    const [imgError, setImgError] = useState(false);

    // The chosen device can disappear (removed from the controller): fall back to the first one
    // instead of keeping a value the select does not offer.
    const selectedId = chosenId && devices.some(d => d.id === chosenId) ? chosenId : (devices[0]?.id ?? null);

    const urlState = useIobState(selectedId ? `devices.${selectedId}.lastThumbnailUrl` : null);
    const tsState = useIobState(selectedId ? `devices.${selectedId}.lastThumbnailAt` : null);
    const url = typeof urlState?.val === 'string' && /^https?:\/\//i.test(urlState.val) ? urlState.val : null;
    const ts = typeof tsState?.val === 'number' && tsState.val > 0 ? tsState.val : null;

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
                        No thumbnail-capable devices discovered (a reader with camera is required: UA Ultra, UA G3 Pro, UA G2 Pro or UA Intercom).
                    </Typography>
                </CardContent>
            </Card>
        );
    }

    const view = thumbnailView(url, ts, imgError);

    return (
        <Card variant="outlined">
            <CardContent>
                <Stack
                    direction="row"
                    sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 1 }}
                >
                    <Typography variant="h6">Last event image</Typography>
                    <Select
                        size="small"
                        value={selectedId ?? ''}
                        onChange={e => setChosenId(e.target.value || null)}
                        inputProps={{ 'aria-label': 'Device' }}
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
                {view === 'image' && url ? (
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
                        {PLACEHOLDER_TEXT[view === 'image' ? 'none' : view]}
                    </Typography>
                )}
            </CardContent>
        </Card>
    );
}
