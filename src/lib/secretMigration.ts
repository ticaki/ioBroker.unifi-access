/**
 * Migration helper for a configuration attribute that becomes `encryptedNative` after it was
 * stored in plain text by earlier adapter versions.
 *
 * js-controller "decrypts" every `encryptedNative` attribute at adapter start, no matter how it is
 * stored. A value that is still plain text therefore arrives as garbage in `adapter.config` — the
 * instance object has to be inspected to tell the cases apart. This module is pure logic so every
 * case can be tested; the adapter does the object access.
 *
 * How js-controller encrypts (tools.encrypt / tools.decrypt):
 * - system secret is 48 hex characters → AES-192-CBC, stored as `$/aes-192-cbc:<iv>:<data>`
 * - any other (legacy) secret → XOR with the secret, no marker at all
 */

const AES_PREFIX = '$/aes-192-cbc:';

export type StoredSecretState =
	/** Nothing stored. */
	| { kind: 'empty'; password: '' }
	/** The instance object does not list the attribute as encrypted: the stored value is the password. */
	| { kind: 'unencrypted-attribute'; password: string }
	/** Stored encrypted: use what js-controller decrypted. */
	| { kind: 'encrypted'; password: string }
	/** Stored in plain text: use the stored value now and write `encrypted` to the instance object. */
	| { kind: 'plaintext'; password: string; encrypted: string }
	/** Legacy system secret and no way to tell plain text from cipher text: use the decrypted value. */
	| { kind: 'ambiguous'; password: string };

export interface StoredSecretInput {
	/** Value of the attribute in the instance object (`system.adapter.<ns>` → `native`), i.e. as stored. */
	raw: unknown;
	/** Value of the attribute in `adapter.config`, i.e. after js-controller's decryption pass. */
	decrypted: unknown;
	/** Whether the instance object lists the attribute in `encryptedNative`. */
	isEncryptedAttribute: boolean;
	/** `adapter.encrypt` — encrypts with the system secret. */
	encrypt: (plain: string) => string;
}

function isPrintableAscii(value: string): boolean {
	return /^[\x20-\x7e]*$/.test(value);
}

/**
 * Work out how a secret attribute is stored and which value is the usable password.
 *
 * The result is stable across restarts: after the `encrypted` value of a `plaintext` result has been
 * written, the next call yields `encrypted` — a migration can never repeat (no restart loop).
 *
 * @param input Stored value, decrypted value and the system's encrypt function
 */
export function classifyStoredSecret(input: StoredSecretInput): StoredSecretState {
	const { raw } = input;
	const decrypted = typeof input.decrypted === 'string' ? input.decrypted : '';
	if (typeof raw !== 'string' || raw === '') {
		return { kind: 'empty', password: '' };
	}
	if (!input.isEncryptedAttribute) {
		return { kind: 'unencrypted-attribute', password: raw };
	}
	if (raw.startsWith(AES_PREFIX)) {
		return { kind: 'encrypted', password: decrypted };
	}

	let encrypted: string;
	try {
		encrypted = input.encrypt(raw);
	} catch {
		return { kind: 'ambiguous', password: decrypted };
	}
	if (typeof encrypted !== 'string' || encrypted === '' || encrypted === raw) {
		return { kind: 'ambiguous', password: decrypted };
	}
	if (encrypted.startsWith(AES_PREFIX)) {
		// The system encrypts with AES, but the stored value carries no AES marker: it is plain text.
		return { kind: 'plaintext', password: raw, encrypted };
	}

	// Legacy XOR secret: cipher text has no marker. XOR-ing printable text with a printable secret
	// produces control characters almost always, which is the only available evidence.
	const rawPrintable = isPrintableAscii(raw);
	if (!rawPrintable) {
		return { kind: 'encrypted', password: decrypted };
	}
	if (!isPrintableAscii(encrypted)) {
		// Stored value is clean text, its encrypted form is not → it was never encrypted. Once the
		// encrypted form is stored, `rawPrintable` is false and the branch above is taken.
		return { kind: 'plaintext', password: raw, encrypted };
	}
	return { kind: 'ambiguous', password: decrypted };
}
