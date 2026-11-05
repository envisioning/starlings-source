import { Button } from '@/ui/button';
import { IOS_DOWNLOAD_URL, MAC_DOWNLOAD_URL } from '@starlings/contracts/deployment';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/ui/dialog';
import { cn } from '@/lib/utils';
import { CloseIcon } from './action-icons';
import { editorDialogClass, editorHeaderClass } from './editor-dialog';
import { t } from './i18n';

/**
 * Keep on the web: a handoff, never a vault. Keep seals every
 * secret on the device under keys only a vault's members hold
 * (docs/KEEP.md), and whoever serves a page's JavaScript could read what it
 * unlocks, so the browser gets no Keep client, no Keep token and no key.
 * This says where Keep is and how to reach this project's vault there.
 */
export function KeepHandoffDialog({ projectTitle, onClose }: { projectTitle: string; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent showCloseButton={false} className={cn(editorDialogClass, 'gap-3 bg-card p-5 sm:max-w-[480px]')}>
        <div className={editorHeaderClass}>
          <DialogTitle className="m-0 text-xl leading-tight text-foreground">{t('Open on Mac or iPhone')}</DialogTitle>
          <Button type="button" variant="ghost" size="icon" className="rounded-full text-muted-foreground" aria-label={t('Close')} onClick={onClose}>
            <CloseIcon />
          </Button>
        </div>
        <DialogDescription className="m-0 text-sm text-muted-foreground">
          {t('Keep is on Mac and iPhone only. Secrets are sealed on your device with keys a browser never holds, so Keep isn’t on the web.')}
        </DialogDescription>
        <p className="m-0 text-sm text-foreground">
          {t('In Starlings on your Mac or iPhone, open Work, choose {project}, then Keep vault from its menu.', { project: projectTitle })}
        </p>
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <Button asChild variant="secondary"><a href={MAC_DOWNLOAD_URL}>{t('Starlings for Mac')}</a></Button>
          <Button asChild variant="secondary"><a href={IOS_DOWNLOAD_URL}>{t('Starlings for iPhone and iPad')}</a></Button>
          <Button type="button" onClick={onClose}>{t('Done')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
