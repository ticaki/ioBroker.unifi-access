import { Chip } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { useConnectionStatus, useIobState } from '../socket';

export function ControllerStatusBadge(): JSX.Element {
    const wsConnected = useConnectionStatus();
    const adapterConn = useIobState('info.connection');
    const adapterOk = adapterConn?.val === true;

    if (!wsConnected) {
        return (
            <Chip
                size="small"
                color="default"
                icon={<ErrorOutlineIcon />}
                label="ioBroker offline"
            />
        );
    }

    return (
        <Chip
            size="small"
            color={adapterOk ? 'success' : 'warning'}
            icon={adapterOk ? <CheckCircleIcon /> : <ErrorOutlineIcon />}
            label={adapterOk ? 'controller connected' : 'controller offline'}
        />
    );
}
