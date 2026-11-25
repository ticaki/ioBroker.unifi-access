/**
 * Recognise TLS certificate verification failures so the log can say what to do about them
 * instead of a generic "network error".
 */

const TLS_CERTIFICATE_ERROR_CODES = new Set([
	'DEPTH_ZERO_SELF_SIGNED_CERT',
	'SELF_SIGNED_CERT_IN_CHAIN',
	'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
	'UNABLE_TO_GET_ISSUER_CERT',
	'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
	'CERT_HAS_EXPIRED',
	'CERT_NOT_YET_VALID',
	'CERT_UNTRUSTED',
	'CERT_REJECTED',
	'CERT_SIGNATURE_FAILURE',
	'CERT_CHAIN_TOO_LONG',
	'INVALID_CA',
	'HOSTNAME_MISMATCH',
	'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * The OpenSSL / Node.js error code when `err` (or its cause) is a certificate verification failure.
 *
 * @param err Error thrown by axios, ws or the TLS socket
 * @returns The code, e.g. `DEPTH_ZERO_SELF_SIGNED_CERT`, or `undefined` for any other error
 */
export function tlsCertificateErrorCode(err: unknown): string | undefined {
	let current: unknown = err;
	for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
		const code = (current as { code?: unknown }).code;
		if (typeof code === 'string' && TLS_CERTIFICATE_ERROR_CODES.has(code)) {
			return code;
		}
		current = (current as { cause?: unknown }).cause;
	}
	return undefined;
}

/**
 * Whether the code says that the certificate is valid but not issued for the host that was contacted.
 *
 * @param code Code from {@link tlsCertificateErrorCode}
 */
export function isHostnameMismatch(code: string | undefined): boolean {
	return code === 'ERR_TLS_CERT_ALTNAME_INVALID' || code === 'HOSTNAME_MISMATCH';
}

/**
 * What the user can do about a rejected certificate. A host name mismatch is not cured by storing a CA
 * certificate — the chain may well be trusted already; the address used does not appear in the certificate.
 *
 * @param code Code from {@link tlsCertificateErrorCode}
 * @param where Which connection failed: the Access controller or the Protect console
 */
export function tlsAdvice(code: string | undefined, where: 'controller' | 'protect'): string {
	const toggle =
		where === 'controller'
			? '"Verify TLS certificate" in the connection settings'
			: '"Verify TLS certificate" on the Protect tab';
	if (isHostnameMismatch(code)) {
		return (
			`The certificate is not issued for the configured host name / IP address. Enter the controller host exactly ` +
			`as it appears in the certificate (subject alternative name), or disable ${toggle}.`
		);
	}
	const device = where === 'controller' ? 'controller' : 'console';
	return `Either disable ${toggle} or store the CA certificate of the ${device} in the connection settings.`;
}
