import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { DoorbellCallsCard } from './DoorbellCallsCard';
import { setStates } from '../test/socketMock';

vi.mock('../socket', () => import('../test/socketMock'));

const STARTED = 1_800_000_000_000;

beforeEach(() => {
    setStates({});
});

describe('DoorbellCallsCard', () => {
    it('shows a ringing doorbell with reader and start and clears it again', () => {
        setStates({
            'doorbell.activeCallId': 'call-1',
            'doorbell.activeFromDevice': 'Front door',
            'doorbell.activeStartedAt': STARTED,
        });
        render(<DoorbellCallsCard />);

        expect(screen.getByRole('alert').textContent).toBe(
            'Incoming doorbell call — answer it from the official UniFi Access app.',
        );
        expect(screen.getByText('Call: call-1')).toBeTruthy();
        expect(screen.getByText('from Front door')).toBeTruthy();
        expect(screen.getByText(`started: ${new Date(STARTED).toLocaleString()}`)).toBeTruthy();

        // the adapter writes null when the call ends
        act(() =>
            setStates({
                'doorbell.activeCallId': null,
                'doorbell.activeFromDevice': null,
                'doorbell.activeStartedAt': null,
            }),
        );
        expect(screen.getByText('No active doorbell call.')).toBeTruthy();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('shows no call before the states exist', () => {
        render(<DoorbellCallsCard />);

        expect(screen.getByText('No active doorbell call.')).toBeTruthy();
    });

    it('leaves out what is unknown or unusable', () => {
        setStates({
            'doorbell.activeCallId': 'call-2',
            'doorbell.activeFromDevice': '',
            'doorbell.activeStartedAt': 'not a date',
        });
        render(<DoorbellCallsCard />);

        expect(screen.getByText('Call: call-2')).toBeTruthy();
        expect(screen.queryByText(/^from /)).toBeNull();
        expect(screen.queryByText(/started/)).toBeNull();
        expect(screen.queryByText(/Invalid Date/)).toBeNull();
    });

    it.each([
        ['a number', 42],
        ['true', true],
        ['an empty text', ''],
    ])('treats a call id that is %s as no call', (_name, value) => {
        setStates({ 'doorbell.activeCallId': value, 'doorbell.activeStartedAt': STARTED });
        render(<DoorbellCallsCard />);

        expect(screen.getByText('No active doorbell call.')).toBeTruthy();
    });
});
