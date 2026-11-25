'use strict';

/**
 * Minimal self-signed X.509 certificate generator (ECDSA P-256 / SHA-256).
 *
 * The real UniFi Access API server uses a "self-generated and untrusted" certificate
 * (api_reference 2.6). The mock mirrors that: the certificate is created at runtime,
 * nothing secret is checked into the repository and no external tool (openssl) or
 * extra npm dependency is needed — only node:crypto plus a few lines of DER encoding.
 */

const crypto = require('node:crypto');
const net = require('node:net');

const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const OID_COMMON_NAME = '2.5.4.3';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';

function derLength(length) {
	if (length < 0x80) {
		return Buffer.from([length]);
	}
	const bytes = [];
	let rest = length;
	while (rest > 0) {
		bytes.unshift(rest & 0xff);
		rest >>= 8;
	}
	return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, ...content) {
	const body = Buffer.concat(content);
	return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const sequence = (...content) => tlv(0x30, ...content);
const set = (...content) => tlv(0x31, ...content);
const octetString = content => tlv(0x04, content);
const bitString = content => tlv(0x03, Buffer.from([0x00]), content);
const utf8String = text => tlv(0x0c, Buffer.from(text, 'utf8'));
const boolean = value => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));

function oid(dotted) {
	const parts = dotted.split('.').map(Number);
	const bytes = [40 * parts[0] + parts[1]];
	for (const value of parts.slice(2)) {
		const chunk = [value & 0x7f];
		let rest = value >>> 7;
		while (rest > 0) {
			chunk.unshift((rest & 0x7f) | 0x80);
			rest >>>= 7;
		}
		bytes.push(...chunk);
	}
	return tlv(0x06, Buffer.from(bytes));
}

function positiveInteger(buffer) {
	let value = buffer;
	while (value.length > 1 && value[0] === 0x00 && (value[1] & 0x80) === 0) {
		value = value.subarray(1);
	}
	if (value[0] & 0x80) {
		value = Buffer.concat([Buffer.from([0x00]), value]);
	}
	return tlv(0x02, value);
}

function utcTime(date) {
	const pad = n => String(n).padStart(2, '0');
	const text =
		pad(date.getUTCFullYear() % 100) +
		pad(date.getUTCMonth() + 1) +
		pad(date.getUTCDate()) +
		pad(date.getUTCHours()) +
		pad(date.getUTCMinutes()) +
		pad(date.getUTCSeconds()) +
		'Z';
	return tlv(0x17, Buffer.from(text, 'ascii'));
}

function ipv6ToBuffer(address) {
	const [head, tail] = address.split('::');
	const headGroups = head ? head.split(':') : [];
	const tailGroups = tail ? tail.split(':') : [];
	const missing = address.includes('::') ? 8 - headGroups.length - tailGroups.length : 0;
	const groups = [...headGroups, ...new Array(missing).fill('0'), ...tailGroups];
	const out = Buffer.alloc(16);
	groups.forEach((group, index) => out.writeUInt16BE(Number.parseInt(group || '0', 16), index * 2));
	return out;
}

function generalName(name) {
	if (net.isIPv4(name)) {
		return tlv(0x87, Buffer.from(name.split('.').map(Number)));
	}
	if (net.isIPv6(name)) {
		return tlv(0x87, ipv6ToBuffer(name));
	}
	return tlv(0x82, Buffer.from(name, 'ascii'));
}

function toPem(label, der) {
	const base64 = der.toString('base64').replace(/(.{64})/g, '$1\n');
	return `-----BEGIN ${label}-----\n${base64.trimEnd()}\n-----END ${label}-----\n`;
}

/**
 * Create a fresh key pair and a matching self-signed certificate.
 *
 * @param {object} [options] Certificate options
 * @param {string} [options.commonName] Subject / issuer common name
 * @param {string[]} [options.altNames] DNS names and IP addresses for the subjectAltName extension
 * @param {number} [options.days] Validity in days (starting one hour in the past)
 * @returns {{ key: string, cert: string }} PEM encoded private key and certificate
 */
function createSelfSignedCert(options = {}) {
	const commonName = options.commonName ?? 'unifi-access-mock';
	const altNames = options.altNames ?? ['localhost', '127.0.0.1', '::1'];
	const days = options.days ?? 7;

	const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

	const signatureAlgorithm = sequence(oid(OID_ECDSA_SHA256));
	const name = sequence(set(sequence(oid(OID_COMMON_NAME), utf8String(commonName))));
	const notBefore = new Date(Date.now() - 60 * 60 * 1000);
	const notAfter = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

	const extensions = sequence(
		sequence(oid(OID_SUBJECT_ALT_NAME), octetString(sequence(...altNames.map(generalName)))),
		// CA:TRUE so the very same certificate can be handed to a client as its trust anchor (`ca`)
		sequence(oid(OID_BASIC_CONSTRAINTS), boolean(true), octetString(sequence(boolean(true)))),
	);

	const tbsCertificate = sequence(
		tlv(0xa0, tlv(0x02, Buffer.from([0x02]))), // version: v3
		positiveInteger(crypto.randomBytes(16)),
		signatureAlgorithm,
		name, // issuer
		sequence(utcTime(notBefore), utcTime(notAfter)),
		name, // subject
		publicKey.export({ type: 'spki', format: 'der' }),
		tlv(0xa3, extensions),
	);

	const signature = crypto.sign('sha256', tbsCertificate, privateKey);
	const certificate = sequence(tbsCertificate, signatureAlgorithm, bitString(signature));

	return {
		key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
		cert: toPem('CERTIFICATE', certificate),
	};
}

module.exports = { createSelfSignedCert };
