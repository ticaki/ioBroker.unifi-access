import { expect } from 'chai';
import { AxiosError } from 'axios';

import { isHostnameMismatch, tlsAdvice, tlsCertificateErrorCode } from './tlsErrors';

describe('tlsErrors', () => {
	for (const code of [
		'DEPTH_ZERO_SELF_SIGNED_CERT',
		'SELF_SIGNED_CERT_IN_CHAIN',
		'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
		'CERT_HAS_EXPIRED',
		'ERR_TLS_CERT_ALTNAME_INVALID',
	]) {
		it(`recognises ${code}`, () => {
			expect(tlsCertificateErrorCode(new AxiosError('tls', code))).to.equal(code);
			expect(tlsCertificateErrorCode(Object.assign(new Error('tls'), { code }))).to.equal(code);
			expect(
				tlsCertificateErrorCode(new Error('wrapped', { cause: Object.assign(new Error('tls'), { code }) })),
			).to.equal(code);
		});
	}

	it('returns undefined for everything else', () => {
		for (const err of [
			new AxiosError('refused', 'ECONNREFUSED'),
			new AxiosError('timeout', 'ECONNABORTED'),
			new Error('boom'),
			Object.assign(new Error('x'), { code: 42 }),
			undefined,
			null,
			'DEPTH_ZERO_SELF_SIGNED_CERT',
		]) {
			expect(tlsCertificateErrorCode(err)).to.equal(undefined);
		}
	});

	// K-16: a host name mismatch is not cured by storing the CA certificate
	describe('tlsAdvice()', () => {
		for (const code of ['ERR_TLS_CERT_ALTNAME_INVALID', 'HOSTNAME_MISMATCH']) {
			it(`${code}: points to the host name, not to the CA certificate`, () => {
				expect(isHostnameMismatch(code)).to.equal(true);
				for (const where of ['controller', 'protect'] as const) {
					const text = tlsAdvice(code, where);
					expect(text).to.contain('not issued for the configured host name');
					expect(text).to.not.contain('CA certificate');
				}
			});
		}

		it('other certificate errors: disable the check or store the CA certificate (per connection)', () => {
			expect(isHostnameMismatch('DEPTH_ZERO_SELF_SIGNED_CERT')).to.equal(false);
			expect(isHostnameMismatch(undefined)).to.equal(false);
			expect(tlsAdvice('DEPTH_ZERO_SELF_SIGNED_CERT', 'controller')).to.equal(
				'Either disable "Verify TLS certificate" in the connection settings or store the CA certificate of the controller in the connection settings.',
			);
			expect(tlsAdvice('SELF_SIGNED_CERT_IN_CHAIN', 'protect')).to.equal(
				'Either disable "Verify TLS certificate" on the Protect tab or store the CA certificate of the console in the connection settings.',
			);
		});
	});
});
