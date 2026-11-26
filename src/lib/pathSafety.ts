/**
 * Validation of path fragments that come from outside the adapter (event payloads, states,
 * responses of other systems) before they become part of a request URL.
 *
 * The HTTP client resolves dot segments, so an unchecked "/../../users" appended to
 * `/api/v1/developer/system/static/` would turn the thumbnail proxy into an open proxy for the
 * whole controller API with the adapter's token. Everything here is allow-list based: what is
 * not explicitly valid is rejected.
 */

/** Top-level folders of the static-resource endpoint (API reference 9.5 and the event samples in 11.7). */
const STATIC_ROOTS = ['avatar', 'capture', 'preview', 'activities_resource'] as const;

const STATIC_PATH_MAX_LENGTH = 512;
/** One path segment: starts with an alphanumeric character, so "." / ".." / hidden names never match. */
const STATIC_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Normalise and validate a static-resource path such as `/preview/reader_<mac>_<door>_<ts>.jpg`.
 *
 * Accepted: an optional run of leading slashes, one of the documented root folders, then one or more
 * plain segments (letters, digits, `.`, `_`, `-`). Rejected: dot segments, empty segments, percent
 * encoding of any kind, backslashes, query/fragment, scheme or host, whitespace and control characters.
 *
 * @param raw Path as received (event payload or stored state)
 * @returns The path relative to `/system/static/` without leading slash, or `null` when it is not valid
 */
export function sanitizeStaticPath(raw: unknown): string | null {
	if (typeof raw !== 'string' || raw.length === 0 || raw.length > STATIC_PATH_MAX_LENGTH) {
		return null;
	}
	const relative = raw.replace(/^\/+/, '');
	const segments = relative.split('/');
	if (segments.length < 2 || !(STATIC_ROOTS as readonly string[]).includes(segments[0])) {
		return null;
	}
	for (const segment of segments) {
		if (!STATIC_SEGMENT.test(segment)) {
			return null;
		}
	}
	return segments.join('/');
}

/**
 * Whether a value is a UniFi Protect camera or event id that is safe to place into a URL path.
 * Protect ids are short alphanumeric tokens; anything else (dots, slashes, encoded characters, …) is refused.
 *
 * @param id Candidate id
 */
export function isSafeProtectId(id: unknown): id is string {
	return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

const PROTECT_API_PREFIX = '/proxy/protect/api/';

/**
 * Normalise the clip location reported by Protect to an absolute path below `/proxy/protect/api/`.
 *
 * The value is used as a request path on the Protect host with the session cookie attached, so it
 * must not be able to point anywhere else: no scheme or host (`//host`, `https://…`), no dot segments
 * (plain or percent-encoded), no backslashes, no control characters or whitespace, no fragment.
 *
 * @param raw `clipUrl` / `clip` of a Protect event
 * @returns The absolute request path including its query string, or `null` when it is not acceptable
 */
export function sanitizeProtectClipPath(raw: unknown): string | null {
	if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) {
		return null;
	}
	// printable ASCII without space, backslash, quotes, angle brackets and fragment marker
	if (!/^[A-Za-z0-9\-._~/?&=%:+,@!*'()]+$/.test(raw)) {
		return null;
	}
	const candidate = raw.startsWith('/') ? raw : `${PROTECT_API_PREFIX}${raw}`;
	const queryStart = candidate.indexOf('?');
	const path = queryStart === -1 ? candidate : candidate.slice(0, queryStart);
	if (!path.startsWith(PROTECT_API_PREFIX) || path.includes('//') || path.includes(':')) {
		return null;
	}
	let decoded: string;
	try {
		decoded = decodeURIComponent(path);
	} catch {
		return null;
	}
	if (decoded.includes('\\') || decoded.includes('%')) {
		// backslash or a second layer of encoding hidden behind percent-encoding
		return null;
	}
	for (const segment of decoded.split('/')) {
		if (segment === '.' || segment === '..') {
			return null;
		}
	}
	return candidate;
}
