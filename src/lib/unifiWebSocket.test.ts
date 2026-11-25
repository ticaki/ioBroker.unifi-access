import { expect } from 'chai';
import sinon from 'sinon';

import {
	createTestLogger,
	delay,
	fixtures,
	MockUnifiController,
	waitFor,
	WS_PATH,
	type TestLogger,
} from '../../test/mock';
import type { UnifiWebSocketMessage } from './types';
import { UnifiWebSocket, type UnifiWebSocketOptions } from './unifiWebSocket';

const TOKEN = 'ws-test-token';
/** 50 ms — keeps reconnect tests fast without fake timers. */
const FAST_RECONNECT_SECONDS = 0.05;

interface Harness {
	socket: UnifiWebSocket;
	logger: TestLogger;
	events: UnifiWebSocketMessage[];
	errors: Error[];
	counts: { open: number; close: number };
}

describe('UnifiWebSocket (against the mock controller)', () => {
	let mock: MockUnifiController;
	let clock: sinon.SinonFakeTimers | undefined;
	const harnesses: Harness[] = [];

	function create(overrides: Partial<UnifiWebSocketOptions> = {}): Harness {
		const logger = createTestLogger();
		const socket = new UnifiWebSocket({
			host: '127.0.0.1',
			port: mock.port,
			token: TOKEN,
			reconnectDelaySeconds: FAST_RECONNECT_SECONDS,
			logger,
			...overrides,
		});
		const harness: Harness = { socket, logger, events: [], errors: [], counts: { open: 0, close: 0 } };
		socket.on('open', () => harness.counts.open++);
		socket.on('close', () => harness.counts.close++);
		socket.on('error', err => harness.errors.push(err));
		socket.on('event', msg => harness.events.push(msg));
		harnesses.push(harness);
		return harness;
	}

	async function startAndWaitOpen(overrides: Partial<UnifiWebSocketOptions> = {}): Promise<Harness> {
		const harness = create(overrides);
		harness.socket.start();
		await waitFor(() => harness.counts.open === 1, { description: 'WebSocket open' });
		return harness;
	}

	before(async () => {
		mock = new MockUnifiController({ token: TOKEN });
		await mock.start();
	});

	after(async () => {
		await mock.stop();
	});

	beforeEach(() => {
		mock.reset();
	});

	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			harness.socket.stop();
		}
		clock?.restore();
		clock = undefined;
		await waitFor(() => mock.wsClients.size === 0, { description: 'all WebSocket clients to disconnect' });
	});

	describe('connect', () => {
		it('opens wss://host:port/api/v1/developer/devices/notifications with the bearer token', async () => {
			const { counts, errors } = await startAndWaitOpen();
			expect(mock.wsHandshakes).to.have.length(1);
			expect(mock.wsHandshakes[0].url).to.equal(WS_PATH);
			expect(mock.wsHandshakes[0].url).to.equal('/api/v1/developer/devices/notifications');
			expect(mock.wsHandshakes[0].headers.authorization).to.equal(`Bearer ${TOKEN}`);
			expect(mock.wsHandshakes[0].accepted).to.equal(true);
			expect(mock.wsClients.size).to.equal(1);
			expect(counts).to.deep.equal({ open: 1, close: 0 });
			expect(errors).to.deep.equal([]);
		});

		it('emits "error" and keeps retrying when the token is rejected (401)', async () => {
			const { socket, errors, counts } = create({ token: 'wrong-token' });
			socket.start();
			await waitFor(() => mock.wsHandshakes.length >= 3, { description: 'three handshake attempts' });
			expect(mock.wsHandshakes.every(h => !h.authorized && !h.accepted)).to.equal(true);
			expect(errors.length).to.be.greaterThan(0);
			expect(errors[0].message).to.contain('401');
			expect(counts.open).to.equal(0);
			expect(counts.close).to.be.greaterThan(0);
		});

		it('verifyTLS=true rejects the self-signed certificate (no handshake reaches the controller)', async () => {
			const { socket, errors, counts } = create({ verifyTLS: true });
			socket.start();
			await waitFor(() => errors.length > 0, { description: 'TLS error' });
			expect((errors[0] as NodeJS.ErrnoException).code).to.equal('DEPTH_ZERO_SELF_SIGNED_CERT');
			expect(counts.open).to.equal(0);
			expect(mock.wsHandshakes).to.have.length(0);
		});

		it('verifyTLS=true with the controller certificate as caCert connects', async () => {
			const { counts } = await startAndWaitOpen({ verifyTLS: true, caCert: mock.cert });
			expect(counts.open).to.equal(1);
			expect(mock.wsClients.size).to.equal(1);
		});
	});

	describe('event dispatch', () => {
		it('emits the three documented notifications as parsed envelopes', async () => {
			const { events } = await startAndWaitOpen();
			const ring = mock.emitRemoteView({ eventObjectId: '535b6125-860c-489a-b0a1-0ba01906afa9' });
			const change = mock.emitRemoteViewChange(108);
			const unlock = mock.emitRemoteUnlock(fixtures.IDS.DOOR_3855);
			await waitFor(() => events.length === 3, { description: 'three events' });
			expect(events).to.deep.equal([ring, change, unlock]);
			expect(events.map(e => e.event)).to.deep.equal([
				'access.remote_view',
				'access.remote_view.change',
				'access.data.device.remote_unlock',
			]);
			expect(events[0].event_object_id).to.equal('535b6125-860c-489a-b0a1-0ba01906afa9');
			expect(events[1].data.reason_code).to.equal(108);
			expect(events[2].data.unique_id).to.equal(fixtures.IDS.DOOR_3855);
		});

		it('decodes UTF-8 payloads', async () => {
			const { events } = await startAndWaitOpen();
			mock.emitRemoteView({ data: { door_name: 'Haustür – Süd ✓' } });
			await waitFor(() => events.length === 1, { description: 'event' });
			expect(events[0].data.door_name).to.equal('Haustür – Süd ✓');
		});

		it('ignores frames that are not JSON (warning only) and keeps the connection', async () => {
			const { events, logger, counts, errors } = await startAndWaitOpen();
			mock.sendRaw('Hello');
			mock.sendRaw('{"event": "broken"');
			mock.emitRemoteViewChange(105);
			await waitFor(() => events.length === 1, { description: 'event after garbage frames' });
			expect(events[0].event).to.equal('access.remote_view.change');
			expect(logger.of('warn').filter(m => m.includes('WebSocket parse error'))).to.have.length(2);
			expect(counts).to.deep.equal({ open: 1, close: 0 });
			expect(errors).to.deep.equal([]);
			expect(mock.wsClients.size).to.equal(1);
		});
	});

	describe('heartbeat', () => {
		it('pings the controller every 30 s while connected and stops pinging after stop()', async () => {
			clock = sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
			const { socket } = await startAndWaitOpen();
			expect(clock.countTimers()).to.equal(1);
			expect(mock.wsPingCount).to.equal(0);

			clock.tick(29_999);
			await delay(30);
			expect(mock.wsPingCount).to.equal(0);

			clock.tick(1);
			await waitFor(() => mock.wsPingCount === 1, { description: 'first ping' });

			clock.tick(60_000);
			await waitFor(() => mock.wsPingCount === 3, { description: 'third ping' });

			socket.stop();
			expect(clock.countTimers()).to.equal(0);
		});

		it('stops the heartbeat when the connection closes and restarts it after the reconnect', async () => {
			clock = sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
			const { counts } = await startAndWaitOpen();
			mock.dropWsConnections();
			await waitFor(() => counts.close === 1, { description: 'close' });
			expect(clock.countTimers()).to.equal(0);
			await waitFor(() => counts.open === 2, { description: 'reconnect' });
			expect(clock.countTimers()).to.equal(1);
		});

		// BUG-C-03: the heartbeat only *sends* pings. Missing pongs are never evaluated, so a dead (half-open)
		// connection is not detected and no reconnect happens — contrary to the class documentation
		// ("Heartbeat ping every 30s to detect dead connections that don't surface a 'close' event").
		it.skip('BUG-C-03: drops and re-establishes a connection whose pings stay unanswered', async () => {
			const deaf = new MockUnifiController({ token: TOKEN, autoPong: false });
			await deaf.start();
			try {
				clock = sinon.useFakeTimers({
					toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
				});
				const { counts } = await startAndWaitOpen({ port: deaf.port, reconnectDelaySeconds: 1 });
				// several heartbeat periods without a single pong
				for (let i = 0; i < 4 && counts.close === 0; i++) {
					await clock.tickAsync(30_000);
					await delay(30);
				}
				expect(deaf.wsPingCount, 'pings sent').to.be.greaterThan(0);
				expect(counts.close, 'dead connection closed by the client').to.be.greaterThan(0);
				await clock.tickAsync(1000);
				await waitFor(() => counts.open === 2, { description: 'reconnect after dead connection' });
			} finally {
				for (const harness of harnesses.splice(0)) {
					harness.socket.stop();
				}
				await deaf.stop();
			}
		});
	});

	describe('reconnect', () => {
		it('reconnects after the connection was cut and delivers events again', async () => {
			const { counts, events, logger } = await startAndWaitOpen();
			expect(mock.dropWsConnections()).to.equal(1);
			await waitFor(() => counts.open === 2, { description: 'reconnect' });
			expect(counts.close).to.equal(1);
			expect(mock.wsConnectionCount).to.equal(2);
			expect(mock.wsClients.size).to.equal(1);
			expect(logger.of('info')).to.deep.equal([`WebSocket reconnect in ${FAST_RECONNECT_SECONDS}s (attempt 1)`]);

			mock.emitRemoteViewChange(400);
			await waitFor(() => events.length === 1, { description: 'event after reconnect' });
			expect(events[0].data.reason_code).to.equal(400);
		});

		it('reconnects after a graceful close by the controller', async () => {
			const { counts } = await startAndWaitOpen();
			mock.dropWsConnections({ graceful: true, code: 1012 });
			await waitFor(() => counts.open === 2, { description: 'reconnect' });
			expect(counts.close).to.equal(1);
			expect(mock.wsClients.size).to.equal(1);
		});

		it('keeps retrying while the controller refuses the upgrade and connects once it is back', async () => {
			const { counts, errors } = await startAndWaitOpen();
			mock.wsAccepting = false;
			mock.dropWsConnections();
			await waitFor(() => mock.wsHandshakes.filter(h => !h.accepted).length >= 3, {
				description: 'three refused reconnect attempts',
			});
			expect(counts.open).to.equal(1);
			expect(errors.length).to.be.greaterThan(0);

			mock.wsAccepting = true;
			await waitFor(() => counts.open === 2, { description: 'reconnect after controller came back' });
			expect(mock.wsClients.size).to.equal(1);
		});

		it('reconnects after a full controller restart on the same port', async function () {
			// connecting to a closed port can take a moment on Windows before it is refused
			this.timeout(20_000);
			const own = new MockUnifiController({ token: TOKEN });
			await own.start();
			try {
				const { counts } = await startAndWaitOpen({ port: own.port });
				await own.restart();
				await waitFor(() => counts.open === 2, { description: 'reconnect after restart', timeoutMs: 15_000 });
				expect(own.wsClients.size).to.equal(1);
			} finally {
				for (const harness of harnesses.splice(0)) {
					harness.socket.stop();
				}
				await own.stop();
			}
		});

		it('backs off exponentially (2 s, 4 s, …) capped at reconnectDelaySeconds and resets after a successful connect', async () => {
			clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			mock.wsAccepting = false;
			const { socket, logger, counts } = create({ reconnectDelaySeconds: 5 });
			const reconnectLog = (): string[] => logger.of('info').filter(m => m.startsWith('WebSocket reconnect'));
			socket.start();

			await waitFor(() => reconnectLog().length === 1, { description: 'first failed attempt' });
			expect(reconnectLog()[0]).to.equal('WebSocket reconnect in 2s (attempt 1)');
			clock.tick(1999);
			await delay(30);
			expect(mock.wsHandshakes, 'no early retry').to.have.length(1);
			clock.tick(1);

			await waitFor(() => reconnectLog().length === 2, { description: 'second failed attempt' });
			expect(reconnectLog()[1]).to.equal('WebSocket reconnect in 4s (attempt 2)');
			clock.tick(4000);

			await waitFor(() => reconnectLog().length === 3, { description: 'third failed attempt' });
			expect(reconnectLog()[2]).to.equal('WebSocket reconnect in 5s (attempt 3)');
			clock.tick(5000);

			await waitFor(() => reconnectLog().length === 4, { description: 'fourth failed attempt' });
			expect(reconnectLog()[3]).to.equal('WebSocket reconnect in 5s (attempt 4)');

			mock.wsAccepting = true;
			clock.tick(5000);
			await waitFor(() => counts.open === 1, { description: 'successful connect' });

			mock.dropWsConnections();
			await waitFor(() => reconnectLog().length === 5, { description: 'reconnect after drop' });
			expect(reconnectLog()[4]).to.equal('WebSocket reconnect in 2s (attempt 1)');
		});
	});

	describe('stop()', () => {
		it('closes the connection and does not reconnect', async () => {
			const { socket, counts, logger } = await startAndWaitOpen();
			socket.stop();
			await waitFor(() => mock.wsClients.size === 0, { description: 'controller sees the disconnect' });
			await waitFor(() => counts.close === 1, { description: 'close event' });
			await delay(FAST_RECONNECT_SECONDS * 1000 * 3);
			expect(mock.wsHandshakes).to.have.length(1);
			expect(counts.open).to.equal(1);
			expect(logger.of('info').filter(m => m.includes('reconnect'))).to.deep.equal([]);
		});

		it('leaves no timers behind (heartbeat and pending reconnect are cleared)', async () => {
			clock = sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
			const { socket, logger } = await startAndWaitOpen({ reconnectDelaySeconds: 5 });
			expect(clock.countTimers(), 'heartbeat running').to.equal(1);

			mock.dropWsConnections();
			await waitFor(() => logger.of('info').some(m => m.includes('reconnect')), {
				description: 'pending reconnect',
			});
			expect(clock.countTimers(), 'reconnect timer pending').to.equal(1);

			socket.stop();
			expect(clock.countTimers(), 'no timers after stop').to.equal(0);
			clock.tick(60_000);
			await delay(30);
			expect(mock.wsHandshakes, 'no reconnect after stop').to.have.length(1);
		});

		it('cancels a connection attempt that is still in progress', async () => {
			const { socket, counts } = create();
			socket.start();
			socket.stop();
			await delay(100);
			expect(counts.open).to.equal(0);
			expect(mock.wsClients.size).to.equal(0);
			expect(mock.wsHandshakes.length).to.be.lessThan(2);
		});

		it('is idempotent and safe before start()', () => {
			const { socket } = create();
			socket.stop();
			socket.stop();
			expect(mock.wsHandshakes).to.have.length(0);
		});

		// BUG-C-04: stop() followed by start() on the same instance — the "close" event of the old socket fires
		// after start() already created the new one. The handler then forgets the new socket (this.socket = null),
		// stops its heartbeat and schedules a reconnect, which opens a second, parallel connection. The first one
		// is orphaned: a later stop() no longer terminates it. (main.ts always creates a new instance, so the
		// adapter is not affected today.)
		it.skip('BUG-C-04: stop() + start() on the same instance ends up with exactly one connection', async () => {
			const { socket, counts } = await startAndWaitOpen();
			socket.stop();
			socket.start();
			await waitFor(() => counts.open === 2, { description: 'second connection' });
			await delay(FAST_RECONNECT_SECONDS * 1000 * 4);
			expect(mock.wsClients.size, 'open connections on the controller').to.equal(1);
			expect(mock.wsConnectionCount, 'connections in total').to.equal(2);
			socket.stop();
			await waitFor(() => mock.wsClients.size === 0, { description: 'stop() closes every connection' });
		});
	});
});
