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

		it('does not create a state for the webhook signing secret', () => {
			expect(adapter.obj('info.webhookSecret')).to.equal(undefined);
			expect([...adapter.states.keys()].filter(id => /secret/i.test(id))).to.deep.equal([]);
		});

		it('creates the global read-only value states with their types', () => {
			const expected: Record<string, string> = {
				'doorbell.activeCallId': 'string',
				'doorbell.activeFromDevice': 'string',
				'doorbell.activeStartedAt': 'number',
				'events.last': 'string',
				'info.webhookEndpointId': 'string',
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
					controllerName: 'UA-ULTRA-AA01',
				},
			});
			expect(adapter.obj(`devices.${DEVICE_HUB}`).native).to.deep.equal({
				rawType: 'UAH',
				model: 'UA-Hub',
				capabilities: ['live-events'],
				controllerName: 'UA-HUB-3855',
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

	describe('door status updates', () => {
		beforeEach(async () => {
			await library.applyBootstrap({ devices: devices(), doors: doors() });
			adapter.stateWrites.length = 0;
		});
		const writes = (): string[] => adapter.stateWrites.map(w => `${w.id.slice(NS.length + 1)}=${String(w.val)}`);

		it('creates the read-only lock rule states for every door', () => {
			expect(adapter.obj(`doors.${DOOR_3855}.lockRuleType`).common).to.include({
				type: 'string',
				role: 'text',
				read: true,
				write: false,
			});
			expect(adapter.obj(`doors.${DOOR_3855}.lockRuleEndsAt`).common).to.include({
				type: 'number',
				role: 'value.time',
				read: true,
				write: false,
			});
		});

		it('updateDoorStatus() writes only what changed', async () => {
			const door = doors().find(d => d.id === DOOR_3855)!;
			await library.updateDoorStatus(door);
			expect(writes(), 'unchanged status').to.deep.equal([]);

			door.door_lock_relay_status = 'unlock';
			await library.updateDoorStatus(door);
			expect(writes()).to.deep.equal([`doors.${DOOR_3855}.locked=false`]);

			door.door_position_status = 'open';
			await library.updateDoorStatus(door);
			await library.updateDoorStatus(door);
			expect(writes()).to.deep.equal([`doors.${DOOR_3855}.locked=false`, `doors.${DOOR_3855}.position=open`]);
		});

		it('updateDoorStatus() notices a change made through setDoorLocked() / setDoorPosition()', async () => {
			const door = doors().find(d => d.id === DOOR_3855)!;
			await library.setDoorLocked(DOOR_3855, false);
			await library.setDoorPosition(DOOR_3855, 'open');
			await library.updateDoorStatus(door);
			expect(writes()).to.deep.equal([
				`doors.${DOOR_3855}.locked=false`,
				`doors.${DOOR_3855}.position=open`,
				`doors.${DOOR_3855}.locked=true`,
				`doors.${DOOR_3855}.position=close`,
			]);
		});

		it('setDoorLocked() / setDoorPosition() always write (events are reported even when the value repeats)', async () => {
			await library.setDoorLocked(DOOR_3855, false);
			await library.setDoorLocked(DOOR_3855, false);
			expect(writes()).to.deep.equal([`doors.${DOOR_3855}.locked=false`, `doors.${DOOR_3855}.locked=false`]);
			expect(adapter.states.get(`${NS}.doors.${DOOR_3855}.locked`)).to.include({ val: false, ack: true });
		});

		it('setDoorLockRule() maps type and ended_time (seconds) to lockRuleType / lockRuleEndsAt (ms)', async () => {
			await library.setDoorLockRule(DOOR_3855, { type: 'custom', ended_time: 1_708_672_257 });
			expect(adapter.val(`doors.${DOOR_3855}.lockRuleType`)).to.equal('custom');
			expect(adapter.val(`doors.${DOOR_3855}.lockRuleEndsAt`)).to.equal(1_708_672_257_000);
		});

		it('setDoorLockRule() maps everything unusable to "no rule"', async () => {
			for (const rule of [
				null,
				{},
				{ type: 5, ended_time: 'soon' },
				{ type: 'schedule', ended_time: 0 },
			] as never[]) {
				await library.setDoorLockRule(DOOR_A2, { type: 'keep_lock', ended_time: 99 });
				await library.setDoorLockRule(DOOR_A2, rule);
				expect(adapter.val(`doors.${DOOR_A2}.lockRuleEndsAt`), JSON.stringify(rule)).to.equal(null);
			}
			expect(adapter.val(`doors.${DOOR_A2}.lockRuleType`)).to.equal('schedule');
			await library.setDoorLockRule(DOOR_A2, null);
			expect(adapter.val(`doors.${DOOR_A2}.lockRuleType`)).to.equal('');
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

		// Events arrive at the same time (e.g. the WebSocket ring and the access.doorbell.incoming webhook
		// of the same doorbell press); the read-modify-write of the list must not let them overwrite each other.
		it('does not lose events that are pushed concurrently', async () => {
			await Promise.all([1, 2, 3, 4, 5].map(n => library.pushEvent({ n })));
			expect(
				events()
					.map(e => e.n)
					.sort(),
			).to.deep.equal([1, 2, 3, 4, 5]);
		});
	});

	describe('concurrent updates of events.last', () => {
		it('keeps the order of the calls and loses nothing with a slow states database', async () => {
			// make every read slow so all writers would start from the same (stale) list without serialisation
			const original = adapter.getStateAsync.bind(adapter);
			adapter.getStateAsync = async (id: string) => {
				const value = await original(id);
				await new Promise(resolve => setImmediate(resolve));
				return value;
			};
			await Promise.all(Array.from({ length: 60 }, (_, n) => library.pushEvent({ n })));
			const list = events();
			expect(list).to.have.length(50);
			expect(list.map(e => e.n)).to.deep.equal(Array.from({ length: 50 }, (_, i) => 59 - i));
		});

		it('an update of an event does not swallow an event pushed at the same time', async () => {
			await library.pushEvent({ ts: 1000, type: 'access.door.unlock' });
			await Promise.all([
				library.updateEventProtectData(1000, { protectCameraId: 'cam1' }),
				library.pushEvent({ ts: 2000, type: 'access.remote_view' }),
				library.updateEventProtectData(2000, { protectCameraId: 'cam2' }),
			]);
			expect(events()).to.deep.equal([
				{ ts: 2000, type: 'access.remote_view', protectCameraId: 'cam2' },
				{ ts: 1000, type: 'access.door.unlock', protectCameraId: 'cam1' },
			]);
		});

		it('a failing write rejects that call only — later events are still stored', async () => {
			const original = adapter.setForeignStateAsync.bind(adapter);
			let fail = true;
			adapter.setForeignStateAsync = async (id: string, state: unknown, ack?: boolean) => {
				if (fail) {
					fail = false;
					throw new Error('states db down');
				}
				return original(id, state, ack);
			};
			const results = await Promise.allSettled([library.pushEvent({ n: 1 }), library.pushEvent({ n: 2 })]);
			expect(results.map(r => r.status)).to.deep.equal(['rejected', 'fulfilled']);
			expect(events()).to.deep.equal([{ n: 2 }]);
		});
	});

	describe('objects that follow the controller without overwriting the user', () => {
		it('takes over a new name from the controller for a channel the user did not rename', async () => {
			await library.ensureDoor({ id: 'door-r', name: 'Front' });
			await library.ensureDoor({ id: 'door-r', name: 'Front Door' });
			expect(adapter.obj('doors.door-r').common.name).to.equal('Front Door');
			expect(adapter.val('doors.door-r.name')).to.equal('Front Door');
		});

		it('keeps the name the user gave a door or device channel in ioBroker', async () => {
			await library.ensureDoor({ id: 'door-u', name: 'Front' });
			await adapter.extendObject('doors.door-u', { common: { name: 'Haustür' } });
			await library.ensureDoor({ id: 'door-u', name: 'Front' });
			await library.ensureDoor({ id: 'door-u', name: 'Front Door' });
			expect(adapter.obj('doors.door-u').common.name).to.equal('Haustür');
			// the name state always shows the controller's name
			expect(adapter.val('doors.door-u.name')).to.equal('Front Door');

			await library.ensureDevice({ id: 'aabbccddeeff', name: 'UA-HUB-1', type: 'UAH' });
			await adapter.extendObject('devices.aabbccddeeff', { common: { name: 'Hub Keller' } });
			await library.ensureDevice({ id: 'aabbccddeeff', name: 'UA-HUB-1', type: 'UAH' });
			expect(adapter.obj('devices.aabbccddeeff').common.name).to.equal('Hub Keller');
		});

		it('creates thumbnail states on demand for devices without the capability flag — once', async () => {
			await library.ensureDevice({ id: DEVICE_HUB, name: 'UA-HUB-3855', type: 'UAH' });
			expect(adapter.obj(`devices.${DEVICE_HUB}.lastThumbnailPath`)).to.equal(undefined);
			await library.ensureThumbnailStates(DEVICE_HUB);
			for (const leaf of ['lastThumbnailPath', 'lastThumbnailUrl', 'lastThumbnailAt']) {
				expect(adapter.obj(`devices.${DEVICE_HUB}.${leaf}`)?.type, leaf).to.equal('state');
			}
			const objects = adapter.objects.size;
			await library.ensureThumbnailStates(DEVICE_HUB);
			expect(adapter.objects.size).to.equal(objects);
		});

		it('admin.uiSettings is writable (the www panel stores its settings there) and an old read-only object is corrected', async () => {
			await adapter.setObjectNotExistsAsync('admin.uiSettings', {
				type: 'state',
				common: {
					name: 'Persistent UI settings (JSON)',
					type: 'string',
					role: 'value',
					read: true,
					write: false,
				},
				native: {},
			});
			await library.ensureBaseObjects();
			expect(adapter.obj('admin.uiSettings').common).to.include({
				type: 'string',
				role: 'json',
				read: true,
				write: true,
			});
		});

		it('keeps firmware and lastSeenAt learned from events when the device list does not carry them', async () => {
			await library.ensureDevice({ id: DEVICE_HUB, name: 'UA-HUB-3855', type: 'UAH' });
			await adapter.setState(`devices.${DEVICE_HUB}.firmware`, { val: 'v4.6.1.0', ack: true });
			await adapter.setState(`devices.${DEVICE_HUB}.lastSeenAt`, { val: '2026-01-02T03:04:05.000Z', ack: true });
			await library.ensureDevice({ id: DEVICE_HUB, name: 'UA-HUB-3855', type: 'UAH' });
			expect(adapter.val(`devices.${DEVICE_HUB}.firmware`)).to.equal('v4.6.1.0');
			expect(adapter.val(`devices.${DEVICE_HUB}.lastSeenAt`)).to.equal('2026-01-02T03:04:05.000Z');
			await library.ensureDevice({ id: DEVICE_HUB, name: 'UA-HUB-3855', type: 'UAH', firmware: 'v5.0.0' });
			expect(adapter.val(`devices.${DEVICE_HUB}.firmware`)).to.equal('v5.0.0');
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
