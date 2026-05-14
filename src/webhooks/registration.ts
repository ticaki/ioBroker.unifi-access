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
 * Ensure a webhook endpoint matching `publicUrl` is registered with the controller.
 * The list endpoint returns the secret for every existing endpoint, so we can always
 * use the current secret directly — no delete+recreate needed just to recover it.
 * Only registers a new endpoint when none with a matching URL is found.
 *
 * @param options Controller HTTP client, public URL, event list and logger
 */
export async function ensureRegistration(
	options: RegistrationOptions,
): Promise<RegistrationResult> {
	const events = options.events ?? DEFAULT_WEBHOOK_EVENTS;
	const list = await options.http.listWebhookEndpoints();
	const existing = list.find(e => e.endpoint === options.publicUrl);
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
	const created = await options.http.createWebhookEndpoint({
		name: options.name,
		endpoint: options.publicUrl,
		events: [...events],
	});
	if (!created?.id || !created?.secret) {
		throw new Error('Webhook endpoint created but response did not include id/secret.');
	}
	options.logger.info(`Registered new webhook endpoint ${created.id} for ${options.publicUrl}.`);
	return { id: created.id, secret: created.secret, endpoint: created.endpoint };
}

export async function reregister(options: RegistrationOptions, storedId: string | null): Promise<RegistrationResult> {
	if (storedId) {
		try {
			await options.http.deleteWebhookEndpoint(storedId);
		} catch (err) {
			options.logger.warn(`Failed to delete previous webhook endpoint: ${(err as Error).message}`);
		}
	}
	const created = await options.http.createWebhookEndpoint({
		name: options.name,
		endpoint: options.publicUrl,
		events: [...(options.events ?? DEFAULT_WEBHOOK_EVENTS)],
	});
	if (!created?.id || !created?.secret) {
		throw new Error('Webhook endpoint created but response did not include id/secret.');
	}
	return { id: created.id, secret: created.secret, endpoint: created.endpoint };
}
