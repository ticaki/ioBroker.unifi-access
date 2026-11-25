import { type JSX, useState } from 'react';
import { Button, Card, CardActions, CardContent, Chip, Stack, Typography } from '@mui/material';
import LockIcon from '@mui/icons-material/Lock';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import { setIobState } from '../socket';

interface DoorCardProps {
    doorId: string;
    name: string;
    locked: boolean | null | undefined;
    /** Active temporary lock rule as the controller reports it (`doors.<id>.lockRuleType`) */
    lockRuleType?: string;
    /** End of the rule in ms epoch (`doors.<id>.lockRuleEndsAt`) */
    lockRuleEndsAt?: number | null;
}

/**
 * Text for the temporary lock rule of a door. `schedule` is the normal state (the door follows its
 * schedule) and an empty type means "no rule" or "unknown" - both are not worth a line.
 *
 * @param type value of `doors.<id>.lockRuleType`
 * @param endsAt value of `doors.<id>.lockRuleEndsAt` (ms epoch)
 */
export function describeLockRule(type: string | undefined, endsAt: number | null | undefined): string | null {
    const until = typeof endsAt === 'number' && endsAt > 0 ? ` until ${new Date(endsAt).toLocaleString()}` : '';
    switch (type) {
        case 'custom':
            return `Unlocked for a limited time${until}`;
        case 'keep_unlock':
            return `Kept unlocked${until}`;
        case 'keep_lock':
            return `Kept locked${until}`;
        case 'lock_early':
            return `Unlock schedule ended early${until}`;
        default:
            return null;
    }
}

export function DoorCard({ doorId, name, locked, lockRuleType, lockRuleEndsAt }: DoorCardProps): JSX.Element {
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
    const rule = describeLockRule(lockRuleType, lockRuleEndsAt);

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
                {rule ? (
                    <Typography
                        variant="caption"
                        color="text.secondary"
                    >
                        {rule}
                    </Typography>
                ) : null}
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
