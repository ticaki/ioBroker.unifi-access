import { expect } from 'chai';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { classifyStoredSecret } from './secretMigration';

/**
 * The encryption of js-controller (packages/common-db → tools.encrypt / tools.decrypt), reproduced
 * so the migration is tested against the real storage formats.
 *
 * @param key System secret
 * @param value Text to encrypt or decrypt
 */
function xor(key: string, value: string): string {
	let result = '';
	for (let i = 0; i < value.length; i++) {
		result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
	}
	return result;
}
function encrypt(key: string, value: string): string {
	if (!/^[0-9a-f]{48}$/.test(key)) {
		return xor(key, value);
	}
	const iv = randomBytes(16);
	const cipher = createCipheriv('aes-192-cbc', Buffer.from(key, 'hex'), iv);
	const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
	return `$/aes-192-cbc:${iv.toString('hex')}:${encrypted.toString('hex')}`;
}
function decrypt(key: string, value: string): string {
	if (!value.startsWith('$/aes-192-cbc:') || !/^[0-9a-f]{48}$/.test(key)) {
		return xor(key, value);
	}
	const parts = value.split(':', 3);
	const decipher = createDecipheriv('aes-192-cbc', Buffer.from(key, 'hex'), Buffer.from(parts[1], 'hex'));
	return Buffer.concat([decipher.update(Buffer.from(parts[2], 'hex')), decipher.final()]).toString();
}

const AES_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';
/** Default system secret of old ioBroker installations */
const LEGACY_SECRET = 'Zgfr56gFe87jJOM';
const PASSWORD = 'correct horse battery staple';

/**
 * What the adapter sees at start for a given stored value: js-controller decrypts every
 * encryptedNative attribute, whatever is stored.
 *
 * @param secret System secret
 * @param raw Value stored in the instance object
 * @param isEncryptedAttribute Whether the instance object lists the attribute in encryptedNative
 */
function atStart(secret: string, raw: unknown, isEncryptedAttribute = true): ReturnType<typeof classifyStoredSecret> {
	return classifyStoredSecret({
		raw,
		decrypted: isEncryptedAttribute && typeof raw === 'string' ? decrypt(secret, raw) : raw,
		isEncryptedAttribute,
		encrypt: plain => encrypt(secret, plain),
	});
}

describe('secretMigration (plain-text password that became an encrypted attribute)', () => {
	for (const [name, secret] of [
		['AES system secret', AES_SECRET],
		['legacy (non-AES) system secret', LEGACY_SECRET],
	] as const) {
		describe(name, () => {
			it('empty: nothing to do', () => {
				for (const raw of ['', undefined, null, 42]) {
					expect(atStart(secret, raw)).to.deep.equal({ kind: 'empty', password: '' });
				}
			});

			it('already encrypted: uses the decrypted value, no migration', () => {
				const result = atStart(secret, encrypt(secret, PASSWORD));
				expect(result).to.deep.equal({ kind: 'encrypted', password: PASSWORD });
			});

			it('plain text: uses the stored value now and asks for the encrypted form to be stored', () => {
				const result = atStart(secret, PASSWORD);
				expect(result.kind).to.equal('plaintext');
				expect(result.password).to.equal(PASSWORD);
				const encrypted = (result as { encrypted: string }).encrypted;
				expect(encrypted).to.not.equal(PASSWORD);
				expect(decrypt(secret, encrypted)).to.equal(PASSWORD);
			});

			it('the migration happens exactly once: the migrated value is recognised as encrypted (no restart loop)', () => {
				let stored: string = PASSWORD;
				const kinds: string[] = [];
				for (let start = 0; start < 4; start++) {
					const result = atStart(secret, stored);
					kinds.push(result.kind);
					expect(result.password, `start ${start}`).to.equal(PASSWORD);
					if (result.kind === 'plaintext') {
						stored = result.encrypted;
					}
				}
				expect(kinds).to.deep.equal(['plaintext', 'encrypted', 'encrypted', 'encrypted']);
			});

			it('attribute not (yet) listed as encrypted in the instance object: stored value is the password, nothing is written', () => {
				expect(atStart(secret, PASSWORD, false)).to.deep.equal({
					kind: 'unencrypted-attribute',
					password: PASSWORD,
				});
			});
		});
	}

	describe('legacy (non-AES) system secret: limits of the detection', () => {
		it('a non-ASCII plain-text password cannot be told from cipher text: no migration, decrypted value is used', () => {
			const result = atStart(LEGACY_SECRET, 'pässwörd');
			expect(result.kind).to.equal('encrypted');
		});

		it('reports "ambiguous" when stored value and its encrypted form are both printable — and never writes', () => {
			// lower-case letters XOR digits/upper-case letters stay printable
			const secret = '5555555555';
			const result = atStart(secret, 'abcabc');
			expect(result).to.deep.equal({ kind: 'ambiguous', password: decrypt(secret, 'abcabc') });
		});

		it('a throwing or no-op encrypt function never leads to a write', () => {
			const base = { raw: PASSWORD, decrypted: 'garbage', isEncryptedAttribute: true };
			expect(
				classifyStoredSecret({
					...base,
					encrypt: () => {
						throw new Error('no secret');
					},
				}),
			).to.deep.equal({ kind: 'ambiguous', password: 'garbage' });
			expect(classifyStoredSecret({ ...base, encrypt: plain => plain })).to.deep.equal({
				kind: 'ambiguous',
				password: 'garbage',
			});
		});
	});
});
