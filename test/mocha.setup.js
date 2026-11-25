'use strict';

// ---------------------------------------------------------------------------------------
// TypeScript loader for the module-level tests (src/**/*.test.ts).
// The repo currently ships ts-node; should it be replaced by tsx, the tests keep working
// without touching this file. Type checking is the job of `npm run check` (tsc --noEmit),
// so the loader only transpiles — faster and independent of the TypeScript version in use.
// ---------------------------------------------------------------------------------------

// Makes ts-node ignore warnings, so mocha --watch does work
process.env.TS_NODE_IGNORE_WARNINGS = 'TRUE';
// Sets the correct tsconfig for testing
process.env.TS_NODE_PROJECT = 'tsconfig.json';
// Make ts-node respect the "include" key in tsconfig.json
process.env.TS_NODE_FILES = 'TRUE';
// Transpile only (see above); can be overridden from the outside with TS_NODE_TRANSPILE_ONLY=false
process.env.TS_NODE_TRANSPILE_ONLY ??= 'true';

function registerTypeScriptLoader() {
	// TEST_TS_LOADER forces a specific loader, e.g. TEST_TS_LOADER=tsx/cjs
	const loaders = process.env.TEST_TS_LOADER ? [process.env.TEST_TS_LOADER] : ['ts-node/register', 'tsx/cjs'];
	for (const loader of loaders) {
		try {
			require(loader);
			return;
		} catch (err) {
			if (err?.code !== 'MODULE_NOT_FOUND') {
				throw err;
			}
		}
	}
	throw new Error(`No TypeScript loader found - install one of: ${loaders.join(', ')}`);
}
registerTypeScriptLoader();

try {
	require('source-map-support/register');
} catch {
	// optional: only improves stack traces
}

// Don't silently swallow unhandled rejections
process.on('unhandledRejection', e => {
	throw e;
});

// enable the should interface with sinon
// and load chai-as-promised and sinon-chai by default
const sinonChai = require('sinon-chai');
const chaiAsPromised = require('chai-as-promised');
const { should, use } = require('chai');

should();
use(sinonChai);
use(chaiAsPromised);
