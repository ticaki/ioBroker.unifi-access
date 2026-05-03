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
                    sx={{ position: 'absolute', right: 8, top: 8 }}
                >
                    <Close fontSize="small" />
                </IconButton>
            </DialogTitle>
            <DialogContent sx={{ p: 0 }}>
                {videoUrl ? (
                    <video
                        controls
                        src={videoUrl}
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
