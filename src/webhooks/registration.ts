import type { UnifiHttp } from '../lib/unifiHttp';

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
	publicUrl: string;
	name: string;
	events?: readonly string[];
	logger: { debug: (msg: string) => void; info: (msg: string) => void; warn: (msg: string) => void };
}

/**
 * Delete all webhook endpoints on the controller that match either `id` or `url`.
 * Errors are swallowed and logged as warnings so the caller can proceed to re-create.
 *
 * @param http
 * @param url
 * @param extraId
 * @param logger
 */
async function deleteAllMatching(
	http: UnifiHttp,
	url: string,
	extraId: string | null,
	logger: RegistrationOptions['logger'],
): Promise<void> {
	let list: Awaited<ReturnType<UnifiHttp['listWebhookEndpoints']>>;
	try {
		list = await http.listWebhookEndpoints();
	} catch (err) {
		logger.warn(`Could not list webhook endpoints before delete: ${(err as Error).message}`);
		return;
	}
	const toDelete = new Set<string>();
	for (const e of list) {
		if (e.endpoint === url || e.id === extraId) {
			toDelete.add(e.id);
		}
	}
	for (const id of toDelete) {
		try {
			await http.deleteWebhookEndpoint(id);
			logger.info(`Deleted webhook endpoint ${id}.`);
		} catch (err) {
			logger.warn(`Failed to delete webhook endpoint ${id}: ${(err as Error).message}`);
		}
	}
}

/**
 * Ensure a webhook endpoint matching `publicUrl` is registered with the controller.
 * The list endpoint returns the secret for every existing endpoint, so the secret is
 * read directly from there — no delete+recreate needed just to recover it.
 * Only registers a new endpoint when none with a matching URL (and secret) is found.
 *
 * @param options
 */
export async function ensureRegistration(options: RegistrationOptions): Promise<RegistrationResult> {
	const events = options.events ?? DEFAULT_WEBHOOK_EVENTS;
	const list = await options.http.listWebhookEndpoints();
	const existing = list.find(e => e.endpoint === options.publicUrl);

	// Clean up stale endpoints registered under the same name but a different URL
	// (e.g. from a previous network config or Docker IP change).
	for (const e of list) {
		if (e.endpoint !== options.publicUrl && e.name === options.name) {
			options.logger.info(`Removing stale webhook endpoint ${e.id} with outdated URL ${e.endpoint}.`);
			try {
				await options.http.deleteWebhookEndpoint(e.id);
			} catch (err) {
				options.logger.warn(`Could not remove stale endpoint ${e.id}: ${(err as Error).message}`);
			}
		}
	}

	if (existing?.id && existing?.secret) {
		options.logger.debug(`Webhook endpoint already registered: ${existing.id}`);
		return { id: existing.id, secret: existing.secret, endpoint: existing.endpoint };
	}
	if (existing) {
		options.logger.info(`Webhook endpoint exists but list did not return a secret — recreating.`);
		try {
			await options.http.deleteWebhookEndpoint(existing.id);
		} catch (err) {
			options.logger.warn(`Failed to delete stale webhook endpoint: ${(err as Error).message}`);
		}
	}
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

export async function reregister(options: RegistrationOptions, storedId: string | null): Promise<RegistrationResult> {
	// Delete by stored ID and by URL — cleans up stale or duplicate entries.
	await deleteAllMatching(options.http, options.publicUrl, storedId, options.logger);
	const result = await options.http.createWebhookEndpoint({
		name: options.name,
		endpoint: options.publicUrl,
		events: [...(options.events ?? DEFAULT_WEBHOOK_EVENTS)],
	});
	if (result.code === 'CODE_DEVICE_WEBHOOK_ENDPOINT_DUPLICATED') {
		// Delete failed silently above — force-delete by URL and retry once.
		options.logger.warn(`Webhook endpoint still duplicated after delete — retrying cleanup.`);
		await deleteAllMatching(options.http, options.publicUrl, null, options.logger);
		const retry = await options.http.createWebhookEndpoint({
			name: options.name,
			endpoint: options.publicUrl,
			events: [...(options.events ?? DEFAULT_WEBHOOK_EVENTS)],
		});
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
