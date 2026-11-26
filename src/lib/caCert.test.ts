import { expect } from 'chai';
import { rootCertificates } from 'node:tls';

import { createSelfSignedCert } from '../../test/mock';
import { parseCaCert, trustedCertificates } from './caCert';

/** The PEM of a fresh certificate, as Node prints it (64-character lines, trailing newline). */
const pemA = createSelfSignedCert().cert;
const pemB = createSelfSignedCert({ altNames: ['other.example'] }).cert;
const body = (pem: string): string => pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');

describe('caCert (U-02: PEM from the admin field)', () => {
	it('a clean PEM is taken as it is', () => {
		expect(parseCaCert(pemA)).to.deep.equal({ certificates: [pemA], problems: [] });
	});

	it('empty or missing values are no certificate and no problem', () => {
		for (const raw of ['', '   \n', undefined, null, 42]) {
			expect(parseCaCert(raw)).to.deep.equal({ certificates: [], problems: [] });
			expect(trustedCertificates(raw)).to.equal(undefined);
		}
	});

	// what a single-line <input> makes of a pasted PEM, depending on the browser
	for (const [name, mangled] of [
		['line breaks removed', pemA.replace(/\n/g, '')],
		['line breaks replaced by spaces', pemA.replace(/\n/g, ' ')],
		['CRLF line endings', pemA.replace(/\n/g, '\r\n')],
		['surrounding blanks and indentation', `  \n\t${pemA.replace(/\n/g, '\n   ')}  \n`],
		['one long base64 line', `-----BEGIN CERTIFICATE-----\n${body(pemA)}\n-----END CERTIFICATE-----`],
	] as const) {
		it(`repairs a PEM with ${name}`, () => {
			expect(parseCaCert(mangled)).to.deep.equal({ certificates: [pemA], problems: [] });
		});
	}

	it('several certificates in a row (also on one line) are all kept, in order', () => {
		expect(parseCaCert(`${pemA}${pemB}`).certificates).to.deep.equal([pemA, pemB]);
		expect(parseCaCert(`${pemA} ${pemB}`.replace(/\n/g, ' ')).certificates).to.deep.equal([pemA, pemB]);
	});

	it('reports text without a certificate block', () => {
		const result = parseCaCert('MIIBkTCB+wIJAK...');
		expect(result.certificates).to.deep.equal([]);
		expect(result.problems).to.deep.equal([
			'no "-----BEGIN CERTIFICATE-----" … "-----END CERTIFICATE-----" block found',
		]);
	});

	it('reports a damaged block and keeps the usable ones', () => {
		const damaged = `-----BEGIN CERTIFICATE-----\n${body(pemB).slice(0, 120)}\n-----END CERTIFICATE-----\n`;
		const result = parseCaCert(
			`${pemA}${damaged}-----BEGIN CERTIFICATE-----\n#not base64#\n-----END CERTIFICATE-----`,
		);
		expect(result.certificates).to.deep.equal([pemA]);
		expect(result.problems).to.have.length(2);
		expect(result.problems[0]).to.match(/^certificate 2: not a readable certificate \(/);
		expect(result.problems[1]).to.equal('certificate 3: the content is not base64');
	});

	// K-16: Node's `ca` option replaces the system CAs — the configured certificate must be added to them
	it('trustedCertificates() adds the configured certificates to the system CAs', () => {
		const trusted = trustedCertificates(pemA.replace(/\n/g, ' '));
		expect(trusted).to.have.length(rootCertificates.length + 1);
		expect(trusted?.slice(0, rootCertificates.length)).to.deep.equal([...rootCertificates]);
		expect(trusted?.[rootCertificates.length]).to.equal(pemA);
	});

	it('trustedCertificates() is undefined when nothing usable is configured (Node then uses the system CAs)', () => {
		expect(trustedCertificates('garbage')).to.equal(undefined);
	});
});
