/**
 * Type declarations for the plain-JS mock UniFi Access controller (test/mock/index.js).
 * Kept by hand so the TypeScript module tests get a typed API without the mock itself
 * depending on a TypeScript loader.
 */

import type { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders } from 'node:http';
import type { WebSocket } from 'ws';

export interface MockDevice {
	id: string;
	name?: string;
	type?: string;
	alias?: string;
	[key: string]: unknown;
}

export interface MockDoor {
	id: string;
	name?: string;
	full_name?: string;
	floor_id?: string;
	type?: string;
	is_bind_hub?: boolean;
	door_lock_relay_status?: string;
	door_position_status?: string | null;
	[key: string]: unknown;
}

export interface MockUser {
	id: string;
	first_name?: string;
	last_name?: string;
	user_email?: string;
	[key: string]: unknown;
}

export interface MockWebhookEndpoint {
	id: string;
	name: string;
	endpoint: string;
	events: string[];
	secret: string;
	headers?: Record<string, string>;
}

export interface MockEventEnvelope {
	event: string;
	receiver_id?: string;
	event_object_id?: string;
	save_to_history?: boolean;
	data: Record<string, any>;
}

export interface RecordedRequest {
	/** Running number, starting at 1 */
	id: number;
	time: number;
	method: string;
	/** Raw request target exactly as received (not normalised) */
	url: string;
	/** URL path below `/api/v1/developer`, e.g. `/doors/<id>/unlock` */
	path: string;
	query: Record<string, string>;
	headers: IncomingHttpHeaders;
	rawBody: string;
	/** Parsed JSON body, `undefined` when empty or not JSON */
	body: any;
	authorized: boolean;
	/** HTTP status sent, -1 when the socket was destroyed by a fault */
	status: number;
	response: unknown;
}

export interface RequestFilter {
	method?: string;
	/** Path below `/api/v1/developer`; string = exact match, RegExp = test */
	path?: string | RegExp;
}

export interface MockFault extends RequestFilter {
	status?: number;
	code?: string;
	msg?: string;
	body?: unknown;
	hangUp?: boolean;
	/** Wait this long before answering; without any other field the regular answer is sent afterwards */
	delayMs?: number;
	times?: number;
}

export type SignatureMode = 'valid' | 'invalid' | 'tampered' | 'expired' | 'future' | 'missing' | 'malformed';

export interface WebhookDeliveryResult {
	endpointId: string;
	url: string;
	status?: number;
	body?: string;
	error?: string;
}

export interface WsHandshake {
	time: number;
	url: string;
	headers: IncomingHttpHeaders;
	authorized: boolean;
	accepted: boolean;
}

export interface MockUnifiControllerOptions {
	token?: string;
	host?: string;
	port?: number;
	devices?: MockDevice[][] | MockDevice[];
	doors?: MockDoor[];
	users?: MockUser[];
	tls?: { key: string; cert: string };
	altNames?: string[];
	autoPong?: boolean;
	autoEvents?: boolean;
	serveAnyStatic?: boolean;
	duplicateEndpointHttpStatus?: number;
	log?: (message: string) => void;
}

export class MockUnifiController extends EventEmitter {
	constructor(options?: MockUnifiControllerOptions);

	token: string;
	host: string;
	port: number;
	readonly url: string;
	readonly wsUrl: string;
	/** PEM certificate of the mock (usable as `caCert`) */
	readonly cert: string;

	devices: MockDevice[][] | MockDevice[];
	doors: MockDoor[];
	users: MockUser[];
	emergency: { lockdown: boolean; evacuation: boolean };
	webhookEndpoints: MockWebhookEndpoint[];
	lockRules: Map<string, { type: string; ended_time: number }>;
	systemLogHits: unknown[];
	omitSecretInList: boolean;
	wsAccepting: boolean;
	autoEvents: boolean;
	serveAnyStatic: boolean;
	duplicateEndpointHttpStatus: number;

	requests: RecordedRequest[];
	unlocks: {
		doorId: string;
		actor_id?: string;
		actor_name?: string;
		extra?: unknown;
		query: Record<string, string>;
	}[];
	wsHandshakes: WsHandshake[];
	wsClients: Set<WebSocket>;
	wsPingCount: number;
	wsConnectionCount: number;
	deliveredWebhooks: { envelope: MockEventEnvelope; results: WebhookDeliveryResult[] }[];
	readonly flatDevices: MockDevice[];

	start(options?: { port?: number }): Promise<this>;
	stop(): Promise<void>;
	restart(): Promise<void>;
	reset(): void;

	clearRequests(): void;
	findRequests(filter?: RequestFilter): RecordedRequest[];
	waitForRequest(
		filter: RequestFilter,
		options?: { timeoutMs?: number; fromIndex?: number },
	): Promise<RecordedRequest>;
	failNext(fault: MockFault): void;
	clearFaults(): void;
	addStaticResource(path: string, body?: Buffer, contentType?: string): void;
	addWebhookEndpoint(endpoint: Partial<MockWebhookEndpoint> & { endpoint: string }): MockWebhookEndpoint;
	findDoor(id: string): MockDoor | undefined;
	findDevice(id: string): MockDevice | undefined;

	emitEvent(envelope: MockEventEnvelope | Record<string, unknown>): number;
	sendRaw(text: string): number;
	emitRemoteView(options?: { eventObjectId?: string; data?: Record<string, unknown> }): MockEventEnvelope;
	emitRemoteViewChange(
		reasonCode: number,
		options?: { eventObjectId?: string; data?: Record<string, unknown> },
	): MockEventEnvelope;
	emitRemoteUnlock(
		doorId?: string,
		options?: { eventObjectId?: string; data?: Record<string, unknown> },
	): MockEventEnvelope;
	dropWsConnections(options?: { graceful?: boolean; code?: number }): number;
	waitForWsClients(count?: number, timeoutMs?: number): Promise<void>;
	waitForWsConnectionCount(total: number, timeoutMs?: number): Promise<void>;
	waitUntil(condition: () => boolean, timeoutMs: number, description: string): Promise<void>;

	deliverWebhook(
		envelope: MockEventEnvelope,
		options?: { signature?: SignatureMode; force?: boolean; endpointId?: string; timestamp?: number },
	): Promise<WebhookDeliveryResult[]>;
}

export function startMockController(options?: MockUnifiControllerOptions): Promise<MockUnifiController>;

export function createSelfSignedCert(options?: { commonName?: string; altNames?: string[]; days?: number }): {
	key: string;
	cert: string;
};

export function computeSignature(secret: string, rawBody: string | Buffer, timestamp: number): string;
export function signatureHeader(secret: string, rawBody: string | Buffer, timestamp?: number): string;

export function sendWebhook(options: {
	url: string;
	secret?: string;
	body: object | string | Buffer;
	signature?: SignatureMode;
	timestamp?: number;
	signatureHeader?: string;
	headers?: Record<string, string>;
	method?: string;
	timeoutMs?: number;
}): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>;

export function httpRequest(options: {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | Buffer;
	/** Request target sent verbatim instead of the URL's path (for path-traversal probes) */
	rawPath?: string;
	timeoutMs?: number;
	/** Trusted CA (PEM); without it TLS certificates are not verified */
	ca?: string;
}): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer; text: string }>;

export function getFreePort(host?: string): Promise<number>;

/**
 * Resolves true when the TCP port can be bound, i.e. nothing listens on it (any more).
 *
 * @param port Port to check
 * @param host Interface to check (default 127.0.0.1)
 */
export function isPortFree(port: number, host?: string): Promise<boolean>;

export interface TestLogger {
	silly: (message: string) => void;
	debug: (message: string) => void;
	info: (message: string) => void;
	warn: (message: string) => void;
	error: (message: string) => void;
	messages: { level: string; message: string }[];
	/** All messages logged with the given level */
	of(level: 'silly' | 'debug' | 'info' | 'warn' | 'error'): string[];
	clear(): void;
}

export function createTestLogger(): TestLogger;

export interface FakeState {
	val: any;
	ack: boolean;
	ts: number;
}

/**
 * In-process stand-in for the `Adapter` base class of `@iobroker/adapter-core`
 * (objects/states in Maps, observable side effects, drivable handlers).
 */
export class FakeAdapter {
	constructor(options?: { name?: string });

	name: string;
	instance: number;
	namespace: string;
	/** ioBroker host name the instance runs on */
	host: string;
	config: Record<string, any>;
	log: TestLogger;
	/** Objects by full id */
	objects: Map<string, any>;
	/** States by full id */
	states: Map<string, FakeState>;
	/** Every state write in order */
	stateWrites: { id: string; val: any; ack: boolean }[];
	subscriptions: string[];
	sentMessages: { to: string; command: string; message: any; callback: unknown }[];
	/** Certificate store behind getCertificatesAsync: name → PEM */
	certificates: Record<string, string>;
	/** Replaceable stand-in for adapter.encrypt (default: `encrypted(<value>)`) */
	encrypt: (value: string) => string;
	/** Pending timers created through adapter.setTimeout */
	timers: Set<unknown>;
	/** Running intervals created through adapter.setInterval */
	intervals: Set<unknown>;
	unloaded: boolean;

	setState(id: string, state: unknown, ack?: boolean): Promise<string>;
	getStateAsync(id: string): Promise<FakeState | null>;
	setForeignStateAsync(id: string, state: unknown, ack?: boolean): Promise<string>;
	extendObject(id: string, obj: Record<string, unknown>): Promise<{ id: string }>;
	setObjectNotExistsAsync(id: string, obj: Record<string, unknown>): Promise<{ id: string }>;
	extendForeignObjectAsync(id: string, obj: Record<string, unknown>): Promise<{ id: string }>;
	sendTo(to: string, command: string, message: unknown, callback?: unknown): void;
	getObjectAsync(id: string): Promise<any>;
	getForeignObjectAsync(id: string): Promise<any>;
	delObjectAsync(id: string): Promise<void>;
	delStateAsync(id: string): Promise<void>;

	/** Run the adapter's `ready` handler */
	fireReady(): Promise<void>;
	/** Simulate a state change (default ack=false: a command from a user or script) */
	fireStateChange(id: string, val: unknown, ack?: boolean): void;
	/** Deliver a sendTo message and resolve with the adapter's answer */
	request(command: string, message?: unknown, timeoutMs?: number): Promise<any>;
	/** Run the adapter's `unload` handler and cancel the adapter timers like js-controller does */
	fireUnload(): Promise<void>;
	/** Value of a state (id with or without namespace); `undefined` when never written */
	val(id: string): any;
	/** Object by id (with or without namespace) */
	obj(id: string): any;

	static instances: FakeAdapter[];
}

/**
 * Load an adapter main file with `@iobroker/adapter-core` replaced by {@link FakeAdapter}
 * and create an instance with the given `native` configuration.
 *
 * @param mainFile Absolute path of the adapter main module
 * @param config The instance's `native` configuration
 */
export function createAdapterWithFakeCore(mainFile: string, config: Record<string, unknown>): FakeAdapter;

/**
 * Minimal stand-in for a UniFi OS console with UniFi Protect (private API, not part of the documented
 * UniFi Access developer API): cookie login with CSRF token, camera snapshot, event metadata, clip.
 */
export class ProtectStub {
	constructor(options?: { username?: string; password?: string; altNames?: string[]; port?: number });

	username: string;
	password: string;
	port: number;
	/** PEM certificate of the stub (usable as `caCert`) */
	readonly cert: string;
	requests: { method: string; url: string; headers: IncomingHttpHeaders; body: string; status: number }[];
	/** Every login attempt with the credentials received and the status answered */
	logins: { username?: string; password?: string; status: number }[];
	snapshot: Buffer;
	clip: Buffer;
	events: Record<string, Record<string, unknown>>;
	sessions: number;

	start(): Promise<this>;
	stop(): Promise<void>;
	/** Invalidate every session handed out so far */
	expireSessions(): void;
	/** Answer the next `times` login attempts (default 1) with the given HTTP status */
	failLogins(status: number, times?: number): void;
}

/**
 * Wait a real amount of time (not affected by fake timers).
 *
 * @param ms Milliseconds to wait
 */
export function delay(ms: number): Promise<void>;

/**
 * Poll until `condition` is truthy and return that value; rejects after `timeoutMs` (default 2000).
 *
 * @param condition Evaluated repeatedly; errors thrown by it count as "not yet"
 * @param options Timing and error text
 * @param options.timeoutMs Give up after this time (default 2000)
 * @param options.intervalMs Poll interval (default 10)
 * @param options.description Used in the timeout error message
 */
export function waitFor<T>(
	condition: () => T | Promise<T>,
	options?: { timeoutMs?: number; intervalMs?: number; description?: string },
): Promise<NonNullable<T>>;

/**
 * Await a promise that is expected to reject and return the rejection reason.
 *
 * @param promise Promise expected to reject
 */
export function rejection(promise: Promise<unknown>): Promise<any>;

/**
 * Resolve with the arguments of the next `event` emitted by `emitter`; rejects after `timeoutMs` (default 2000).
 *
 * @param emitter Event source
 * @param event Event name
 * @param timeoutMs Give up after this time (default 2000)
 */
export function nextEvent(emitter: EventEmitter, event: string, timeoutMs?: number): Promise<any[]>;

interface EventSubject {
	id: string;
	name?: string;
	alias?: string;
	type?: string;
	full_name?: string;
}

export const fixtures: {
	WEBHOOK_EVENTS: string[];
	WEBSOCKET_EVENTS: string[];
	LOCK_RULE_TYPES: string[];
	SYSTEM_LOG_TOPICS: string[];
	DEFAULT_DEVICES: MockDevice[][];
	DEFAULT_DOORS: MockDoor[];
	DEFAULT_USERS: MockUser[];
	IDS: {
		DOOR_A2: string;
		DOOR_3855: string;
		DEVICE_HUB: string;
		DEVICE_LITE: string;
		DEVICE_G2_PRO: string;
		DEVICE_ULTRA: string;
	};
	TINY_JPEG: Buffer;
	clone<T>(value: T): T;
	websocketEvents: {
		remoteView(options?: { eventObjectId?: string; data?: Record<string, unknown> }): MockEventEnvelope;
		remoteViewChange(
			reasonCode: number,
			options?: { eventObjectId?: string; data?: Record<string, unknown> },
		): MockEventEnvelope;
		remoteUnlock(
			door: EventSubject,
			options?: { eventObjectId?: string; data?: Record<string, unknown> },
		): MockEventEnvelope;
	};
	webhookEvents: {
		doorUnlock(args: {
			door: EventSubject;
			device: EventSubject;
			readerId?: string;
			actor?: { id: string; name: string; type?: string } | null;
			deviceOverrides?: Record<string, unknown>;
			object?: Record<string, unknown>;
			thumbnailTime?: number;
		}): MockEventEnvelope;
		doorbellIncoming(args: {
			door: EventSubject;
			device: EventSubject;
			requestId?: string;
			thumbnailTime?: number;
		}): MockEventEnvelope;
		doorbellCompleted(args: {
			door: EventSubject;
			device: EventSubject;
			reasonCode?: number;
			requestId?: string;
		}): MockEventEnvelope;
		doorbellIncomingRen(args: { door: EventSubject; readerId?: string }): MockEventEnvelope;
		dpsStatus(args: { door: EventSubject; device: EventSubject; status: 'open' | 'close' }): MockEventEnvelope;
		emergencyStatus(args: {
			device: EventSubject;
			mode: 'lockdown' | 'evacuation';
			value: boolean;
		}): MockEventEnvelope;
		generic(
			eventName: string,
			args?: { door?: EventSubject; device?: EventSubject; object?: Record<string, unknown> },
		): MockEventEnvelope;
	};
};

export const API_PREFIX: string;
export const WS_PATH: string;
export const CONTROL_ROUTES: Record<string, string>;
