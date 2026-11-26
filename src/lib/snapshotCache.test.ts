import { expect } from 'chai';

import { PROTECT_SNAPSHOT_CACHE_MAX_BYTES, PROTECT_SNAPSHOT_CACHE_MAX_ENTRIES, SnapshotCache } from './snapshotCache';

const bytes = (n: number, fill = 0): Buffer => Buffer.alloc(n, fill);

describe('SnapshotCache (Protect snapshots, RT-04)', () => {
	it('the limits of the adapter are 50 snapshots and 32 MiB (R2T-03)', () => {
		expect(PROTECT_SNAPSHOT_CACHE_MAX_ENTRIES).to.equal(50);
		expect(PROTECT_SNAPSHOT_CACHE_MAX_BYTES).to.equal(33_554_432);
	});

	it('keeps up to the entry limit and drops the oldest first', () => {
		const cache = new SnapshotCache(50, 32 * 1024 * 1024);
		for (let i = 0; i < 51; i++) {
			cache.add(`cam:${i}`, bytes(10, i));
		}
		expect(cache.size).to.equal(50);
		expect(cache.bytes).to.equal(500);
		expect(cache.get('cam:0'), 'oldest dropped').to.equal(undefined);
		expect(cache.get('cam:1')?.[0]).to.equal(1);
		expect(cache.get('cam:50')?.[0]).to.equal(50);
	});

	it('keeps within the byte limit, dropping as many old snapshots as needed', () => {
		const cache = new SnapshotCache(50, 100);
		cache.add('a', bytes(40));
		cache.add('b', bytes(40));
		expect(cache.bytes).to.equal(80);
		cache.add('c', bytes(30));
		// 110 > 100 → "a" goes
		expect([cache.get('a'), cache.size, cache.bytes]).to.deep.equal([undefined, 2, 70]);
		cache.add('d', bytes(100));
		// exactly the limit: everything else had to go
		expect([cache.get('b'), cache.get('c'), cache.size, cache.bytes]).to.deep.equal([undefined, undefined, 1, 100]);
		expect(cache.get('d')).to.have.length(100);
	});

	it('a snapshot larger than the byte limit is not kept and leaves the others alone', () => {
		const cache = new SnapshotCache(50, 100);
		cache.add('a', bytes(60));
		cache.add('huge', bytes(101));
		expect(cache.get('huge')).to.equal(undefined);
		expect([cache.size, cache.bytes]).to.deep.equal([1, 60]);
	});

	it('a key that is already present keeps its first snapshot and is not counted twice', () => {
		const cache = new SnapshotCache(2, 1000);
		cache.add('a', bytes(10, 1));
		cache.add('a', bytes(20, 2));
		expect(cache.get('a')?.[0]).to.equal(1);
		expect([cache.size, cache.bytes]).to.deep.equal([1, 10]);
		cache.add('b', bytes(10));
		cache.add('c', bytes(10));
		expect(cache.get('a')).to.equal(undefined);
		expect([cache.size, cache.bytes]).to.deep.equal([2, 20]);
	});

	it('the byte count stays exact over many evictions', () => {
		const cache = new SnapshotCache(5, 64);
		let expected: number[] = [];
		for (let i = 0; i < 200; i++) {
			const size = (i * 7) % 23;
			cache.add(`k${i}`, bytes(size));
			expected.push(size);
			while (expected.length > 5 || expected.reduce((a, b) => a + b, 0) > 64) {
				expected = expected.slice(1);
			}
			expect(cache.bytes, `after ${i}`).to.equal(expected.reduce((a, b) => a + b, 0));
			expect(cache.size, `after ${i}`).to.equal(expected.length);
		}
	});
});
