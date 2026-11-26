import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Tells React that state updates in tests are wrapped by the testing library.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
	cleanup();
});
