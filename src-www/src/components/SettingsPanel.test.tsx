import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { JSX } from 'react';
import { SettingsPanel } from './SettingsPanel';
import { DEFAULTS, SettingsContext, useSettingsProvider, type AppSettings } from '../settings';
import { setIobState, setStates } from '../test/socketMock';

vi.mock('../socket', () => import('../test/socketMock'));

function Panel(): JSX.Element {
    const ctx = useSettingsProvider();
    return (
        <SettingsContext.Provider value={ctx}>
            <SettingsPanel />
        </SettingsContext.Provider>
    );
}

/** The settings each write of `admin.uiSettings` stored */
function stored(): AppSettings[] {
    return setIobState.mock.calls.map(([id, val]) => {
        expect(id).toBe('admin.uiSettings');
        return JSON.parse(val as string) as AppSettings;
    });
}

function open(): void {
    render(<Panel />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
}

beforeEach(() => {
    setIobState.mockClear();
    setIobState.mockImplementation(() => Promise.resolve());
    setStates({});
});

describe('SettingsPanel', () => {
    it.each([
        ['Show doorbell calls', 'showDoorbell'],
        ['Show last event image', 'showSnapshot'],
        ['Show door list', 'showDoorList'],
        ['Show event log', 'showEventLog'],
    ] as const)('"%s" switches %s and nothing else', (label, key) => {
        open();
        const toggle = screen.getByRole('switch', { name: label });
        expect(toggle).toHaveProperty('checked', true);

        fireEvent.click(toggle);

        expect(stored()).toEqual([{ ...DEFAULTS, [key]: false }]);
        expect(screen.getByRole('switch', { name: label })).toHaveProperty('checked', false);

        fireEvent.click(screen.getByRole('switch', { name: label }));
        expect(stored()[1]).toEqual(DEFAULTS);
    });

    it.each([
        ['Event thumbnail width', 'thumbWidth', 104, 'Event thumbnail width: 104 px'],
        ['Last event image height', 'snapshotHeight', 260, 'Last event image height: 260 px'],
        ['Max. width', 'maxWidth', 1250, 'Max. width: 1250 px'],
    ] as const)('the slider "%s" changes %s in its own steps', (label, key, value, text) => {
        open();

        fireEvent.keyDown(screen.getByRole('slider', { name: label }), { key: 'ArrowRight' });

        expect(stored()).toEqual([{ ...DEFAULTS, [key]: value }]);
        expect(screen.getByText(text)).toBeTruthy();
        expect(screen.getByRole('slider', { name: label })).toHaveProperty('value', String(value));
    });

    it.each([
        ['Event thumbnail width', 'thumbWidth', 0, 'Event thumbnail width: Off'],
        ['Last event image height', 'snapshotHeight', 0, 'Last event image height: Auto'],
        ['Max. width', 'maxWidth', 600, 'Max. width: 600 px'],
    ] as const)('the slider "%s" goes down to its minimum', (label, key, value, text) => {
        open();

        fireEvent.keyDown(screen.getByRole('slider', { name: label }), { key: 'Home' });

        expect(stored()).toEqual([{ ...DEFAULTS, [key]: value }]);
        expect(screen.getByText(text)).toBeTruthy();
    });

    it('starts from the stored settings', () => {
        setStates({ 'admin.uiSettings': JSON.stringify({ ...DEFAULTS, thumbWidth: 160, showEventLog: false }) });
        open();

        expect(screen.getByText('Event thumbnail width: 160 px')).toBeTruthy();
        expect(screen.getByRole('switch', { name: 'Show event log' })).toHaveProperty('checked', false);

        fireEvent.click(screen.getByRole('switch', { name: 'Show door list' }));
        // the change keeps the other stored values
        expect(stored()).toEqual([{ ...DEFAULTS, thumbWidth: 160, showEventLog: false, showDoorList: false }]);
    });
});
