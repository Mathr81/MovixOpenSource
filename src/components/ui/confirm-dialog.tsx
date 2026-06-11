import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';

import { Button } from './button';
import ReusableModal from './reusable-modal';

export interface ConfirmDialogProps {
    isOpen: boolean;
    title: string;
    message: React.ReactNode;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: 'default' | 'destructive';
    busy?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}

/**
 * Modal de confirmation custom. Remplace `window.confirm()` qui :
 *   - n'est pas stylisable (cassait le look custom du panel admin)
 *   - bloque le main thread
 *   - ne supporte pas le markdown / les composants React dans le message
 *
 * Pour les actions destructives passe `variant="destructive"` pour avoir
 * une icône d'alerte rouge + un bouton de confirmation rouge.
 */
const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
    isOpen,
    title,
    message,
    confirmLabel,
    cancelLabel,
    variant = 'default',
    busy = false,
    onConfirm,
    onCancel,
}) => {
    const { t } = useTranslation();
    const isDestructive = variant === 'destructive';

    return (
        <ReusableModal isOpen={isOpen} onClose={onCancel} title={title} className="max-w-md">
            <div className="space-y-5">
                <div className="flex items-start gap-3">
                    {isDestructive && (
                        <div className="shrink-0 rounded-full bg-red-500/15 p-2 ring-1 ring-red-500/30">
                            <AlertTriangle className="h-5 w-5 text-red-400" />
                        </div>
                    )}
                    <div className="flex-1 text-sm text-white/80">{message}</div>
                </div>

                <div className="flex justify-end gap-2">
                    <Button variant="secondary" onClick={onCancel} disabled={busy}>
                        {cancelLabel ?? t('common.cancel')}
                    </Button>
                    <Button
                        variant={isDestructive ? 'destructive' : 'default'}
                        onClick={onConfirm}
                        disabled={busy}
                    >
                        {confirmLabel ?? t('common.confirm')}
                    </Button>
                </div>
            </div>
        </ReusableModal>
    );
};

export default ConfirmDialog;
