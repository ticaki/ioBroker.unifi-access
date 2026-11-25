import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { DEFAULTS, parseSettings, useSettingsProvider } from './settings';
import {
    deliverAll,
    deliverNext,
    holdDeliveries,
    pendingDeliveries,
    resetSocketMock,
    setAdapterRunning,
    setIobState,
    setStates,
    updateState,
} from './test/socketMock';

vi.mock('./socket', () => import('./test/socketMock'));

beforeEach(() => {
    resetSocketMock();
    setStates({});
});

describe('parseSettings', () => {
    it.each([undefined, null, '', 'not json', '42', '"text"', '[1,2]', 'null'])(
        'falls back to the defaults for %j',
        raw => {
            expect(parseSettings(raw)).toEqual(DEFAULTS);
        },
    );

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
    describe('a change before the stored settings were read (RF-03)', () => {
        const STORED = { ...DEFAULTS, thumbWidth: 160, maxWidth: 900, showSnapshot: false };

        it('is not written over the stored settings, but merged into them once they arrive', () => {
            setStates({}, { loading: ['admin.uiSettings'] });
            const { result } = renderHook(() => useSettingsProvider());

            act(() => result.current.update({ showDoorbell: false }));
            // shown at once, not written yet
            expect(result.current.settings.showDoorbell).toBe(false);
            expect(setIobState).not.toHaveBeenCalled();

            act(() => setStates({ 'admin.uiSettings': JSON.stringify(STORED) }));

            const expected = { ...STORED, showDoorbell: false };
            expect(result.current.settings).toEqual(expected);
            expect(setIobState).toHaveBeenCalledTimes(1);
            expect(setIobState).toHaveBeenCalledWith('admin.uiSettings', JSON.stringify(expected));
        });

        it('several changes are combined; a slider that is only dragged writes nothing', () => {
            setStates({}, { loading: ['admin.uiSettings'] });
            const { result } = renderHook(() => useSettingsProvider());
            act(() => {
                result.current.update({ maxWidth: 1300 }, false);
                result.current.update({ showEventLog: false });
            });
            act(() => setStates({ 'admin.uiSettings': JSON.stringify(STORED) }));
            expect(setIobState).toHaveBeenCalledWith(
                'admin.uiSettings',
                JSON.stringify({ ...STORED, maxWidth: 1300, showEventLog: false }),
            );

            setIobState.mockClear();
            setStates({}, { loading: ['admin.uiSettings'] });
            const second = renderHook(() => useSettingsProvider());
            act(() => second.result.current.update({ maxWidth: 1250 }, false));
            act(() => setStates({ 'admin.uiSettings': JSON.stringify(STORED) }));
            expect(second.result.current.settings.maxWidth).toBe(1250);
            expect(setIobState).not.toHaveBeenCalled();
        });

        it('no stored settings at all (state missing): the change is written on top of the defaults', () => {
            setStates({}, { loading: ['admin.uiSettings'] });
            const { result } = renderHook(() => useSettingsProvider());
            act(() => result.current.update({ thumbWidth: 0 }));
            act(() => setStates({}));
            expect(setIobState).toHaveBeenCalledWith(
                'admin.uiSettings',
                JSON.stringify({ ...DEFAULTS, thumbWidth: 0 }),
            );
        });
    });
});

describe('echoes and confirmations of the own writes (flicker: R2F, R3F-03)', () => {
    const ID = 'admin.uiSettings';
    const both = { showDoorList: false, showEventLog: false };

    /**
     * Deliver the changes on their way one by one; after each the screen must still show both changes.
     *
     * @param result the hook
     * @param result.current current value of the hook
     * @param result.current.settings what is shown
     * @param expected what the screen has to show throughout
     */
    function deliverOneByOne(result: { current: { settings: object } }, expected: object): string[] {
        const order: string[] = [];
        for (;;) {
            let delivered: ReturnType<typeof deliverNext>;
            act(() => {
                delivered = deliverNext();
            });
            if (!delivered!) {
                return order;
            }
            order.push(
                `${delivered.ack ? 'ack' : 'echo'} ${JSON.parse(String(delivered.val)).showEventLog === false ? 'Y' : 'X'}`,
            );
            expect(result.current.settings, order.join(', ')).toMatchObject(expected);
        }
    }

    it('order echo X, echo Y, ack X, ack Y: the confirmation of the first does not flip the second back', () => {
        setStates({ [ID]: JSON.stringify(DEFAULTS) });
        holdDeliveries();
        const { result } = renderHook(() => useSettingsProvider());
        act(() => result.current.update({ showDoorList: false }));
        act(() => result.current.update({ showEventLog: false }));
        expect(deliverOneByOne(result, both)).toEqual(['echo X', 'echo Y', 'ack X', 'ack Y']);
        expect(setIobState).toHaveBeenCalledTimes(2);
    });

    it('order echo X, ack X, echo Y, ack Y (Y written before the confirmation of X arrived)', () => {
        setStates({ [ID]: JSON.stringify(DEFAULTS) });
        holdDeliveries();
        const { result } = renderHook(() => useSettingsProvider());
        act(() => result.current.update({ showDoorList: false }));
        act(() => {
            deliverNext();
        });
        act(() => result.current.update({ showEventLog: false }));
        expect(deliverOneByOne(result, both)).toEqual(['ack X', 'echo Y', 'ack Y']);
        expect(setIobState).toHaveBeenCalledTimes(2);
    });

    it('stopped adapter (only echoes, no confirmations): both changes stay, a later change from elsewhere is taken over', () => {
        setStates({ [ID]: JSON.stringify(DEFAULTS) });
        setAdapterRunning(false);
        holdDeliveries();
        const { result } = renderHook(() => useSettingsProvider());
        act(() => result.current.update({ showDoorList: false }));
        act(() => result.current.update({ showEventLog: false }));
        expect(deliverOneByOne(result, both)).toEqual(['echo X', 'echo Y']);
        act(() => updateState(ID, JSON.stringify({ ...DEFAULTS, maxWidth: 900 }), Date.now(), { ack: false }));
        expect(result.current.settings).toEqual({ ...DEFAULTS, maxWidth: 900 });
    });

    it('a slider that is being dragged does not jump back when the echo or confirmation of an earlier change arrives', () => {
        setStates({ [ID]: JSON.stringify(DEFAULTS) });
        holdDeliveries();
        const { result } = renderHook(() => useSettingsProvider());
        act(() => result.current.update({ showDoorbell: false }));
        act(() => result.current.update({ thumbWidth: 150 }, false));
        act(() => deliverAll());
        expect(result.current.settings).toMatchObject({ showDoorbell: false, thumbWidth: 150 });
        act(() => result.current.update({ thumbWidth: 160 }));
        act(() => deliverAll());
        expect(result.current.settings).toMatchObject({ showDoorbell: false, thumbWidth: 160 });
        expect(setIobState).toHaveBeenCalledTimes(2);
    });

    it('a change from elsewhere is still taken over, also between the own deliveries', () => {
        setStates({ [ID]: JSON.stringify(DEFAULTS) });
        holdDeliveries();
        const { result } = renderHook(() => useSettingsProvider());
        act(() => updateState(ID, JSON.stringify({ ...DEFAULTS, maxWidth: 900 })));
        expect(result.current.settings.maxWidth).toBe(900);
        act(() => result.current.update({ showDoorList: false }));
        act(() => deliverAll());
        act(() => updateState(ID, JSON.stringify({ ...DEFAULTS, maxWidth: 700 })));
        expect(result.current.settings).toEqual({ ...DEFAULTS, maxWidth: 700 });
    });

    it('with deliveries right away (default) a change is stored once and stays', () => {
        setStates({ [ID]: JSON.stringify(DEFAULTS) });
        const { result } = renderHook(() => useSettingsProvider());
        act(() => result.current.update({ showDoorList: false }));
        act(() => result.current.update({ showEventLog: false }));
        expect(result.current.settings).toMatchObject(both);
        expect(setIobState).toHaveBeenCalledTimes(2);
        expect(pendingDeliveries()).toEqual([]);
    });
});
