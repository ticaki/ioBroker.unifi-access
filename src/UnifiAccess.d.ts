import * as utils from '@iobroker/adapter-core';

/**
 * Type-only declaration of the adapter class.
 * Why: keeping this in a .d.ts file lets `src/main.ts` stay a pure CommonJS module
 * (no top-level `export`), which avoids esbuild's `commonjs-variable-in-esm` warning
 * triggered by the `module.exports = …` line at the bottom of main.ts.
 */
export declare class UnifiAccess extends utils.Adapter {}
