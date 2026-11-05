import { useEffect, useId, useState } from 'react';
import { workspaceTimeZones } from './workspace-defaults';
import { SESSION_BODY_MAX, SESSION_DESCRIPTION_MAX, type WorkEvent, type WorkEventCreate, type WorkEventOptions, type WorkEventResponse } from '@starlings/contracts/event-signups';
import { Dialog, DialogContent, DialogTitle } from '@/ui/dialog';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { Spinner } from '@/ui/spinner';
import { cn } from '@/lib/utils';
import { apiFetch } from './api';
import { CloseIcon } from './action-icons';
import { DatePicker } from './DatePicker';
import { ErrorNotice } from './ErrorNotice';
import { FormRow } from './form-row';
import { localTimeZone } from './meeting-time';
import { t } from './i18n';
import { editorDialogClass, editorFieldsetClass, editorHeaderClass, editorTitleClass } from './editor-dialog';

/** The form's options: the workspace's rooms and whether this person may create here. Null when events are off. */
export async function fetchWorkEventOptions(): Promise<WorkEventOptions | null> {
  try {
    return await apiFetch<WorkEventOptions>('/work/events/options', { fallbackError: t('Couldn’t load the event form.') });
  } catch {
    return null;
  }
}

/** One event for the form, or null when the store edits it elsewhere (a CMS event). */
export async function fetchWorkEvent(id: string): Promise<WorkEvent | null> {
  try {
    return (await apiFetch<WorkEventResponse>(`/work/events/${encodeURIComponent(id)}`, { fallbackError: t('Couldn’t load this event.') })).event;
  } catch {
    return null;
  }
}

type Draft = Record<'title' | 'description' | 'body' | 'date' | 'start_time' | 'end_time' | 'time_zone' | 'location' | 'url' | 'notes' | 'public_slug' | 'room_slug' | 'cta_url' | 'cta_label' | 'follow_up_note' | 'attendance' | 'host_emails', string>;

function draftFrom(event: WorkEvent | null): Draft {
  return {
    title: event?.title ?? '',
    description: event?.description ?? '',
    body: event?.body ?? '',
    date: event?.date ?? '',
    start_time: event?.start_time ?? '',
    end_time: event?.end_time ?? '',
    time_zone: event?.time_zone ?? localTimeZone(),
    location: event?.location ?? '',
    url: event?.url ?? '',
    notes: event?.notes ?? '',
    public_slug: event?.public_slug ?? '',
    room_slug: event?.room_slug ?? '',
    cta_url: event?.cta_url ?? '',
    cta_label: event?.cta_label ?? '',
    follow_up_note: event?.follow_up_note ?? '',
    attendance: event?.attendance ?? '',
    host_emails: (event?.host_emails ?? []).join(', '),
  };
}

const OPTIONAL = ['description', 'body', 'location', 'url', 'notes', 'public_slug', 'room_slug', 'cta_url', 'cta_label', 'follow_up_note'] as const;

/** The body to send: text trimmed, an empty optional field as null so a save clears it. */
function body(draft: Draft): WorkEventCreate {
  const value: Record<string, string | null> = {
    title: draft.title.trim(),
    date: draft.date,
    start_time: draft.start_time.trim(),
    end_time: draft.end_time.trim(),
    time_zone: draft.time_zone,
  };
  for (const key of OPTIONAL) value[key] = draft[key].trim() || null;
  return {
    ...value,
    attendance: draft.attendance || null,
    host_emails: draft.host_emails.split(/[\s,;]+/u).map((email) => email.toLowerCase()).filter(Boolean),
  } as unknown as WorkEventCreate;
}

const CLOCK = '(?:[01][0-9]|2[0-3]):[0-5][0-9]';

/**
 * Create or edit an event (docs/SESSIONS.md §0 S8). One form for
 * both stores: the Worker writes the D1 row or the CMS event, and this form
 * does not know which. A public slug and a room give the event a sign-up page.
 */
export function EventEditor({ event, rooms, onClose, onSaved }: {
  /** Null to create one. */
  event: WorkEvent | null;
  rooms: readonly string[];
  onClose: () => void;
  onSaved: (event: WorkEvent) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(event));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ids = { title: useId(), description: useId(), body: useId(), date: useId(), start: useId(), end: useId(), zone: useId(), location: useId(), url: useId(), notes: useId(), slug: useId(), room: useId(), ctaUrl: useId(), ctaLabel: useId(), followUp: useId(), attendance: useId(), hosts: useId() };
  useEffect(() => { setDraft(draftFrom(event)); }, [event]);
  const set = (key: keyof Draft) => (next: string) => setDraft((current) => ({ ...current, [key]: next }));
  const change = (key: keyof Draft) => (input: { target: { value: string } }) => set(key)(input.target.value);
  const zones = workspaceTimeZones().some((zone) => zone.zone === draft.time_zone)
    ? workspaceTimeZones().map((zone) => ({ value: zone.zone, label: t(zone.city) }))
    : [{ value: draft.time_zone, label: draft.time_zone }, ...workspaceTimeZones().map((zone) => ({ value: zone.zone, label: t(zone.city) }))];
  const canSave = !busy && draft.title.trim() !== '' && draft.date !== '' && draft.start_time.trim() !== '' && draft.end_time.trim() !== '';

  async function save() {
    setBusy(true);
    setError('');
    try {
      const answer = await apiFetch<WorkEventResponse>(event ? `/work/events/${encodeURIComponent(event.id)}` : '/work/events', {
        method: event ? 'PATCH' : 'POST',
        body: body(draft),
        fallbackError: t('Couldn’t save the event.'),
      });
      onSaved(answer.event);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t save the event.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className={cn(editorDialogClass, 'gap-3 bg-card p-5 sm:max-w-[560px]')}
        // An editor keeps its draft: only Esc or Close leaves.
        onInteractOutside={(interaction) => interaction.preventDefault()}
      >
        <form className="m-0" onSubmit={(submit) => { submit.preventDefault(); void save(); }}>
          <div className={editorHeaderClass}>
            <DialogTitle asChild><h2 className={editorTitleClass}>{event ? t('Edit event') : t('New event')}</h2></DialogTitle>
            <Button type="button" variant="ghost" size="icon" className="rounded-full text-muted-foreground" aria-label={t('Close')} disabled={busy} onClick={onClose}>
              <CloseIcon />
            </Button>
          </div>
          {error && <ErrorNotice message={error} />}
          <fieldset className={editorFieldsetClass} disabled={busy}>
            <FormRow id={ids.title} label={t('Title')}><Input id={ids.title} required maxLength={200} value={draft.title} onChange={change('title')} /></FormRow>
            <FormRow id={ids.description} label={t('Description')}>
              <Textarea id={ids.description} rows={2} maxLength={SESSION_DESCRIPTION_MAX} value={draft.description} onChange={change('description')} />
            </FormRow>
            <FormRow id={ids.body} label={t('About')}>
              <Textarea id={ids.body} rows={5} maxLength={SESSION_BODY_MAX} value={draft.body} onChange={change('body')} />
            </FormRow>
            <FormRow id={ids.date} label={t('Date')}><DatePicker id={ids.date} value={draft.date} ariaLabel={t('Date')} onChange={set('date')} /></FormRow>
            <div className="grid grid-cols-2 gap-3">
              <FormRow id={ids.start} label={t('Starts')}>
                <Input id={ids.start} required inputMode="numeric" pattern={CLOCK} maxLength={5} placeholder={t('HH:MM')} value={draft.start_time} onChange={change('start_time')} />
              </FormRow>
              <FormRow id={ids.end} label={t('Ends')}>
                <Input id={ids.end} required inputMode="numeric" pattern={CLOCK} maxLength={5} placeholder={t('HH:MM')} value={draft.end_time} onChange={change('end_time')} />
              </FormRow>
            </div>
            <FormRow id={ids.zone} label={t('Time zone')}>
              <NativeSelect id={ids.zone} value={draft.time_zone} onChange={change('time_zone')}>
                {zones.map((zone) => <NativeSelectOption key={zone.value} value={zone.value}>{zone.label}</NativeSelectOption>)}
              </NativeSelect>
            </FormRow>
            <FormRow id={ids.location} label={t('Location')}><Input id={ids.location} maxLength={200} value={draft.location} onChange={change('location')} /></FormRow>
            <FormRow id={ids.attendance} label={t('Attendance')}>
              <NativeSelect id={ids.attendance} value={draft.attendance} onChange={change('attendance')}>
                <NativeSelectOption value="">{t('Not set')}</NativeSelectOption>
                <NativeSelectOption value="in_person">{t('In person')}</NativeSelectOption>
                <NativeSelectOption value="hybrid">{t('Hybrid')}</NativeSelectOption>
                <NativeSelectOption value="online">{t('Online')}</NativeSelectOption>
              </NativeSelect>
            </FormRow>
            <FormRow id={ids.hosts} label={t('Members at the event')}>
              <Input id={ids.hosts} inputMode="email" placeholder={t('Emails, separated by commas')} value={draft.host_emails} onChange={change('host_emails')} />
            </FormRow>
            <FormRow id={ids.url} label={t('Link')}><Input id={ids.url} type="url" inputMode="url" placeholder="https://" value={draft.url} onChange={change('url')} /></FormRow>
            <FormRow id={ids.notes} label={t('Notes')}><Textarea id={ids.notes} rows={3} value={draft.notes} onChange={change('notes')} /></FormRow>
            <FormRow id={ids.room} label={t('Room')}>
              <NativeSelect id={ids.room} value={draft.room_slug} onChange={change('room_slug')}>
                <NativeSelectOption value="">{t('No room')}</NativeSelectOption>
                {rooms.map((room) => <NativeSelectOption key={room} value={room}>{room}</NativeSelectOption>)}
              </NativeSelect>
            </FormRow>
            <FormRow id={ids.slug} label={t('Sign-up page address')}>
              <Input id={ids.slug} maxLength={80} pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?" placeholder={t('e.g. starlings-at-work')} value={draft.public_slug} onChange={change('public_slug')} />
            </FormRow>
            <FormRow id={ids.ctaUrl} label={t('Call to action link')}><Input id={ids.ctaUrl} type="url" inputMode="url" placeholder="https://" value={draft.cta_url} onChange={change('cta_url')} /></FormRow>
            <FormRow id={ids.ctaLabel} label={t('Call to action label')}><Input id={ids.ctaLabel} maxLength={80} value={draft.cta_label} onChange={change('cta_label')} /></FormRow>
            <FormRow id={ids.followUp} label={t('Follow-up note')}><Textarea id={ids.followUp} rows={4} value={draft.follow_up_note} onChange={change('follow_up_note')} /></FormRow>
          </fieldset>
          <div className="mt-[18px] flex flex-wrap items-center justify-end gap-2">
            <Button disabled={!canSave}>{busy && <Spinner aria-hidden />}{t('Save')}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
