import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { App } from './App';
import { useThemeMode } from './theme';
import { setIobState, setStates } from './test/socketMock';

vi.mock('./socket', () => import('./test/socketMock'));

type MediaListener = (e: { matches: boolean }) => void;

/** jsdom has no matchMedia; this one lets a test switch the system colour scheme */
function installMatchMedia(prefersDark: boolean): { setSystemDark: (dark: boolean) => void } {
    const listeners = new Set<MediaListener>();
    let matches = prefersDark;
    window.matchMedia = vi.fn(() => ({
        get matches() {
            return matches;
        },
        addEventListener: (_type: string, l: MediaListener) => listeners.add(l),
        removeEventListener: (_type: string, l: MediaListener) => listeners.delete(l),
    })) as unknown as typeof window.matchMedia;
    return {
        setSystemDark: dark => {
            matches = dark;
            listeners.forEach(l => l({ matches }));
        },
    };
}

beforeEach(() => {
    localStorage.clear();
    setIobState.mockClear();
    setStates({});
});

afterEach(() => {
    vi.useRealTimers();
});

describe('App', () => {
    it('renders the empty panel without errors', () => {
        const error = vi.spyOn(console, 'error');
        installMatchMedia(false);
        render(<App />);

        expect(screen.getByText('controller offline')).toBeTruthy();
        expect(screen.getByText('No active doorbell call.')).toBeTruthy();
        expect(screen.getByText(/No thumbnail-capable devices discovered/)).toBeTruthy();
        expect(screen.getByText('No doors discovered yet.')).toBeTruthy();
        expect(screen.getByText('No events yet.')).toBeTruthy();
        expect(error).not.toHaveBeenCalled();
    });

    it('renders the states of a running adapter without errors', () => {
        const error = vi.spyOn(console, 'error');
        installMatchMedia(true);
        setStates({
            'info.connection': true,
            'doorbell.activeCallId': 'call-1',
            'doorbell.activeFromDevice': 'Front door',
            'doorbell.activeStartedAt': 1_800_000_000_000,
            'doors.d1.name': 'Front door',
            'doors.d1.locked': true,
            'doors.emergency.lockdown': false,
            'doors.emergency.evacuation': false,
            'devices.aabbccddeeff.name': 'Front reader',
            'devices.aabbccddeeff.model': 'UA-Ultra',
            'events.last': JSON.stringify([{ ts: 1_800_000_000_000, type: 'access.remote_view', doorName: 'Front door' }]),
        });
        render(<App />);

        expect(screen.getByText('controller connected')).toBeTruthy();
        expect(screen.getByText('Call: call-1')).toBeTruthy();
        expect(screen.getByText('from Front door')).toBeTruthy();
        expect(screen.getAllByRole('button', { name: 'Unlock' })).toHaveLength(1);
        expect(screen.getByText('Doorbell ringing')).toBeTruthy();
        expect(error).not.toHaveBeenCalled();
    });

    it('hides the sections that are switched off in the stored settings', () => {
        installMatchMedia(false);
        setStates({ 'admin.uiSettings': JSON.stringify({ showDoorList: false, showEventLog: false }) });
        render(<App />);

        expect(screen.queryByText('Doors')).toBeNull();
        expect(screen.queryByText('Recent events')).toBeNull();
        expect(screen.getByText('Last event image')).toBeTruthy();
    });

    it('stores a switch of the settings panel', () => {
        installMatchMedia(false);
        render(<App />);

        fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
        fireEvent.click(screen.getByRole('switch', { name: 'Show door list' }));

        expect(screen.queryByText('No doors discovered yet.')).toBeNull();
        expect(setIobState).toHaveBeenCalledTimes(1);
        expect(JSON.parse(setIobState.mock.calls[0][1] as string)).toMatchObject({ showDoorList: false });
    });
});

describe('useThemeMode', () => {
    it('follows the system colour scheme until the user chooses a mode', () => {
        const media = installMatchMedia(false);
        const { result } = renderHook(() => useThemeMode());
        expect(result.current.mode).toBe('light');

        act(() => media.setSystemDark(true));
        expect(result.current.mode).toBe('dark');

        // explicit choice: light
        act(() => result.current.toggle());
        expect(result.current.mode).toBe('light');
        expect(localStorage.getItem('unifi-access-www-theme')).toBe('light');

        // the system switching again must not override it
        act(() => media.setSystemDark(false));
        act(() => media.setSystemDark(true));
        expect(result.current.mode).toBe('light');
    });

    it('starts with the stored mode', () => {
        installMatchMedia(true);
        localStorage.setItem('unifi-access-www-theme', 'light');

        const { result } = renderHook(() => useThemeMode());

        expect(result.current.mode).toBe('light');
    });
});
