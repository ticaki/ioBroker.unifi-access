const path = require('path');
const { tests } = require('@iobroker/testing');

const { defineAdapterTests } = require('./functional/adapterTests');

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
//
// Besides the standard "adapter starts" check this runs the adapter-level functional tests
// (test/functional/adapterTests.js): a real adapter instance against the mock UniFi Access
// controller from test/mock. Set TEST_LOGLEVEL=debug to see the adapter's debug log.
tests.integration(path.join(__dirname, '..'), {
	loglevel: /** @type {ioBroker.LogLevel} */ (process.env.TEST_LOGLEVEL || 'info'),
	defineAdditionalTests: defineAdapterTests,
});
