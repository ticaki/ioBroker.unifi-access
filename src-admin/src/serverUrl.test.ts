import { describe, expect, it } from 'vitest';
import { normalizePort, normalizePublicBaseUrl, normalizeWebhookPath, PUBLIC_BASE_URL_PATTERN } from './serverUrl';

// The same rules as the adapter; test/contract/frontendContract.test.ts compares both implementations.

describe('normalizePublicBaseUrl', () => {
	it('drops blanks and trailing slashes', () => {
		expect(normalizePublicBaseUrl('  https://proxy.example.com/iob/  ')).toBe('https://proxy.example.com/iob');
		expect(normalizePublicBaseUrl('http://203.0.113.4:18095///')).toBe('http://203.0.113.4:18095');
	});

	it('writes host and port like the URL parser of the adapter', () => {
		expect(normalizePublicBaseUrl('HTTPS://Proxy.Example.com:443')).toBe('https://proxy.example.com');
		expect(normalizePublicBaseUrl('http://proxy.example.com:80/a')).toBe('http://proxy.example.com/a');
		expect(normalizePublicBaseUrl('http://[2001:db8::1]:8095')).toBe('http://[2001:db8::1]:8095');
	});

	it('is null for empty and unusable values', () => {
		for (const value of [
			'',
			'   ',
			'/',
			'proxy.example.com',
			'ftp://proxy.example.com',
			'https://proxy.example.com/?a=1',
			'https://proxy.example.com/#x',
			'https://proxy.example.com/a b',
			'https://user:secret@proxy.example.com',
			'https://proxy.example.com:99999',
			'https://proxy.example.com:0',
			'http://203.0.113.4:00/iob',
			null,
			undefined,
			42,
		]) {
			expect(normalizePublicBaseUrl(value), String(value)).toBeNull();
		}
	});

	it('uses the rule of the validator in admin/jsonConfig.json', () => {
		expect(PUBLIC_BASE_URL_PATTERN.source).toBe(String.raw`^https?:\/\/[^\s/?#]+(\/[A-Za-z0-9._~-]+)*$`);
		expect(PUBLIC_BASE_URL_PATTERN.flags).toBe('i');
	});
});

describe('normalizeWebhookPath', () => {
	it.each([
		['/webhook', '/webhook'],
		['hook', '/hook'],
		['  /alarm  ', '/alarm'],
		['', '/webhook'],
		['   ', '/webhook'],
		[null, '/webhook'],
		['//a//b', '/a/b'],
		['/a?x=1', '/a'],
		['/a#frag', '/a'],
		['?x', '/webhook'],
	])('%j → %s', (raw, expected) => {
		expect(normalizeWebhookPath(raw)).toBe(expected);
	});
});

describe('normalizePort', () => {
	it.each([
		[9000, 9000],
		['9000', 9000],
		[' 9000 ', 9000],
		[0, 8095],
		[65_536, 8095],
		[8095.5, 8095],
		['', 8095],
		['90a', 8095],
		[undefined, 8095],
	])('%j → %s', (raw, expected) => {
		expect(normalizePort(raw)).toBe(expected);
	});
});
