/** Most Protect snapshots the adapter keeps for its media endpoint. */
export const PROTECT_SNAPSHOT_CACHE_MAX_ENTRIES = 50;
/** Most bytes of Protect snapshots the adapter keeps in total (32 MiB). */
export const PROTECT_SNAPSHOT_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Camera snapshots kept for the media endpoint, bounded by the number of entries and by bytes. When a
 * bound is exceeded, the oldest snapshots are dropped first. A single snapshot larger than the byte
 * bound is not kept at all (it would push out everything else and be dropped itself).
 */
export class SnapshotCache {
	private readonly entries = new Map<string, Buffer>();
	private readonly order: string[] = [];
	private totalBytes = 0;

	/**
	 * @param maxEntries Most snapshots kept
	 * @param maxBytes Most bytes kept in total
	 */
	constructor(
		readonly maxEntries: number,
		readonly maxBytes: number,
	) {}

	/** Number of snapshots kept. */
	get size(): number {
		return this.entries.size;
	}

	/** Bytes of all snapshots kept. */
	get bytes(): number {
		return this.totalBytes;
	}

	/**
	 * The snapshot stored under the key.
	 *
	 * @param key Cache key
	 */
	get(key: string): Buffer | undefined {
		return this.entries.get(key);
	}

	/**
	 * Keep a snapshot. A key that is already present keeps its first snapshot.
	 *
	 * @param key Cache key (`<cameraId>:<event timestamp>`)
	 * @param buf JPEG bytes
	 */
	add(key: string, buf: Buffer): void {
		if (this.entries.has(key) || buf.length > this.maxBytes) {
			return;
		}
		this.order.push(key);
		this.entries.set(key, buf);
		this.totalBytes += buf.length;
		while (this.order.length > this.maxEntries || this.totalBytes > this.maxBytes) {
			const oldest = this.order.shift();
			if (oldest === undefined) {
				break;
			}
			this.totalBytes -= this.entries.get(oldest)?.length ?? 0;
			this.entries.delete(oldest);
		}
	}
}
