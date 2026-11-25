/**
 * The rules the adapter applies to the settings of its built-in HTTP server, mirrored for the URL the
 * settings page shows. They have to stay identical to the adapter:
 *
 * - {@link normalizePublicBaseUrl} ↔ `normalizePublicBaseUrl` in `src/lib/publicBaseUrl.ts`
 * - {@link normalizeWebhookPath} ↔ `normalizeWebhookPath` in `src/webhooks/genericWebhookServer.ts`
 * - {@link normalizePort} ↔ `normalizePort` in `src/lib/controlValues.ts`
 *
 * `test/contract/frontendContract.test.ts` runs this file against the adapter functions. That is why
 * it must not import anything.
 */

/** Same rule as `src/lib/publicBaseUrl.ts` and the validator of the admin field `publicBaseUrl`. */
export const PUBLIC_BASE_URL_PATTERN = /^https?:\/\/[^\s/?#]+(\/[A-Za-z0-9._~-]+)*$/i;

/** Default listen path of the generic webhook (adapter: `DEFAULT_GENERIC_WEBHOOK_PATH`). */
export const DEFAULT_GENERIC_WEBHOOK_PATH = '/webhook';

/** Default port of the built-in HTTP server. */
export const DEFAULT_LISTEN_PORT = 8095;

/**
 * The public base URL the adapter uses for a value of the setting: blanks around it and trailing
 * slashes dropped, `scheme://host[:port][/path]`; `null` if empty or not usable (the adapter then
 * builds the URLs from listen address and port).
 *
 * @param raw value of the setting `publicBaseUrl`
 */
export function normalizePublicBaseUrl(raw: unknown): string | null {
	if (typeof raw !== 'string') {
		return null;
	}
	const value = raw.trim().replace(/\/+$/, '');
	if (value === '' || !PUBLIC_BASE_URL_PATTERN.test(value)) {
		return null;
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return null;
	}
	if (parsed.username || parsed.password) {
		return null;
	}
	const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
	return `${parsed.protocol}//${parsed.host}${path}`;
}

/**
 * The listen path of the generic webhook as the adapter matches it: blanks around it, a query or
 * fragment and repeated slashes dropped, a missing leading `/` added, empty means the default.
 *
 * @param raw value of the setting `genericWebhookPath`
 */
export function normalizeWebhookPath(raw: unknown): string {
	let path = typeof raw === 'string' ? raw.trim() : '';
	path = path.split(/[?#]/)[0];
	if (path === '') {
		return DEFAULT_GENERIC_WEBHOOK_PATH;
	}
	if (!path.startsWith('/')) {
		path = `/${path}`;
	}
	return path.replace(/\/{2,}/g, '/');
}

/**
 * The port the adapter listens on: an integer 1…65535 (also as digit string), otherwise the default.
 *
 * @param raw value of the setting `listenPort`
 */
export function normalizePort(raw: unknown): number {
	const n = typeof raw === 'string' && /^\d{1,5}$/.test(raw.trim()) ? Number(raw.trim()) : raw;
	return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65_535 ? n : DEFAULT_LISTEN_PORT;
}
