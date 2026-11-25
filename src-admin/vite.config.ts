import react from '@vitejs/plugin-react';
import commonjs from 'vite-plugin-commonjs';
import { federation } from '@module-federation/vite';
import { moduleFederationShared } from '@iobroker/gui-components/modulefederation.admin.config';
import { readFileSync } from 'node:fs';
import type { ConfigEnv, UserConfig } from 'vite';

/**
 * Not shared at all: the used icons are bundled (tree-shaken, a few kB). Admin 8.3 no longer offers
 * `@mui/icons-material`, so the shared fallback - the complete icon library - was always the one in use.
 */
const NOT_SHARED = new Set(['@mui/icons-material']);

/**
 * Taken from the admin, never from an own copy (`import: false`). Every admin that can load this page
 * (`admin >= 8.0.12`, see io-package.json) provides them - checked in the `mf-manifest.json` of admin 8.0.12
 * and 8.3.15. With a local fallback, the federation plugin has to evaluate these copies before the
 * components start (`@iobroker/json-config` depends on them and on the federation runtime), so opening
 * the settings downloaded and evaluated a 7 MB chunk that was never used.
 */
const HOST_ONLY = new Set(['@iobroker/gui-components', '@mui/material', 'react-dom']);

/**
 * Shared modules of the admin, adjusted for this remote
 *
 * @param build only the production build relies on the admin; the dev server has no host
 */
export function sharedModules(build: boolean): Record<string, Record<string, unknown>> {
	const shared = moduleFederationShared(JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')));
	return Object.fromEntries(
		Object.entries(shared as Record<string, Record<string, unknown>>)
			.filter(([name]) => !NOT_SHARED.has(name))
			.map(([name, config]) => [name, build && HOST_ONLY.has(name) ? { ...config, import: false } : config]),
	);
}

export default ({ command }: ConfigEnv): UserConfig => ({
	plugins: [
		federation({
			manifest: true,
			name: 'ConfigCustomUnifiAccessSet',
			filename: 'customComponents.js',
			exposes: {
				'./Components': './src/Components.tsx',
			},
			remotes: {},
			shared: sharedModules(command === 'build'),
			dts: false,
		}),
		react(),
		commonjs(),
	],
	server: {
		port: 3000,
	},
	base: './',
	build: {
		target: 'chrome89',
		outDir: './build',
		chunkSizeWarningLimit: 5000,
	},
});
