import { expect } from 'chai';
import { AxiosError } from 'axios';

import { tlsCertificateErrorCode } from './tlsErrors';

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
});
