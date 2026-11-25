// ioBroker eslint template configuration file for js and ts files
// Please note that esm or react based modules need additional modules loaded.
import config from '@iobroker/eslint-config';
// eslint-plugin-unicorn is a peer dependency of @iobroker/eslint-config and gets installed with it –
// it must not be listed in our own devDependencies (ioBroker repo checker E0078).
// The default config does not register the plugin, so we do it below for the one rule we use.
import pluginUnicorn from 'eslint-plugin-unicorn';

/** Adapter methods with an effect outside the process (state/object writes, timers). */
const EFFECT_METHODS =
	'/^(setState|setStateAsync|setStateChanged|setStateChangedAsync|setForeignState|setForeignStateAsync|extendObject|extendObjectAsync|extendForeignObject|extendForeignObjectAsync|setObject|setObjectAsync|setObjectNotExists|setObjectNotExistsAsync|setForeignObject|setForeignObjectAsync|delObject|delObjectAsync|delState|delStateAsync|setTimeout|setInterval)$/';

export default [
	...config,
	{
		// specify files to exclude from linting here
		ignores: [
			// Claude Code keeps agent worktrees (full repo copies) in .claude/worktrees/ –
			// flat config does not ignore dot-directories on its own.
			'.claude/',
			'.dev-server/',
			'.vscode/',
			'*.test.js',
			'test/**/*.js',
			'*.config.mjs',
			'build',
			'dist',
			'admin/words.js',
			'admin/admin.d.ts',
			'admin/blockly.js',
			'**/adapter-config.d.ts',
			'widgets/**/*.js',
			'tasks.ts',
			'data',
			'admin',
			'src-admin',
			'src-www',
			'www',
		],
	},
	{
		plugins: {
			unicorn: pluginUnicorn,
		},
		rules: {
			'jsdoc/require-jsdoc': 'off',
			'require-await': 'off',
			'@typescript-eslint/require-await': 'off',
			'no-unused-vars': 'off',
			'unicorn/numeric-separators-style': [
				'warn',
				{
					number: { minimumDigits: 5, groupLength: 3 },
					hexadecimal: { minimumDigits: 0, groupLength: 2 },
					binary: { minimumDigits: 0, groupLength: 4 },
					octal: { minimumDigits: 0, groupLength: 3 },
				},
			],
		},
	},
	{
		// Work that continues after the stop must not write anything or start timers (src/lib/stopSignal.ts):
		// the adapter class and the state manager only write through their stop-aware wrappers.
		files: ['src/main.ts'],
		rules: {
			'no-restricted-syntax': [
				'error',
				{
					selector: `CallExpression[callee.object.type='ThisExpression'][callee.property.name=${EFFECT_METHODS}]`,
					message:
						'Use the stop-aware wrappers (writeState, writeForeignState, startTimer, startInterval) or call this.throwIfStopped() right before.',
				},
			],
		},
	},
	{
		files: ['src/lib/library.ts'],
		rules: {
			'no-restricted-syntax': [
				'error',
				{
					selector: `CallExpression[callee.object.property.name='adapter'][callee.property.name=${EFFECT_METHODS}]`,
					message:
						'Write through set/extend/create (they refuse after the stop) or call throwIfStopped() right before.',
				},
			],
		},
	},
];
