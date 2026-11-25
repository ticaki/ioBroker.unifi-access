import { type JSX, useState } from 'react';
import { Button, Card, CardActions, CardContent, Chip, Stack, Typography } from '@mui/material';
import LockIcon from '@mui/icons-material/Lock';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import { setIobState } from '../socket';

interface DoorCardProps {
    doorId: string;
    name: string;
    locked: boolean | null | undefined;
}

export function DoorCard({ doorId, name, locked }: DoorCardProps): JSX.Element {
    const [failed, setFailed] = useState(false);

    const handleUnlock = (): void => {
        setFailed(false);
        // The command can be refused (no permission, connection lost) - tell the user instead of
        // leaving an unhandled rejection behind a button that seems to work.
        setIobState(`doors.${doorId}.unlock`, true).catch((err: unknown) => {
            // eslint-disable-next-line no-console
            console.error(`Cannot send the unlock command for door ${doorId}:`, err);
            setFailed(true);
        });
    };

    const lockedKnown = typeof locked === 'boolean';
    const isLocked = locked === true;

    return (
        <Card variant="outlined">
            <CardContent>
                <Stack
                    direction="row"
                    sx={{ justifyContent: 'space-between', alignItems: 'center' }}
                >
                    <Typography variant="subtitle1">{name}</Typography>
                    <Chip
                        size="small"
                        icon={isLocked ? <LockIcon /> : <LockOpenIcon />}
                        color={!lockedKnown ? 'default' : isLocked ? 'success' : 'warning'}
                        label={!lockedKnown ? 'unknown' : isLocked ? 'locked' : 'unlocked'}
                    />
                </Stack>
            </CardContent>
            <CardActions>
                <Button
                    size="small"
                    variant="contained"
                    startIcon={<LockOpenIcon />}
                    onClick={handleUnlock}
                >
                    Unlock
                </Button>
                {failed ? (
                    <Typography
                        variant="caption"
                        color="error"
                        role="alert"
                    >
                        The unlock command could not be sent.
                    </Typography>
                ) : null}
            </CardActions>
        </Card>
    );
}
