import { expect } from 'chai';

import { isSafeProtectId, sanitizeProtectClipPath, sanitizeStaticPath } from './pathSafety';

describe('pathSafety (validation of externally supplied URL path parts)', () => {
	describe('sanitizeStaticPath()', () => {
		const accepted: [raw: string, expected: string][] = [
			// event sample, api_reference 11.7
			[
				'/preview/reader_0418d6a2bb7a_d2b87427-7efa-43c1-aa52-b00d40d99ecf_1722913291.jpg',
				'preview/reader_0418d6a2bb7a_d2b87427-7efa-43c1-aa52-b00d40d99ecf_1722913291.jpg',
			],
			// request samples, api_reference 9.5
			['avatar/da1aceb6-20ba-4285-a6b1-c4f2bf7161f8', 'avatar/da1aceb6-20ba-4285-a6b1-c4f2bf7161f8'],
			[
				'/preview/1700707333_9660da3a-06c8-459d-8cc9-24889d13fba5.png',
				'preview/1700707333_9660da3a-06c8-459d-8cc9-24889d13fba5.png',
			],
			[
				'/activities_resource/thumbnail/1708402379_92746868-5c69-4a11-9d4c-33f03785d741.jpg',
				'activities_resource/thumbnail/1708402379_92746868-5c69-4a11-9d4c-33f03785d741.jpg',
			],
			['///capture/abc.jpg', 'capture/abc.jpg'],
		];
		for (const [raw, expected] of accepted) {
			it(`accepts ${raw}`, () => {
				expect(sanitizeStaticPath(raw)).to.equal(expected);
			});
		}

		const rejected: unknown[] = [
			'',
			'/',
			'preview',
			'/preview/',
			'/../../users',
			'/preview/../../../users',
			'/preview/reader_ab_/../../../../users?page_size=1000',
			'/preview/..',
			'/preview/./x.jpg',
			'/preview//x.jpg',
			'/preview/.hidden',
			'/preview/%2e%2e/%2e%2e/users',
			'/preview/%2E%2E%2Fusers',
			'/preview/..%2f..%2fusers',
			'/preview/%252e%252e/users',
			'/preview/a%00.jpg',
			'/preview/..\\..\\users',
			'\\preview\\x.jpg',
			'/preview/x.jpg?page_size=1000',
			'/preview/x.jpg#frag',
			'/preview/x y.jpg',
			'/preview/x\n.jpg',
			'/preview/x;y.jpg',
			'https://evil.example/preview/x.jpg',
			'//evil.example/preview/x.jpg',
			'/users',
			'/doors/1/unlock',
			'/Preview/x.jpg',
			'/previews/x.jpg',
			`/preview/${'a'.repeat(600)}`,
			null,
			undefined,
			42,
			{},
			['/preview/x.jpg'],
		];
		for (const raw of rejected) {
			it(`rejects ${JSON.stringify(raw)?.slice(0, 70)}`, () => {
				expect(sanitizeStaticPath(raw)).to.equal(null);
			});
		}
	});

	describe('isSafeProtectId()', () => {
		it('accepts alphanumeric ids', () => {
			expect(isSafeProtectId('66a1b2c3d4e5f60718293a4b')).to.equal(true);
			expect(isSafeProtectId('evt_1-a')).to.equal(true);
		});

		for (const bad of ['', '.', '..', 'a/b', 'a%2Fb', 'a b', 'a\\b', 'a?b', 'a#b', 'a'.repeat(129), null, 5]) {
			it(`rejects ${JSON.stringify(bad)?.slice(0, 40)}`, () => {
				expect(isSafeProtectId(bad)).to.equal(false);
			});
		}
	});

	describe('sanitizeProtectClipPath()', () => {
		it('keeps absolute paths below /proxy/protect/api/ and resolves relative ones against it', () => {
			expect(sanitizeProtectClipPath('/proxy/protect/api/video/export?camera=c1&start=1')).to.equal(
				'/proxy/protect/api/video/export?camera=c1&start=1',
			);
			expect(sanitizeProtectClipPath('video/export?camera=c1')).to.equal(
				'/proxy/protect/api/video/export?camera=c1',
			);
			expect(sanitizeProtectClipPath('video/clip2.mp4')).to.equal('/proxy/protect/api/video/clip2.mp4');
		});

		for (const bad of [
			'',
			'//evil.example/clip.mp4',
			'https://evil.example/clip.mp4',
			'/api/auth/login',
			'/proxy/network/api/s/default/stat/device',
			'/proxy/protect/api/../../network/api',
			'../../network/api',
			'video/../../../api/users',
			'video/%2e%2e/%2e%2e/%2e%2e/api/users',
			'video/%252e%252e/x',
			'video\\..\\x',
			'video/%5c..%5cx',
			'video/x.mp4#frag',
			'video/x y.mp4',
			'video/x\r\nHost: evil',
			'/proxy/protect/api//evil.example/x',
			'/proxy/protect/api/http://evil.example/x',
			'video/%zz',
			null,
			7,
		]) {
			it(`rejects ${JSON.stringify(bad)?.slice(0, 60)}`, () => {
				expect(sanitizeProtectClipPath(bad)).to.equal(null);
			});
		}
	});
});
