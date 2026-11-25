import { Alert, AlertTitle } from '@mui/material';
import type { JSX } from 'react';
import { useSocketLoadError } from '../socket';

/**
 * Without socket.io.js of the web adapter the panel can never connect. Say so instead of showing
 * "ioBroker offline" for ever.
 */
export function SocketLoadErrorAlert(): JSX.Element | null {
    const tried = useSocketLoadError();
    if (!tried) {
        return null;
    }
    return (
        <Alert
            severity="error"
            variant="outlined"
        >
            <AlertTitle>Cannot load the connection library of ioBroker</AlertTitle>
            socket.io.js could not be loaded from {tried}. Open this page through the ioBroker web adapter (for
            example http://&lt;ioBroker&gt;:8082/unifi-access/index.html) and check that the web adapter is running. Behind
            a reverse proxy, the proxy has to forward the lib/ folder of the web adapter, too.
        </Alert>
    );
}
