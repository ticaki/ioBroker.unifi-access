/**
 * The timer functions of the adapter instance (`adapter.setTimeout`, `adapter.setInterval`, …),
 * reduced to what the helper classes need. js-controller tracks these timers and clears them when
 * the adapter stops; classes in `src/lib` get this interface injected instead of the whole adapter
 * so they stay testable with a small fake.
 */
export interface TimerHost {
	/** Run `callback` once after `ms` milliseconds. May return `undefined` while the adapter is stopping. */
	setTimeout: (callback: () => void, ms: number) => unknown;
	clearTimeout: (handle: unknown) => void;
	/** Run `callback` every `ms` milliseconds. May return `undefined` while the adapter is stopping. */
	setInterval: (callback: () => void, ms: number) => unknown;
	clearInterval: (handle: unknown) => void;
}
