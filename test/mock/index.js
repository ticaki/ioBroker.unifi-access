'use strict';

/**
 * Public entry point of the mock UniFi Access controller used by the functional tests.
 * Plain CommonJS on purpose: usable from the TypeScript module tests, from the plain-JS
 * adapter integration tests and from the CLI (`node test/mock/cli.js`) without any loader.
 */

const net = require('node:net');

const { MockUnifiController, API_PREFIX, WS_PATH, CONTROL_ROUTES } = require('./controller');
const { createSelfSignedCert } = require('./selfSignedCert');
const { computeSignature, signatureHeader, sendWebhook } = require('./webhookSender');
const { httpRequest } = require('./httpClient');
const { delay, waitFor, rejection, nextEvent } = require('./testUtils');
const { createTestLogger } = require('./testLogger');
const { FakeAdapter, createAdapterWithFakeCore } = require('./fakeAdapterCore');
const fixtures = require('./fixtures');

/**
 * Ask the OS for a currently unused TCP port.
 *
 * @param {string} [host] Interface to probe (default 127.0.0.1)
 * @returns {Promise<number>} A port that was free at the time of the call
 */
function getFreePort(host = '127.0.0.1') {
	return new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.unref();
		probe.once('error', reject);
		probe.listen(0, host, () => {
			const address = probe.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

/**
 * Check whether a TCP port can be bound, i.e. nothing is listening on it (any more).
 *
 * @param {number} port Port to check
 * @param {string} [host] Interface to check (default 127.0.0.1)
 * @returns {Promise<boolean>} true when the port is free
 */
function isPortFree(port, host = '127.0.0.1') {
	return new Promise(resolve => {
		const probe = net.createServer();
		probe.once('error', () => resolve(false));
		probe.listen(port, host, () => probe.close(() => resolve(true)));
	});
}

/**
 * Create and start a mock controller in one go.
 *
 * @param {ConstructorParameters<typeof MockUnifiController>[0]} [options] See MockUnifiController
 * @returns {Promise<MockUnifiController>} The started mock
 */
async function startMockController(options) {
	const mock = new MockUnifiController(options);
	await mock.start();
	return mock;
}

module.exports = {
	MockUnifiController,
	startMockController,
	createSelfSignedCert,
	computeSignature,
	signatureHeader,
	sendWebhook,
	httpRequest,
	getFreePort,
	isPortFree,
	createTestLogger,
	delay,
	waitFor,
	rejection,
	nextEvent,
	FakeAdapter,
	createAdapterWithFakeCore,
	fixtures,
	API_PREFIX,
	WS_PATH,
	CONTROL_ROUTES,
};
