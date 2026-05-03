import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
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

const DEFAULTS: AppSettings = {
    showDoorList: true,
    showSnapshot: true,
    showDoorbell: true,
    showEventLog: true,
    maxWidth: 1200,
    snapshotHeight: 240,
    thumbWidth: 96,
};
const SETTINGS_ID = 'admin.uiSettings';

interface SettingsCtx {
    settings: AppSettings;
    update: (patch: Partial<AppSettings>) => void;
}

export const SettingsContext = createContext<SettingsCtx>({
    settings: DEFAULTS,
    update: () => {},
});

export function useSettingsProvider(): SettingsCtx {
    const raw = useIobState(SETTINGS_ID);
    const [local, setLocal] = useState<AppSettings>(DEFAULTS);

    useEffect(() => {
        if (raw === undefined) return;
        if (typeof raw?.val === 'string' && raw.val) {
            try {
                const parsed = JSON.parse(raw.val) as Partial<AppSettings>;
                setLocal({ ...DEFAULTS, ...parsed });
            } catch {
                // ignore corrupt state
            }
        }
    }, [raw]);

    const update = useCallback((patch: Partial<AppSettings>) => {
        setLocal(prev => {
            const next = { ...prev, ...patch };
            void setIobState(SETTINGS_ID, JSON.stringify(next));
            return next;
        });
    }, []);

    return useMemo(() => ({ settings: local, update }), [local, update]);
}

export function useSettings(): SettingsCtx {
    return useContext(SettingsContext);
}
