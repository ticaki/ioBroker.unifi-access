import { expect } from 'chai';

import { createTestLogger } from '../../test/mock';
import { LogThrottle } from './logThrottle';

describe('LogThrottle (K-14)', () => {
	it('warns once per key and window; repeats go to debug and are counted in the next warning', () => {
		const logger = createTestLogger();
		let now = 1_000_000;
		const throttle = new LogThrottle(logger, 60_000, () => now);
		throttle.warn('signature', 'Webhook signature verification failed.');
		for (let i = 0; i < 3; i++) {
			now += 10_000;
			throttle.warn('signature', 'Webhook signature verification failed.');
		}
		expect(logger.of('warn')).to.deep.equal(['Webhook signature verification failed.']);
		expect(logger.of('debug')).to.have.length(3);

		now += 30_000; // 60 s after the first warning
		throttle.warn('signature', 'Webhook signature verification failed.');
		expect(logger.of('warn')).to.deep.equal([
			'Webhook signature verification failed.',
			'Webhook signature verification failed. (3 more like this in the last 60 s, logged at debug level)',
		]);
	});

	it('keys are independent of each other', () => {
		const logger = createTestLogger();
		const throttle = new LogThrottle(logger, 60_000, () => 5);
		throttle.warn('a', 'first a');
		throttle.warn('b', 'first b');
		throttle.warn('a', 'second a');
		expect(logger.of('warn')).to.deep.equal(['first a', 'first b']);
		expect(logger.of('debug')).to.deep.equal(['second a']);
	});

	it('a warning after a quiet window carries no counter', () => {
		const logger = createTestLogger();
		let now = 0;
		const throttle = new LogThrottle(logger, 60_000, () => now);
		throttle.warn('a', 'x');
		now = 120_000;
		throttle.warn('a', 'x');
		expect(logger.of('warn')).to.deep.equal(['x', 'x']);
	});

	it('does not grow without bound for ever new keys', () => {
		const logger = createTestLogger();
		const throttle = new LogThrottle(logger, 60_000, () => 0);
		for (let i = 0; i < 1000; i++) {
			throttle.warn(`key-${i}`, 'm');
		}
		expect((throttle as unknown as { last: Map<string, unknown> }).last.size).to.be.at.most(100);
	});
});
