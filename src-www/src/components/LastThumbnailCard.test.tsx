import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { collectThumbnailDevices, LastThumbnailCard, THUMBNAIL_MODELS, thumbnailView } from './LastThumbnailCard';
import { featuresFor, type UnifiDeviceModel } from '../../../src/lib/deviceModels';
import { setStates } from '../test/socketMock';

vi.mock('../socket', () => import('../test/socketMock'));

const NS = 'unifi-access.0';
/** URL as `setThumbnail()` of the adapter builds it */
const URL_A = 'http://192.0.2.5:8095/unifi-access/0/thumbnail/aabbccddeeff.jpg?ts=1800000000000';

function state(val: ioBroker.StateValue): ioBroker.State {
    return { val, ack: true, ts: 1, lc: 1, from: '' };
}

const ULTRA: Record<string, ioBroker.StateValue> = {
    'devices.aabbccddeeff.name': 'Front reader',
    'devices.aabbccddeeff.model': 'UA-Ultra',
    'devices.aabbccddeeff.online': true,
};
const HUB: Record<string, ioBroker.StateValue> = {
    'devices.112233445566.name': 'Garage hub',
    'devices.112233445566.model': 'UA-Hub',
};

beforeEach(() => {
    setStates({});
});

describe('collectThumbnailDevices', () => {
    it('offers every model with the event-thumbnail capability, but no hub', () => {
        const states = {
            [`${NS}.devices.u.model`]: state('UA-Ultra'),
            [`${NS}.devices.g3.model`]: state('UA-G3-Pro'),
            [`${NS}.devices.g2.model`]: state('UA-G2-Pro'),
            [`${NS}.devices.g2.name`]: state('Back reader'),
            [`${NS}.devices.hub.model`]: state('UA-Hub'),
            [`${NS}.devices.x.model`]: state('unknown'),
            'unifi-access.1.devices.other.model': state('UA-Ultra'),
        };

        expect(collectThumbnailDevices(states, NS)).toEqual([
            { id: 'u', name: undefined, model: 'UA-Ultra' },
            { id: 'g3', name: undefined, model: 'UA-G3-Pro' },
            { id: 'g2', name: 'Back reader', model: 'UA-G2-Pro' },
        ]);
    });

    it('knows exactly the models the adapter gives the event-thumbnail capability', () => {
        // every value of UnifiDeviceModel - a new one must be added here and is then checked against the panel
        const models: Record<UnifiDeviceModel, true> = {
            'UA-Ultra': true,
            'UA-G2-Pro': true,
            'UA-G3-Pro': true,
            'UA-Intercom': true,
            'UA-Lite': true,
            'UA-Hub': true,
            unknown: true,
        };
        const withThumbnail = (Object.keys(models) as UnifiDeviceModel[]).filter(model =>
            featuresFor(model).includes('event-thumbnail'),
        );

        expect([...THUMBNAIL_MODELS].sort()).toEqual(withThumbnail.sort());
    });

    it('offers a UA Intercom, but no UA Lite (reader without camera)', () => {
        const states = {
            [`${NS}.devices.i.model`]: state('UA-Intercom'),
            [`${NS}.devices.l.model`]: state('UA-Lite'),
        };

        expect(collectThumbnailDevices(states, NS)).toEqual([{ id: 'i', name: undefined, model: 'UA-Intercom' }]);
    });

    it('offers a device of another model once a thumbnail was stored for it', () => {
        const states = {
            [`${NS}.devices.x.model`]: state('unknown'),
            [`${NS}.devices.x.lastThumbnailAt`]: state(1_800_000_000_000),
            [`${NS}.devices.y.lastThumbnailPath`]: state(''),
        };

        expect(collectThumbnailDevices(states, NS)).toEqual([{ id: 'x', name: undefined, model: 'unknown' }]);
    });
});

describe('thumbnailView', () => {
    it('picks the image or the matching placeholder', () => {
        expect(thumbnailView(URL_A, 1, false)).toBe('image');
        expect(thumbnailView(URL_A, 1, true)).toBe('load-error');
        expect(thumbnailView(null, 1_800_000_000_000, false)).toBe('server-disabled');
        expect(thumbnailView(null, null, false)).toBe('none');
    });
});

describe('LastThumbnailCard', () => {
    it('explains that no device can deliver images', () => {
        setStates(HUB);
        render(<LastThumbnailCard />);

        expect(screen.getByText(/No thumbnail-capable devices discovered/)).toBeTruthy();
        expect(screen.queryByRole('combobox')).toBeNull();
    });

    it('shows the placeholder until the first image arrives', () => {
        setStates({ ...ULTRA, ...HUB });
        render(<LastThumbnailCard />);

        expect(screen.getByRole('combobox').textContent).toBe('Front reader (UA-Ultra)');
        expect(screen.getByText(/No event image received yet/)).toBeTruthy();
        expect(screen.queryByRole('img')).toBeNull();
    });

    it('shows the image the adapter serves and its time', () => {
        setStates({
            ...ULTRA,
            'devices.aabbccddeeff.lastThumbnailUrl': URL_A,
            'devices.aabbccddeeff.lastThumbnailAt': 1_800_000_000_000,
        });
        render(<LastThumbnailCard />);

        expect(screen.getByAltText('event thumbnail').getAttribute('src')).toBe(URL_A);
        expect(screen.getByText(new Date(1_800_000_000_000).toLocaleString())).toBeTruthy();
    });

    it('names the disabled thumbnail server if an image exists but has no URL', () => {
        setStates({ ...ULTRA, 'devices.aabbccddeeff.lastThumbnailAt': 1_800_000_000_000 });
        render(<LastThumbnailCard />);

        expect(screen.getByText(/thumbnail server is switched off/)).toBeTruthy();
        expect(screen.queryByRole('img')).toBeNull();
    });

    it('names the disabled thumbnail server for the empty URL the adapter writes when the server is off', () => {
        // since E-04 the adapter clears lastThumbnailUrl at start instead of keeping an old URL
        setStates({
            ...ULTRA,
            'devices.aabbccddeeff.lastThumbnailAt': 1_800_000_000_000,
            'devices.aabbccddeeff.lastThumbnailUrl': '',
        });
        render(<LastThumbnailCard />);

        expect(screen.getByText(/thumbnail server is switched off/)).toBeTruthy();
        expect(screen.queryByText(/could not be loaded/)).toBeNull();
        expect(screen.queryByRole('img')).toBeNull();
    });

    it('says so if the image cannot be loaded and tries again with the next image', () => {
        setStates({ ...ULTRA, 'devices.aabbccddeeff.lastThumbnailUrl': URL_A });
        render(<LastThumbnailCard />);

        fireEvent.error(screen.getByAltText('event thumbnail'));
        expect(screen.getByText(/could not be loaded/)).toBeTruthy();
        expect(screen.queryByRole('img')).toBeNull();

        const next = URL_A.replace('1800000000000', '1800000005000');
        act(() => setStates({ ...ULTRA, 'devices.aabbccddeeff.lastThumbnailUrl': next }));
        expect(screen.getByAltText('event thumbnail').getAttribute('src')).toBe(next);
    });

    it('does not use a value that is no http(s) URL as image source', () => {
        setStates({ ...ULTRA, 'devices.aabbccddeeff.lastThumbnailUrl': 'javascript:alert(1)' });
        render(<LastThumbnailCard />);

        expect(screen.queryByRole('img')).toBeNull();
    });

    it('switches devices and falls back to the first one if the chosen device disappears', () => {
        const warn = vi.spyOn(console, 'warn');
        const second: Record<string, ioBroker.StateValue> = {
            'devices.g3.name': 'Back reader',
            'devices.g3.model': 'UA-G3-Pro',
            'devices.g3.lastThumbnailUrl': 'http://192.0.2.5:8095/unifi-access/0/thumbnail/g3.jpg?ts=5',
        };
        setStates({ ...ULTRA, ...second });
        render(<LastThumbnailCard />);
        expect(screen.getByText(/No event image received yet/)).toBeTruthy();

        fireEvent.mouseDown(screen.getByRole('combobox'));
        fireEvent.click(within(screen.getByRole('listbox')).getByText('Back reader (UA-G3-Pro)'));
        expect(screen.getByAltText('event thumbnail').getAttribute('src')).toContain('/thumbnail/g3.jpg');

        act(() => setStates(ULTRA));
        expect(screen.getByRole('combobox').textContent).toBe('Front reader (UA-Ultra)');
        expect(warn.mock.calls.flat().join(' ')).not.toContain('out-of-range');
    });
});
