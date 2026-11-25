'use strict';

/**
 * Logger double with the `{ debug, info, warn, error }` shape the adapter modules expect.
 * Every message is collected so tests can assert on (or simply silence) log output.
 *
 * @returns {{ silly: (m: string) => void, debug: (m: string) => void, info: (m: string) => void, warn: (m: string) => void, error: (m: string) => void, messages: { level: string, message: string }[], of: (level: string) => string[], clear: () => void }}
 *   The logger
 */
function createTestLogger() {
	/** @type {{ level: string, message: string }[]} */
	const messages = [];
	const sink = level => message => {
		messages.push({ level, message: String(message) });
	};
	return {
		silly: sink('silly'),
		debug: sink('debug'),
		info: sink('info'),
		warn: sink('warn'),
		error: sink('error'),
		messages,
		of: level => messages.filter(entry => entry.level === level).map(entry => entry.message),
		clear: () => {
			messages.length = 0;
		},
	};
}

module.exports = { createTestLogger };
