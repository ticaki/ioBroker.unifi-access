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
 * If one already exists for the same URL, it is reused (we cannot read the secret back
 * from list — caller must keep its previously-stored secret). If none matches, register
 * a fresh endpoint and return the new id+secret.
 *
 * Returns null if a match was found but the caller has no stored secret (forces a
 * delete+recreate via reregister()).
 *
 * @param options      Controller HTTP client, public URL, event list and logger
 * @param storedSecret Previously persisted webhook secret (or null if unknown)
 * @param storedId     Previously persisted endpoint id (or null if unknown)
 */
export async function ensureRegistration(
	options: RegistrationOptions,
	storedSecret: string | null,
	storedId: string | null,
): Promise<RegistrationResult | null> {
	const events = options.events ?? DEFAULT_WEBHOOK_EVENTS;
	const list = await options.http.listWebhookEndpoints();
	const existing = list.find(e => e.endpoint === options.publicUrl);
	if (existing) {
		if (storedId === existing.id && storedSecret) {
			options.logger.debug(`Webhook endpoint already registered: ${existing.id}`);
			return { id: existing.id, secret: storedSecret, endpoint: existing.endpoint };
		}
		options.logger.info(`Webhook endpoint exists but secret unknown — recreating to obtain a fresh secret.`);
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
