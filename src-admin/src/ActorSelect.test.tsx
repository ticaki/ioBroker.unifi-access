import { beforeAll, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ActorSelect from './ActorSelect';
import { initI18n, makeHarness } from './test/harness';

const USERS = [
	{ id: 'u1', name: 'Alice Example' },
	{ id: 'u2', name: 'Bob Example' },
];
const LABEL = 'Unlock actor (shown in logs)';

beforeAll(initI18n);

describe('ActorSelect', () => {
	it('preselects the user stored in the configuration', async () => {
		const { props, socket } = makeHarness({
			attr: 'unlockActorId',
			data: { unlockActorId: 'u2' },
			answers: { listUsers: { users: USERS } },
		});
		render(<ActorSelect {...props} />);

		const select = await screen.findByRole('combobox', { name: LABEL });
		expect(select.textContent).toBe('Bob Example');
		expect(socket.sendTo).toHaveBeenCalledWith('unifi-access.0', 'listUsers', {});
	});

	it('shows "none" if nothing is stored', async () => {
		const { props } = makeHarness({ attr: 'unlockActorId', data: {}, answers: { listUsers: { users: USERS } } });
		render(<ActorSelect {...props} />);

		const select = await screen.findByRole('combobox', { name: LABEL });
		// the users are loaded, none of them is selected - "none" is
		fireEvent.mouseDown(select);
		const options = within(await screen.findByRole('listbox')).getAllByRole('option');
		expect(options.map(o => [o.textContent, o.getAttribute('aria-selected')])).toEqual([
			['None (use API token name)', 'true'],
			['Alice Example', 'false'],
			['Bob Example', 'false'],
		]);
	});

	it('writes the selected user to the key unlockActorId', async () => {
		const { props, onChange } = makeHarness({
			attr: 'unlockActorId',
			data: { unlockActorId: 'u2', controllerHost: '192.0.2.1' },
			answers: { listUsers: { users: USERS } },
		});
		render(<ActorSelect {...props} />);

		fireEvent.mouseDown(await screen.findByRole('combobox', { name: LABEL }));
		fireEvent.click(within(screen.getByRole('listbox')).getByText('Alice Example'));

		await waitFor(() => expect(onChange).toHaveBeenCalled());
		// For instance settings json-config reports the whole changed configuration object
		expect(onChange.mock.calls[0][0]).toEqual({ unlockActorId: 'u1', controllerHost: '192.0.2.1' });
		expect(screen.getByRole('combobox', { name: LABEL }).textContent).toBe('Alice Example');
	});

	it('can reset the selection to "none"', async () => {
		const { props, onChange } = makeHarness({
			attr: 'unlockActorId',
			data: { unlockActorId: 'u2' },
			answers: { listUsers: { users: USERS } },
		});
		render(<ActorSelect {...props} />);

		fireEvent.mouseDown(await screen.findByRole('combobox', { name: LABEL }));
		fireEvent.click(within(screen.getByRole('listbox')).getByText('None (use API token name)'));

		await waitFor(() => expect(onChange).toHaveBeenCalled());
		expect(onChange.mock.calls[0][0]).toEqual({ unlockActorId: '' });
	});

	// R2F (unconfirmed): the admin resets the form without remounting the component
	it('follows a reset of the form by the admin (forceUpdate) after a selection', async () => {
		const { props } = makeHarness({
			attr: 'unlockActorId',
			data: { unlockActorId: 'u2' },
			answers: { listUsers: { users: USERS } },
		});
		render(<ActorSelect {...props} />);
		fireEvent.mouseDown(await screen.findByRole('combobox', { name: LABEL }));
		fireEvent.click(within(screen.getByRole('listbox')).getByText('Alice Example'));
		await waitFor(() => expect(screen.getByRole('combobox', { name: LABEL }).textContent).toBe('Alice Example'));

		// how json-config reports reset/reloaded data to its items
		const register = vi.mocked(props.oContext.registerOnForceUpdate!);
		const onUpdate = register.mock.calls.find(call => call[0] === 'unlockActorId')?.[1] as
			((data: Record<string, unknown>) => void) | undefined;
		expect(onUpdate).toBeTypeOf('function');
		act(() => onUpdate!({ unlockActorId: 'u2' }));
		expect(screen.getByRole('combobox', { name: LABEL }).textContent).toBe('Bob Example');
	});

	it('keeps a stored user that the controller does not report any more', async () => {
		const warn = vi.spyOn(console, 'warn');
		const { props, onChange } = makeHarness({
			attr: 'unlockActorId',
			data: { unlockActorId: 'gone-user' },
			answers: { listUsers: { users: USERS } },
		});
		render(<ActorSelect {...props} />);

		const select = await screen.findByRole('combobox', { name: LABEL });
		expect(select.textContent).toBe('User not in list (ID: gone-user)');
		expect(onChange).not.toHaveBeenCalled();
		expect(warn.mock.calls.flat().join(' ')).not.toContain('out-of-range');
	});

	it('shows an error instead of a spinner if the instance is not running', async () => {
		const { props, socket } = makeHarness({
			attr: 'unlockActorId',
			data: { unlockActorId: 'u2' },
			alive: false,
			aliveState: false,
		});
		render(<ActorSelect {...props} />);

		expect((await screen.findByRole('alert')).textContent).toBe(
			'The adapter instance is not running. Start it and try again.',
		);
		expect(socket.sendTo).not.toHaveBeenCalled();
		expect(screen.queryByText('Loading users…')).toBeNull();
		// the stored value is neither lost nor changed
		expect(screen.getByRole('combobox', { name: LABEL }).textContent).toBe('User not in list (ID: u2)');
	});

	it('loads the users as soon as the instance is started', async () => {
		const first = makeHarness({ attr: 'unlockActorId', data: { unlockActorId: 'u1' }, alive: false });
		const { rerender } = render(<ActorSelect {...first.props} />);
		await screen.findByRole('alert');

		const second = makeHarness({
			attr: 'unlockActorId',
			data: { unlockActorId: 'u1' },
			alive: true,
			answers: { listUsers: { users: USERS } },
		});
		rerender(<ActorSelect {...second.props} />);

		await waitFor(() => expect(screen.getByRole('combobox', { name: LABEL }).textContent).toBe('Alice Example'));
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('shows an error if the request fails or is not answered', async () => {
		const { props, socket } = makeHarness({ attr: 'unlockActorId', answers: { listUsers: 'timeout' } });
		render(<ActorSelect {...props} />);

		expect((await screen.findByRole('alert')).textContent).toBe('The adapter did not respond in time.');

		socket.sendTo.mockRejectedValueOnce(new Error('socket closed'));
		fireEvent.click(screen.getByRole('button', { name: 'Refresh user list' }));
		await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('socket closed'));
	});

	it.each([
		[
			'not-configured',
			'The running instance has no controller host or API token yet. Enter both, save and try again.',
		],
		['unauthorized', 'Token rejected (unauthorized).'],
		['network', 'Cannot reach the controller (network error).'],
		[
			'unknown-command',
			'The running adapter instance does not know this request. Adapter and settings page seem to have different versions — restart the instance.',
		],
		// not a code of the adapter: no raw text, the general hint instead
		['Request failed with status code 500', 'Could not load users. Is the adapter running?'],
	])('explains why the adapter could not deliver the users: %s', async (error, text) => {
		const { props } = makeHarness({ attr: 'unlockActorId', answers: { listUsers: { users: [], error } } });
		render(<ActorSelect {...props} />);

		expect((await screen.findByRole('alert')).textContent).toBe(text);
	});

	it('ignores malformed entries of the user list', async () => {
		const { props } = makeHarness({
			attr: 'unlockActorId',
			answers: { listUsers: { users: [null, { name: 'no id' }, { id: 'u7' }, ...USERS] } },
		});
		render(<ActorSelect {...props} />);

		fireEvent.mouseDown(await screen.findByRole('combobox', { name: LABEL }));
		const options = within(screen.getByRole('listbox')).getAllByRole('option');
		expect(options.map(o => o.textContent)).toEqual([
			'None (use API token name)',
			'u7',
			'Alice Example',
			'Bob Example',
		]);
	});
});
