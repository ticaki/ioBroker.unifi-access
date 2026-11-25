/**
 * Consistency between the admin configuration (admin/jsonConfig.json), the instance defaults and
 * secret handling in io-package.json and the config keys the adapter code reads.
 */

import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface IoPackage {
	native: Record<string, unknown>;
	encryptedNative?: string[];
	protectedNative?: string[];
}

const ROOT = join(__dirname, '..', '..');
const readJson = <T>(...segments: string[]): T => JSON.parse(readFileSync(join(ROOT, ...segments), 'utf8')) as T;

/** jsonConfig item types that do not store a value in `native`. */
const NON_VALUE_TYPES = new Set(['panel', 'tabs', 'header', 'staticText', 'staticLink', 'staticImage', 'divider']);

/**
 * Collect all config attributes of a jsonConfig tree together with their item type.
 * Custom components store their value under `attr`, everything else under the item key.
 *
 * @param node Current jsonConfig node
 * @param found Accumulator: attribute name → item type
 */
function collectAttributes(node: unknown, found = new Map<string, string>()): Map<string, string> {
	if (!node || typeof node !== 'object') {
		return found;
	}
	const items = (node as { items?: unknown }).items;
	if (items && typeof items === 'object' && !Array.isArray(items)) {
		for (const [key, value] of Object.entries(items as Record<string, { type?: string; attr?: string }>)) {
			const type = value?.type ?? '';
			if (type === 'custom') {
				if (typeof value.attr === 'string') {
					found.set(value.attr, type);
				}
			} else if (!NON_VALUE_TYPES.has(type) && !key.startsWith('_')) {
				found.set(key, type);
			}
			collectAttributes(value, found);
		}
	}
	return found;
}

describe('adapter configuration metadata (io-package.json / admin/jsonConfig.json)', () => {
	const ioPackage = readJson<IoPackage>('io-package.json');
	const attributes = collectAttributes(readJson<unknown>('admin', 'jsonConfig.json'));
	const encrypted = ioPackage.encryptedNative ?? [];
	const protectedKeys = ioPackage.protectedNative ?? [];

	it('finds the configuration attributes of the admin UI', () => {
		expect([...attributes.keys()]).to.include.members([
			'controllerHost',
			'controllerPort',
			'apiToken',
			'listenPort',
		]);
	});

	it('every encrypted value is also protected against read access by other adapters, and vice versa', () => {
		expect([...encrypted].sort()).to.deep.equal([...protectedKeys].sort());
	});

	it('the API token, webhook secret and generic webhook credentials are stored encrypted', () => {
		expect(encrypted).to.include.members([
			'apiToken',
			'webhookSecret',
			'genericWebhookPassword',
			'genericWebhookToken',
			'protectPassword',
		]);
	});

	it('every encrypted key has a default in native', () => {
		for (const key of encrypted) {
			expect(ioPackage.native, key).to.have.property(key);
		}
	});

	// A password field that is not listed in encryptedNative/protectedNative is stored in plain text in the
	// instance object and is readable by every adapter / user with object access.
	it('every password field of the admin UI is listed in encryptedNative and protectedNative', () => {
		const passwords = [...attributes].filter(([, type]) => type === 'password').map(([key]) => key);
		expect(passwords).to.include('protectPassword');
		for (const key of passwords) {
			expect(encrypted, `encryptedNative: ${key}`).to.include(key);
			expect(protectedKeys, `protectedNative: ${key}`).to.include(key);
		}
	});

	// Attributes the admin UI writes (and main.ts reads) need a default so a fresh instance does not start
	// with undefined keys.
	it('every attribute of the admin UI has a default in io-package.json native', () => {
		const missing = [...attributes.keys()].filter(key => !(key in ioPackage.native));
		expect(missing).to.deep.equal([]);
	});
});
