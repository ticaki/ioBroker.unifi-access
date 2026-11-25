import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts on purpose: the module federation plugin must not run for unit tests.
export default defineConfig({
	test: {
		environment: 'jsdom',
		include: ['src/**/*.test.{ts,tsx}'],
		setupFiles: ['./src/test/setup.ts'],
		restoreMocks: true,
		server: {
			deps: {
				// These packages ship ES modules with extension-less relative imports, which Node cannot
				// load natively - let Vite transform them.
				inline: [/@iobroker\/(json-config|gui-components)/],
			},
		},
	},
});
