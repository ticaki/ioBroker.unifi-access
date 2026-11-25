import { expect } from 'chai';

import {
	describeValue,
	extractDpsStatus,
	LOCK_RULE_BY_INDEX,
	MAX_UNLOCK_MINUTES,
	normalizeDefaultUnlockMinutes,
	normalizePort,
	parseLockRuleIndex,
	parseUnlockMinutes,
} from './controlValues';

describe('controlValues (validation of control state values)', () => {
	describe('parseUnlockMinutes()', () => {
		it('accepts finite numbers from 0 to the maximum and rounds fractions down', () => {
			expect(parseUnlockMinutes(0)).to.equal(0);
			expect(parseUnlockMinutes(0.4)).to.equal(0);
			expect(parseUnlockMinutes(7.9)).to.equal(7);
			expect(parseUnlockMinutes(MAX_UNLOCK_MINUTES)).to.equal(600);
			expect(parseUnlockMinutes(MAX_UNLOCK_MINUTES + 0.9)).to.equal(600);
		});

		for (const bad of [
			'5',
			'',
			null,
			undefined,
			true,
			false,
			Number.NaN,
			Infinity,
			-Infinity,
			-0.1,
			-5,
			601,
			1e12,
			{},
			[],
		]) {
			it(`rejects ${describeValue(bad)}`, () => {
				expect(parseUnlockMinutes(bad)).to.equal(null);
			});
		}
	});

	describe('parseLockRuleIndex()', () => {
		it('maps the known indexes to the documented rule types', () => {
			expect([0, 1, 2, 3, 4].map(parseLockRuleIndex)).to.deep.equal([
				'reset',
				'keep_unlock',
				'keep_lock',
				'lock_now',
				'lock_early',
			]);
			expect(Object.values(LOCK_RULE_BY_INDEX)).to.not.include('custom');
		});

		for (const bad of [
			'1',
			null,
			undefined,
			true,
			Number.NaN,
			Infinity,
			1.5,
			-1,
			5,
			9,
			{},
			'toString',
			'constructor',
		]) {
			it(`rejects ${describeValue(bad)}`, () => {
				expect(parseLockRuleIndex(bad)).to.equal(null);
			});
		}
	});

	describe('normalizeDefaultUnlockMinutes()', () => {
		it('returns whole minutes, 0 for anything unusable, capped at the maximum', () => {
			expect(normalizeDefaultUnlockMinutes(10)).to.equal(10);
			expect(normalizeDefaultUnlockMinutes(2.7)).to.equal(2);
			expect(normalizeDefaultUnlockMinutes('15')).to.equal(15);
			expect(normalizeDefaultUnlockMinutes(100_000)).to.equal(600);
			for (const unusable of [0, -3, Number.NaN, Infinity, '', 'abc', null, undefined, true, {}]) {
				expect(normalizeDefaultUnlockMinutes(unusable), describeValue(unusable)).to.equal(0);
			}
		});
	});

	describe('normalizePort()', () => {
		it('accepts integers from 1 to 65535 (also as numeric string), otherwise the fallback', () => {
			expect(normalizePort(8443, 443)).to.equal(8443);
			expect(normalizePort('8443', 443)).to.equal(8443);
			expect(normalizePort(1, 443)).to.equal(1);
			expect(normalizePort(65_535, 443)).to.equal(65_535);
			for (const bad of [
				0,
				-1,
				65_536,
				80.5,
				Number.NaN,
				Infinity,
				'',
				'abc',
				'80a',
				'123456',
				null,
				undefined,
				true,
				{},
			]) {
				expect(normalizePort(bad, 443), describeValue(bad)).to.equal(443);
			}
		});
	});

	describe('extractDpsStatus()', () => {
		it('reads the documented data.object.status first', () => {
			expect(
				extractDpsStatus({ object: { event_type: 'dps_change', status: 'close' }, dps_status: 'open' }),
			).to.equal('close');
		});

		it('falls back to data.dps_status, then data.value', () => {
			expect(extractDpsStatus({ dps_status: 'open', value: 'close' })).to.equal('open');
			expect(extractDpsStatus({ object: null, value: 'close' })).to.equal('close');
			expect(extractDpsStatus({ object: { status: '' }, value: 'open' })).to.equal('open');
		});

		it('returns undefined when there is no non-empty string', () => {
			for (const data of [undefined, null, {}, { object: {} }, { object: { status: 1 } }, { dps_status: true }]) {
				expect(extractDpsStatus(data)).to.equal(undefined);
			}
		});
	});

	describe('describeValue()', () => {
		it('names the type and shortens long values', () => {
			expect(describeValue('10')).to.equal('"10" (string)');
			expect(describeValue(null)).to.equal('null (null)');
			expect(describeValue(Number.NaN)).to.equal('NaN (number)');
			expect(describeValue('x'.repeat(200))).to.have.length.lessThan(80);
		});
	});
});
