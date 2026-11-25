/**
 * Stand-in for `src/socket.ts` in component tests: `vi.mock('../socket', () => import('../test/socketMock'))`.
 * The states live in memory and can be replaced with `setStates()` while a component is mounted.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { vi } from 'vitest';

export const ADAPTER_INSTANCE = 0;
export const ADAPTER_NAMESPACE = 'unifi-access.0';

let states: Record<string, ioBroker.State> = {};
/** ids whose value has not been read yet (useIobState answers undefined, like before the first getState) */
let loading = new Set<string>();
const listeners = new Set<() => void>();

export function fullId(id: string): string {
    // ids of other objects (system.adapter.<instance>.alive) are passed on as they are
    return id.startsWith(`${ADAPTER_NAMESPACE}.`) || id.startsWith('system.') ? id : `${ADAPTER_NAMESPACE}.${id}`;
}

function makeState(val: ioBroker.StateValue, ts: number): ioBroker.State {
    return { val, ack: true, ts, lc: ts, from: 'system.adapter.unifi-access.0' };
}

/**
 * Replace all states of the adapter.
 *
 * @param values state id (with or without namespace) => value
 * @param options.ts time stamp of the states as ioBroker writes it (its own clock); default: `Date.now()`
 * @param options.perId further states with their own time stamp, e.g. `system.adapter.unifi-access.0.alive`
 * @param options.loading ids that are still being read: their value is `undefined` until the next setStates
 */
export function setStates(
    values: Record<string, ioBroker.StateValue>,
    options: {
        ts?: number;
        perId?: Record<string, { val: ioBroker.StateValue; ts: number }>;
        loading?: string[];
    } = {},
): void {
    const ts = options.ts ?? Date.now();
    loading = new Set((options.loading ?? []).map(fullId));
    states = Object.fromEntries(Object.entries(values).map(([id, val]) => [fullId(id), makeState(val, ts)]));
    for (const [id, state] of Object.entries(options.perId ?? {})) {
        states[fullId(id)] = makeState(state.val, state.ts);
    }
    notify();
}

/**
 * Change one state and leave all others as they are (same objects, as a real state change does).
 *
 * @param id state id (with or without namespace)
 * @param val new value
 * @param ts time stamp as ioBroker writes it; default: `Date.now()`
 */
export function updateState(id: string, val: ioBroker.StateValue, ts = Date.now()): void {
    loading.delete(fullId(id));
    states = { ...states, [fullId(id)]: makeState(val, ts) };
    notify();
}

function notify(): void {
    for (const listener of listeners) {
        listener();
    }
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function useAllStates(): Record<string, ioBroker.State> {
    return useSyncExternalStore(subscribe, () => states);
}

export function useIobState(id: string | null): ioBroker.State | null | undefined {
    const all = useAllStates();
    if (!id || loading.has(fullId(id))) {
        return undefined;
    }
    return all[fullId(id)] ?? null;
}

export function useIobStates(pattern: string | null): Record<string, ioBroker.State> {
    const all = useAllStates();
    return useMemo(() => {
        if (!pattern) {
            return {};
        }
        const prefix = fullId(pattern).replace(/\*$/, '');
        return Object.fromEntries(Object.entries(all).filter(([id]) => id.startsWith(prefix)));
    }, [all, pattern]);
}

export const setIobState = vi.fn<(id: string, val: ioBroker.StateValue) => Promise<void>>(() => Promise.resolve());

export function useConnectionStatus(): boolean {
    return true;
}

let socketLoadError: string | null = null;

/**
 * Pretend that index.html could not load socket.io.js
 *
 * @param tried URLs it tried, null for "loaded"
 */
export function setSocketLoadError(tried: string | null): void {
    socketLoadError = tried;
    for (const listener of listeners) {
        listener();
    }
}

export function useSocketLoadError(): string | null {
    return useSyncExternalStore(subscribe, () => socketLoadError);
}
