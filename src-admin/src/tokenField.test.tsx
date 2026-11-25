/**
 * `apiToken` and `genericWebhookToken` are `password` fields in admin/jsonConfig.json. AuthSetup reads
 * the token from the configuration data for its connection test. These tests pin the behaviour of the
 * stock password field this relies on: the data keeps the real value, the field itself only shows a
 * placeholder, and nothing is written unless the user types.
 */
import type React from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ConfigPassword from '@iobroker/json-config/build/JsonConfigComponent/ConfigPassword';
import jsonConfig from '../../admin/jsonConfig.json';
import AuthSetup from './AuthSetup';
import { type Harness, initI18n, makeHarness } from './test/harness';

const connectionItems = jsonConfig.items._connectionTab.items;
const webhookItems = jsonConfig.items._genericWebhookTab.items;

beforeAll(initI18n);

type PasswordProps = React.ComponentProps<typeof ConfigPassword>;

/**
 * Props for the stock password field with the schema of `apiToken` from jsonConfig
 *
 * @param data the adapter configuration
 */
function passwordProps(data: Record<string, unknown>): { props: PasswordProps; onChange: Harness['onChange'] } {
	const harness = makeHarness({ attr: 'apiToken', data });
	const props = { ...harness.props, schema: connectionItems.apiToken } as unknown as PasswordProps;
	return { props, onChange: harness.onChange };
}

describe('token fields', () => {
	it('are masked in jsonConfig', () => {
		expect(connectionItems.apiToken).toMatchObject({ type: 'password', visible: true });
		expect(webhookItems.genericWebhookToken).toMatchObject({ type: 'password', visible: true });
	});

	it('do not put a stored token into the page and do not touch it', async () => {
		const { props, onChange } = passwordProps({ apiToken: 'stored-secret-token' });
		const { container } = render(<ConfigPassword {...props} />);

		const input = await waitFor(() => {
			const field = container.querySelector('input');
			expect(field).not.toBeNull();
			return field as HTMLInputElement;
		});
		expect(input.type).toBe('password');
		expect(input.value).toBe('____ppp____');
		expect(container.innerHTML).not.toContain('stored-secret-token');
		// give the default-value logic of the base class time to run
		await new Promise(resolve => setTimeout(resolve, 200));
		expect(onChange).not.toHaveBeenCalled();
		expect(props.data.apiToken).toBe('stored-secret-token');
	});

	it('report a newly typed token', async () => {
		const { props, onChange } = passwordProps({ apiToken: 'stored-secret-token', controllerHost: '192.0.2.10' });
		const { container } = render(<ConfigPassword {...props} />);
		const input = await waitFor(() => {
			const field = container.querySelector('input');
			expect(field).not.toBeNull();
			return field as HTMLInputElement;
		});

		fireEvent.change(input, { target: { value: 'new-token' } });

		await waitFor(() => expect(onChange).toHaveBeenCalled());
		expect(onChange.mock.calls[0][0]).toEqual({ apiToken: 'new-token', controllerHost: '192.0.2.10' });
	});

	it('let the connection test use the stored token although the field shows the placeholder', async () => {
		const data = { controllerHost: '192.0.2.10', controllerPort: 12445, apiToken: 'stored-secret-token' };
		const field = passwordProps(data);
		const auth = makeHarness({ data, answers: { verifyToken: { ok: true } } });
		render(
			<>
				<ConfigPassword {...field.props} />
				<AuthSetup {...auth.props} />
			</>,
		);

		fireEvent.click(await screen.findByRole('button', { name: 'Test connection' }));

		await waitFor(() => expect(auth.socket.sendTo).toHaveBeenCalled());
		expect(auth.socket.sendTo.mock.calls[0][2]).toMatchObject({ token: 'stored-secret-token' });
	});
});
