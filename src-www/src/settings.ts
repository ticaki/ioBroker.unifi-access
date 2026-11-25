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
}

export const SettingsContext = createContext<SettingsCtx>({
    settings: DEFAULTS,
    update: () => {},
});

export function useSettingsProvider(): SettingsCtx {
    const raw = useIobState(SETTINGS_ID);
    const [local, setLocal] = useState<AppSettings>(DEFAULTS);
    const latest = useRef<AppSettings>(DEFAULTS);
    /** false until the stored settings were read (undefined: not read yet; null: the state does not exist) */
    const loaded = useRef(false);
    /** Changes made before the stored settings were read: merged into them, not written over them */
    const pending = useRef<{ patch: Partial<AppSettings>; persist: boolean } | null>(null);

    const apply = useCallback((next: AppSettings) => {
        latest.current = next;
        setLocal(next);
    }, []);

    const store = useCallback((next: AppSettings) => {
        setIobState(SETTINGS_ID, JSON.stringify(next)).catch((err: unknown) => {
            // eslint-disable-next-line no-console
            console.error('Cannot store the UI settings:', err);
        });
    }, []);

    useEffect(() => {
        if (raw === undefined) {
            return;
        }
        loaded.current = true;
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
            apply(stored);
        }
    }, [raw, apply, store]);

    const update = useCallback(
        (patch: Partial<AppSettings>, persist = true) => {
            const next = { ...latest.current, ...patch };
            apply(next);
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

    return useMemo(() => ({ settings: local, update }), [local, update]);
}

export function useSettings(): SettingsCtx {
    return useContext(SettingsContext);
}
