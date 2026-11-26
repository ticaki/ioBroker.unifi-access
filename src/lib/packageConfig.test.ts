/**
 * Consistency between the admin configuration (admin/jsonConfig.json), the instance defaults and
 * secret handling in io-package.json and the config keys the adapter code reads.
 */

import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeWebhookPath } from '../webhooks/genericWebhookServer';
import { normalizePublicBaseUrl } from './publicBaseUrl';

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
 * Custom components store their value under `attr` or — without `attr` — under the item key (like
 * `unlockActorId`); everything else under the item key. Keys starting with `_` store nothing.
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
				} else if (!key.startsWith('_')) {
					found.set(key, type);
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
	it('the link to the www panel carries the instance number (admin replaces %instance% in localLinks)', () => {
		const common = readJson<{ common: { localLinks: Record<string, string> } }>('io-package.json').common;
		expect(common.localLinks._default).to.equal(
			'%web_protocol%://%ip%:%web_port%/unifi-access/index.html?instance=%instance%',
		);
	});

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
			'publicBaseUrl',
		]);
	});

	// T-07: a custom component without `attr` stores its value under its own key
	it('also finds custom components that store their value under their key (no "attr")', () => {
		expect(attributes.get('unlockActorId')).to.equal('custom');
		expect([...attributes.keys()].filter(key => key.startsWith('_'))).to.deep.equal([]);
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

	// T-08: a typo in a hidden/disabled/validator expression (data.enableTLS, data.verifyTls) silently hides
	// or locks a field — every expression is checked against the stored keys and evaluated
	describe('hidden / disabled / validator expressions', () => {
		const jsonConfig = readJson<unknown>('admin', 'jsonConfig.json');
		const expressions: { key: string; prop: string; expr: string }[] = [];
		const items: Record<string, Record<string, unknown>> = {};
		(function walk(node: unknown): void {
			const children = (node as { items?: unknown } | null)?.items;
			if (!children || typeof children !== 'object') {
				return;
			}
			const list = Array.isArray(children)
				? children.map((value, index) => [`[${index}]`, value] as const)
				: Object.entries(children as Record<string, unknown>);
			for (const [key, value] of list) {
				const item = value as Record<string, unknown>;
				items[key] = item;
				for (const prop of ['hidden', 'disabled', 'validator']) {
					if (typeof item?.[prop] === 'string') {
						expressions.push({ key, prop, expr: item[prop] });
					}
				}
				walk(item);
			}
		})(jsonConfig);

		/**
		 * Evaluate an expression the way the admin does: `return` is put in front only when the text
		 * does not contain the word `return` (`ConfigGeneric.execute()` of `@iobroker/json-config`).
		 *
		 * @param expr The expression
		 * @param data The form values
		 */
		const evaluate = (expr: string, data: Record<string, unknown>): unknown =>
			new Function(
				'data',
				'_alive',
				'_common',
				'_system',
				'instanceObj',
				'arrayIndex',
				'globalData',
				expr.includes('return') ? expr : `return ${expr};`,
			)(data, true, {}, {}, {}, 0, {});

		it('finds the expressions (sanity check)', () => {
			expect(expressions.length).to.be.greaterThan(10);
			expect(expressions.map(e => `${e.key}.${e.prop}`)).to.include.members([
				'caCert.disabled',
				'_tlsCertificates.hidden',
				'publicBaseUrl.validator',
				'genericWebhookPath.validator',
			]);
		});

		it('every data.<key> in an expression is a key of io-package.json native', () => {
			const unknown: string[] = [];
			for (const { key, prop, expr } of expressions) {
				for (const [, name] of expr.matchAll(/\bdata\.([A-Za-z_$][\w$]*)/g)) {
					if (!(name in ioPackage.native)) {
						unknown.push(`${key}.${prop}: data.${name}`);
					}
				}
			}
			expect(unknown).to.deep.equal([]);
		});

		it('every expression evaluates without error with the defaults and with everything switched on', () => {
			const allOn = Object.fromEntries(
				Object.entries(ioPackage.native).map(([k, v]) => [k, typeof v === 'boolean' ? true : v]),
			);
			for (const { key, prop, expr } of expressions) {
				for (const data of [ioPackage.native, allOn]) {
					expect(() => evaluate(expr, data), `${key}.${prop}`).to.not.throw();
					expect(typeof evaluate(expr, data), `${key}.${prop}`).to.equal('boolean');
				}
			}
		});

		it('validators accept the defaults (a fresh instance can be saved)', () => {
			for (const { key, prop, expr } of expressions.filter(e => e.prop === 'validator')) {
				expect(evaluate(expr, ioPackage.native), `${key}.${prop}`).to.equal(true);
			}
		});

		const expressionOf = (key: string, prop: string): string => {
			const found = expressions.find(e => e.key === key && e.prop === prop);
			expect(found, `${key}.${prop}`).to.not.equal(undefined);
			return found!.expr;
		};

		// U-07: the CA certificate is also used for Protect
		it('the CA field is editable when Access or Protect verify TLS', () => {
			const disabled = expressionOf('caCert', 'disabled');
			const d = (verifyTLS: boolean, enableProtect: boolean, protectVerifyTLS: boolean): unknown =>
				evaluate(disabled, { ...ioPackage.native, verifyTLS, enableProtect, protectVerifyTLS });
			expect(d(false, false, false)).to.equal(true);
			expect(d(true, false, false)).to.equal(false);
			expect(d(false, true, true)).to.equal(false);
			expect(d(false, true, false)).to.equal(true);
			expect(d(false, false, true), 'Protect off: its TLS setting does not count').to.equal(true);
		});

		it('the CA field is a multi-line field (U-02)', () => {
			expect(items.caCert.minRows).to.be.greaterThan(1);
		});

		it('the certificate selection is shown exactly when TLS is enabled', () => {
			const hidden = expressionOf('_tlsCertificates', 'hidden');
			expect(evaluate(hidden, { ...ioPackage.native, enableTls: true })).to.equal(false);
			expect(evaluate(hidden, { ...ioPackage.native, enableTls: false })).to.equal(true);
		});

		// U-10: the field accepts exactly what the adapter uses
		it('publicBaseUrl: the validator accepts exactly the values the adapter can use', () => {
			const validator = expressionOf('publicBaseUrl', 'validator');
			for (const value of [
				'',
				'https://iobroker.example.com',
				'https://iobroker.example.com/',
				'http://192.168.1.10:8095',
				'https://proxy.example/unifi-access',
				'https://[fd00::1]:8443',
				'iobroker.example.com',
				'ftp://host',
				'https://host/path?x=1',
				'https://host/#frag',
				'https://host/with space',
				'https://',
			]) {
				const accepted = evaluate(validator, { ...ioPackage.native, publicBaseUrl: value });
				const adapter = normalizePublicBaseUrl(value);
				expect(accepted, value).to.equal(adapter.problem === undefined);
			}
		});

		// U-01: the path the admin page shows is the path the handler answers on
		it('genericWebhookPath: accepted paths are used by the adapter as the admin page shows them', () => {
			const validator = expressionOf('genericWebhookPath', 'validator');
			// the rule of src-admin/src/GenericWebhookUrl.tsx
			const shown = (raw: string): string => {
				const path = raw || '/webhook';
				return path.startsWith('/') ? path : `/${path}`;
			};
			const check = (value: string): unknown =>
				evaluate(validator, { ...ioPackage.native, enableGenericWebhook: true, genericWebhookPath: value });
			for (const value of ['', '/webhook', 'alarm', '/hooks/alarm', '/a.b~c_d-e', '/trailing/']) {
				expect(check(value), value).to.equal(true);
				expect(normalizeWebhookPath(value), value).to.equal(shown(value));
			}
			for (const value of ['/with space', ' /alarm', '/a?b=1', '/a#b', '//double', '/a//b', '/ä', '/%41']) {
				expect(check(value), value).to.equal(false);
			}
			// switched off, nothing is checked
			expect(
				evaluate(validator, {
					...ioPackage.native,
					enableGenericWebhook: false,
					genericWebhookPath: '/with space',
				}),
			).to.equal(true);
		});
	});
});
