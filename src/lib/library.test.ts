import { expect } from 'chai';

import { FakeAdapter, fixtures } from '../../test/mock';
import { Library } from './library';
import type { UnifiDeviceRaw, UnifiDoorRaw } from './types';

const NS = 'unifi-access.0';
const { DOOR_A2, DOOR_3855, DEVICE_HUB, DEVICE_G2_PRO, DEVICE_ULTRA, DEVICE_LITE } = fixtures.IDS;

describe('Library (object and state management, in-memory adapter)', () => {
	let adapter: FakeAdapter;
	let library: Library;

	const devices = (): UnifiDeviceRaw[] => fixtures.clone(fixtures.DEFAULT_DEVICES).flat();
	const doors = (): UnifiDoorRaw[] => fixtures.clone(fixtures.DEFAULT_DOORS) as UnifiDoorRaw[];
	const events = (): { n?: number; ts?: number; [key: string]: unknown }[] =>
		JSON.parse(adapter.val('events.last') as string);

	beforeEach(() => {
		adapter = new FakeAdapter();
		library = new Library(adapter as unknown as ConstructorParameters<typeof Library>[0]);
	});

	describe('applyBootstrap()', () => {
		beforeEach(async () => {
			await library.applyBootstrap({ devices: devices(), doors: doors() });
		});

		it('creates the channel structure', () => {
			for (const id of [
				'devices',
				'doors',
				'doors.emergency',
				'events',
				'doorbell',
				'admin',
				'info',
				'notifications',
			]) {
				expect(adapter.obj(id)?.type, id).to.equal('channel');
			}
		});

		it('creates the global read-only value states with their types', () => {
			const expected: Record<string, string> = {
				'doorbell.activeCallId': 'string',
				'doorbell.activeFromDevice': 'string',
				'doorbell.activeStartedAt': 'number',
				'events.last': 'string',
				'admin.uiSettings': 'string',
				'info.webhookEndpointId': 'string',
				'info.webhookSecret': 'string',
				'info.webhookRegistered': 'boolean',
				'info.protectConnected': 'boolean',
				'notifications.lastRaw': 'string',
				'notifications.lastAlarmId': 'string',
				'notifications.lastEventType': 'string',
				'notifications.lastLocationId': 'string',
				'notifications.lastLocationName': 'string',
				'notifications.lastUserId': 'string',
				'notifications.lastUserName': 'string',
				'notifications.lastDirection': 'string',
				'notifications.lastUnlockMethod': 'string',
				'notifications.lastTimestamp': 'number',
			};
			for (const [id, type] of Object.entries(expected)) {
				const obj = adapter.obj(id);
				expect(obj?.type, id).to.equal('state');
				expect(obj.common.type, id).to.equal(type);
				expect(obj.common.role, id).to.equal('value');
				expect(obj.common.read, id).to.equal(true);
				expect(obj.common.write, id).to.equal(false);
			}
		});

		it('creates the emergency switches as writable boolean states', () => {
			for (const id of ['doors.emergency.lockdown', 'doors.emergency.evacuation']) {
				expect(adapter.obj(id).common).to.include({ type: 'boolean', role: 'switch', read: true, write: true });
			}
		});

		it('creates a channel per device with model and capabilities in native', () => {
			expect(adapter.obj(`devices.${DEVICE_ULTRA}`)).to.deep.include({
				type: 'channel',
				common: { name: 'UA-ULTRA-AA01' },
				native: {
					rawType: 'UA-ULTRA',
					model: 'UA-Ultra',
					capabilities: ['event-thumbnail', 'doorbell', 'door-unlock', 'live-events'],
				},
			});
			expect(adapter.obj(`devices.${DEVICE_HUB}`).native).to.deep.equal({
				rawType: 'UAH',
				model: 'UA-Hub',
				capabilities: ['live-events'],
			});
			expect(adapter.obj(`devices.${DEVICE_LITE}`).native.model).to.equal('unknown');
		});

		it('fills the device states from the bootstrap data', () => {
			const base = `devices.${DEVICE_G2_PRO}`;
			expect(adapter.val(`${base}.name`)).to.equal('UA-G2-PRO-BB7A');
			expect(adapter.val(`${base}.alias`)).to.equal('UNVR - Main Floor');
			expect(adapter.val(`${base}.type`)).to.equal('UA-G2-PRO');
			expect(adapter.val(`${base}.model`)).to.equal('UA-G2-Pro');
			expect(adapter.val(`${base}.firmware`)).to.equal('');
			expect(adapter.val(`${base}.online`)).to.equal(true);
			expect(adapter.val(`${base}.lastSeenAt`)).to.equal('');
			for (const leaf of ['name', 'alias', 'type', 'model', 'firmware', 'lastSeenAt']) {
				expect(adapter.obj(`${base}.${leaf}`).common.type, leaf).to.equal('string');
			}
			expect(adapter.obj(`${base}.online`).common.type).to.equal('boolean');
			expect(adapter.states.get(`${NS}.${base}.name`)?.ack).to.equal(true);
		});

		it('creates thumbnail states only for devices that deliver event thumbnails', () => {
			for (const id of [DEVICE_ULTRA, DEVICE_G2_PRO]) {
				expect(adapter.obj(`devices.${id}.lastThumbnailPath`)?.common.type, id).to.equal('string');
				expect(adapter.obj(`devices.${id}.lastThumbnailUrl`)?.common.type, id).to.equal('string');
				expect(adapter.obj(`devices.${id}.lastThumbnailAt`)?.common.type, id).to.equal('number');
			}
			for (const id of [DEVICE_HUB, DEVICE_LITE]) {
				expect(adapter.obj(`devices.${id}.lastThumbnailPath`), id).to.equal(undefined);
			}
		});

		it('creates a channel per door with all states (types, roles, access)', () => {
			const base = `doors.${DOOR_3855}`;
			expect(adapter.obj(base)).to.deep.include({ type: 'channel', common: { name: 'Door 3855' } });
			const expected: Record<string, Record<string, unknown>> = {
				name: { type: 'string', role: 'value', read: true, write: false },
				fullName: { type: 'string', role: 'value', read: true, write: false },
				locked: { type: 'boolean', role: 'value', read: true, write: false },
				position: { type: 'string', role: 'value', read: true, write: false },
				isBindHub: { type: 'boolean', role: 'value', read: true, write: false },
				unlock: { type: 'boolean', role: 'button', read: false, write: true },
				unlock_duration: {
					type: 'number',
					role: 'level',
					unit: 'min',
					min: 0,
					max: 600,
					def: 0,
					read: true,
					write: true,
				},
				lock_rule: { type: 'number', role: 'value', def: 0, read: true, write: true },
			};
			for (const [leaf, common] of Object.entries(expected)) {
				expect(adapter.obj(`${base}.${leaf}`)?.type, leaf).to.equal('state');
				expect(adapter.obj(`${base}.${leaf}`).common, leaf).to.include(common);
			}
			expect(adapter.obj(`${base}.lock_rule`).common.states).to.deep.equal({
				0: 'default',
				1: 'keep_unlock',
				2: 'keep_lock',
				3: 'lock_now',
				4: 'lock_early',
			});
		});

		it('fills the door states from the bootstrap data', () => {
			expect(adapter.val(`doors.${DOOR_3855}.name`)).to.equal('Door 3855');
			expect(adapter.val(`doors.${DOOR_3855}.fullName`)).to.equal('UNVR - 1F - Door 3855');
			expect(adapter.val(`doors.${DOOR_3855}.locked`)).to.equal(true);
			expect(adapter.val(`doors.${DOOR_3855}.position`)).to.equal('close');
			expect(adapter.val(`doors.${DOOR_3855}.isBindHub`)).to.equal(true);
			expect(adapter.val(`doors.${DOOR_3855}.unlock_duration`)).to.equal(0);
			expect(adapter.val(`doors.${DOOR_3855}.lock_rule`)).to.equal(0);
			expect(adapter.val(`doors.${DOOR_A2}.locked`)).to.equal(false);
			expect(adapter.val(`doors.${DOOR_A2}.position`)).to.equal('open');
		});

		it('does not write the unlock button during bootstrap', () => {
			expect(adapter.stateWrites.filter(w => w.id.endsWith('.unlock'))).to.deep.equal([]);
		});

		it('keeps user-set unlock_duration / lock_rule values on a second bootstrap', async () => {
			await adapter.setState(`doors.${DOOR_A2}.unlock_duration`, { val: 15, ack: true });
			await adapter.setState(`doors.${DOOR_A2}.lock_rule`, { val: 2, ack: true });
			await library.applyBootstrap({ devices: devices(), doors: doors() });
			expect(adapter.val(`doors.${DOOR_A2}.unlock_duration`)).to.equal(15);
			expect(adapter.val(`doors.${DOOR_A2}.lock_rule`)).to.equal(2);
		});
	});

	describe('ensureDoor() edge cases', () => {
		it('maps unknown relay status to locked=null and a null sensor to position "unknown"', async () => {
			await library.ensureDoor({ id: 'door-x', name: 'X', door_position_status: null });
			expect(adapter.val('doors.door-x.locked')).to.equal(null);
			expect(adapter.val('doors.door-x.position')).to.equal('unknown');
			expect(adapter.val('doors.door-x.isBindHub')).to.equal(false);
			expect(adapter.val('doors.door-x.fullName')).to.equal('');
		});

		it('falls back to full_name / id for the channel name', async () => {
			await library.ensureDoor({ id: 'door-y', full_name: 'Building - Y' });
			await library.ensureDoor({ id: 'door-z' });
			expect(adapter.obj('doors.door-y').common.name).to.equal('Building - Y');
			expect(adapter.obj('doors.door-z').common.name).to.equal('door-z');
			expect(adapter.val('doors.door-z.name')).to.equal('door-z');
		});

		it('replaces characters that are not allowed in state ids', async () => {
			await library.ensureDoor({ id: 'door.1/a b', name: 'Odd' });
			expect(adapter.obj('doors.door_1_a_b')?.type).to.equal('channel');
			expect(adapter.val('doors.door_1_a_b.name')).to.equal('Odd');
		});

		// The documented door sample (api_reference 7.7) reports a door without position sensor as
		// `"door_position_status": ""`; the value range of `position` is open | close | unknown.
		it('maps an empty door_position_status to "unknown"', async () => {
			await library.ensureDoor({
				id: 'door-nosensor',
				name: 'Main Door',
				door_lock_relay_status: 'lock',
				door_position_status: '' as unknown as null,
			});
			expect(adapter.val('doors.door-nosensor.position')).to.equal('unknown');
		});
	});

	describe('ensureDevice() edge cases', () => {
		it('honours explicit online=false and firmware from the controller', async () => {
			const { model } = await library.ensureDevice({
				id: 'aabbccddeeff',
				name: 'Reader',
				type: 'UA-G3-PRO',
				firmware: 'v1.2.3',
				online: false,
			});
			expect(model).to.equal('UA-G3-Pro');
			expect(adapter.val('devices.aabbccddeeff.online')).to.equal(false);
			expect(adapter.val('devices.aabbccddeeff.firmware')).to.equal('v1.2.3');
		});

		it('falls back to alias / id for names and to "unknown" without a type', async () => {
			await library.ensureDevice({ id: 'dev1', alias: 'Only Alias' });
			await library.ensureDevice({ id: 'dev2' });
			expect(adapter.obj('devices.dev1').common.name).to.equal('Only Alias');
			expect(adapter.val('devices.dev1.name')).to.equal('dev1');
			expect(adapter.obj('devices.dev2').common.name).to.equal('dev2');
			expect(adapter.val('devices.dev2.model')).to.equal('unknown');
			expect(adapter.val('devices.dev2.type')).to.equal('');
		});
	});

	describe('pushEvent()', () => {
		it('stores events newest first as a JSON array in events.last (ack=true)', async () => {
			await library.pushEvent({ n: 1 });
			await library.pushEvent({ n: 2 });
			expect(events()).to.deep.equal([{ n: 2 }, { n: 1 }]);
			expect(adapter.states.get(`${NS}.events.last`)?.ack).to.equal(true);
		});

		it('keeps only the 50 newest events', async () => {
			for (let n = 1; n <= 55; n++) {
				await library.pushEvent({ n });
			}
			const list = events();
			expect(list).to.have.length(50);
			expect(list[0].n).to.equal(55);
			expect(list[49].n).to.equal(6);
		});

		it('starts a fresh list when the stored value is not a JSON array', async () => {
			for (const broken of ['not json', '{"a":1}', '', 42]) {
				await adapter.setState('events.last', { val: broken, ack: true });
				await library.pushEvent({ n: 1 });
				expect(events(), String(broken)).to.deep.equal([{ n: 1 }]);
			}
		});

		// BUG-C-09: pushEvent() reads events.last, modifies the list and writes it back without any
		// serialisation. Events that arrive at the same time (e.g. the WebSocket ring and the
		// access.doorbell.incoming webhook of the same doorbell press) overwrite each other.
		it.skip('BUG-C-09: does not lose events that are pushed concurrently', async () => {
			await Promise.all([1, 2, 3, 4, 5].map(n => library.pushEvent({ n })));
			expect(
				events()
					.map(e => e.n)
					.sort(),
			).to.deep.equal([1, 2, 3, 4, 5]);
		});
	});

	describe('updateEventProtectData()', () => {
		it('adds the Protect fields to the event with the matching timestamp only', async () => {
			await library.pushEvent({ ts: 1000, type: 'access.door.unlock' });
			await library.pushEvent({ ts: 2000, type: 'access.door.unlock' });
			await library.updateEventProtectData(1000, {
				protectCameraId: 'cam1',
				protectEventId: 'evt1',
				protectSnapshotUrl: 'http://host/snap.jpg',
				protectVideoUrl: 'http://host/clip.mp4',
			});
			expect(events()).to.deep.equal([
				{ ts: 2000, type: 'access.door.unlock' },
				{
					ts: 1000,
					type: 'access.door.unlock',
					protectCameraId: 'cam1',
					protectEventId: 'evt1',
					protectSnapshotUrl: 'http://host/snap.jpg',
					protectVideoUrl: 'http://host/clip.mp4',
				},
			]);
		});

		it('writes nothing when no event has the timestamp', async () => {
			await library.pushEvent({ ts: 1000 });
			const writes = adapter.stateWrites.length;
			await library.updateEventProtectData(9999, { protectCameraId: 'cam1' });
			expect(adapter.stateWrites).to.have.length(writes);
			expect(events()).to.deep.equal([{ ts: 1000 }]);
		});
	});
});
