import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { EventLogCard, parseEvents } from './EventLogCard';
import { setStates } from '../test/socketMock';

vi.mock('../socket', () => import('../test/socketMock'));

const NOW = 1_800_000_000_000;
const SNAPSHOT = 'http://192.0.2.5:8095/unifi-access/0/protect-snapshot/cam1/1799999990000.jpg';
const VIDEO = 'http://192.0.2.5:8095/unifi-access/0/protect-video/evt1.mp4';

/** The 250 ms tickers the card started and whether each of them was stopped again */
function tickers(): { started: number; running: number } {
    const set = vi.mocked(setInterval);
    const cleared = new Set(vi.mocked(clearInterval).mock.calls.map(call => call[0]));
    const ids = set.mock.results.filter((_result, i) => set.mock.calls[i][1] === 250).map(result => result.value);
    return { started: ids.length, running: ids.filter(id => !cleared.has(id)).length };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(globalThis, 'setInterval');
    vi.spyOn(globalThis, 'clearInterval');
    setStates({});
});

afterEach(() => {
    vi.useRealTimers();
});

describe('parseEvents', () => {
    it.each([
        ['undefined', undefined],
        ['null', null],
        ['an empty string', ''],
        ['a number', 42],
        ['truncated JSON', '[{"ts":1,"type":"access.door.unl'],
        ['a JSON object', '{"ts":1,"type":"access.door.unlock"}'],
        ['a JSON string', '"events"'],
        ['JSON null', 'null'],
    ])('returns no events for %s', (_name, raw) => {
        expect(parseEvents(raw)).toEqual([]);
    });

    it('skips entries that are no events and drops fields of the wrong type', () => {
        const raw = JSON.stringify([
            null,
            'text',
            7,
            [],
            { type: 'access.door.unlock' },
            { ts: '123', type: 'access.door.unlock' },
            { ts: 5, type: '' },
            { ts: 10, type: 'access.door.unlock', doorName: { nested: true }, userName: 'Tim', subtype: 3 },
        ]);

        expect(parseEvents(raw)).toEqual([
            {
                ts: 10,
                type: 'access.door.unlock',
                subtype: undefined,
                deviceName: undefined,
                doorName: undefined,
                userName: 'Tim',
                protectSnapshotUrl: undefined,
                protectVideoUrl: undefined,
                protectCameraId: undefined,
            },
        ]);
    });

    it('only keeps absolute http(s) media URLs', () => {
        const [relative, script, ok] = parseEvents(
            JSON.stringify([
                { ts: 1, type: 'x', protectSnapshotUrl: '/unifi-access/0/protect-snapshot/cam/1.jpg' },
                { ts: 2, type: 'x', protectSnapshotUrl: 'javascript:alert(1)', protectVideoUrl: 'data:text/html,x' },
                { ts: 3, type: 'x', protectSnapshotUrl: SNAPSHOT, protectVideoUrl: VIDEO },
            ]),
        );

        expect(relative.protectSnapshotUrl).toBeUndefined();
        expect(script.protectSnapshotUrl).toBeUndefined();
        expect(script.protectVideoUrl).toBeUndefined();
        expect(ok.protectSnapshotUrl).toBe(SNAPSHOT);
        expect(ok.protectVideoUrl).toBe(VIDEO);
    });

    it('limits the list to 50 events', () => {
        const raw = JSON.stringify(Array.from({ length: 80 }, (_v, i) => ({ ts: i + 1, type: 'x' })));

        const events = parseEvents(raw);

        expect(events).toHaveLength(50);
        expect(events[49].ts).toBe(50);
    });
});

describe('EventLogCard', () => {
    it.each([
        ['no state', {}],
        ['an empty value', { 'events.last': '' }],
        ['broken JSON', { 'events.last': '[{"ts":1,' }],
        ['a list without usable events', { 'events.last': '[null, 1, {"foo":"bar"}]' }],
    ])('shows the empty text for %s', (_name, states) => {
        setStates(states);
        render(<EventLogCard />);

        expect(screen.getByText('No events yet.')).toBeTruthy();
    });

    it('lists events with label, subtype and context and escapes their content', () => {
        setStates({
            'events.last': JSON.stringify([
                { ts: NOW - 60_000, type: 'access.device.dps_status', subtype: 'open', doorName: 'Front door' },
                { ts: NOW - 120_000, type: 'access.remote_view.change', subtype: 'timeout' },
                { ts: NOW - 180_000, type: 'constructor', subtype: 'toString', userName: '<img src=x onerror=alert(1)>' },
            ]),
        });
        const { container } = render(<EventLogCard />);

        expect(screen.getByText('Door sensor')).toBeTruthy();
        expect(screen.getByText('— open')).toBeTruthy();
        expect(screen.getByText('@ Front door')).toBeTruthy();
        expect(screen.getByText('Doorbell call ended')).toBeTruthy();
        expect(screen.getByText('(timeout)')).toBeTruthy();
        // unknown type and subtype are shown as they are, also if they are names of Object.prototype
        expect(screen.getByText('constructor')).toBeTruthy();
        expect(screen.getByText('toString')).toBeTruthy();
        expect(screen.getByText('@ <img src=x onerror=alert(1)>')).toBeTruthy();
        expect(container.querySelector('img')).toBeNull();
    });

    it('shows no snapshot placeholder while UniFi Protect is not connected', () => {
        setStates({ 'events.last': JSON.stringify([{ ts: NOW - 500, type: 'access.door.unlock' }]) });
        render(<EventLogCard />);
        act(() => {
            vi.advanceTimersByTime(5000);
        });

        expect(screen.getByText('Door unlocked')).toBeTruthy();
        expect(screen.queryByText('Not available')).toBeNull();
        expect(screen.queryByText(/^[123]$/)).toBeNull();
        expect(tickers().started).toBe(0);
    });

    it('counts down while the snapshot is awaited, then gives up and stops ticking', () => {
        setStates({
            'info.protectConnected': true,
            'events.last': JSON.stringify([{ ts: NOW - 1000, type: 'access.door.unlock', doorName: 'Front door' }]),
        });
        render(<EventLogCard />);

        expect(screen.getByText('2')).toBeTruthy();
        expect(tickers()).toEqual({ started: 1, running: 1 });

        act(() => {
            vi.advanceTimersByTime(1000);
        });
        expect(screen.getByText('1')).toBeTruthy();

        act(() => {
            vi.advanceTimersByTime(2500);
        });
        expect(screen.getByText('Not available')).toBeTruthy();
        // the 250 ms interval must not keep re-rendering the list forever
        expect(tickers()).toEqual({ started: 1, running: 0 });
    });

    it('shows "Not available" right away for an old event without snapshot', () => {
        setStates({
            'info.protectConnected': true,
            'events.last': JSON.stringify([{ ts: NOW - 3_600_000, type: 'access.temporary_unlock.start' }]),
        });
        render(<EventLogCard />);

        expect(screen.getByText('Not available')).toBeTruthy();
        expect(tickers().started).toBe(0);
    });

    it('counts down normally on a browser whose clock is minutes behind', () => {
        // wall tablet 5 minutes late; ioBroker wrote the list at NOW, the event happened 1 s before
        vi.setSystemTime(NOW - 300_000);
        setStates(
            {
                'info.protectConnected': true,
                'events.last': JSON.stringify([{ ts: NOW - 1000, type: 'access.door.unlock' }]),
            },
            { ts: NOW },
        );
        render(<EventLogCard />);
        expect(screen.getByText('2')).toBeTruthy();

        act(() => {
            vi.advanceTimersByTime(3500);
        });
        expect(screen.getByText('Not available')).toBeTruthy();
        expect(screen.queryByText(/^[123]$/)).toBeNull();
        expect(tickers()).toEqual({ started: 1, running: 0 });
    });

    it('counts down normally on a browser whose clock is ahead', () => {
        vi.setSystemTime(NOW + 3_600_000);
        setStates(
            {
                'info.protectConnected': true,
                'events.last': JSON.stringify([{ ts: NOW - 1000, type: 'access.door.unlock' }]),
            },
            { ts: NOW },
        );
        render(<EventLogCard />);

        expect(screen.getByText('2')).toBeTruthy();
        expect(screen.queryByText('Not available')).toBeNull();
    });

    it('ends the waiting window of an event "from the future" 4 s after it arrived', () => {
        // controller clock one minute ahead of ioBroker
        setStates({
            'info.protectConnected': true,
            'events.last': JSON.stringify([{ ts: NOW + 60_000, type: 'access.door.unlock' }]),
        });
        render(<EventLogCard />);
        expect(screen.getByText('3')).toBeTruthy();

        act(() => {
            vi.advanceTimersByTime(4000);
        });
        expect(screen.getByText('Not available')).toBeTruthy();
        expect(tickers()).toEqual({ started: 1, running: 0 });
    });

    it('keeps the window of an event when the list is written again (new event) instead of restarting it', () => {
        const first = { ts: NOW - 1000, type: 'access.door.unlock', doorName: 'Front door' };
        setStates({ 'info.protectConnected': true, 'events.last': JSON.stringify([first]) });
        render(<EventLogCard />);
        expect(screen.getByText('2')).toBeTruthy();

        act(() => {
            vi.advanceTimersByTime(2000);
            // ioBroker writes the list again 2 s later with a newer event in front
            setStates({
                'info.protectConnected': true,
                'events.last': JSON.stringify([{ ts: NOW + 2000, type: 'access.device.dps_status' }, first]),
            });
        });
        act(() => {
            vi.advanceTimersByTime(1100);
        });
        expect(screen.getByText('Not available')).toBeTruthy();
        expect(tickers().running).toBe(0);
    });

    it('stops ticking when it is unmounted during the countdown', () => {
        setStates({
            'info.protectConnected': true,
            'events.last': JSON.stringify([{ ts: NOW - 500, type: 'access.door.unlock' }]),
        });
        const { unmount } = render(<EventLogCard />);
        expect(tickers()).toEqual({ started: 1, running: 1 });

        unmount();
        expect(tickers()).toEqual({ started: 1, running: 0 });
    });

    it('shows the snapshot, replaces the placeholder when it arrives and opens the media dialog', () => {
        const event = { ts: NOW - 1000, type: 'access.door.unlock', doorName: 'Front door' };
        setStates({ 'info.protectConnected': true, 'events.last': JSON.stringify([event]) });
        render(<EventLogCard />);
        expect(screen.getByText('2')).toBeTruthy();

        act(() => {
            setStates({
                'info.protectConnected': true,
                'events.last': JSON.stringify([{ ...event, protectSnapshotUrl: SNAPSHOT, protectVideoUrl: VIDEO }]),
            });
        });
        const thumb = screen.getByAltText('camera');
        expect(thumb.getAttribute('src')).toBe(SNAPSHOT);
        expect(screen.queryByText('2')).toBeNull();

        fireEvent.click(thumb);
        const video = document.querySelector('video');
        expect(video?.getAttribute('src')).toBe(VIDEO);

        // no clip for this event: fall back to the snapshot
        fireEvent.error(video as HTMLVideoElement);
        expect(document.querySelector('video')).toBeNull();
        expect(screen.getByRole('dialog').querySelector('img')?.getAttribute('src')).toBe(SNAPSHOT);
    });

    it('shows "Not available" if the snapshot cannot be loaded', () => {
        setStates({
            'events.last': JSON.stringify([{ ts: NOW - 60_000, type: 'access.door.unlock', protectSnapshotUrl: SNAPSHOT }]),
        });
        render(<EventLogCard />);

        fireEvent.error(screen.getByAltText('camera'));

        expect(screen.queryByAltText('camera')).toBeNull();
        expect(screen.getByText('Not available')).toBeTruthy();
    });
});
