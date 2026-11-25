import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { DEFAULTS, parseSettings, useSettingsProvider } from './settings';
import { setIobState, setStates } from './test/socketMock';

vi.mock('./socket', () => import('./test/socketMock'));

beforeEach(() => {
    setIobState.mockClear();
    setIobState.mockImplementation(() => Promise.resolve());
    setStates({});
});

describe('parseSettings', () => {
    it.each([undefined, null, '', 'not json', '42', '"text"', '[1,2]', 'null'])('falls back to the defaults for %j', raw => {
        expect(parseSettings(raw)).toEqual(DEFAULTS);
    });

    it('takes valid values and keeps the default for everything else', () => {
        const raw = JSON.stringify({
            showDoorList: false,
            showEventLog: 'no',
            maxWidth: 1600,
            snapshotHeight: '300',
            thumbWidth: 5000,
            unknownKey: true,
        });

        expect(parseSettings(raw)).toEqual({ ...DEFAULTS, showDoorList: false, maxWidth: 1600 });
    });

    it('accepts the limits of the sliders', () => {
        const raw = JSON.stringify({ maxWidth: 600, snapshotHeight: 0, thumbWidth: 200 });

        expect(parseSettings(raw)).toEqual({ ...DEFAULTS, maxWidth: 600, snapshotHeight: 0, thumbWidth: 200 });
    });
});

describe('useSettingsProvider', () => {
    it('starts with the defaults and takes over the stored settings', () => {
        const { result } = renderHook(() => useSettingsProvider());
        expect(result.current.settings).toEqual(DEFAULTS);

        act(() => setStates({ 'admin.uiSettings': JSON.stringify({ thumbWidth: 160, showDoorbell: false }) }));

        expect(result.current.settings).toEqual({ ...DEFAULTS, thumbWidth: 160, showDoorbell: false });
        expect(setIobState).not.toHaveBeenCalled();
    });

    it('survives a broken settings state', () => {
        setStates({ 'admin.uiSettings': '{"thumbWidth":' });
        const { result } = renderHook(() => useSettingsProvider());

        expect(result.current.settings).toEqual(DEFAULTS);
    });

    it('stores a change exactly once', () => {
        const { result } = renderHook(() => useSettingsProvider());

        act(() => result.current.update({ showEventLog: false }));

        expect(result.current.settings.showEventLog).toBe(false);
        expect(setIobState).toHaveBeenCalledTimes(1);
        expect(setIobState).toHaveBeenCalledWith(
            'admin.uiSettings',
            JSON.stringify({ ...DEFAULTS, showEventLog: false }),
        );
    });

    it('does not write the state while a slider is dragged, only when it is released', () => {
        const { result } = renderHook(() => useSettingsProvider());

        act(() => result.current.update({ maxWidth: 1250 }, false));
        act(() => result.current.update({ maxWidth: 1300 }, false));
        expect(result.current.settings.maxWidth).toBe(1300);
        expect(setIobState).not.toHaveBeenCalled();

        act(() => result.current.update({ maxWidth: 1350 }));
        expect(setIobState).toHaveBeenCalledTimes(1);
        expect(JSON.parse(setIobState.mock.calls[0][1] as string)).toEqual({ ...DEFAULTS, maxWidth: 1350 });
    });

    it('combines changes that follow each other immediately', () => {
        const { result } = renderHook(() => useSettingsProvider());

        act(() => {
            result.current.update({ showDoorList: false });
            result.current.update({ showSnapshot: false });
        });

        expect(JSON.parse(setIobState.mock.calls[1][1] as string)).toEqual({
            ...DEFAULTS,
            showDoorList: false,
            showSnapshot: false,
        });
    });

    it('keeps the change on screen if it cannot be stored', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        setIobState.mockImplementation(() => Promise.reject(new Error('permissionError')));
        const { result } = renderHook(() => useSettingsProvider());

        act(() => result.current.update({ showDoorbell: false }));

        await waitFor(() => expect(error).toHaveBeenCalled());
        expect(result.current.settings.showDoorbell).toBe(false);
    });
});
