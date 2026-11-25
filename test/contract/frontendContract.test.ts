/**
 * Contract between the adapter and its two frontends (admin custom components in src-admin/src, www
 * panel in src-www/src).
 *
 * The frontend tests work with hand-written answers and state ids; drift between them and the adapter
 * stays unnoticed there. This test takes the other side: it runs the REAL adapter (fake adapter core,
 * mock controller) and checks its sendTo answers, error codes and objects against what the frontend
 * sources declare and parse. The frontend files are read as text — importing them would need the
 * React/MUI dependencies of the sub-projects, which the root CI job does not install.
 *
 * When a check here fails, either the adapter or the frontend has to follow the other.
 */

import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import sinon from 'sinon';
import * as ts from 'typescript';

import {
	createAdapterWithFakeCore,
	fixtures,
	getFreePort,
	httpRequest,
	MockUnifiController,
	waitFor,
	type FakeAdapter,
} from '../mock';
import { featuresFor, type UnifiDeviceModel } from '../../src/lib/deviceModels';
import { normalizePort } from '../../src/lib/controlValues';
import { DOORBELL_REASONS } from '../../src/lib/eventNormalizer';
import { normalizePublicBaseUrl } from '../../src/lib/publicBaseUrl';
import { normalizeWebhookPath, reservedWebhookPathOwner } from '../../src/webhooks/genericWebhookServer';

const ROOT = join(__dirname, '..', '..');
const MAIN = join(ROOT, 'src', 'main');
const TOKEN = 'contract-test-token';
const NS = 'unifi-access.0';
const { DOOR_3855, DEVICE_ULTRA } = fixtures.IDS;

const source = (...segments: string[]): string => readFileSync(join(ROOT, ...segments), 'utf8');

/**
 * Field names of a TypeScript interface in a source text.
 *
 * @param text Source text
 * @param name Interface name
 * @returns name → whether the field is optional
 */
function interfaceFields(text: string, name: string): Map<string, boolean> {
	const match = new RegExp(`interface ${name}\\s*(?:extends [^{]+)?\\{([\\s\\S]*?)\\n\\}`).exec(text);
	expect(match, `interface ${name}`).to.not.equal(null);
	const fields = new Map<string, boolean>();
	for (const [, field, optional] of match![1].matchAll(/^\s*(\w+)(\?)?:/gm)) {
		fields.set(field, optional === '?');
	}
	return fields;
}

/**
 * Keys of an object literal `const NAME: … = { … }` in a source text.
 *
 * @param text Source text
 * @param name Constant name
 */
function objectLiteralKeys(text: string, name: string): string[] {
	const match = new RegExp(`const ${name}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`).exec(text);
	expect(match, `const ${name}`).to.not.equal(null);
	return [...match![1].matchAll(/^\s*'?([\w-]+)'?\s*:/gm)].map(m => m[1]);
}

/** The URL rules of the admin page (src-admin/src/serverUrl.ts) */
interface FrontendServerUrl {
	normalizePublicBaseUrl(raw: unknown): string | null;
	normalizeWebhookPath(raw: unknown): string;
	normalizePort(raw: unknown): number;
}

/**
 * Run a frontend module that imports nothing: strip the types, evaluate it in a fresh context.
 *
 * @param segments Path below the project root
 */
function loadFrontendModule<T>(...segments: string[]): T {
	const text = source(...segments);
	expect(text, `${segments.join('/')} must not import anything`).to.not.match(/^\s*import\s/m);
	const { outputText } = ts.transpileModule(text, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const module = { exports: {} as Record<string, unknown> };
	runInNewContext(outputText, { module, exports: module.exports, URL });
	return module.exports as T;
}

const adminAuthSetup = source('src-admin', 'src', 'AuthSetup.tsx');
const adminRequest = source('src-admin', 'src', 'adapterRequest.ts');
const adminDevices = source('src-admin', 'src', 'DeviceManagement.tsx');
const adminActors = source('src-admin', 'src', 'ActorSelect.tsx');
const adminWebhookUrl = source('src-admin', 'src', 'GenericWebhookUrl.tsx');
const jsonConfig = JSON.parse(source('admin', 'jsonConfig.json')) as {
	items: Record<string, { items: Record<string, { error?: Record<string, string> }> }>;
};

type JsonConfigItem = { validator?: string; [key: string]: unknown };

/**
 * The validator of a field in admin/jsonConfig.json as a function of the form data — evaluated the way
 * the admin does it (`ConfigGeneric.execute()` of `@iobroker/json-config`): `return` is put in front only
 * when the text does not contain the word `return` anywhere; an exception counts as "invalid".
 *
 * @param tab Tab key
 * @param field Field key
 */
function jsonConfigValidator(tab: string, field: string): (data: Record<string, unknown>) => boolean {
	const item = (jsonConfig.items[tab].items as Record<string, JsonConfigItem>)[field];
	expect(item?.validator, `${tab}.${field}.validator`).to.be.a('string');
	const body = item.validator!.includes('return') ? item.validator! : `return ${item.validator}`;
	const fn = new Function('data', body) as (data: Record<string, unknown>) => unknown;
	return data => {
		try {
			return fn(data) === true;
		} catch {
			return false;
		}
	};
}

/** Error codes describeAdapterError translates (everything else is shown raw). */
const TRANSLATED_ERRORS = new Set(objectLiteralKeys(adminRequest, 'ADAPTER_ERROR_TEXTS'));
/** Codes AuthSetup handles itself before falling back to describeAdapterError. */
const AUTH_SETUP_ERRORS = new Set([...adminAuthSetup.matchAll(/code === '([\w-]+)'/g)].map(m => m[1]));

describe('contract adapter ↔ frontend (sendTo answers, error codes, state ids)', () => {
	let mock: MockUnifiController;
	let adapter: FakeAdapter | undefined;
	let clock: sinon.SinonFakeTimers;
	let listenPort: number;

	async function start(overrides: Record<string, unknown> = {}): Promise<FakeAdapter> {
		adapter = createAdapterWithFakeCore(MAIN, {
			controllerHost: '127.0.0.1',
			controllerPort: mock.port,
			apiToken: TOKEN,
			wsReconnectDelay: 0.05,
			listenPort,
			listenIp: '127.0.0.1',
			enableWebhooks: true,
			enableThumbnailServer: true,
			forwardEvents: [],
			...overrides,
		});
		await adapter.fireReady();
		return adapter;
	}

	beforeEach(async () => {
		mock = new MockUnifiController({ token: TOKEN });
		await mock.start();
		listenPort = await getFreePort();
		clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
	});

	afterEach(async () => {
		try {
			await adapter?.fireUnload();
		} finally {
			adapter = undefined;
			clock.restore();
			await mock.stop();
		}
	});

	describe('verifyToken ↔ AuthSetup.tsx', () => {
		const fields = interfaceFields(adminAuthSetup, 'VerifyTokenAnswer');

		it('the frontend parses the documented fields (sanity check of the text parser)', () => {
			expect([...fields.keys()]).to.include.members(['ok', 'error', 'detail', 'deviceCount']);
		});

		it('every field of a real answer is one the frontend declares; deviceCount is a count', async () => {
			const instance = await start({ enableWebhooks: false });
			const answer = await instance.request('verifyToken', { host: '127.0.0.1', port: mock.port, token: TOKEN });
			expect(answer.ok).to.equal(true);
			for (const key of Object.keys(answer)) {
				expect(fields.has(key), `field ${key}`).to.equal(true);
			}
			expect(Number.isInteger(answer.deviceCount) && answer.deviceCount >= 0).to.equal(true);
		});

		it('every error code the adapter answers is handled by the frontend; "tls" comes with its detail', async () => {
			const instance = await start({ enableWebhooks: false });
			const closedPort = await getFreePort();
			const answers = [
				await instance.request('verifyToken', { host: '127.0.0.1', port: mock.port, token: 'wrong' }),
				await instance.request('verifyToken', { host: '127.0.0.1', port: closedPort, token: TOKEN }, 15_000),
				await instance.request('verifyToken', {
					host: '127.0.0.1',
					port: mock.port,
					token: TOKEN,
					verifyTLS: true,
					caCert: '',
				}),
				await instance.request('verifyToken', { host: '', token: TOKEN }),
				await instance.request('verifyToken-does-not-exist'),
			];
			expect(answers.map(a => a.error)).to.deep.equal([
				'unauthorized',
				'network',
				'tls',
				'missing-fields',
				'unknown-command',
			]);
			for (const answer of answers) {
				expect(answer.ok).to.equal(false);
				expect(
					AUTH_SETUP_ERRORS.has(answer.error) || TRANSLATED_ERRORS.has(answer.error),
					`code ${answer.error} has a text in the frontend`,
				).to.equal(true);
				for (const key of Object.keys(answer)) {
					expect(fields.has(key), `field ${key}`).to.equal(true);
				}
			}
			expect(answers[2].detail).to.equal('DEPTH_ZERO_SELF_SIGNED_CERT');
		});
	});

	describe('listDevices ↔ DeviceManagement.tsx', () => {
		it('every device carries the fields the panel needs, with the expected types', async () => {
			const fields = interfaceFields(adminDevices, 'UnifiDeviceEntry');
			const instance = await start({ enableWebhooks: false });
			await waitFor(() => instance.val('info.connection') === true, { description: 'connected' });
			const { devices } = await instance.request('listDevices');
			expect(devices).to.have.length(4);
			for (const device of devices as Record<string, unknown>[]) {
				for (const [field, optional] of fields) {
					if (!optional) {
						expect(device, `${String(device.id)}.${field}`).to.have.property(field);
					}
				}
				expect(device.id).to.be.a('string');
				expect(device.name).to.be.a('string');
				expect(device.model).to.be.a('string');
				expect(device.capabilities).to.be.an('array');
			}
		});

		it('every capability the adapter can report has its own chip in the panel', () => {
			const models: UnifiDeviceModel[] = [
				'UA-Ultra',
				'UA-G2-Pro',
				'UA-G3-Pro',
				'UA-Intercom',
				'UA-Lite',
				'UA-Hub',
				'unknown',
			];
			const capabilities = new Set(models.flatMap(model => [...featuresFor(model)]));
			for (const capability of capabilities) {
				const key = capability.replace(/-/g, '\\-');
				expect(new RegExp(`(?:'${key}'|\\b${key})\\s*:\\s*\\{`).test(adminDevices), capability).to.equal(true);
			}
		});
	});

	describe('listUsers ↔ ActorSelect.tsx', () => {
		it('users come as {id, name} strings', async () => {
			const fields = interfaceFields(adminActors, 'UnifiUser');
			expect([...fields.keys()].sort()).to.deep.equal(['id', 'name']);
			const instance = await start({ enableWebhooks: false });
			await waitFor(() => instance.val('info.connection') === true, { description: 'connected' });
			const { users, error } = await instance.request('listUsers');
			expect(error).to.equal(undefined);
			expect(users.length).to.be.greaterThan(0);
			for (const user of users as Record<string, unknown>[]) {
				expect(Object.keys(user).sort()).to.deep.equal(['id', 'name']);
				expect(user.id).to.be.a('string');
				expect(user.name).to.be.a('string');
			}
		});

		it('the error of an unconfigured instance has a text in the frontend', async () => {
			const instance = await start({ apiToken: '' });
			const answer = await instance.request('listUsers');
			expect(answer).to.deep.equal({ users: [], error: 'not-configured' });
			expect(TRANSLATED_ERRORS.has(answer.error)).to.equal(true);
		});
	});

	describe('getServerInfo / getNetworkInterfaces ↔ GenericWebhookUrl.tsx', () => {
		it('getServerInfo carries every field of ServerInfo with the expected type', async () => {
			const fields = interfaceFields(adminWebhookUrl, 'ServerInfo');
			const instance = await start();
			const info = await instance.request('getServerInfo');
			for (const field of fields.keys()) {
				expect(info, field).to.have.property(field);
			}
			expect(info.running).to.equal(true);
			expect(info.scheme).to.be.oneOf(['http', 'https']);
			expect(info.tlsEnabled).to.be.a('boolean');
			expect(info.tlsActive).to.be.a('boolean');
			expect(info.tlsError).to.equal(null);
			expect(info.publicBaseUrl).to.equal(null);
		});

		it('the frontend parses the fields the U-10 / fail-closed rules need (sanity check of the text parser)', () => {
			expect([...interfaceFields(adminWebhookUrl, 'ServerInfo').keys()]).to.include.members([
				'running',
				'tlsEnabled',
				'tlsError',
				'publicBaseUrl',
			]);
		});

		it('with unusable certificates: not running, TLS enabled, the reason as text — as GenericWebhookUrl expects', async () => {
			const instance = await start({ enableTls: true, certPublic: 'missing', certPrivate: 'missing' });
			const info = await instance.request('getServerInfo');
			expect(info).to.include({
				running: false,
				scheme: null,
				baseUrl: null,
				tlsEnabled: true,
				tlsActive: false,
			});
			expect(info.tlsError).to.be.a('string').and.not.equal('');
			expect(info).to.have.property('publicBaseUrl', null);
		});

		it('publicBaseUrl is the saved value as the admin page normalises the form value', async () => {
			const frontend = loadFrontendModule<FrontendServerUrl>('src-admin', 'src', 'serverUrl.ts');
			const raw = '  HTTPS://Proxy.example.com:443/iob//  ';
			const instance = await start({ publicBaseUrl: raw });
			const info = await instance.request('getServerInfo');
			expect(info.publicBaseUrl).to.equal('https://proxy.example.com/iob');
			expect(info.publicBaseUrl).to.equal(frontend.normalizePublicBaseUrl(raw));
			expect(info.baseUrl).to.equal(info.publicBaseUrl);
		});

		it('the URL rules of the admin page are the rules of the adapter', () => {
			const frontend = loadFrontendModule<FrontendServerUrl>('src-admin', 'src', 'serverUrl.ts');
			const baseUrls: unknown[] = [
				'',
				'   ',
				'/',
				'https://proxy.example.com',
				' https://proxy.example.com/iob/// ',
				'HTTP://Proxy.Example.COM:80/a/b',
				'https://proxy.example.com:443',
				'http://203.0.113.4:18095',
				'http://[2001:db8::1]:8095/x',
				'https://proxy.example.com:99999',
				'https://user:pw@proxy.example.com',
				'https://proxy.example.com/?a=1',
				'https://proxy.example.com/#x',
				'https://proxy.example.com/a b',
				'https://proxy.example.com/a%20b',
				'ftp://proxy.example.com',
				'proxy.example.com',
				'https://',
				'https://%zz',
				null,
				undefined,
				42,
			];
			for (const raw of baseUrls) {
				expect(frontend.normalizePublicBaseUrl(raw), String(raw)).to.equal(normalizePublicBaseUrl(raw).url);
			}
			const paths: unknown[] = [
				'/webhook',
				'hook',
				' /a ',
				'',
				'  ',
				'//a//b',
				'/a?x',
				'/a#y',
				'?x',
				'/ä',
				null,
				5,
			];
			for (const raw of paths) {
				expect(frontend.normalizeWebhookPath(raw), String(raw)).to.equal(normalizeWebhookPath(raw));
			}
			const ports: unknown[] = [9000, '9000', ' 9000 ', 0, -1, 65_535, 65_536, 8095.5, '', '90a', '1e3', null];
			for (const raw of ports) {
				expect(frontend.normalizePort(raw), String(raw)).to.equal(normalizePort(raw, 8095));
			}
		});

		it('the validator of publicBaseUrl accepts exactly what the adapter uses (RF-05)', () => {
			const validator = jsonConfigValidator('_serverTab', 'publicBaseUrl');
			const values = [
				'',
				'   ',
				'/',
				'https://proxy.example.com',
				' https://proxy.example.com/iob/// ',
				'HTTP://Proxy.Example.COM:80/a/b',
				'https://proxy.example.com:443',
				'http://203.0.113.4:18095',
				'http://[2001:db8::1]:8095/x',
				'https://proxy.example.com:65535',
				'https://proxy.example.com:65536',
				'https://proxy.example.com:99999',
				'https://user:pw@proxy.example.com',
				'https://user@proxy.example.com',
				'https://:pw@proxy.example.com',
				'https://proxy.example.com/?a=1',
				'https://proxy.example.com/#x',
				'https://proxy.example.com/a b',
				'https://proxy.example.com/a%20b',
				'ftp://proxy.example.com',
				'proxy.example.com',
				'https://',
				'https://%zz',
				'https://exa mple.com',
				'https://[::1',
			];
			for (const value of values) {
				// a value the adapter ignores without a warning (empty after trimming) can be saved as well
				expect(validator({ publicBaseUrl: value }), JSON.stringify(value)).to.equal(
					normalizePublicBaseUrl(value).problem === undefined,
				);
			}
			// the same in a browser without URL.canParse (Chrome < 120, Safari < 17, Firefox < 115; R2F-02)
			const canParse = Object.getOwnPropertyDescriptor(URL, 'canParse');
			try {
				Object.defineProperty(URL, 'canParse', { value: undefined, configurable: true, writable: true });
				for (const value of values) {
					expect(
						validator({ publicBaseUrl: value }),
						`without URL.canParse: ${JSON.stringify(value)}`,
					).to.equal(normalizePublicBaseUrl(value).problem === undefined);
				}
			} finally {
				if (canParse) {
					Object.defineProperty(URL, 'canParse', canParse);
				}
			}
			// and the admin page applies the same rule (shown URL ↔ validator)
			const frontend = loadFrontendModule<FrontendServerUrl>('src-admin', 'src', 'serverUrl.ts');
			for (const value of values) {
				const usable = frontend.normalizePublicBaseUrl(value) !== null;
				if (usable) {
					expect(validator({ publicBaseUrl: value }), JSON.stringify(value)).to.equal(true);
				}
			}
		});

		it('getServerInfo.port is the port the admin page compares the form with (RF-06)', async () => {
			const frontend = loadFrontendModule<FrontendServerUrl>('src-admin', 'src', 'serverUrl.ts');
			expect([...interfaceFields(adminWebhookUrl, 'ServerInfo').keys()]).to.include('port');
			const instance = await start({ listenPort: ` ${listenPort} ` });
			const info = await instance.request('getServerInfo');
			expect(info.port).to.equal(frontend.normalizePort(` ${listenPort} `));
		});

		it('the path validator refuses exactly the paths the adapter does not start the generic webhook on (RK-03)', () => {
			const validator = jsonConfigValidator('_genericWebhookTab', 'genericWebhookPath');
			const FORMAT = /^\/?(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/;
			const paths = [
				'',
				'/webhook',
				'alarm/door',
				'unifi-access-webhook',
				'/unifi-access-webhook',
				'/unifi-access-webhook2',
				'/unifi-access-webhook/x',
				'/unifi-access',
				'unifi-access/',
				'/unifi-access/0/thumbnail/x',
				'/unifi-access/1/protect-video/a',
				'/my/unifi-access-webhook',
			];
			for (const path of paths) {
				const free = reservedWebhookPathOwner(normalizeWebhookPath(path)) === null;
				expect(validator({ enableGenericWebhook: true, genericWebhookPath: path }), path).to.equal(
					FORMAT.test(path || '/webhook') && free,
				);
				// switched off, any value can be saved
				expect(validator({ enableGenericWebhook: false, genericWebhookPath: path }), path).to.equal(true);
			}
			expect(validator({ enableGenericWebhook: true, genericWebhookPath: '/unifi-access-webhook' })).to.equal(
				false,
			);
			expect(validator({ enableGenericWebhook: true, genericWebhookPath: '/unifi-access/0/x' })).to.equal(false);
		});

		it('the generic webhook answers at the path the admin page shows', async () => {
			const frontend = loadFrontendModule<FrontendServerUrl>('src-admin', 'src', 'serverUrl.ts');
			const path = '  //alarm//in  ';
			await start({ enableWebhooks: false, enableGenericWebhook: true, genericWebhookPath: path });
			const url = `http://127.0.0.1:${frontend.normalizePort(listenPort)}${frontend.normalizeWebhookPath(path)}`;
			const answer = await httpRequest({ url, method: 'POST', body: '{}' });
			expect(answer.status, url).to.equal(200);
		});

		it('getNetworkInterfaces answers a list of address strings', async () => {
			const instance = await start({ enableWebhooks: false });
			const { addresses } = await instance.request('getNetworkInterfaces');
			expect(addresses).to.be.an('array');
			for (const address of addresses as unknown[]) {
				expect(address).to.be.a('string');
			}
		});
	});

	describe('reregisterWebhook ↔ admin/jsonConfig.json', () => {
		const errorTexts = jsonConfig.items._serverTab.items._reregisterWebhook.error ?? {};

		it('every error code the adapter answers has a text at the button', async () => {
			const codes: string[] = [];
			let instance = await start({ apiToken: '' });
			codes.push((await instance.request('reregisterWebhook')).error);
			await instance.fireUnload();
			instance = await start({ enableWebhooks: false });
			codes.push((await instance.request('reregisterWebhook')).error);
			await instance.fireUnload();
			// webhooks on, but nothing to serve on the port: the receiver is not running
			instance = await start({ enableTls: true, certPublic: 'missing', certPrivate: 'missing' });
			codes.push((await instance.request('reregisterWebhook')).error);
			codes.push((await instance.request('reregisterWebhook-does-not-exist')).error);
			expect(codes).to.deep.equal([
				'not-configured',
				'webhooks-disabled',
				'receiver-not-running',
				'unknown-command',
			]);
			for (const code of codes) {
				expect(errorTexts, code).to.have.property(code);
			}
		});

		it('a successful answer is exactly {ok, id}', async () => {
			const instance = await start();
			await waitFor(() => instance.val('info.webhookRegistered') === true, { description: 'registered' });
			const answer = await instance.request('reregisterWebhook');
			expect(Object.keys(answer).sort()).to.deep.equal(['id', 'ok']);
		});
	});

	describe('state ids of the www panel ↔ objects the adapter creates', () => {
		const wwwFiles = [
			'App.tsx',
			'settings.ts',
			'socket.ts',
			'components/ControllerStatusBadge.tsx',
			'components/DoorCard.tsx',
			'components/DoorList.tsx',
			'components/DoorbellCallsCard.tsx',
			'components/EventLogCard.tsx',
			'components/LastThumbnailCard.tsx',
			'components/SettingsPanel.tsx',
		];
		const www = wwwFiles.map(file => source('src-www', 'src', ...file.split('/'))).join('\n');

		/**
		 * State ids written as literals in the panel (template parts replaced by real ids).
		 *
		 * @param doorId Door id for `doors.${…}`
		 * @param deviceId Device id for `devices.${…}`
		 */
		const literalIds = (doorId: string, deviceId: string): string[] =>
			[
				...new Set(
					[...www.matchAll(/['`]((?:info|doors|devices|events|doorbell|admin)\.[\w.${}]+)['`]/g)].map(
						m => m[1],
					),
				),
			].map(id =>
				id
					.replace(/^doors\.\$\{[^}]+\}/, `doors.${doorId}`)
					.replace(/^devices\.\$\{[^}]+\}/, `devices.${deviceId}`),
			);

		/**
		 * Leaves the panel reads from the door / device channels (`leaf === '…'`, THUMBNAIL_STATES).
		 *
		 * @param file Component file below src-www/src/components
		 */
		const parsedLeaves = (file: string): string[] => {
			const text = source('src-www', 'src', 'components', file);
			const leaves = [...text.matchAll(/leaf === '(\w+)'/g)].map(m => m[1]);
			const set = /THUMBNAIL_STATES = new Set\(\[([^\]]*)\]\)/.exec(text);
			if (set) {
				leaves.push(...[...set[1].matchAll(/'(\w+)'/g)].map(m => m[1]));
			}
			return [...new Set(leaves)];
		};

		async function startWithThumbnail(): Promise<FakeAdapter> {
			const instance = await start();
			await waitFor(() => instance.val('info.webhookRegistered') === true, { description: 'registered' });
			// a thumbnail of the UA Ultra creates its thumbnail states (if not there from the start)
			await mock.deliverWebhook(
				fixtures.webhookEvents.doorbellIncoming({
					door: mock.findDoor(DOOR_3855)!,
					device: mock.findDevice(DEVICE_ULTRA)!,
					requestId: 'contract-1',
				}),
			);
			await waitFor(() => typeof instance.val(`devices.${DEVICE_ULTRA}.lastThumbnailAt`) === 'number', {
				description: 'thumbnail states',
			});
			return instance;
		}

		it('every state id the panel names literally exists as object', async () => {
			const instance = await startWithThumbnail();
			const ids = literalIds(DOOR_3855, DEVICE_ULTRA);
			expect(ids).to.include.members(['info.connection', 'events.last', 'admin.uiSettings']);
			// objects of io-package.json instanceObjects are created by js-controller, not by the adapter
			const instanceObjects = new Set(
				(JSON.parse(source('io-package.json')) as { instanceObjects: { _id: string }[] }).instanceObjects.map(
					o => o._id,
				),
			);
			const missing = ids.filter(id => !instance.objects.has(`${NS}.${id}`) && !instanceObjects.has(id));
			expect(missing).to.deep.equal([]);
		});

		it('the leaves the panel reads from doors.* and devices.* exist for every door and device', async () => {
			const instance = await startWithThumbnail();
			const doorLeaves = parsedLeaves('DoorList.tsx');
			expect(doorLeaves).to.include.members(['locked', 'name', 'lockdown', 'evacuation']);
			for (const leaf of doorLeaves) {
				const id = ['lockdown', 'evacuation'].includes(leaf)
					? `doors.emergency.${leaf}`
					: `doors.${DOOR_3855}.${leaf}`;
				expect(instance.objects.has(`${NS}.${id}`), id).to.equal(true);
			}
			const deviceLeaves = parsedLeaves('LastThumbnailCard.tsx');
			expect(deviceLeaves).to.include.members(['name', 'model', 'lastThumbnailUrl']);
			for (const leaf of deviceLeaves) {
				const id = `devices.${DEVICE_ULTRA}.${leaf}`;
				expect(instance.objects.has(`${NS}.${id}`), id).to.equal(true);
			}
		});

		it('the types the panel expects: locked boolean, lockRuleEndsAt number, lastThumbnailUrl an http(s) URL', async () => {
			const instance = await startWithThumbnail();
			expect(instance.obj(`doors.${DOOR_3855}.locked`)?.common.type).to.equal('boolean');
			expect(instance.obj(`doors.${DOOR_3855}.lockRuleEndsAt`)?.common.type).to.equal('number');
			expect(instance.obj(`devices.${DEVICE_ULTRA}.lastThumbnailAt`)?.common.type).to.equal('number');
			expect(instance.val(`devices.${DEVICE_ULTRA}.lastThumbnailUrl`)).to.match(/^https?:\/\//);
		});

		it('the states the panel writes are writable', async () => {
			const instance = await startWithThumbnail();
			for (const id of [`doors.${DOOR_3855}.unlock`, 'admin.uiSettings', 'doors.emergency.lockdown']) {
				expect(instance.obj(id)?.common.write, id).to.equal(true);
			}
		});

		it('the panel lists exactly the models with the event-thumbnail capability', () => {
			const set = /THUMBNAIL_MODELS = new Set\(\[([^\]]*)\]\)/.exec(
				source('src-www', 'src', 'components', 'LastThumbnailCard.tsx'),
			);
			expect(set).to.not.equal(null);
			const panel = [...set![1].matchAll(/'([\w-]+)'/g)].map(m => m[1]).sort();
			const models: UnifiDeviceModel[] = [
				'UA-Ultra',
				'UA-G2-Pro',
				'UA-G3-Pro',
				'UA-Intercom',
				'UA-Lite',
				'UA-Hub',
				'unknown',
			];
			const adapter = models.filter(model => featuresFor(model).includes('event-thumbnail')).sort();
			expect(panel).to.deep.equal(adapter);
		});

		describe('event log ↔ events the adapter writes (RF contract)', () => {
			const card = source('src-www', 'src', 'components', 'EventLogCard.tsx');
			const mainSource = source('src', 'main.ts');

			it('every event type the adapter logs has a label in the panel', () => {
				const set = /const USER_RELEVANT_EVENTS = new Set\(\[([^\]]*)\]\)/.exec(mainSource);
				expect(set, 'USER_RELEVANT_EVENTS').to.not.equal(null);
				const logged = [...set![1].matchAll(/'([\w.]+)'/g)].map(m => m[1]).sort();
				expect(logged.length).to.be.greaterThan(10);
				const block = /const EVENT_LABELS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(card);
				expect(block, 'EVENT_LABELS').to.not.equal(null);
				const labels = [...block![1].matchAll(/^\s*'([\w.]+)'\s*:/gm)].map(m => m[1]).sort();
				expect(labels).to.deep.equal(logged);
			});

			it('every subtype of a doorbell end and of the door sensor has a label', () => {
				const labels = new Set(objectLiteralKeys(card, 'SUBTYPE_LABELS'));
				for (const reason of Object.values(DOORBELL_REASONS)) {
					expect(labels.has(reason), reason).to.equal(true);
				}
				for (const status of ['open', 'close']) {
					expect(labels.has(status), status).to.equal(true);
				}
			});

			for (const [result, granted] of [
				['Access Granted', true],
				['BLOCKED', false],
				['Access Denied', false],
			] as [string, boolean][]) {
				it(`access.door.unlock with result "${result}" reaches the panel with granted ${granted}`, async () => {
					const instance = await start({ enableThumbnailServer: false });
					await waitFor(() => instance.val('info.webhookRegistered') === true, { description: 'registered' });
					const [answer] = await mock.deliverWebhook(
						fixtures.webhookEvents.doorUnlock({
							door: mock.findDoor(DOOR_3855)!,
							device: mock.findDevice(fixtures.IDS.DEVICE_HUB)!,
							object: { result },
						}),
					);
					expect(answer.status).to.equal(200);
					await waitFor(() => typeof instance.val('events.last') === 'string', { description: 'logged' });
					const [entry] = JSON.parse(instance.val('events.last') as string) as Record<string, unknown>[];
					expect(entry).to.include({ type: 'access.door.unlock', granted, subtype: result });
				});
			}

			it('the panel decides "Access denied" by the field granted, not by its own copy of the result rule', () => {
				expect(card).to.match(/e\.type === 'access\.door\.unlock' && e\.granted === false/);
				// the rule itself lives in the adapter (isAccessGranted), not in a copy in the panel
				expect(card).to.not.match(/denied\|blocked/i);
				expect(card).to.not.contain("'BLOCKED'");
				expect(interfaceFields(source('src', 'lib', 'types.ts'), 'NormalizedEvent').get('granted')).to.equal(
					true,
				);
			});

			it('ts of events.last is the time of its last write; the panel counts down only for a list that arrives as a change (RF-02, R3T-01)', async () => {
				const instance = await start();
				await waitFor(() => instance.val('info.webhookRegistered') === true, { description: 'registered' });
				const before = Date.now();
				await mock.deliverWebhook(
					fixtures.webhookEvents.doorUnlock({
						door: mock.findDoor(DOOR_3855)!,
						device: mock.findDevice(fixtures.IDS.DEVICE_HUB)!,
					}),
				);
				await waitFor(() => typeof instance.val('events.last') === 'string', { description: 'logged' });
				const state = instance.states.get(`${NS}.events.last`)!;
				expect(state.ts).to.be.at.least(before).and.at.most(Date.now());
				// every new event and every attached snapshot rewrites the list: a list arriving while the page is
				// open was just written, so its ts is "now" on the clock of ioBroker; a list read on opening is old
				expect(card).to.match(
					/liveList\s*\?\s*timeEvents\(parseEvents\(last\?\.val\), last\?\.ts, receivedAt\)/,
				);
			});

			it('the lock rule types the panel describes are the documented ones (schedule on purpose not)', () => {
				const libraryText = source('src', 'lib', 'library.ts');
				const documented = /Active temporary lock rule \(([^;]+);/.exec(libraryText);
				expect(documented).to.not.equal(null);
				const types = documented![1]
					.split(',')
					.map(t => t.trim())
					.sort();
				expect(types).to.deep.equal(['custom', 'keep_lock', 'keep_unlock', 'lock_early', 'schedule']);
				const doorCard = source('src-www', 'src', 'components', 'DoorCard.tsx');
				const body = /function describeLockRule[\s\S]*?\n\}/.exec(doorCard)![0];
				const cases = [...body.matchAll(/case '([\w]+)':/g)].map(m => m[1]).sort();
				expect([...cases, 'schedule'].sort()).to.deep.equal(types);
			});
		});

		it('the event fields the event log reads are fields of the events the adapter writes', () => {
			const card = source('src-www', 'src', 'components', 'EventLogCard.tsx');
			const used = [...new Set([...card.matchAll(/\be\.(\w+)/g)].map(m => m[1]))];
			const types = source('src', 'lib', 'types.ts');
			const fields = interfaceFields(types, 'NormalizedEvent');
			expect(used).to.include.members(['ts', 'type']);
			expect(used.filter(field => !fields.has(field))).to.deep.equal([]);
		});
	});
});
