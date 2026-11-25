import { expect } from 'chai';

import { fixtures } from '../../test/mock';
import { asRecord, asString, isAccessGranted, MASKED_VALUE, parseAccessEvent } from './eventNormalizer';

const NOW = 1_764_000_000_000;
const { DOOR_3855, DEVICE_HUB, DEVICE_G2_PRO } = fixtures.IDS;
const door = { id: DOOR_3855, name: 'Door 3855' };
const hub = { id: DEVICE_HUB, name: 'UA-HUB-3855', type: 'UAH' };

describe('eventNormalizer (parsing of untrusted event envelopes)', () => {
	describe('invalid envelopes are rejected without throwing', () => {
		for (const msg of [
			null,
			undefined,
			42,
			'text',
			true,
			[],
			[{ event: 'x' }],
			{},
			{ event: null },
			{ event: 7 },
			{ event: '' },
		]) {
			it(`returns null for ${JSON.stringify(msg) ?? 'undefined'}`, () => {
				expect(parseAccessEvent(msg, 'ws', NOW)).to.equal(null);
			});
		}
	});

	describe('envelopes with fields of the wrong type', () => {
		it('treats a missing or non-object data as empty', () => {
			for (const data of [undefined, null, 'text', 5, ['a']]) {
				const parsed = parseAccessEvent({ event: 'access.door.unlock', data }, 'webhook', NOW);
				expect(parsed?.event).to.deep.include({ type: 'access.door.unlock', ts: NOW, source: 'webhook' });
				expect(parsed?.event.doorId).to.equal(undefined);
				expect(parsed?.data).to.deep.equal({});
			}
		});

		it('ignores ids and names that are not strings', () => {
			const parsed = parseAccessEvent(
				{
					event: 'access.door.unlock',
					event_object_id: { nested: true },
					data: {
						door_id: 12,
						device_id: { a: 1 },
						device: { id: ['x'], name: 5, alias: null },
						location: { id: 99, name: {}, extras: 'no-object' },
						actor: 'nobody',
						object: [],
					},
				},
				'webhook',
				NOW,
			);
			expect(parsed?.event).to.deep.include({
				doorId: undefined,
				deviceId: undefined,
				deviceName: undefined,
				doorName: undefined,
				userName: undefined,
				thumbnailPath: undefined,
			});
			expect(parsed?.object).to.equal(undefined);
		});

		it('uses the envelope timestamp when it is a number or a parseable date, otherwise "now"', () => {
			expect(parseAccessEvent({ event: 'e', timestamp: 1234 }, 'ws', NOW)?.event.ts).to.equal(1234);
			expect(parseAccessEvent({ event: 'e', timestamp: '2026-01-02T03:04:05Z' }, 'ws', NOW)?.event.ts).to.equal(
				Date.parse('2026-01-02T03:04:05Z'),
			);
			for (const timestamp of ['garbage', Number.NaN, Infinity, {}, null]) {
				expect(parseAccessEvent({ event: 'e', timestamp }, 'ws', NOW)?.event.ts).to.equal(NOW);
			}
		});
	});

	describe('documented payloads', () => {
		it('access.door.unlock (webhook): door, device, actor, thumbnail and result', () => {
			const msg = fixtures.webhookEvents.doorUnlock({ door, device: hub, readerId: DEVICE_G2_PRO });
			const parsed = parseAccessEvent(msg, 'webhook', NOW)!;
			expect(parsed.event).to.deep.include({
				type: 'access.door.unlock',
				subtype: 'Access Granted',
				doorId: DOOR_3855,
				doorName: 'Door 3855',
				deviceId: DEVICE_HUB,
				userName: 'Hon***',
				thumbnailPath: msg.data.location.extras.door_thumbnail,
			});
			expect(parsed.result).to.equal('Access Granted');
			expect(parsed.event.raw).to.deep.equal(msg);
			expect(parsed.thumbnailPathRejected).to.equal(false);
		});

		it('access.device.dps_status: subtype from data.object.status', () => {
			const msg = fixtures.webhookEvents.dpsStatus({ door, device: hub, status: 'open' });
			expect(parseAccessEvent(msg, 'webhook', NOW)?.event.subtype).to.equal('open');
		});

		it('access.doorbell.completed: reason from data.object.reason_code, request id from data.object.request_id', () => {
			for (const [code, subtype] of [
				[105, 'timeout'],
				[106, 'admin_rejected'],
				[107, 'admin_unlocked'],
				[108, 'visitor_cancelled'],
				[400, 'answered_elsewhere'],
			] as const) {
				const msg = fixtures.webhookEvents.doorbellCompleted({
					door,
					device: hub,
					reasonCode: code,
					requestId: 'req-1',
				});
				const parsed = parseAccessEvent(msg, 'webhook', NOW)!;
				expect(parsed.event.subtype).to.equal(subtype);
				expect(parsed.reasonCode).to.equal(code);
				expect(parsed.requestId).to.equal('req-1');
			}
		});

		it('access.remote_view.change (WebSocket): reason from data.reason_code', () => {
			const parsed = parseAccessEvent(fixtures.websocketEvents.remoteViewChange(107), 'ws', NOW)!;
			expect(parsed.reasonCode).to.equal(107);
			expect(parsed.event.subtype).to.equal('admin_unlocked');
			expect(parseAccessEvent({ event: 'access.remote_view.change', data: {} }, 'ws', NOW)?.reasonCode).to.equal(
				undefined,
			);
		});

		it('access.data.device.remote_unlock (WebSocket): the data object is the door', () => {
			const parsed = parseAccessEvent(fixtures.websocketEvents.remoteUnlock(door), 'ws', NOW)!;
			expect(parsed.event.doorId).to.equal(DOOR_3855);
			expect(parsed.event.doorName).to.equal('Door 3855');
		});
	});

	describe('WebRTC credentials of a doorbell call (R-19)', () => {
		it('removes data.channel and data.token from the stored envelope and keeps everything else', () => {
			const msg = fixtures.websocketEvents.remoteView();
			expect(msg.data.channel).to.be.a('string');
			expect(msg.data.token).to.be.a('string');
			const parsed = parseAccessEvent(msg, 'ws', NOW)!;
			const raw = parsed.event.raw as typeof msg;
			expect(raw.data).to.not.have.property('channel');
			expect(raw.data).to.not.have.property('token');
			const { channel, token, ...rest } = msg.data;
			expect(raw.data).to.deep.equal(rest);
			expect(raw.event_object_id).to.equal(msg.event_object_id);
			expect(JSON.stringify(parsed.event)).to.not.contain(channel).and.not.contain(token);
			// the caller's object is not modified
			expect(msg.data.token).to.equal(token);
			expect(parsed.requestId).to.equal(msg.data.request_id);
		});
	});

	describe('credential values of the person at the door (RK U-3)', () => {
		for (const [type, value] of [
			['PIN_CODE', '123456'],
			['NFC', '6FC02554'],
			['NFC', 42],
		] as [string, unknown][]) {
			it(`masks data.object.authentication_value (${type}) in the stored envelope, the caller's object stays`, () => {
				const msg = fixtures.webhookEvents.doorUnlock({
					door,
					device: hub,
					object: { authentication_type: type, authentication_value: value },
				});
				const parsed = parseAccessEvent(msg, 'webhook', NOW)!;
				const raw = parsed.event.raw as typeof msg;
				expect(raw.data.object.authentication_value).to.equal(MASKED_VALUE);
				expect(raw.data.object.authentication_type).to.equal(type);
				expect(raw.data.object.result).to.equal('Access Granted');
				expect(JSON.stringify(parsed.event)).to.not.contain(String(value));
				expect(msg.data.object.authentication_value).to.equal(value);
				// the parsed object the adapter evaluates is the original one
				expect(parsed.object?.authentication_value).to.equal(value);
			});
		}

		it('an empty value stays empty and the envelope is passed on unchanged', () => {
			const msg = fixtures.webhookEvents.doorUnlock({ door, device: hub });
			expect(msg.data.object.authentication_value).to.equal('');
			const parsed = parseAccessEvent(msg, 'webhook', NOW)!;
			expect(parsed.event.raw).to.equal(msg);
		});

		it('also masks the key directly in data, and together with the WebRTC credentials', () => {
			const msg = fixtures.websocketEvents.remoteView({ data: { authentication_value: '9876' } });
			const parsed = parseAccessEvent(msg, 'ws', NOW)!;
			const raw = parsed.event.raw as { data: Record<string, unknown> };
			expect(raw.data.authentication_value).to.equal(MASKED_VALUE);
			expect(raw.data).to.not.have.property('token');
			expect(raw.data).to.not.have.property('channel');
		});
	});

	describe('result of an access attempt (RF-01)', () => {
		for (const [result, granted] of [
			['Access Granted', true],
			[undefined, true],
			['BLOCKED', false],
			['Access Denied', false],
		] as [string | undefined, boolean][]) {
			it(`access.door.unlock with result ${String(result)} → granted ${granted}`, () => {
				const msg = fixtures.webhookEvents.doorUnlock({ door, device: hub, object: { result } });
				expect(parseAccessEvent(msg, 'webhook', NOW)?.event.granted).to.equal(granted);
			});
		}

		it('other event types carry no granted field', () => {
			const parsed = parseAccessEvent(fixtures.websocketEvents.remoteUnlock(door), 'ws', NOW)!;
			expect(parsed.event).to.not.have.property('granted');
			expect(JSON.parse(JSON.stringify(parsed.event))).to.not.have.property('granted');
		});
	});

	describe('thumbnail path', () => {
		it('drops a path that is not a plain static-resource path and reports it', () => {
			const msg = fixtures.webhookEvents.doorUnlock({ door, device: hub, readerId: DEVICE_G2_PRO });
			for (const bad of ['/preview/../../users', 'https://x/preview/a.jpg', 42, { path: '/preview/a.jpg' }]) {
				msg.data.location.extras.door_thumbnail = bad;
				const parsed = parseAccessEvent(msg, 'webhook', NOW)!;
				expect(parsed.event.thumbnailPath).to.equal(undefined);
				expect(parsed.thumbnailPathRejected).to.equal(true);
			}
		});

		it('an absent or empty path is not reported as rejected', () => {
			const msg = fixtures.webhookEvents.doorUnlock({ door, device: hub });
			expect(parseAccessEvent(msg, 'webhook', NOW)?.thumbnailPathRejected).to.equal(false);
			msg.data.location.extras.door_thumbnail = '';
			expect(parseAccessEvent(msg, 'webhook', NOW)?.thumbnailPathRejected).to.equal(false);
		});
	});

	describe('isAccessGranted()', () => {
		it('counts a missing result and "Access Granted" as an unlock', () => {
			for (const result of [undefined, 'Access Granted', 'ACCESS', 'Success']) {
				expect(isAccessGranted(result), String(result)).to.equal(true);
			}
		});

		it('does not count denied / blocked results as an unlock', () => {
			for (const result of ['BLOCKED', 'Access Denied', 'Access Denied / Unknown (NFC)', 'Rejected', 'FAILED']) {
				expect(isAccessGranted(result), result).to.equal(false);
			}
		});
	});

	describe('helpers', () => {
		it('asRecord() accepts plain objects only', () => {
			expect(asRecord({ a: 1 })).to.deep.equal({ a: 1 });
			for (const value of [null, undefined, [], 'x', 1, true]) {
				expect(asRecord(value)).to.equal(undefined);
			}
		});

		it('asString() accepts non-empty strings only', () => {
			expect(asString('x')).to.equal('x');
			for (const value of ['', null, undefined, 1, {}, []]) {
				expect(asString(value)).to.equal(undefined);
			}
		});
	});
});
