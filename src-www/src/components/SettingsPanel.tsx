import { Box, Divider, Drawer, FormControlLabel, IconButton, Slider, Stack, Switch, Tooltip, Typography } from '@mui/material';
import SettingsIcon from '@mui/icons-material/Settings';
import { useState } from 'react';
import { useSettings } from '../settings';

export function SettingsPanel(): JSX.Element {
    const [open, setOpen] = useState(false);
    const { settings, update } = useSettings();

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
                        onChange={(_, v) => update({ thumbWidth: v as number })}
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
                        onChange={(_, v) => update({ snapshotHeight: v as number })}
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
                        onChange={(_, v) => update({ maxWidth: v as number })}
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
