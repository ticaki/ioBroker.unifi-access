/**
 * Stand-in for `src/socket.ts` in component tests: `vi.mock('../socket', () => import('../test/socketMock'))`.
 * The states live in memory and can be replaced with `setStates()` while a component is mounted.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { vi } from 'vitest';

export const ADAPTER_INSTANCE = 0;
export const ADAPTER_NAMESPACE = 'unifi-access.0';

let states: Record<string, ioBroker.State> = {};
const listeners = new Set<() => void>();

export function fullId(id: string): string {
    return id.startsWith(`${ADAPTER_NAMESPACE}.`) ? id : `${ADAPTER_NAMESPACE}.${id}`;
}

function makeState(val: ioBroker.StateValue, ts: number): ioBroker.State {
    return { val, ack: true, ts, lc: ts, from: 'system.adapter.unifi-access.0' };
}

/**
 * Replace all states of the adapter.
 *
 * @param values state id (with or without namespace) => value
 * @param options.ts time stamp of the states as ioBroker writes it (its own clock); default: `Date.now()`
 */
export function setStates(values: Record<string, ioBroker.StateValue>, options: { ts?: number } = {}): void {
    const ts = options.ts ?? Date.now();
    states = Object.fromEntries(Object.entries(values).map(([id, val]) => [fullId(id), makeState(val, ts)]));
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
    return id ? (all[fullId(id)] ?? null) : undefined;
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
