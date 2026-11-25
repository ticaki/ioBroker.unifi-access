import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

type Handler = (id: string, state: ioBroker.State | null | undefined) => void;

/** The parts of `Connection` of @iobroker/socket-client that the panel uses */
class FakeConnection {
    static last: FakeConnection | null = null;
    /** like the real class, the socket does not exist yet when the constructor returns */
    _socket: undefined;
    connectionHandlers: ((connected: boolean) => void)[] = [];
    subscriptions = new Map<string, Set<Handler>>();
    values: Record<string, ioBroker.StateValue> = {};
    failReads = false;
    getState = vi.fn((id: string) =>
        this.failReads ? Promise.reject(new Error('not connected')) : Promise.resolve(this.makeState(id)),
    );
    getStates = vi.fn((pattern: string) => {
        if (this.failReads) {
            return Promise.reject(new Error('not connected'));
        }
        const prefix = pattern.replace(/\*$/, '');
        return Promise.resolve(
            Object.fromEntries(
                Object.keys(this.values)
                    .filter(id => id.startsWith(prefix))
                    .map(id => [id, this.makeState(id)]),
            ),
        );
    });
    setState = vi.fn((_id: string, _val: ioBroker.StateValue) => Promise.resolve());
    subscribeState = vi.fn((id: string, handler: Handler) => {
        if (!this.subscriptions.has(id)) {
            this.subscriptions.set(id, new Set());
        }
        this.subscriptions.get(id)?.add(handler);
        return Promise.resolve();
    });
    unsubscribeState = vi.fn((id: string, handler: Handler) => {
        this.subscriptions.get(id)?.delete(handler);
    });

    constructor(readonly props: { onReady: () => void }) {
        FakeConnection.last = this;
    }

    registerConnectionHandler(handler: (connected: boolean) => void): void {
        this.connectionHandlers.push(handler);
    }

    makeState(id: string): ioBroker.State | null {
        return id in this.values ? { val: this.values[id], ack: true, ts: 1, lc: 1, from: '' } : null;
    }

    /** the web adapter reports a state change */
    emit(id: string, val: ioBroker.StateValue): void {
        this.values[id] = val;
        for (const [pattern, handlers] of this.subscriptions) {
            if (pattern === id || (pattern.endsWith('*') && id.startsWith(pattern.slice(0, -1)))) {
                handlers.forEach(h => h(id, this.makeState(id)));
            }
        }
    }

    setConnected(connected: boolean): void {
        this.connectionHandlers.forEach(h => h(connected));
    }

    activeSubscriptions(): number {
        let count = 0;
        this.subscriptions.forEach(handlers => (count += handlers.size));
        return count;
    }
}

vi.mock('@iobroker/socket-client', () => ({ Connection: FakeConnection }));

/** `socket.ts` keeps its connection in module variables, so every test loads a fresh copy */
async function loadSocket(search = ''): Promise<typeof import('./socket')> {
    vi.resetModules();
    window.history.replaceState({}, '', `/unifi-access/index.html${search}`);
    return import('./socket');
}

/** Mounts a hook, lets the connection become ready and returns the fake connection */
async function connect(): Promise<FakeConnection> {
    await waitFor(() => expect(FakeConnection.last).not.toBeNull());
    const conn = FakeConnection.last as FakeConnection;
    act(() => {
        conn.setConnected(true);
        conn.props.onReady();
    });
    return conn;
}

beforeEach(() => {
    FakeConnection.last = null;
    (globalThis as { io?: unknown }).io = {};
});

afterEach(() => {
    delete (globalThis as { io?: unknown }).io;
});

describe('instance selection', () => {
    it('reads the instance number from the URL', async () => {
        const { resolveInstance } = await loadSocket();

        expect(resolveInstance('')).toBe(0);
        expect(resolveInstance('?instance=2')).toBe(2);
        expect(resolveInstance('?foo=bar&instance=11')).toBe(11);
        expect(resolveInstance('?instance=')).toBe(0);
        expect(resolveInstance('?instance=abc')).toBe(0);
        expect(resolveInstance('?instance=-1')).toBe(0);
        expect(resolveInstance('?instance=1.5')).toBe(0);
    });

    it('uses instance 0 without a parameter', async () => {
        const socket = await loadSocket();

        expect(socket.ADAPTER_NAMESPACE).toBe('unifi-access.0');
        expect(socket.fullId('doors.d1.unlock')).toBe('unifi-access.0.doors.d1.unlock');
        expect(socket.fullId('unifi-access.0.doors.*')).toBe('unifi-access.0.doors.*');
        // ids of other objects are passed on unchanged — the event list reads the alive state (R2T-02)
        expect(socket.fullId('system.adapter.unifi-access.0.alive')).toBe('system.adapter.unifi-access.0.alive');
    });

    it('addresses the states of the instance given in the URL', async () => {
        const socket = await loadSocket('?instance=1');
        const { result } = renderHook(() => socket.useIobState('info.connection'));
        const conn = await connect();

        expect(socket.ADAPTER_NAMESPACE).toBe('unifi-access.1');
        await waitFor(() => expect(conn.getState).toHaveBeenCalledWith('unifi-access.1.info.connection'));
        await act(() => socket.setIobState('doors.d1.unlock', true));
        expect(conn.setState).toHaveBeenCalledWith('unifi-access.1.doors.d1.unlock', true);
        expect(result.current).toBeNull();
    });
});

describe('useConnectionStatus', () => {
    it('follows disconnects and reconnects of the socket', async () => {
        const socket = await loadSocket();
        const { result } = renderHook(() => {
            socket.useConnection();
            return socket.useConnectionStatus();
        });
        expect(result.current).toBe(false);

        const conn = await connect();
        expect(result.current).toBe(true);

        act(() => conn.setConnected(false));
        expect(result.current).toBe(false);

        act(() => conn.setConnected(true));
        expect(result.current).toBe(true);
    });
});

describe('useIobState', () => {
    it('reads the state, follows changes and unsubscribes on unmount', async () => {
        const socket = await loadSocket();
        const { result, unmount } = renderHook(() => socket.useIobState('info.connection'));
        expect(result.current).toBeUndefined();

        const conn = await connect();
        conn.values['unifi-access.0.info.connection'] = true;
        await waitFor(() => expect(conn.getState).toHaveBeenCalled());
        act(() => conn.emit('unifi-access.0.info.connection', true));
        expect(result.current?.val).toBe(true);

        act(() => conn.emit('unifi-access.0.info.connection', false));
        expect(result.current?.val).toBe(false);

        // a change of another state is none of our business
        act(() => conn.emit('unifi-access.0.info.protectConnected', true));
        expect(result.current?.val).toBe(false);

        unmount();
        expect(conn.activeSubscriptions()).toBe(0);
    });

    it('reports a missing state as null', async () => {
        const socket = await loadSocket();
        const { result } = renderHook(() => socket.useIobState('events.last'));
        await connect();

        await waitFor(() => expect(result.current).toBeNull());
    });

    it('does not hand out the value of the previously requested state', async () => {
        const socket = await loadSocket();
        const { result, rerender } = renderHook(({ id }: { id: string | null }) => socket.useIobState(id), {
            initialProps: { id: 'devices.a.lastThumbnailUrl' as string | null },
        });
        const conn = await connect();
        await waitFor(() => expect(conn.activeSubscriptions()).toBe(1));
        conn.values['unifi-access.0.devices.a.lastThumbnailUrl'] = 'http://192.0.2.5/a.jpg';
        act(() => conn.emit('unifi-access.0.devices.a.lastThumbnailUrl', 'http://192.0.2.5/a.jpg'));
        expect(result.current?.val).toBe('http://192.0.2.5/a.jpg');

        rerender({ id: 'devices.b.lastThumbnailUrl' });
        expect(result.current).toBeUndefined();
        await waitFor(() => expect(result.current).toBeNull());

        rerender({ id: null });
        expect(result.current).toBeUndefined();
    });

    it('reads the state again after a reconnect', async () => {
        const socket = await loadSocket();
        const { result } = renderHook(() => socket.useIobState('doors.d1.locked'));
        const conn = await connect();
        await waitFor(() => expect(conn.activeSubscriptions()).toBe(1));
        conn.values['unifi-access.0.doors.d1.locked'] = true;
        act(() => conn.emit('unifi-access.0.doors.d1.locked', true));
        expect(result.current?.val).toBe(true);

        act(() => conn.setConnected(false));
        // changed while the connection was down: nobody reports it
        conn.values['unifi-access.0.doors.d1.locked'] = false;
        act(() => conn.setConnected(true));

        await waitFor(() => expect(result.current?.val).toBe(false));
    });

    it('logs a failed read instead of leaving an unhandled rejection', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        const socket = await loadSocket();
        renderHook(() => {
            socket.useIobState('info.connection');
            socket.useIobStates('unifi-access.0.doors.*');
        });
        await waitFor(() => expect(FakeConnection.last).not.toBeNull());
        (FakeConnection.last as FakeConnection).failReads = true;
        await connect();

        await waitFor(() => expect(error).toHaveBeenCalledTimes(2));
        await new Promise(resolve => setTimeout(resolve, 0));
        process.off('unhandledRejection', unhandled);
        expect(unhandled).not.toHaveBeenCalled();
    });
});

describe('useIobStateArrival (R2F-01)', () => {
    const ID = 'unifi-access.0.events.last';

    it('the value read on subscribing is not live, a later change is; after a reconnect it is read again', async () => {
        const socket = await loadSocket();
        const { result } = renderHook(() => socket.useIobStateArrival('events.last'));
        await waitFor(() => expect(FakeConnection.last).not.toBeNull());
        const conn = FakeConnection.last as FakeConnection;
        conn.values[ID] = '[1]';
        await connect();
        await waitFor(() => expect(result.current.state?.val).toBe('[1]'));
        expect(result.current.live).toBe(false);

        // the real socket-client also answers the subscription with the current value: still the read one
        act(() => conn.emit(ID, '[1]'));
        expect(result.current.live).toBe(false);

        act(() => conn.emit(ID, '[2,1]'));
        expect(result.current).toMatchObject({ state: { val: '[2,1]' }, live: true });

        act(() => conn.setConnected(false));
        conn.values[ID] = '[3,2,1]';
        act(() => conn.setConnected(true));
        await waitFor(() => expect(result.current.state?.val).toBe('[3,2,1]'));
        expect(result.current.live).toBe(false);
    });

    it('a read that answers after a change does not replace the change', async () => {
        const socket = await loadSocket();
        let answerRead: (s: ioBroker.State | null) => void = () => undefined;
        const { result } = renderHook(() => socket.useIobStateArrival('events.last'));
        await waitFor(() => expect(FakeConnection.last).not.toBeNull());
        const conn = FakeConnection.last as FakeConnection;
        conn.getState.mockImplementationOnce(() => new Promise(resolve => (answerRead = resolve)));
        conn.values[ID] = '[1]';
        await connect();
        await waitFor(() => expect(conn.getState).toHaveBeenCalled());
        act(() => conn.emit(ID, '[1]'));
        act(() => conn.emit(ID, '[2,1]'));
        await act(async () => answerRead({ val: '[1]', ack: true, ts: 1, lc: 1, from: '' }));
        expect(result.current).toMatchObject({ state: { val: '[2,1]' }, live: true });
    });
});

describe('useIobStates', () => {
    it('collects the states of a pattern and follows changes and deletions', async () => {
        const socket = await loadSocket();
        const { result, unmount } = renderHook(() => socket.useIobStates('unifi-access.0.doors.*'));
        expect(result.current).toEqual({});

        await waitFor(() => expect(FakeConnection.last).not.toBeNull());
        const conn = FakeConnection.last as FakeConnection;
        conn.values['unifi-access.0.doors.d1.name'] = 'Front door';
        conn.values['unifi-access.0.info.connection'] = true;
        await connect();

        await waitFor(() => expect(Object.keys(result.current)).toEqual(['unifi-access.0.doors.d1.name']));

        act(() => conn.emit('unifi-access.0.doors.d1.locked', true));
        expect(result.current['unifi-access.0.doors.d1.locked'].val).toBe(true);

        act(() => {
            delete conn.values['unifi-access.0.doors.d1.locked'];
            conn.subscriptions.get('unifi-access.0.doors.*')?.forEach(h => h('unifi-access.0.doors.d1.locked', null));
        });
        expect(result.current['unifi-access.0.doors.d1.locked']).toBeUndefined();

        unmount();
        expect(conn.activeSubscriptions()).toBe(0);
    });

    it('reads the states again after a reconnect', async () => {
        const socket = await loadSocket();
        const { result } = renderHook(() => socket.useIobStates('doors.*'));
        await waitFor(() => expect(FakeConnection.last).not.toBeNull());
        const conn = FakeConnection.last as FakeConnection;
        conn.values['unifi-access.0.doors.d1.name'] = 'Front door';
        await connect();
        await waitFor(() => expect(Object.keys(result.current)).toEqual(['unifi-access.0.doors.d1.name']));
        expect(conn.getStates).toHaveBeenCalledTimes(1);

        act(() => conn.setConnected(false));
        // while the connection was down: a door was added and the name changed, nobody reports it
        conn.values['unifi-access.0.doors.d1.name'] = 'Main entrance';
        conn.values['unifi-access.0.doors.d2.name'] = 'Garage';
        act(() => conn.setConnected(true));

        await waitFor(() =>
            expect(Object.fromEntries(Object.entries(result.current).map(([id, s]) => [id, s.val]))).toEqual({
                'unifi-access.0.doors.d1.name': 'Main entrance',
                'unifi-access.0.doors.d2.name': 'Garage',
            }),
        );
        expect(conn.getStates).toHaveBeenCalledTimes(2);
        // the subscription of the old connection was removed, not doubled
        expect(conn.activeSubscriptions()).toBe(1);
    });
});

describe('loading socket.io.js', () => {
    type LoaderWindow = {
        registerSocketOnLoad?: (cb: () => void) => void;
        registerSocketLoadError?: (cb: (tried: string) => void) => void;
    };
    const w = window as unknown as LoaderWindow;

    afterEach(() => {
        delete w.registerSocketOnLoad;
        delete w.registerSocketLoadError;
    });

    it('waits for the loader of index.html before it connects', async () => {
        delete (globalThis as { io?: unknown }).io;
        let loaded: (() => void) | undefined;
        w.registerSocketOnLoad = cb => (loaded = cb);
        const socket = await loadSocket();
        renderHook(() => socket.useConnection());

        await waitFor(() => expect(loaded).toBeTypeOf('function'));
        expect(FakeConnection.last).toBeNull();

        (globalThis as { io?: unknown }).io = {};
        act(() => loaded?.());
        await waitFor(() => expect(FakeConnection.last).not.toBeNull());
    });

    it('reports the URLs index.html could not load the library from', async () => {
        delete (globalThis as { io?: unknown }).io;
        let failed: ((tried: string) => void) | undefined;
        w.registerSocketOnLoad = () => {};
        w.registerSocketLoadError = cb => (failed = cb);
        const socket = await loadSocket();
        const { result } = renderHook(() => socket.useSocketLoadError());
        expect(result.current).toBeNull();

        act(() => failed?.('http://192.0.2.5:8082/lib/js/socket.io.js'));

        expect(result.current).toBe('http://192.0.2.5:8082/lib/js/socket.io.js');
        expect(FakeConnection.last).toBeNull();
    });

    it('stays quiet with an index.html that has no error callback', async () => {
        const socket = await loadSocket();
        const { result } = renderHook(() => socket.useSocketLoadError());

        expect(result.current).toBeNull();
    });
});
