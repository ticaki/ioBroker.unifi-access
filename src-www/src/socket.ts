import { Connection } from '@iobroker/socket-client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { qualifyStateId } from './stateId';

/**
 * Instance number the panel shows: `index.html?instance=1` selects `unifi-access.1`, default is 0.
 *
 * @param search query string of the page
 */
export function resolveInstance(search: string): number {
    const raw = new URLSearchParams(search).get('instance');
    return raw !== null && /^\d{1,4}$/.test(raw) ? Number(raw) : 0;
}

export const ADAPTER_INSTANCE = resolveInstance(globalThis.location?.search ?? '');
export const ADAPTER_NAMESPACE = `unifi-access.${ADAPTER_INSTANCE}`;

let connectionPromise: Promise<Connection> | null = null;
let cachedConnection: Connection | null = null;
const connectedListeners = new Set<() => void>();
let isConnected = false;

function notifyConnected(): void {
    for (const l of connectedListeners) {
        l();
    }
}

function setConnected(connected: boolean): void {
    if (isConnected !== connected) {
        isConnected = connected;
        notifyConnected();
    }
}

function logError(what: string): (err: unknown) => void {
    return err => {
        // eslint-disable-next-line no-console
        console.error(`${what}:`, err);
    };
}

interface SocketLoaderWindow {
    registerSocketOnLoad?: (cb: () => void) => void;
    /** set by index.html: calls back with the URLs it tried if socket.io.js could not be loaded */
    registerSocketLoadError?: (cb: (tried: string) => void) => void;
}

let socketLoadError: string | null = null;
const loadErrorListeners = new Set<() => void>();
let watchingLoadError = false;

function watchSocketLoadError(): void {
    if (watchingLoadError || typeof window === 'undefined') {
        return;
    }
    watchingLoadError = true;
    const w = window as unknown as SocketLoaderWindow;
    if (typeof w.registerSocketLoadError === 'function') {
        w.registerSocketLoadError(tried => {
            socketLoadError = tried || 'socket.io.js';
            for (const l of loadErrorListeners) {
                l();
            }
        });
    }
}

/** The URLs `index.html` tried in vain to load socket.io.js from, or null while nothing failed */
export function useSocketLoadError(): string | null {
    return useSyncExternalStore(
        listener => {
            loadErrorListeners.add(listener);
            watchSocketLoadError();
            return () => loadErrorListeners.delete(listener);
        },
        () => socketLoadError,
        () => null,
    );
}

function awaitSocketIo(): Promise<void> {
    watchSocketLoadError();
    if (typeof globalThis !== 'undefined' && (globalThis as any).io) {
        return Promise.resolve();
    }
    return new Promise(resolve => {
        const w = window as unknown as SocketLoaderWindow;
        if (typeof w.registerSocketOnLoad === 'function') {
            w.registerSocketOnLoad(resolve);
        } else {
            const t = setInterval(() => {
                if ((globalThis as any).io) {
                    clearInterval(t);
                    resolve();
                }
            }, 100);
        }
    });
}

export function getConnection(): Promise<Connection> {
    if (cachedConnection) {
        return Promise.resolve(cachedConnection);
    }
    if (connectionPromise) {
        return connectionPromise;
    }
    connectionPromise = awaitSocketIo().then(
        () =>
            new Promise<Connection>(resolve => {
                const conn = new Connection({
                    name: 'unifi-access.www',
                    onReady: () => {
                        cachedConnection = conn;
                        setConnected(true);
                        resolve(conn);
                    },
                    onError: logError('socket-client error'),
                });
                // The socket itself is created asynchronously by the Connection, so its events cannot be
                // bound here - the handler below is called on every disconnect and reconnect.
                conn.registerConnectionHandler(connected => setConnected(connected));
            }),
    );
    return connectionPromise;
}

export function useConnection(): Connection | null {
    const [conn, setConn] = useState<Connection | null>(cachedConnection);
    useEffect(() => {
        if (!conn) {
            void getConnection().then(setConn);
        }
    }, [conn]);
    return conn;
}

export function useConnectionStatus(): boolean {
    return useSyncExternalStore(
        listener => {
            connectedListeners.add(listener);
            return () => connectedListeners.delete(listener);
        },
        () => isConnected,
        () => false,
    );
}

export function fullId(id: string): string {
    return qualifyStateId(id, ADAPTER_NAMESPACE);
}

export function useIobState(id: string | null): ioBroker.State | null | undefined {
    const conn = useConnection();
    // Part of the effect dependencies: after a reconnect the value is read again, because changes that
    // happened while the connection was down are never reported.
    const connected = useConnectionStatus();
    const [entry, setEntry] = useState<{ id: string; state: ioBroker.State | null } | null>(null);
    useEffect(() => {
        if (!conn || !id || !connected) {
            return;
        }
        const sid = fullId(id);
        let active = true;
        const handler: ioBroker.StateChangeHandler = (changedId, s) => {
            if (changedId === sid && active) {
                setEntry({ id: sid, state: s ?? null });
            }
        };
        conn.subscribeState(sid, handler).catch(logError(`Cannot subscribe to ${sid}`));
        conn.getState(sid)
            .then(s => {
                if (active) {
                    setEntry({ id: sid, state: s ?? null });
                }
            })
            .catch(logError(`Cannot read ${sid}`));
        return () => {
            active = false;
            conn.unsubscribeState(sid, handler);
        };
    }, [conn, id, connected]);
    // Never hand out the value of the state that was requested before `id` changed
    return id && entry && entry.id === fullId(id) ? entry.state : undefined;
}

export function useIobStates(pattern: string | null): Record<string, ioBroker.State> {
    const conn = useConnection();
    const connected = useConnectionStatus();
    const [states, setStates] = useState<Record<string, ioBroker.State>>({});
    useEffect(() => {
        if (!conn || !pattern || !connected) {
            return;
        }
        const fullPattern = fullId(pattern);
        let active = true;
        const handler: ioBroker.StateChangeHandler = (id, state) => {
            if (!active) {
                return;
            }
            setStates(prev => {
                const next = { ...prev };
                if (state) {
                    next[id] = state;
                } else {
                    delete next[id];
                }
                return next;
            });
        };
        conn.subscribeState(fullPattern, handler).catch(logError(`Cannot subscribe to ${fullPattern}`));
        conn.getStates(fullPattern)
            .then(initial => {
                if (active) {
                    setStates(initial || {});
                }
            })
            .catch(logError(`Cannot read ${fullPattern}`));
        return () => {
            active = false;
            conn.unsubscribeState(fullPattern, handler);
        };
    }, [conn, pattern, connected]);
    return states;
}

export async function setIobState(id: string, val: ioBroker.StateValue): Promise<void> {
    const conn = await getConnection();
    await conn.setState(fullId(id), val);
}

export async function getAdapterConfig(): Promise<Record<string, unknown> | null> {
    const conn = await getConnection();
    const obj = await conn.getObject(`system.adapter.${ADAPTER_NAMESPACE}`);
    return (obj?.native as Record<string, unknown>) ?? null;
}
