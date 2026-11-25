/**
 * Stop signal of the adapter instance.
 *
 * Work that was started before the instance stopped (a request in flight, a timer that already fired,
 * an event that is being processed) continues after `onUnload` as soon as its `await` returns. From
 * then on it must not have any effect any more: no further request to the controller or to Protect,
 * no state or object write, no new timer, no "connected"/"initialized" log. The helpers below are the
 * one place that decides this:
 *
 * - the HTTP clients (`UnifiHttp`, `ProtectHttp`) refuse every new request once `isStopped()` is true,
 * - the state/object writes of the adapter and of `Library` go through wrappers that do the same,
 *
 * and both throw {@link StoppedError}. The error ends the remaining chain of the operation (the next
 * step is never reached); handlers recognise it with {@link isStoppedError} and end quietly.
 */

/** The instance is stopping: the operation was abandoned before its next effect. */
export class StoppedError extends Error {
	public constructor(message = 'the instance is stopping') {
		super(message);
		this.name = 'StoppedError';
	}
}

/**
 * Whether an error says that the instance stopped (and not that something failed).
 *
 * @param err Whatever was thrown
 */
export function isStoppedError(err: unknown): err is StoppedError {
	return err instanceof StoppedError;
}

/**
 * Throw {@link StoppedError} when the stop signal is set.
 *
 * @param isStopped The stop signal (absent: never stopped)
 */
export function throwIfStopped(isStopped: (() => boolean) | undefined): void {
	if (isStopped?.()) {
		throw new StoppedError();
	}
}
