/**
 * The generated bundle in admin/custom as the admin loads it: through the module federation runtime,
 * with React, MUI and the ioBroker libraries taken from the host.
 *
 * The CI job "frontend-tests" fails if admin/custom does not match the sources, so this checks what is
 * shipped. Locally run `npm run build:admin` first after a change.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as EmotionReact from '@emotion/react';
import * as EmotionStyled from '@emotion/styled';
import * as JsxRuntime from 'react/jsx-runtime';
import * as Mui from '@mui/material';
import * as GuiComponents from '@iobroker/gui-components';
import * as JsonConfig from '@iobroker/json-config';
import { init, loadRemote, registerRemotes } from '@module-federation/runtime';
import { fireEvent, render, screen } from '@testing-library/react';
import { initI18n, makeHarness } from './test/harness';
import type { ConfigGenericProps } from '@iobroker/json-config';

const here = dirname(fileURLToPath(import.meta.url));
const customDir = resolve(here, '../../admin/custom');
const assetsDir = resolve(customDir, 'assets');

/**
 * Relative imports of a chunk: `import`/`export … from` (static) and `import()` (dynamic)
 *
 * @param file absolute path of the chunk
 */
function importsOf(file: string): { static: string[]; dynamic: string[] } {
	const code = readFileSync(file, 'utf8');
	const target = (spec: string): string => resolve(dirname(file), spec);
	return {
		static: [
			...code.matchAll(/(?:^|[;}\s])(?:import|export)\s*(?:[\w*{}\s,$]+from\s*)?["'](\.\.?\/[^"']+)["']/g),
		].map(m => target(m[1])),
		dynamic: [...code.matchAll(/import\(\s*["'`](\.\.?\/[^"'`]+)["'`]\s*\)/g)].map(m => target(m[1])),
	};
}

/**
 * Every file the browser has to load before the module evaluates
 *
 * @param entry absolute path of the module the browser loads
 */
function staticClosure(entry: string): Set<string> {
	const seen = new Set<string>();
	const stack = [entry];
	while (stack.length) {
		const file = stack.pop() as string;
		if (!seen.has(file)) {
			seen.add(file);
			stack.push(...importsOf(file).static);
		}
	}
	return seen;
}

function exposedChunk(): string {
	const chunks = readdirSync(assetsDir).filter(file => /^Components-[\w-]+\.js$/.test(file));
	expect(chunks).toHaveLength(1);
	return resolve(assetsDir, chunks[0]);
}

describe('admin/custom bundle', () => {
	it('loads only a small part when the settings open', () => {
		const files = staticClosure(exposedChunk());
		const sizes = [...files].map(file => statSync(file).size);
		const total = sizes.reduce((sum, size) => sum + size, 0);

		// Before the fix the exposed module statically imported a 7.3 MB chunk with copies of
		// gui-components, MUI and the complete icon library.
		expect(Math.max(...sizes)).toBeLessThan(200_000);
		expect(total).toBeLessThan(400_000);
	});

	it('carries no own copy of the libraries the admin provides', () => {
		const manifest = JSON.parse(readFileSync(resolve(customDir, 'mf-manifest.json'), 'utf8')) as {
			shared: { name: string }[];
		};
		const shared = manifest.shared.map(entry => entry.name);

		// the admin decides by this entry that the components belong to GUI API generation 2
		expect(shared).toContain('@iobroker/gui-components');
		// admin 8.3 does not offer the icon library, the used icons are bundled
		expect(shared).not.toContain('@mui/icons-material');
		const all = readdirSync(assetsDir).reduce((sum, file) => sum + statSync(resolve(assetsDir, file)).size, 0);
		expect(all).toBeLessThan(2_000_000);
	});

	it('refers only to chunks that exist', () => {
		for (const file of [
			resolve(customDir, 'customComponents.js'),
			...readdirSync(assetsDir).map(f => resolve(assetsDir, f)),
		]) {
			const { static: s, dynamic: d } = importsOf(file);
			for (const target of [...s, ...d]) {
				expect(() => statSync(target), `${file} -> ${target}`).not.toThrow();
			}
		}
	});
});

describe('admin/custom loaded through module federation like the admin does it', () => {
	type Components = Record<string, React.ComponentType<ConfigGenericProps>>;
	let components: Components;

	beforeAll(async () => {
		initI18n();
		const lib = (version: string, module: unknown): Record<string, unknown> => ({
			version,
			lib: () => module,
			shareConfig: { singleton: true, requiredVersion: '*' },
		});
		// what admin 8 registers (see its mf-manifest.json); deliberately no @mui/icons-material
		init({
			name: 'iobroker_admin',
			remotes: [],
			shared: {
				react: lib('19.3.1', React),
				'react-dom': lib('19.3.1', ReactDOM),
				'react/jsx-runtime': lib('19.3.1', JsxRuntime),
				'@emotion/react': lib('11.14.0', EmotionReact),
				'@emotion/styled': lib('11.14.1', EmotionStyled),
				'@mui/material': lib('9.5.0', Mui),
				'@iobroker/gui-components': lib('10.4.8', GuiComponents),
				'@iobroker/json-config': lib('10.1.24', JsonConfig),
			},
		});
		registerRemotes([
			{
				name: 'ConfigCustomUnifiAccessSet',
				entry: pathToFileURL(resolve(customDir, 'customComponents.js')).href,
				type: 'module',
			},
		]);
		const module = await loadRemote<{ default: Components }>('ConfigCustomUnifiAccessSet/Components');
		components = module?.default as Components;
	}, 60_000);

	it('exposes all four components', () => {
		expect(Object.keys(components).sort()).toEqual([
			'ActorSelect',
			'AuthSetup',
			'DeviceManagement',
			'GenericWebhookUrl',
		]);
	});

	it('renders with the React, MUI and I18n instance of the host', async () => {
		const { AuthSetup } = components;
		const { props, socket } = makeHarness({
			data: { controllerHost: '192.0.2.10', controllerPort: 12445, apiToken: 'secret-token' },
			answers: { verifyToken: { ok: true, deviceCount: 2 } },
		});
		render(<AuthSetup {...props} />);

		// translated by the I18n of the host: a second copy would show the raw key
		fireEvent.click(await screen.findByRole('button', { name: 'Test connection' }));
		expect((await screen.findByRole('alert')).textContent).toBe('Connection successful — 2 devices found');
		expect(socket.sendTo).toHaveBeenCalledWith(
			'unifi-access.0',
			'verifyToken',
			expect.objectContaining({ host: '192.0.2.10' }),
		);
		// it is the class of the host's json-config
		expect(Object.getPrototypeOf(AuthSetup)).toBe(JsonConfig.ConfigGeneric);
	});
});
