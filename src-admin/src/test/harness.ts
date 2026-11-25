import { vi, type Mock } from 'vitest';
import type { ConfigGenericProps } from '@iobroker/json-config';
import { I18n } from '@iobroker/gui-components';
import en from '../i18n/en.json';

export interface FakeSocket {
	sendTo: Mock<(instance: string, command: string, payload: unknown) => Promise<unknown>>;
	getState: Mock<(id: string) => Promise<{ val: unknown } | null>>;
}

export interface Harness {
	props: ConfigGenericProps;
	socket: FakeSocket;
	onChange: Mock<ConfigGenericProps['onChange']>;
}

export interface HarnessOptions {
	/** Key of the item in jsonConfig */
	attr?: string;
	/** `native` of the instance as the admin holds it while editing */
	data?: Record<string, unknown>;
	/** What the admin reports about the instance */
	alive?: boolean;
	/** Value of `system.adapter.unifi-access.<n>.alive` */
	aliveState?: boolean;
	instance?: number;
	/** Answer of the adapter per command */
	answers?: Record<string, unknown>;
}

/** Load the real English texts, so a test fails if a component uses a key that does not exist */
export function initI18n(): void {
	I18n.setLanguage('en');
	I18n.extendTranslations(en, 'en');
	I18n.disableWarning(true);
}

/**
 * Props as `ConfigCustom` of the admin passes them to a custom component of the instance settings
 *
 * @param options what the test needs to differ from the defaults
 */
export function makeHarness(options: HarnessOptions = {}): Harness {
	const answers = options.answers ?? {};
	const socket: FakeSocket = {
		sendTo: vi.fn((_instance: string, command: string) =>
			command in answers ? Promise.resolve(answers[command]) : new Promise<unknown>(() => {}),
		),
		getState: vi.fn(() => Promise.resolve({ val: options.aliveState ?? false })),
	};
	const onChange: Harness['onChange'] = vi.fn((_attrOrData, _val, cb) => cb?.());
	const data = options.data ?? {};
	const props = {
		oContext: {
			adapterName: 'unifi-access',
			instance: options.instance ?? 0,
			socket,
			themeType: 'light',
			forceUpdate: vi.fn(),
			onCommandRunning: vi.fn(),
			registerOnForceUpdate: vi.fn(),
			unsubscribeStates: vi.fn(),
		},
		alive: options.alive ?? true,
		attr: options.attr,
		changed: false,
		data,
		originalData: { ...data },
		onChange,
		onError: vi.fn(),
		schema: { type: 'custom', name: 'test', url: 'custom/customComponents.js', guiApi: 2 },
		themeName: 'light',
	} as unknown as ConfigGenericProps;
	return { props, socket, onChange };
}
