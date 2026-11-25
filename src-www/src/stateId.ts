/**
 * The one rule for complete state ids, shared by `socket.ts` and the test stand-in `test/socketMock.ts`
 * (so the two cannot drift apart). No imports: the mock must be able to use it without the real socket.
 *
 * @param id state id with or without namespace
 * @param namespace namespace of the adapter instance, e.g. `unifi-access.0`
 */
export function qualifyStateId(id: string, namespace: string): string {
    // ids of other objects (system.*) are passed on as they are
    return id.startsWith(`${namespace}.`) || id.startsWith('system.') ? id : `${namespace}.${id}`;
}
