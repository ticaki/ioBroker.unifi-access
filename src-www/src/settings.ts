import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { setIobState, useIobState } from './socket';

export interface AppSettings {
    showDoorList: boolean;
    showSnapshot: boolean;
    showDoorbell: boolean;
    showEventLog: boolean;
    maxWidth: number;
    snapshotHeight: number;
    thumbWidth: number;
}

export const DEFAULTS: AppSettings = {
    showDoorList: true,
    showSnapshot: true,
    showDoorbell: true,
    showEventLog: true,
    maxWidth: 1200,
    snapshotHeight: 240,
    thumbWidth: 96,
};
const SETTINGS_ID = 'admin.uiSettings';
/** Own writes remembered at most (only reached while the adapter confirms nothing, e.g. stopped) */
const MAX_IN_FLIGHT = 20;

/** An own write of the settings that is not confirmed by the adapter yet. */
interface OwnWrite {
    json: string;
    /** its echo (ack=false) has arrived */
    echoed: boolean;
}

/**
 * Whether a value that arrived for the settings state is one of the own writes - and must then not be
 * taken over while newer own writes are still on their way, or the screen would flip back.
 *
 * Every write comes back twice: first as its echo (`ack: false`), then as the confirmation of the adapter
 * (`ack: true`, same value; src/main.ts handleUiSettings). Echoes and confirmations of several writes
 * may interleave (echo X, echo Y, ack X, ack Y), but the adapter confirms them in the order of writing:
 * a confirmation also settles every older write. An echo settles nothing - the confirmation of an older
 * write may still come after it. Without a running adapter there are only echoes; the list is limited.
 *
 * @param inFlight own writes, oldest first (changed in place)
 * @param state the value that arrived
 * @returns true: an own value older than the newest own write - ignore it
 */
export function isOutdatedOwnValue(inFlight: OwnWrite[], state: ioBroker.State | null): boolean {
    if (typeof state?.val !== 'string') {
        return false;
    }
    const val = state.val;
    if (state.ack) {
        const index = inFlight.findIndex(write => write.json === val);
        if (index < 0) {
            return false;
        }
        inFlight.splice(0, index + 1);
        return inFlight.length > 0;
    }
    const index = inFlight.findIndex(write => write.json === val && !write.echoed);
    if (index < 0) {
        return false;
    }
    inFlight[index].echoed = true;
    return index < inFlight.length - 1;
}

/** Allowed range per numeric setting - the same limits the sliders of the settings panel have */
const NUMBER_LIMITS: Record<'maxWidth' | 'snapshotHeight' | 'thumbWidth', [min: number, max: number]> = {
    maxWidth: [600, 2000],
    snapshotHeight: [0, 600],
    thumbWidth: [0, 200],
};

/**
 * Reads the stored settings. Whatever is missing, has the wrong type or is out of range falls back to the
 * default, so a broken state value can neither crash the page nor hide all of it.
 *
 * @param raw value of the settings state
 */
export function parseSettings(raw: unknown): AppSettings {
    let parsed: unknown;
    try {
        parsed = typeof raw === 'string' && raw ? JSON.parse(raw) : null;
    } catch {
        parsed = null;
    }
    const result: AppSettings = { ...DEFAULTS };
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return result;
    }
    const stored = parsed as Record<string, unknown>;
    for (const key of ['showDoorList', 'showSnapshot', 'showDoorbell', 'showEventLog'] as const) {
        if (typeof stored[key] === 'boolean') {
            result[key] = stored[key];
        }
    }
    for (const key of ['maxWidth', 'snapshotHeight', 'thumbWidth'] as const) {
        const value = stored[key];
        const [min, max] = NUMBER_LIMITS[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) {
            result[key] = value;
        }
    }
    return result;
}

interface SettingsCtx {
    settings: AppSettings;
    /**
     * Change settings.
     *
     * @param patch the changed values
     * @param persist false: only change what is shown (e.g. while a slider is dragged), do not store it yet
     */
    update: (patch: Partial<AppSettings>, persist?: boolean) => void;
    /**
     * A drag that ended without its final change (the slider was unmounted while it was dragged, e.g. the
     * drawer closed with Escape - MUI then sends no onChangeCommitted): store what is shown.
     */
    endDrag: () => void;
}

export const SettingsContext = createContext<SettingsCtx>({
    settings: DEFAULTS,
    update: () => {},
    endDrag: () => {},
});

export function useSettingsProvider(): SettingsCtx {
    const raw = useIobState(SETTINGS_ID);
    const [local, setLocal] = useState<AppSettings>(DEFAULTS);
    const latest = useRef<AppSettings>(DEFAULTS);
    /** false until the stored settings were read (undefined: not read yet; null: the state does not exist) */
    const loaded = useRef(false);
    /** Changes made before the stored settings were read: merged into them, not written over them */
    const pending = useRef<{ patch: Partial<AppSettings>; persist: boolean } | null>(null);
    /** Own writes not confirmed by the adapter yet, oldest first */
    const inFlight = useRef<OwnWrite[]>([]);
    /** Shown but not stored yet (a slider that is being dragged) */
    const draft = useRef<Partial<AppSettings>>({});

    const apply = useCallback((next: AppSettings) => {
        latest.current = next;
        setLocal(next);
    }, []);

    const store = useCallback((next: AppSettings) => {
        const json = JSON.stringify(next);
        const write: OwnWrite = { json, echoed: false };
        inFlight.current.push(write);
        if (inFlight.current.length > MAX_IN_FLIGHT) {
            inFlight.current.splice(0, inFlight.current.length - MAX_IN_FLIGHT);
        }
        draft.current = {};
        setIobState(SETTINGS_ID, json).catch((err: unknown) => {
            inFlight.current = inFlight.current.filter(entry => entry !== write);
            // eslint-disable-next-line no-console
            console.error('Cannot store the UI settings:', err);
        });
    }, []);

    useEffect(() => {
        if (raw === undefined) {
            return;
        }
        loaded.current = true;
        // an echo or confirmation of an own write: what is on screen already contains it. While later writes
        // are still on their way, it is older than the screen - taking it over would flip those changes back.
        if (isOutdatedOwnValue(inFlight.current, raw)) {
            return;
        }
        const stored = typeof raw?.val === 'string' && raw.val ? parseSettings(raw.val) : undefined;
        const waiting = pending.current;
        pending.current = null;
        if (waiting) {
            const next = { ...(stored ?? DEFAULTS), ...waiting.patch };
            apply(next);
            if (waiting.persist) {
                store(next);
            }
        } else if (stored) {
            // a slider that is being dragged keeps its position
            apply({ ...stored, ...draft.current });
        }
    }, [raw, apply, store]);

    const update = useCallback(
        (patch: Partial<AppSettings>, persist = true) => {
            const next = { ...latest.current, ...patch };
            apply(next);
            if (!persist) {
                draft.current = { ...draft.current, ...patch };
            }
            if (!loaded.current) {
                // Not read yet (slow or missing connection): writing now would replace every stored
                // setting with the defaults. Keep the change and write it merged once the value is there.
                pending.current = {
                    patch: { ...pending.current?.patch, ...patch },
                    persist: persist || pending.current?.persist === true,
                };
                return;
            }
            if (persist) {
                store(next);
            }
        },
        [apply, store],
    );

    const endDrag = useCallback(() => {
        if (Object.keys(draft.current).length === 0) {
            return;
        }
        if (!loaded.current) {
            // stored once the settings were read (see update)
            pending.current = { patch: { ...pending.current?.patch, ...draft.current }, persist: true };
            draft.current = {};
            return;
        }
        store(latest.current);
    }, [store]);

    return useMemo(() => ({ settings: local, update, endDrag }), [local, update, endDrag]);
}

export function useSettings(): SettingsCtx {
    return useContext(SettingsContext);
}
