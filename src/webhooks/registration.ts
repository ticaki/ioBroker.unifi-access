import type { UnifiHttp } from '../lib/unifiHttp';
import type { UnifiWebhookEndpoint } from '../lib/types';

export const DEFAULT_WEBHOOK_EVENTS = [
	'access.doorbell.incoming',
	'access.doorbell.completed',
	'access.doorbell.incoming.REN',
	'access.device.dps_status',
	'access.door.unlock',
	'access.device.emergency_status',
	'access.unlock_schedule.activate',
	'access.unlock_schedule.deactivate',
	'access.temporary_unlock.start',
	'access.temporary_unlock.end',
	'access.visitor.status.changed',
] as const;

export interface RegistrationResult {
	id: string;
	secret: string;
	endpoint: string;
}

export interface RegistrationOptions {
	http: UnifiHttp;
	/** URL the controller shall deliver events to. */
	publicUrl: string;
	/**
	 * Name of this installation's endpoint. It should identify the installation (instance and host):
	 * endpoints are only cleaned up when they carry exactly this name or the stored id, so two
	 * installations at the same controller never remove each other's endpoint.
	 */
	name: string;
	/** Id of the endpoint registered by an earlier start (from the instance configuration). */
	storedId?: string | null;
	/** Secret of that endpoint (from the instance configuration). */
	storedSecret?: string | null;
	events?: readonly string[];
	logger: { debug: (msg: string) => void; info: (msg: string) => void; warn: (msg: string) => void };
	/**
	 * True once the adapter stops: {@link reregister} then sends no further DELETE or POST to the
	 * controller and fails with {@link RegistrationStoppedError}.
	 */
	isStopped?: () => boolean;
}

/** {@link reregister} was abandoned because the adapter stopped. */
export class RegistrationStoppedError extends Error {
	public constructor() {
		super('Webhook re-registration abandoned: the instance is stopping');
		this.name = 'RegistrationStoppedError';
	}
}

function sameEvents(a: readonly string[] | undefined, b: readonly string[]): boolean {
	if (!Array.isArray(a)) {
		return false;
	}
	const left = new Set(a);
	const right = new Set(b);
	return left.size === right.size && [...left].every(event => right.has(event));
}

/**
 * Whether an endpoint belongs to this installation: it carries this installation's name or it is the
 * endpoint whose id is stored in the instance configuration. Endpoints of other integrations, of
 * other ioBroker hosts or with the name scheme of earlier versions (unless it is the stored one)
 * are never touched.
 *
 * @param endpoint Endpoint from the controller's list
 * @param options Registration options (name and stored id)
 */
function isOwn(endpoint: UnifiWebhookEndpoint, options: RegistrationOptions): boolean {
	return endpoint.name === options.name || (!!options.storedId && endpoint.id === options.storedId);
}

async function deleteEndpoints(
	http: UnifiHttp,
	ids: Iterable<string>,
	logger: RegistrationOptions['logger'],
	what: string,
): Promise<void> {
	for (const id of ids) {
		try {
			await http.deleteWebhookEndpoint(id);
			logger.info(`Deleted ${what} ${id}.`);
		} catch (err) {
			logger.warn(`Failed to delete ${what} ${id}: ${(err as Error).message}`);
		}
	}
}

async function createEndpoint(options: RegistrationOptions, events: readonly string[]): Promise<RegistrationResult> {
	const result = await options.http.createWebhookEndpoint({
		name: options.name,
		endpoint: options.publicUrl,
		events: [...events],
	});
	if (result.code === 'CODE_DEVICE_WEBHOOK_ENDPOINT_DUPLICATED') {
		// Endpoint was registered between our list and our create — fetch the current list and reuse it.
		options.logger.info(`Webhook endpoint already exists on controller (race/stale) — fetching from list.`);
		const refreshed = await options.http.listWebhookEndpoints();
		const dup = refreshed.find(e => e.endpoint === options.publicUrl);
		if (dup?.id && dup?.secret) {
			return { id: dup.id, secret: dup.secret, endpoint: dup.endpoint };
		}
		throw new Error('Webhook endpoint is duplicated on controller but could not be found in the list.');
	}
	if (!result.endpoint?.id || !result.endpoint?.secret) {
		throw new Error('Webhook endpoint created but response did not include id/secret.');
	}
	options.logger.info(`Registered new webhook endpoint ${result.endpoint.id} for ${options.publicUrl}.`);
	return { id: result.endpoint.id, secret: result.endpoint.secret, endpoint: result.endpoint.endpoint };
}

/**
 * Bring an existing endpoint in line with name, URL and event list via PUT /webhooks/endpoints/:id
 * (API reference 11.5). The endpoint keeps its id and — per the documented response — its secret.
 *
 * @param options Registration options
 * @param endpoint The endpoint to update
 * @param events Events the endpoint has to deliver
 * @returns The secret reported by the controller for the updated endpoint, if any
 */
async function updateEndpoint(
	options: RegistrationOptions,
	endpoint: UnifiWebhookEndpoint,
	events: readonly string[],
): Promise<string | undefined> {
	const updated = await options.http.updateWebhookEndpoint(endpoint.id, {
		name: options.name,
		endpoint: options.publicUrl,
		events: [...events],
		...(endpoint.headers && Object.keys(endpoint.headers).length > 0 ? { headers: endpoint.headers } : {}),
	});
	return typeof updated?.secret === 'string' && updated.secret ? updated.secret : undefined;
}

/**
 * Ensure a webhook endpoint for `publicUrl` is registered with the controller and delivers all
 * required events.
 *
 * - An endpoint that already exists for the URL is reused; a differing event list or name is brought
 *   in line with an update (PUT) instead of delete + create, so id and secret stay the same and
 *   nothing has to be written to the instance configuration (no adapter restart).
 * - An endpoint of this installation with an outdated URL (changed IP) is updated the same way.
 * - Only endpoints of this installation are ever changed or removed (see {@link isOwn}).
 * - The list endpoint returns the secret of every endpoint. Should a controller omit it, the secret
 *   stored for the same endpoint id is used; only without any secret the endpoint is recreated.
 *
 * @param options Registration options
 */
export async function ensureRegistration(options: RegistrationOptions): Promise<RegistrationResult> {
	const events = options.events ?? DEFAULT_WEBHOOK_EVENTS;
	const { logger } = options;
	const list = await options.http.listWebhookEndpoints();

	let current = list.find(e => e.endpoint === options.publicUrl);
	const staleOwn = list.filter(e => e.endpoint !== options.publicUrl && isOwn(e, options));

	if (!current && staleOwn.length > 0) {
		// Our endpoint points to an outdated URL (e.g. the IP of this host changed): move it.
		const candidate = staleOwn.find(e => e.id === options.storedId) ?? staleOwn[0];
		const secret = candidate.secret || (candidate.id === options.storedId ? options.storedSecret : undefined);
		if (secret) {
			try {
				const updatedSecret = await updateEndpoint(options, candidate, events);
				logger.info(
					`Webhook endpoint ${candidate.id} moved from outdated URL ${candidate.endpoint} to ${options.publicUrl}.`,
				);
				staleOwn.splice(staleOwn.indexOf(candidate), 1);
				current = {
					...candidate,
					name: options.name,
					endpoint: options.publicUrl,
					events: [...events],
					secret: updatedSecret ?? secret,
				};
			} catch (err) {
				logger.warn(
					`Could not update webhook endpoint ${candidate.id} (${(err as Error).message}) — registering a new one.`,
				);
			}
		}
	}

	// Remove what is left of this installation's endpoints with an outdated URL.
	for (const e of staleOwn) {
		logger.info(`Removing stale webhook endpoint ${e.id} with outdated URL ${e.endpoint}.`);
		try {
			await options.http.deleteWebhookEndpoint(e.id);
		} catch (err) {
			logger.warn(`Could not remove stale endpoint ${e.id}: ${(err as Error).message}`);
		}
	}

	if (current) {
		const secret = current.secret || (current.id === options.storedId ? options.storedSecret : undefined);
		if (current.id && secret) {
			if (!sameEvents(current.events, events) || current.name !== options.name) {
				try {
					const updatedSecret = await updateEndpoint(options, current, events);
					logger.info(`Webhook endpoint ${current.id} updated (name / subscribed events).`);
					return { id: current.id, secret: updatedSecret ?? secret, endpoint: options.publicUrl };
				} catch (err) {
					logger.warn(
						`Webhook endpoint ${current.id} could not be updated: ${(err as Error).message} — some event types may not be delivered.`,
					);
				}
			} else {
				logger.debug(`Webhook endpoint already registered: ${current.id}`);
			}
			return { id: current.id, secret, endpoint: current.endpoint };
		}
		logger.info(`Webhook endpoint exists but its secret is not available — recreating.`);
		try {
			await options.http.deleteWebhookEndpoint(current.id);
		} catch (err) {
			logger.warn(`Failed to delete stale webhook endpoint: ${(err as Error).message}`);
		}
	}
	return createEndpoint(options, events);
}

/**
 * Delete this installation's endpoint(s) and register a fresh one — yields a new secret.
 * Removed are: the endpoint for `publicUrl`, the endpoint with the stored id and endpoints carrying
 * this installation's name. Everything else on the controller is left alone.
 *
 * @param options Registration options
 * @param storedId Id of the endpoint registered earlier (overrides `options.storedId`)
 */
export async function reregister(options: RegistrationOptions, storedId: string | null): Promise<RegistrationResult> {
	const events = options.events ?? DEFAULT_WEBHOOK_EVENTS;
	const scoped: RegistrationOptions = { ...options, storedId };
	const stopCheck = (): void => {
		if (options.isStopped?.()) {
			throw new RegistrationStoppedError();
		}
	};
	const cleanup = async (): Promise<void> => {
		let list: UnifiWebhookEndpoint[];
		try {
			list = await options.http.listWebhookEndpoints();
		} catch (err) {
			options.logger.warn(`Could not list webhook endpoints before delete: ${(err as Error).message}`);
			return;
		}
		stopCheck();
		const ids = new Set(list.filter(e => e.endpoint === options.publicUrl || isOwn(e, scoped)).map(e => e.id));
		await deleteEndpoints(options.http, ids, options.logger, 'webhook endpoint');
	};

	stopCheck();
	await cleanup();
	stopCheck();
	const payload = { name: options.name, endpoint: options.publicUrl, events: [...events] };
	const result = await options.http.createWebhookEndpoint(payload);
	if (result.code === 'CODE_DEVICE_WEBHOOK_ENDPOINT_DUPLICATED') {
		// Delete failed silently above — clean up and retry once.
		options.logger.warn(`Webhook endpoint still duplicated after delete — retrying cleanup.`);
		await cleanup();
		stopCheck();
		const retry = await options.http.createWebhookEndpoint(payload);
		if (!retry.endpoint?.id || !retry.endpoint?.secret) {
			throw new Error(
				'Webhook endpoint re-registration failed: response did not include id/secret after duplicate cleanup.',
			);
		}
		return { id: retry.endpoint.id, secret: retry.endpoint.secret, endpoint: retry.endpoint.endpoint };
	}
	if (!result.endpoint?.id || !result.endpoint?.secret) {
		throw new Error('Webhook endpoint created but response did not include id/secret.');
	}
	return { id: result.endpoint.id, secret: result.endpoint.secret, endpoint: result.endpoint.endpoint };
}
