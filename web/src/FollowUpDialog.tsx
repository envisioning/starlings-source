import { useState } from 'react';
import type { InboxFollowUpItem } from '@starlings/contracts/inbox';
import { MEETING_FOLLOW_UP_SUBJECT_MAX } from '@starlings/contracts';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/ui/dialog';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Textarea } from '@/ui/textarea';
import { ErrorNotice } from './ErrorNotice';
import { approveFollowUp, dismissFollowUp } from './crm-work';
import { openFollowUpMail } from './follow-up-mail';
import { toast } from './Toast';
import { t } from './i18n';

/**
 * After the call: the host reads the follow-up drafted for the
 * people outside, edits it, ticks the tasks to keep, and approves. Approve
 * opens the draft in the host's own mail app; Starlings sends nothing.
 */
export function FollowUpDialog({ item, onDone, onClose }: {
  item: InboxFollowUpItem;
  onDone: () => void;
  onClose: () => void;
}) {
  const [subject, setSubject] = useState(item.draft.subject);
  const [body, setBody] = useState(item.draft.body);
  const [kept, setKept] = useState<Set<string>>(() => new Set(item.tasks.map((task) => task.id)));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = subject.trim().length > 0 && body.trim().length > 0 && !busy;

  async function approve() {
    if (!ready) return;
    setBusy(true);
    try {
      const answer = await approveFollowUp(item, {
        subject: subject.trim(),
        body: body.trim(),
        accept: item.tasks.filter((task) => kept.has(task.id)).map((task) => task.id),
        decline: item.tasks.filter((task) => !kept.has(task.id)).map((task) => task.id),
      });
      const opened = await openFollowUpMail(answer.mail);
      if (opened === 'copied') toast(t('The message was too long for a mail link. It is on the clipboard: paste it into the mail.'), 'neutral');
      if (answer.failed_task_ids.length > 0) toast(t('Some tasks did not change. Answer them in Inbox.'), 'danger');
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t approve that follow-up.'));
      setBusy(false);
    }
  }

  async function dismiss() {
    setBusy(true);
    try {
      await dismissFollowUp(item);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t dismiss that follow-up.'));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="gap-3 p-4 sm:max-w-lg" aria-describedby={undefined} onEscapeKeyDown={(event) => event.stopPropagation()}>
        <DialogTitle>{t('Follow-up: {title}', { title: item.meeting.title })}</DialogTitle>
        <p className="m-0 text-[13px] text-muted-foreground">
          {t('To {people}', { people: item.recipients.map((person) => person.name).join(', ') })}
        </p>
        <div className="grid gap-1.5">
          <Label htmlFor="followup-subject">{t('Subject')}</Label>
          <Input id="followup-subject" value={subject} disabled={busy} maxLength={MEETING_FOLLOW_UP_SUBJECT_MAX} onChange={(event) => setSubject(event.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="followup-body">{t('Message')}</Label>
          <Textarea id="followup-body" value={body} disabled={busy} rows={8} maxLength={4000} onChange={(event) => setBody(event.target.value)} />
        </div>
        {item.tasks.length > 0 && (
          <fieldset className="m-0 grid gap-2 border-0 p-0">
            <legend className="mb-1 text-[13px] font-medium">{t('Tasks from this call')}</legend>
            {item.tasks.map((task) => (
              <Label key={task.id} className="flex items-center gap-2 font-normal">
                <Checkbox
                  checked={kept.has(task.id)}
                  disabled={busy}
                  onCheckedChange={(value) => setKept((current) => {
                    const next = new Set(current);
                    if (value === true) next.add(task.id); else next.delete(task.id);
                    return next;
                  })}
                />
                <span className="text-[13px]">{task.title}</span>
              </Label>
            ))}
          </fieldset>
        )}
        {error && <ErrorNotice message={error} copyText={error} />}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void dismiss()}>{t('Dismiss')}</Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>{t('Cancel')}</Button>
          <Button type="button" disabled={!ready} onClick={() => void approve()}>{t('Approve')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
