/**
 * Consistency of admin/jsonConfig.json with the custom components and the translations.
 * The schema itself is validated by `npm run test:package` in the repository root.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import jsonConfig from '../../admin/jsonConfig.json';
import Components from './Components';

const here = dirname(fileURLToPath(import.meta.url));
const LANGUAGES = ['de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt', 'ru', 'uk', 'zh-cn'];
/** Properties of an item whose value is a translation key */
const TEXT_PROPERTIES = new Set(['label', 'help', 'text', 'title', 'tooltip', 'placeholder']);

type Item = Record<string, unknown>;

function loadDictionaries(dir: string): Record<string, Record<string, string>> {
	const result: Record<string, Record<string, string>> = {};
	for (const file of readdirSync(dir)) {
		result[file.replace(/\.json$/, '')] = JSON.parse(readFileSync(resolve(dir, file), 'utf8')) as Record<
			string,
			string
		>;
	}
	return result;
}

/**
 * All items of the configuration, also the columns of tables, with their key
 *
 * @param node
 * @param key
 * @param out
 */
function collectItems(node: unknown, key: string, out: [string, Item][]): [string, Item][] {
	if (Array.isArray(node)) {
		node.forEach((entry, i) => collectItems(entry, `${key}[${i}]`, out));
	} else if (node && typeof node === 'object') {
		const item = node as Item;
		if (typeof item.type === 'string') {
			out.push([key, item]);
		}
		if (item.items) {
			if (Array.isArray(item.items)) {
				collectItems(item.items, key, out);
			} else {
				for (const [childKey, child] of Object.entries(item.items)) {
					collectItems(child, childKey, out);
				}
			}
		}
	}
	return out;
}

/**
 * Every translation key the configuration refers to
 *
 * @param items
 */
function collectTextKeys(items: [string, Item][]): string[] {
	const keys = new Set<string>();
	for (const [, item] of items) {
		for (const [property, value] of Object.entries(item)) {
			if (TEXT_PROPERTIES.has(property) && typeof value === 'string') {
				keys.add(value);
			}
		}
		for (const option of (item.options as { label?: unknown }[] | undefined) ?? []) {
			if (typeof option.label === 'string') {
				keys.add(option.label);
			}
		}
		for (const map of [item.error, item.result]) {
			for (const value of Object.values((map as Record<string, unknown> | undefined) ?? {})) {
				if (typeof value === 'string') {
					keys.add(value);
				}
			}
		}
	}
	return [...keys].sort();
}

const items = collectItems(jsonConfig, 'root', []);
const adminTexts = loadDictionaries(resolve(here, '../../admin/i18n'));
const componentTexts = loadDictionaries(resolve(here, 'i18n'));

describe('admin/jsonConfig.json', () => {
	it('only refers to custom components that exist and declares the GUI API generation', () => {
		const custom = items.filter(([, item]) => item.type === 'custom');

		expect(custom.map(([key]) => key).sort()).toEqual([
			'_authSetup',
			'_devicesComponent',
			'_genericWebhookUrlDisplay',
			'unlockActorId',
		]);
		for (const [key, item] of custom) {
			const [federationName, exposed, componentName] = String(item.name).split('/');
			expect(federationName, key).toBe('ConfigCustomUnifiAccessSet');
			expect(exposed, key).toBe('Components');
			expect(Object.keys(Components), key).toContain(componentName);
			expect(item.url, key).toBe('custom/customComponents.js');
			expect(item.guiApi, key).toBe(2);
			expect(item.i18n, key).toBe(true);
			expect(item, key).not.toHaveProperty('bundlerType');
		}
	});

	it('stores the selected unlock actor under a key the admin saves', () => {
		// keys starting with "_" are not written to native
		const actor = items.find(([, item]) => String(item.name).endsWith('/ActorSelect'));

		expect(actor?.[0]).toBe('unlockActorId');
	});

	it('does not use deprecated item types', () => {
		expect(items.filter(([, item]) => item.type === 'sendto').map(([key]) => key)).toEqual([]);
		expect(items.find(([key]) => key === '_reregisterWebhook')?.[1]).toMatchObject({
			type: 'sendTo',
			command: 'reregisterWebhook',
		});
	});

	it('masks every secret', () => {
		const secrets = ['apiToken', 'genericWebhookToken', 'genericWebhookPassword', 'protectPassword'];

		for (const key of secrets) {
			expect(items.find(([itemKey]) => itemKey === key)?.[1].type, key).toBe('password');
		}
	});

	it('does not verify TLS certificates by default', () => {
		// UniFi consoles come with a self-signed certificate
		for (const key of ['verifyTLS', 'protectVerifyTLS']) {
			const item = items.find(([itemKey]) => itemKey === key)?.[1];
			expect(item?.default, key).toBe(false);
			expect(typeof item?.help, key).toBe('string');
		}
	});

	it('has a translation for every text', () => {
		const missing = collectTextKeys(items).filter(key => !(key in adminTexts.en));

		expect(missing).toEqual([]);
	});

	it('has no translations that nothing uses', () => {
		const used = new Set(collectTextKeys(items));

		expect(Object.keys(adminTexts.en).filter(key => !used.has(key))).toEqual([]);
	});
});

describe.each([
	['admin/i18n', adminTexts],
	['src-admin/src/i18n', componentTexts],
])('translations in %s', (_name, dictionaries) => {
	it('exist for all languages of ioBroker', () => {
		expect(Object.keys(dictionaries).sort()).toEqual(LANGUAGES);
	});

	it('have the same keys and no empty text in every language', () => {
		const expected = Object.keys(dictionaries.en).sort();

		for (const language of LANGUAGES) {
			expect(Object.keys(dictionaries[language]).sort(), language).toEqual(expected);
			const empty = Object.entries(dictionaries[language]).filter(([, text]) => !String(text).trim());
			expect(empty, language).toEqual([]);
		}
	});

	it('keep the %s placeholders of the English text', () => {
		for (const language of LANGUAGES) {
			for (const [key, text] of Object.entries(dictionaries.en)) {
				const expected = text.split('%s').length;
				expect(dictionaries[language][key].split('%s').length, `${language}: ${key}`).toBe(expected);
			}
		}
	});
});

describe('translations of the custom components', () => {
	it('do not repeat keys of the jsonConfig dictionary', () => {
		// The admin merges both dictionaries: a key in both would show whichever text was loaded last.
		expect(Object.keys(componentTexts.en).filter(key => key in adminTexts.en)).toEqual([]);
	});
});
