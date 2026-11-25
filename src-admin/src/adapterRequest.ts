import type { ConfigGenericProps } from '@iobroker/json-config';
import { I18n } from '@iobroker/gui-components';

/** How long a component waits for the answer of the adapter before it gives up */
export const REQUEST_TIMEOUT_MS = 15_000;

export type AdapterRequestFailure = 'not-running' | 'no-response';

/** The request never reached a running adapter instance or was not answered */
export class AdapterRequestError extends Error {
	readonly reason: AdapterRequestFailure;

	constructor(reason: AdapterRequestFailure) {
		super(reason);
		this.name = 'AdapterRequestError';
		this.reason = reason;
	}
}

export type RequestContext = Pick<ConfigGenericProps, 'oContext' | 'alive'>;

function instanceId(ctx: RequestContext): string {
	return `unifi-access.${ctx.oContext.instance}`;
}

/**
 * `alive` of the props is false until the admin has read the state, so ask ourselves before we tell
 * the user that the instance does not run.
 *
 * @param ctx props of the component
 */
async function isInstanceAlive(ctx: RequestContext): Promise<boolean> {
	if (ctx.alive) {
		return true;
	}
	try {
		const state = await ctx.oContext.socket.getState(`system.adapter.${instanceId(ctx)}.alive`);
		return !!state?.val;
	} catch {
		return false;
	}
}

/**
 * Send a message to the own adapter instance and wait for the answer.
 *
 * `socket.sendTo()` has no timeout: without a running instance the promise stays pending (or the ws
 * client answers with the string `timeout`/`disconnected` much later), which left the components in
 * their loading state forever.
 *
 * @param ctx props of the component
 * @param command message command, see `onMessage` of the adapter
 * @param payload message payload
 * @param timeoutMs give up after this time
 */
export async function requestAdapter<T>(
	ctx: RequestContext,
	command: string,
	payload: Record<string, unknown> = {},
	timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<T> {
	if (!(await isInstanceAlive(ctx))) {
		throw new AdapterRequestError('not-running');
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const answer: unknown = await Promise.race([
			ctx.oContext.socket.sendTo(instanceId(ctx), command, payload),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new AdapterRequestError('no-response')), timeoutMs);
			}),
		]);
		// Answers of the ws client itself, not of the adapter
		if (answer === 'timeout' || answer === 'disconnected') {
			throw new AdapterRequestError('no-response');
		}
		return answer as T;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Text for the user if a request failed
 *
 * @param err what `requestAdapter` threw
 * @param fallbackKey translation key that is used if the error has no message of its own
 */
export function describeRequestError(err: unknown, fallbackKey: string): string {
	if (err instanceof AdapterRequestError) {
		return I18n.t(err.reason === 'not-running' ? 'adapter_not_running' : 'adapter_no_response');
	}
	const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
	return message || I18n.t(fallbackKey);
}
