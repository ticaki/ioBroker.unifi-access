/**
 * Rate limit for warnings caused by requests from outside (port scanners, wrong clients, a dashboard
 * that keeps polling a broken URL). Without it every rejected request writes a warning and real
 * warnings drown in the log.
 *
 * Per key the first warning goes out; repeats within the window go to debug only and are counted. The
 * next warning after the window says how many were suppressed. No timers: a suppressed series that
 * simply stops is not reported again (it is in the debug log).
 */

export interface ThrottledLogger {
	debug: (msg: string) => void;
	warn: (msg: string) => void;
}

export class LogThrottle {
	private readonly last = new Map<string, { at: number; suppressed: number }>();

	/**
	 * @param logger Target logger
	 * @param windowMs Minimum distance between two warnings of the same key (default 60 s)
	 * @param now Clock (tests)
	 */
	constructor(
		private readonly logger: ThrottledLogger,
		private readonly windowMs = 60_000,
		private readonly now: () => number = Date.now,
	) {}

	/**
	 * Warn, unless the same kind of warning was given within the window.
	 *
	 * @param key Kind of the warning (e.g. "signature")
	 * @param message Text of the warning
	 */
	warn(key: string, message: string): void {
		const now = this.now();
		const entry = this.last.get(key);
		if (entry && now - entry.at < this.windowMs) {
			entry.suppressed += 1;
			this.logger.debug(message);
			return;
		}
		const suppressed = entry?.suppressed ?? 0;
		if (this.last.size >= 100 && !entry) {
			// keys are a fixed set in practice; never let the map grow without bound
			this.last.clear();
		}
		this.last.set(key, { at: now, suppressed: 0 });
		this.logger.warn(
			suppressed > 0
				? `${message} (${suppressed} more like this in the last ${Math.round((now - (entry?.at ?? now)) / 1000)} s, logged at debug level)`
				: message,
		);
	}
}
