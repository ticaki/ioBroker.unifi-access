#!/usr/bin/env node
'use strict';

/**
 * Stand-alone launcher for the mock UniFi Access controller.
 *
 *   node test/mock/cli.js --port 12445 --token test-token
 *   npm run mock:controller -- --port 12445 --token test-token
 *
 * See test/mock/README.md for all options and the /__mock/... control routes.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MockUnifiController, CONTROL_ROUTES } = require('./index');

const HELP = `Mock UniFi Access controller (Developer API, HTTPS + WebSocket)

Usage: node test/mock/cli.js [options]

  --port <n>          Port to listen on (default 12445, 0 = let the OS pick)
  --host <addr>       Interface to bind (default 127.0.0.1; use 0.0.0.0 for all interfaces)
  --token <token>     Accepted API token (default test-token)
  --auto-events       Deliver an access.door.unlock webhook after every PUT /doors/:id/unlock
  --any-static        Serve a tiny JPEG for every /system/static/<path>
  --duplicate-status <n>  HTTP status for CODE_DEVICE_WEBHOOK_ENDPOINT_DUPLICATED (default 200)
  --cert-out <file>   Write the generated certificate (PEM) to <file> (use it as "CA certificate")
  --san <name>        Extra subjectAltName (DNS name or IP), repeatable
  --quiet             Do not log requests
  --help              Show this help
`;

function parseArgs(argv) {
	const options = {
		port: 12_445,
		host: '127.0.0.1',
		token: 'test-token',
		autoEvents: false,
		anyStatic: false,
		duplicateStatus: 200,
		certOut: '',
		san: [],
		quiet: false,
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = () => {
			const next = argv[++i];
			if (next === undefined) {
				throw new Error(`missing value for ${arg}`);
			}
			return next;
		};
		switch (arg) {
			case '--port':
				options.port = Number.parseInt(value(), 10);
				break;
			case '--host':
				options.host = value();
				break;
			case '--token':
				options.token = value();
				break;
			case '--auto-events':
				options.autoEvents = true;
				break;
			case '--any-static':
				options.anyStatic = true;
				break;
			case '--duplicate-status':
				options.duplicateStatus = Number.parseInt(value(), 10);
				break;
			case '--cert-out':
				options.certOut = value();
				break;
			case '--san':
				options.san.push(value());
				break;
			case '--quiet':
				options.quiet = true;
				break;
			case '--help':
			case '-h':
				options.help = true;
				break;
			default:
				throw new Error(`unknown option: ${arg}`);
		}
	}
	if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
		throw new Error('--port must be an integer between 0 and 65535');
	}
	return options;
}

function localAltNames(extra) {
	const names = new Set(['localhost', '127.0.0.1', '::1', os.hostname(), ...extra]);
	for (const addresses of Object.values(os.networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (!address.internal && address.family === 'IPv4') {
				names.add(address.address);
			}
		}
	}
	return [...names].filter(Boolean);
}

async function main() {
	let options;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(`${err.message}\n\n${HELP}`);
		process.exitCode = 2;
		return;
	}
	if (options.help) {
		console.log(HELP);
		return;
	}

	const mock = new MockUnifiController({
		port: options.port,
		host: options.host,
		token: options.token,
		autoEvents: options.autoEvents,
		serveAnyStatic: options.anyStatic,
		duplicateEndpointHttpStatus: options.duplicateStatus,
		altNames: localAltNames(options.san),
		log: options.quiet ? undefined : message => console.log(`[${new Date().toISOString()}] ${message}`),
	});
	await mock.start();

	if (options.certOut) {
		const target = path.resolve(options.certOut);
		fs.writeFileSync(target, mock.cert);
		console.log(`certificate written to ${target}`);
	}

	const base = `https://${options.host === '0.0.0.0' ? '127.0.0.1' : options.host}:${mock.port}`;
	console.log('');
	console.log(`Mock UniFi Access controller ready`);
	console.log(`  API:        ${base}/api/v1/developer/...`);
	console.log(`  WebSocket:  ${base.replace('https', 'wss')}/api/v1/developer/devices/notifications`);
	console.log(`  API token:  ${mock.token}`);
	console.log(
		`  Adapter:    controllerHost=${options.host === '0.0.0.0' ? '<this host>' : options.host}, controllerPort=${mock.port}, verifyTLS=false`,
	);
	console.log('');
	console.log('Control routes (no token needed, self-signed certificate → curl -k):');
	for (const [route, description] of Object.entries(CONTROL_ROUTES)) {
		console.log(`  ${route.padEnd(26)} ${description}`);
	}
	console.log('');
	console.log('Press Ctrl+C to stop.');

	let stopping = false;
	const shutdown = () => {
		if (stopping) {
			return;
		}
		stopping = true;
		mock.stop().then(
			() => process.exit(0),
			() => process.exit(1),
		);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

main().catch(err => {
	console.error(err);
	process.exitCode = 1;
});
