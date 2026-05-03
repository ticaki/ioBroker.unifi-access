// ioBroker eslint template configuration file for js and ts files
// Please note that esm or react based modules need additional modules loaded.
import config from '@iobroker/eslint-config';
import pluginUnicorn from 'eslint-plugin-unicorn';

export default [
	...config,
	{
		// specify files to exclude from linting here
		ignores: [
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
];
