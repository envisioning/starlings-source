import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/alert-dialog';
import type { DataLossAsk } from './ConfirmDataLoss';
import { t } from './i18n';

/** The data-loss confirm's drawing, loaded with the first ask (`ConfirmDataLoss.tsx`). */
export default function ConfirmDialog({ ask, onAnswer }: { ask: DataLossAsk; onAnswer: (confirmed: boolean) => void }) {
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onAnswer(false); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{ask.title}</AlertDialogTitle>
          <AlertDialogDescription>{ask.body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => onAnswer(false)}>{t('Cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => onAnswer(true)}>{ask.action}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
