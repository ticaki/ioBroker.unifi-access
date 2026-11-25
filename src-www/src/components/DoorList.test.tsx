import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { collectDoors, DoorList } from './DoorList';
import { describeLockRule } from './DoorCard';
import { setIobState, setStates } from '../test/socketMock';

vi.mock('../socket', () => import('../test/socketMock'));

const NS = 'unifi-access.0';

function state(val: ioBroker.StateValue): ioBroker.State {
    return { val, ack: true, ts: 1, lc: 1, from: '' };
}

/** States as the adapter creates them for two doors, see `ensureDoor()` and `applyBootstrap()` */
const BOOTSTRAP: Record<string, ioBroker.StateValue> = {
    'doors.door-b.name': 'Side entrance',
    'doors.door-b.fullName': 'Building - Side entrance',
    'doors.door-b.locked': true,
    'doors.door-b.position': 'close',
    'doors.door-b.isBindHub': true,
    'doors.door-b.unlock_duration': 0,
    'doors.door-b.lock_rule': 0,
    'doors.door-a.name': 'Front door',
    'doors.door-a.locked': false,
    'doors.door-a.position': 'open',
    'doors.emergency.lockdown': false,
    'doors.emergency.evacuation': false,
};

beforeEach(() => {
    setIobState.mockClear();
    setIobState.mockImplementation(() => Promise.resolve());
    setStates({});
});

describe('collectDoors', () => {
    it('does not treat the emergency channel as a door', () => {
        const states = Object.fromEntries(Object.entries(BOOTSTRAP).map(([id, val]) => [`${NS}.${id}`, state(val)]));

        const { doors, emergency } = collectDoors(states, NS);

        expect(doors).toEqual([
            { id: 'door-a', name: 'Front door', locked: false },
            { id: 'door-b', name: 'Side entrance', locked: true },
        ]);
        expect(emergency).toEqual({ lockdown: false, evacuation: false });
    });

    it('reports the emergency switches', () => {
        const { doors, emergency } = collectDoors(
            {
                [`${NS}.doors.emergency.lockdown`]: state(true),
                [`${NS}.doors.emergency.evacuation`]: state(null),
            },
            NS,
        );

        expect(doors).toEqual([]);
        expect(emergency).toEqual({ lockdown: true, evacuation: false });
    });

    it('ignores other namespaces, deeper ids and missing values', () => {
        const { doors } = collectDoors(
            {
                'unifi-access.1.doors.other.name': state('Other instance'),
                [`${NS}.doors.door-a.some.deeper`]: state(1),
                [`${NS}.doors.door-a.locked`]: null,
                [`${NS}.doors.door-c.locked`]: state('yes'),
            },
            NS,
        );

        expect(doors).toEqual([
            { id: 'door-a', locked: null },
            { id: 'door-c', locked: null },
        ]);
    });
});

describe('temporary lock rule of a door', () => {
    const END = new Date(2026, 10, 25, 14, 30).getTime();

    it('is read from lockRuleType / lockRuleEndsAt', () => {
        const { doors } = collectDoors(
            {
                [`${NS}.doors.door-a.lockRuleType`]: state('custom'),
                [`${NS}.doors.door-a.lockRuleEndsAt`]: state(END),
                [`${NS}.doors.door-b.lockRuleType`]: state(''),
                [`${NS}.doors.door-b.lockRuleEndsAt`]: state(null),
                [`${NS}.doors.door-c.lockRuleType`]: state(4),
                [`${NS}.doors.door-c.lockRuleEndsAt`]: state('soon'),
            },
            NS,
        );

        expect(doors).toEqual([
            { id: 'door-a', lockRuleType: 'custom', lockRuleEndsAt: END },
            { id: 'door-b', lockRuleType: undefined, lockRuleEndsAt: null },
            { id: 'door-c', lockRuleType: undefined, lockRuleEndsAt: null },
        ]);
    });

    it('is described for the rule types of the controller', () => {
        const until = ` until ${new Date(END).toLocaleString()}`;

        expect(describeLockRule('custom', END)).toBe(`Unlocked for a limited time${until}`);
        expect(describeLockRule('keep_unlock', null)).toBe('Kept unlocked');
        expect(describeLockRule('keep_lock', 0)).toBe('Kept locked');
        expect(describeLockRule('lock_early', END)).toBe(`Unlock schedule ended early${until}`);
    });

    it('is not mentioned while the door just follows its schedule or nothing is known', () => {
        expect(describeLockRule('schedule', END)).toBeNull();
        expect(describeLockRule('', null)).toBeNull();
        expect(describeLockRule(undefined, undefined)).toBeNull();
        expect(describeLockRule('toString', null)).toBeNull();
    });

    it('is shown on the card of the door only', () => {
        setStates({ ...BOOTSTRAP, 'doors.door-a.lockRuleType': 'keep_unlock', 'doors.door-b.lockRuleType': 'schedule' });
        render(<DoorList />);

        expect(screen.getAllByText('Kept unlocked')).toHaveLength(1);
        expect(screen.queryByText(/schedule/i)).toBeNull();
    });
});

describe('DoorList', () => {
    it('shows one card per door and none for "emergency"', () => {
        setStates(BOOTSTRAP);
        render(<DoorList />);

        expect(screen.getByText('Front door')).toBeTruthy();
        expect(screen.getByText('Side entrance')).toBeTruthy();
        expect(screen.queryByText('emergency')).toBeNull();
        expect(screen.getAllByRole('button', { name: 'Unlock' })).toHaveLength(2);
        expect(screen.getByText('locked')).toBeTruthy();
        expect(screen.getByText('unlocked')).toBeTruthy();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('shows no door at all if only the emergency states exist', () => {
        setStates({ 'doors.emergency.lockdown': false, 'doors.emergency.evacuation': false });
        render(<DoorList />);

        expect(screen.getByText('No doors discovered yet.')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Unlock' })).toBeNull();
    });

    it('announces an active lockdown or evacuation', () => {
        setStates({ ...BOOTSTRAP, 'doors.emergency.lockdown': true });
        render(<DoorList />);
        expect(screen.getByRole('alert').textContent).toBe('Lockdown active — all doors are forced locked.');

        act(() => setStates({ ...BOOTSTRAP, 'doors.emergency.evacuation': true }));
        expect(screen.getByRole('alert').textContent).toBe('Evacuation active — all doors are forced unlocked.');
    });

    it('writes the unlock state of the door', () => {
        setStates(BOOTSTRAP);
        render(<DoorList />);

        fireEvent.click(screen.getAllByRole('button', { name: 'Unlock' })[0]);

        expect(setIobState).toHaveBeenCalledTimes(1);
        expect(setIobState).toHaveBeenCalledWith('doors.door-a.unlock', true);
    });

    it('tells the user if the unlock command could not be sent', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        setIobState.mockImplementation(() => Promise.reject(new Error('permissionError')));
        setStates(BOOTSTRAP);
        render(<DoorList />);

        fireEvent.click(screen.getAllByRole('button', { name: 'Unlock' })[1]);

        await waitFor(() =>
            expect(screen.getByRole('alert').textContent).toBe('The unlock command could not be sent.'),
        );
        expect(error).toHaveBeenCalled();
    });
});
