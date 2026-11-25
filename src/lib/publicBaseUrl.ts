/**
 * Optional setting `publicBaseUrl`: the address under which clients and the UniFi controller reach
 * the built-in HTTP server when it is not the listen address itself (reverse proxy with TLS, port
 * forwarding, Docker bridge, several network cards). Used for the registered webhook URL, the media
 * URLs written to states and `getServerInfo`.
 */

export interface NormalizedPublicBaseUrl {
	/** `scheme://host[:port][/path]` without trailing slash, or null (empty / unusable). */
	url: string | null;
	/** Why a non-empty value is not used. */
	problem?: string;
}

/** Same rule as the validator of the admin field (admin/jsonConfig.json, `publicBaseUrl`). */
export const PUBLIC_BASE_URL_PATTERN = /^https?:\/\/[^\s/?#]+(\/[A-Za-z0-9._~-]+)*$/i;

/**
 * Check and normalise the setting: blanks around it and trailing slashes are dropped; scheme http or
 * https, a host, optionally a port and a path prefix of plain segments — no query, fragment or
 * credentials.
 *
 * @param raw Value of the setting
 */
export function normalizePublicBaseUrl(raw: unknown): NormalizedPublicBaseUrl {
	if (typeof raw !== 'string') {
		return { url: null };
	}
	const value = raw.trim().replace(/\/+$/, '');
	if (value === '') {
		return { url: null };
	}
	if (!PUBLIC_BASE_URL_PATTERN.test(value)) {
		return {
			url: null,
			problem: 'expected http(s)://host[:port][/path] without query, fragment or blanks',
		};
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return { url: null, problem: 'not a valid URL' };
	}
	if (parsed.username || parsed.password) {
		return { url: null, problem: 'credentials in the URL are not allowed' };
	}
	if (parsed.port === '0') {
		// accepted by the URL parser, but nothing can be reached there
		return { url: null, problem: 'port 0 is not a usable port (1-65535)' };
	}
	const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
	return { url: `${parsed.protocol}//${parsed.host}${path}` };
}
