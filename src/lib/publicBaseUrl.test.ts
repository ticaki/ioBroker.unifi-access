import { expect } from 'chai';

import { normalizePublicBaseUrl } from './publicBaseUrl';

describe('publicBaseUrl (U-10)', () => {
	for (const [raw, url] of [
		['https://iobroker.example.com', 'https://iobroker.example.com'],
		['https://iobroker.example.com/', 'https://iobroker.example.com'],
		['  http://192.168.1.10:8095  ', 'http://192.168.1.10:8095'],
		['https://proxy.example/unifi-access', 'https://proxy.example/unifi-access'],
		['https://proxy.example/a/b//', 'https://proxy.example/a/b'],
		['https://[fd00::1]:8443', 'https://[fd00::1]:8443'],
		['HTTPS://Host.Example:443', 'https://host.example'],
	] as const) {
		it(`${JSON.stringify(raw)} → ${url}`, () => {
			expect(normalizePublicBaseUrl(raw)).to.deep.equal({ url });
		});
	}

	for (const raw of ['', '   ', undefined, null, 5]) {
		it(`${JSON.stringify(raw)} means "not set" (no problem)`, () => {
			expect(normalizePublicBaseUrl(raw)).to.deep.equal({ url: null });
		});
	}

	for (const raw of [
		'iobroker.example.com',
		'ftp://host',
		'https://host/path?x=1',
		'https://host/#frag',
		'https://host/with space',
		'https://user:pw@host',
		'https://host/%2e%2e',
		'https://',
		// R3F-02: the parser takes port 0, but nothing listens there
		'https://proxy.example.com:0',
		'https://proxy.example.com:00/iob',
	]) {
		it(`refuses ${JSON.stringify(raw)} with a reason`, () => {
			const result = normalizePublicBaseUrl(raw);
			expect(result.url).to.equal(null);
			expect(result.problem).to.be.a('string');
		});
	}
});
