import { AppBar, Box, CssBaseline, Divider, IconButton, Stack, ThemeProvider, Toolbar, Tooltip } from '@mui/material';
import LightModeIcon from '@mui/icons-material/LightMode';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import { useThemeMode } from './theme';
import { ControllerStatusBadge } from './components/ControllerStatusBadge';
import { DoorList } from './components/DoorList';
import { LastThumbnailCard } from './components/LastThumbnailCard';
import { DoorbellCallsCard } from './components/DoorbellCallsCard';
import { EventLogCard } from './components/EventLogCard';
import { SettingsPanel } from './components/SettingsPanel';
import { SettingsContext, useSettings, useSettingsProvider } from './settings';

function AppInner(): JSX.Element {
    const { mode, toggle, theme } = useThemeMode();
    const { settings } = useSettings();

    return (
        <ThemeProvider theme={theme}>
            <CssBaseline />
            <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
                <AppBar
                    position="sticky"
                    elevation={0}
                    color="default"
                >
                    <Toolbar
                        variant="dense"
                        sx={{ gap: 2 }}
                    >
                        <Box
                            component="img"
                            src="./unifi-access.png"
                            alt=""
                            sx={{ height: 24 }}
                            onError={e => {
                                (e.currentTarget as HTMLImageElement).style.display = 'none';
                            }}
                        />
                        <Box sx={{ flex: 1 }} />
                        <ControllerStatusBadge />
                        <Tooltip title={mode === 'dark' ? 'Light mode' : 'Dark mode'}>
                            <IconButton
                                size="small"
                                onClick={toggle}
                            >
                                {mode === 'dark' ? <LightModeIcon /> : <DarkModeIcon />}
                            </IconButton>
                        </Tooltip>
                        <SettingsPanel />
                    </Toolbar>
                </AppBar>
                <Box sx={{ maxWidth: settings.maxWidth, mx: 'auto', p: 2 }}>
                    <Stack spacing={2}>
                        {settings.showDoorbell && <DoorbellCallsCard />}
                        {settings.showSnapshot && <LastThumbnailCard />}
                        {settings.showDoorList && <Divider />}
                        {settings.showDoorList && <DoorList />}
                        {settings.showEventLog && <Divider />}
                        {settings.showEventLog && <EventLogCard />}
                    </Stack>
                </Box>
            </Box>
        </ThemeProvider>
    );
}

export function App(): JSX.Element {
    const ctx = useSettingsProvider();
    return (
        <SettingsContext.Provider value={ctx}>
            <AppInner />
        </SettingsContext.Provider>
    );
}
