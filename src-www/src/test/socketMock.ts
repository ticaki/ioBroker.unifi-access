/**
 * Stand-in for `src/socket.ts` in component tests: `vi.mock('../socket', () => import('../test/socketMock'))`.
 * The states live in memory and can be replaced with `setStates()` while a component is mounted.
 *
 * Like the real socket, `useIobStateArrival` reports the value a component finds when it mounts as read
 * (`live: false`) and every later change as live. `{ read: true }` delivers a value as read again, as
 * after a reconnect.
 *
 * A write of the panel (`setIobState`) comes back the way ioBroker and the adapter answer it: first the
 * echo of the write itself (`ack: false`), then - for the states the adapter confirms - the adapter's
 * confirmation (`ack: true`, see `adapterReply`). By default both are delivered right away, one after
 * the other. `holdDeliveries()` keeps them in a queue instead, so a test can let them arrive in any
 * order the real system allows (`deliverNext()`, `deliverAll()`); `setAdapterRunning(false)` leaves
 * the confirmations out (stopped adapter).
 */
import { useMemo, useRef, useSyncExternalStore } from 'react';
import type { IobStateArrival } from '../socket';
import { vi } from 'vitest';
import { qualifyStateId } from '../stateId';

export const ADAPTER_INSTANCE = 0;
export const ADAPTER_NAMESPACE = 'unifi-access.0';

let states: Record<string, ioBroker.State> = {};
/** ids whose value has not been read yet (useIobState answers undefined, like before the first getState) */
let loading = new Set<string>();
/** ids whose current value was delivered as read (reconnect), see `{ read: true }` */
let readIds = new Set<string>();
const listeners = new Set<() => void>();

export function fullId(id: string): string {
    return qualifyStateId(id, ADAPTER_NAMESPACE);
}

function makeState(val: ioBroker.StateValue, ts: number, ack = true): ioBroker.State {
    return { val, ack, ts, lc: ts, from: ack ? 'system.adapter.unifi-access.0' : 'system.adapter.web.0' };
}

/** A state change on its way to the panel. */
export interface Delivery {
    id: string;
    val: ioBroker.StateValue;
    ack: boolean;
}

let queue: Delivery[] = [];
let holding = false;
let adapterRunning = true;
/** what the adapter puts back for an invalid admin.uiSettings value (main.ts handleUiSettings) */
let lastValidUiSettings = '{}';

/**
 * What the adapter writes back (`ack: true`) after a write of the panel, as `src/main.ts` does it -
 * `undefined` for states it does not confirm.
 *
 * - `admin.uiSettings` (handleUiSettings): a JSON object (at most 10 000 characters) is confirmed as it
 *   is, anything else is replaced by the last valid value.
 * - `doors.<id>.unlock` (onStateChange/handleDoorUnlock): `true` is confirmed once the door opened,
 *   any other value except `false` is reset to `false`; `false` itself is ignored.
 * - `doors.<id>.unlock_duration` / `lock_rule` and `doors.emergency.*`: a valid value is confirmed.
 *
 * @param id full state id
 * @param val value the panel wrote
 */
function adapterReply(id: string, val: ioBroker.StateValue): ioBroker.StateValue | undefined {
    const local = id.startsWith(`${ADAPTER_NAMESPACE}.`) ? id.slice(ADAPTER_NAMESPACE.length + 1) : id;
    if (local === 'admin.uiSettings') {
        let valid = false;
        if (typeof val === 'string' && val.length <= 10_000) {
            try {
                const parsed: unknown = JSON.parse(val);
                valid = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
            } catch {
                valid = false;
            }
        }
        if (valid) {
            lastValidUiSettings = val as string;
            return val;
        }
        return lastValidUiSettings;
    }
    if (/^doors\.emergency\.(lockdown|evacuation)$/.test(local)) {
        return typeof val === 'boolean' ? val : undefined;
    }
    if (/^doors\.[^.]+\.unlock$/.test(local)) {
        return val === false ? undefined : val === true;
    }
    if (/^doors\.[^.]+\.(unlock_duration|lock_rule)$/.test(local)) {
        return typeof val === 'number' ? val : undefined;
    }
    return undefined;
}

function deliver(delivery: Delivery): void {
    loading.delete(delivery.id);
    readIds.delete(delivery.id);
    states = { ...states, [delivery.id]: makeState(delivery.val, Date.now(), delivery.ack) };
    notify();
}

/**
 * Deliver the oldest state change that is on its way. The echo of a write lets the adapter answer:
 * its confirmation joins the end of the queue.
 *
 * @returns what was delivered, `undefined` when nothing was on its way
 */
export function deliverNext(): Delivery | undefined {
    const next = queue.shift();
    if (!next) {
        return undefined;
    }
    deliver(next);
    if (!next.ack && adapterRunning) {
        const reply = adapterReply(next.id, next.val);
        if (reply !== undefined) {
            queue.push({ id: next.id, val: reply, ack: true });
        }
    }
    return next;
}

/** Deliver everything that is on its way, including the confirmations that follow from it. */
export function deliverAll(): void {
    while (deliverNext()) {
        // next
    }
}

/** From now on keep echoes and confirmations in the queue until the test delivers them. */
export function holdDeliveries(): void {
    holding = true;
}

/** State changes that are on their way (oldest first). */
export function pendingDeliveries(): readonly Delivery[] {
    return queue;
}

/**
 * @param running false: the adapter is stopped and confirms nothing
 */
export function setAdapterRunning(running: boolean): void {
    adapterRunning = running;
}

/** A write of the panel: ioBroker echoes it, the adapter confirms it (see the module description). */
export function writeLikeIoBroker(id: string, val: ioBroker.StateValue): Promise<void> {
    queue.push({ id: fullId(id), val, ack: false });
    if (!holding) {
        deliverAll();
    }
    return Promise.resolve();
}

/**
 * Replace all states of the adapter.
 *
 * @param values state id (with or without namespace) => value
 * @param options.ts time stamp of the states as ioBroker writes it (its own clock); default: `Date.now()`
 * @param options.perId further states with their own time stamp, e.g. `system.adapter.unifi-access.0.alive`
 * @param options.loading ids that are still being read: their value is `undefined` until the next setStates
 * @param options.read deliver the values as read (reconnect), not as live changes
 */
export function setStates(
    values: Record<string, ioBroker.StateValue>,
    options: {
        ts?: number;
        perId?: Record<string, { val: ioBroker.StateValue; ts: number }>;
        loading?: string[];
        read?: boolean;
    } = {},
): void {
    const ts = options.ts ?? Date.now();
    loading = new Set((options.loading ?? []).map(fullId));
    states = Object.fromEntries(Object.entries(values).map(([id, val]) => [fullId(id), makeState(val, ts)]));
    for (const [id, state] of Object.entries(options.perId ?? {})) {
        states[fullId(id)] = makeState(state.val, state.ts);
    }
    readIds = options.read ? new Set(Object.keys(states)) : new Set();
    notify();
}

/**
 * Change one state and leave all others as they are (same objects, as a real state change does).
 *
 * @param id state id (with or without namespace)
 * @param val new value
 * @param ts time stamp as ioBroker writes it; default: `Date.now()`
 * @param options.read deliver the value as read (reconnect), not as a live change
 * @param options.ack acknowledge flag (default true: written by the adapter)
 */
export function updateState(
    id: string,
    val: ioBroker.StateValue,
    ts = Date.now(),
    options: { read?: boolean; ack?: boolean } = {},
): void {
    loading.delete(fullId(id));
    if (options.read) {
        readIds.add(fullId(id));
    } else {
        readIds.delete(fullId(id));
    }
    states = { ...states, [fullId(id)]: makeState(val, ts, options.ack ?? true) };
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

export function useIobStateArrival(id: string | null): IobStateArrival {
    const state = useIobState(id);
    // the first value this component saw is the read one
    const first = useRef<{ id: string | null; state: ioBroker.State | null } | null>(null);
    if (state !== undefined && (first.current === null || first.current.id !== id)) {
        first.current = { id, state };
    }
    const live = state !== undefined && first.current?.state !== state && !(id !== null && readIds.has(fullId(id)));
    return { state, live };
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

export const setIobState = vi.fn<(id: string, val: ioBroker.StateValue) => Promise<void>>(writeLikeIoBroker);

/**
 * Back to the start: deliveries right away, adapter running, nothing on its way, `setIobState` with its
 * realistic answer and no recorded calls.
 */
export function resetSocketMock(): void {
    setIobState.mockReset();
    setIobState.mockImplementation(writeLikeIoBroker);
    queue = [];
    holding = false;
    adapterRunning = true;
    lastValidUiSettings = '{}';
}

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
