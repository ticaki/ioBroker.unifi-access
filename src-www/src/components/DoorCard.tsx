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
    const handleUnlock = (): void => {
        void setIobState(`doors.${doorId}.unlock`, true);
    };

    const lockedKnown = typeof locked === 'boolean';
    const isLocked = locked === true;

    return (
        <Card variant="outlined">
            <CardContent>
                <Stack
                    direction="row"
                    justifyContent="space-between"
                    alignItems="center"
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
            </CardActions>
        </Card>
    );
}
