import { type JSX, useEffect, useState } from 'react';
import { Box, Dialog, DialogContent, DialogTitle, IconButton } from '@mui/material';
import Close from '@mui/icons-material/Close';

interface EventMediaModalProps {
    open: boolean;
    onClose: () => void;
    snapshotUrl: string;
    videoUrl?: string;
    title?: string;
}

export function EventMediaModal({ open, onClose, snapshotUrl, videoUrl, title }: EventMediaModalProps): JSX.Element {
    // The adapter answers 501/502 if Protect has no clip for the event (yet): show the snapshot then,
    // not a dead video player.
    const [videoFailed, setVideoFailed] = useState(false);
    useEffect(() => {
        setVideoFailed(false);
    }, [videoUrl]);

    return (
        <Dialog
            open={open}
            onClose={onClose}
            maxWidth="md"
            fullWidth
        >
            <DialogTitle sx={{ pr: 6 }}>
                {title ?? 'Camera'}
                <IconButton
                    onClick={onClose}
                    size="small"
                    aria-label="Close"
                    sx={{ position: 'absolute', right: 8, top: 8 }}
                >
                    <Close fontSize="small" />
                </IconButton>
            </DialogTitle>
            <DialogContent sx={{ p: 0 }}>
                {videoUrl && !videoFailed ? (
                    <video
                        controls
                        src={videoUrl}
                        onError={() => setVideoFailed(true)}
                        style={{ width: '100%', display: 'block' }}
                    />
                ) : (
                    <Box
                        component="img"
                        src={snapshotUrl}
                        alt={title ?? 'camera snapshot'}
                        sx={{ width: '100%', display: 'block' }}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}
