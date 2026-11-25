/**
 * CA certificate from the connection settings.
 *
 * The admin field may hold what a browser made of a pasted PEM: line breaks removed or replaced by
 * spaces, CRLF, surrounding blanks, several certificates in a row. Node silently ignores a PEM it
 * cannot parse (`tls.createSecureContext({ ca })` does not throw) — strict TLS verification would then
 * fail for no visible reason. Everything that can be recovered is recovered here, and what cannot is
 * reported.
 */

import { X509Certificate } from 'node:crypto';
import { rootCertificates } from 'node:tls';

const BLOCK = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;

export interface ParsedCaCert {
	/** Every usable certificate as clean PEM (64-character lines). */
	certificates: string[];
	/** One line per part that could not be used (empty when everything was fine). */
	problems: string[];
}

/**
 * Split and repair the PEM text of the CA field.
 *
 * @param raw Value of the `caCert` setting (any type, may be empty)
 */
export function parseCaCert(raw: unknown): ParsedCaCert {
	const result: ParsedCaCert = { certificates: [], problems: [] };
	if (typeof raw !== 'string' || raw.trim() === '') {
		return result;
	}
	const text = raw.replace(/\r\n?/g, '\n');
	const blocks = [...text.matchAll(BLOCK)];
	if (blocks.length === 0) {
		result.problems.push('no "-----BEGIN CERTIFICATE-----" … "-----END CERTIFICATE-----" block found');
		return result;
	}
	blocks.forEach((block, index) => {
		const label = blocks.length > 1 ? `certificate ${index + 1}: ` : '';
		const body = block[1].replace(/\s+/g, '');
		if (body === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) {
			result.problems.push(`${label}the content is not base64`);
			return;
		}
		const lines = body.match(/.{1,64}/g) ?? [];
		const pem = `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
		try {
			new X509Certificate(pem);
		} catch (err) {
			result.problems.push(
				`${label}not a readable certificate (${err instanceof Error ? err.message : String(err)})`,
			);
			return;
		}
		result.certificates.push(pem);
	});
	return result;
}

/**
 * Certificates a TLS client trusts: the system CAs plus the configured ones. Node's `ca` option
 * replaces the system CAs instead of adding to them — with only the controller CA a console whose
 * port 443 carries a publicly signed certificate (Protect) could no longer be verified.
 *
 * @param raw Value of the `caCert` setting
 * @returns `undefined` when no usable certificate is configured (Node then uses the system CAs)
 */
export function trustedCertificates(raw: unknown): string[] | undefined {
	const { certificates } = parseCaCert(raw);
	return certificates.length > 0 ? [...rootCertificates, ...certificates] : undefined;
}
