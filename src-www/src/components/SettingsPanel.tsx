import { Box, Divider, Drawer, FormControlLabel, IconButton, Slider, Stack, Switch, Tooltip, Typography } from '@mui/material';
import SettingsIcon from '@mui/icons-material/Settings';
import { type JSX, useEffect, useState } from 'react';
import { useSettings } from '../settings';

/**
 * Rendered inside the drawer: its content (with the sliders) is unmounted when the drawer has closed. A
 * slider that is still being dragged then never sends onChangeCommitted - its value is stored here.
 *
 * @param props.onUnmount what to run when the drawer content goes away
 */
function EndDragOnUnmount({ onUnmount }: { onUnmount: () => void }): null {
    useEffect(() => onUnmount, [onUnmount]);
    return null;
}

export function SettingsPanel(): JSX.Element {
    const [open, setOpen] = useState(false);
    const { settings, update, endDrag } = useSettings();

    return (
        <>
            <Tooltip title="Settings">
                <IconButton
                    size="small"
                    onClick={() => setOpen(true)}
                >
                    <SettingsIcon />
                </IconButton>
            </Tooltip>
            <Drawer
                anchor="right"
                open={open}
                onClose={() => setOpen(false)}
            >
                <Box sx={{ width: 300, p: 3 }}>
                    <EndDragOnUnmount onUnmount={endDrag} />
                    <Typography
                        variant="h6"
                        sx={{ mb: 3 }}
                    >
                        UI Settings
                    </Typography>

                    <Typography
                        variant="body2"
                        sx={{ mb: 1 }}
                    >
                        Event thumbnail width:{' '}
                        {settings.thumbWidth === 0 ? 'Off' : `${settings.thumbWidth} px`}
                    </Typography>
                    <Slider
                        min={0}
                        max={200}
                        step={8}
                        value={settings.thumbWidth}
                        aria-label="Event thumbnail width"
                        onChange={(_, v) => update({ thumbWidth: v as number }, false)}
                        onChangeCommitted={(_, v) => update({ thumbWidth: v as number })}
                        marks={[
                            { value: 0, label: 'Off' },
                            { value: 96, label: '96' },
                            { value: 200, label: '200' },
                        ]}
                        sx={{ mb: 3 }}
                    />

                    <Typography
                        variant="body2"
                        sx={{ mb: 1 }}
                    >
                        Last event image height:{' '}
                        {settings.snapshotHeight === 0 ? 'Auto' : `${settings.snapshotHeight} px`}
                    </Typography>
                    <Slider
                        min={0}
                        max={600}
                        step={20}
                        value={settings.snapshotHeight}
                        aria-label="Last event image height"
                        onChange={(_, v) => update({ snapshotHeight: v as number }, false)}
                        onChangeCommitted={(_, v) => update({ snapshotHeight: v as number })}
                        marks={[
                            { value: 0, label: 'Auto' },
                            { value: 240, label: '240' },
                            { value: 600, label: '600' },
                        ]}
                        sx={{ mb: 3 }}
                    />

                    <Typography
                        variant="body2"
                        sx={{ mb: 1 }}
                    >
                        Max. width: {settings.maxWidth} px
                    </Typography>
                    <Slider
                        min={600}
                        max={2000}
                        step={50}
                        value={settings.maxWidth}
                        aria-label="Max. width"
                        onChange={(_, v) => update({ maxWidth: v as number }, false)}
                        onChangeCommitted={(_, v) => update({ maxWidth: v as number })}
                        marks={[
                            { value: 600, label: '600' },
                            { value: 1200, label: '1200' },
                            { value: 2000, label: '2000' },
                        ]}
                        sx={{ mb: 3 }}
                    />

                    <Divider sx={{ mb: 2 }} />

                    <Stack spacing={0.5}>
                        <FormControlLabel
                            control={
                                <Switch
                                    checked={settings.showDoorbell}
                                    onChange={e => update({ showDoorbell: e.target.checked })}
                                />
                            }
                            label="Show doorbell calls"
                        />
                        <FormControlLabel
                            control={
                                <Switch
                                    checked={settings.showSnapshot}
                                    onChange={e => update({ showSnapshot: e.target.checked })}
                                />
                            }
                            label="Show last event image"
                        />
                        <FormControlLabel
                            control={
                                <Switch
                                    checked={settings.showDoorList}
                                    onChange={e => update({ showDoorList: e.target.checked })}
                                />
                            }
                            label="Show door list"
                        />
                        <FormControlLabel
                            control={
                                <Switch
                                    checked={settings.showEventLog}
                                    onChange={e => update({ showEventLog: e.target.checked })}
                                />
                            }
                            label="Show event log"
                        />
                    </Stack>
                </Box>
            </Drawer>
        </>
    );
}
