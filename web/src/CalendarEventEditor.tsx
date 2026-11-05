import { CALENDAR_TRAVEL_MINUTES } from '@starlings/contracts/calendar-values';
import { Tip } from './Tip';
import { confirmDataLoss } from './ConfirmDataLoss';
import { DatePicker } from './DatePicker';
import { RadioGroup, RadioGroupItem } from '@/ui/radio-group';
import { Checkbox } from '@/ui/checkbox';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { Button } from '@/ui/button';
import { InviteesEditor } from './InviteesEditor';
import { CheckRow, FormRow } from './form-row';
import { useId, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/ui/dialog';
import { rawCalendarEventId } from '@starlings/contracts';
import { apiFetch } from './api';
import { CloseIcon, CopyLinkIcon, GoogleCalendarIcon, TrashIcon } from './action-icons';
import { toast } from './Toast';
import { allDayPatch, allDayRange, combineLocalDateTime, eventTimePatch, localDateTime, localDay, nextEventStart, recurrenceTarget, shiftDay, type RecurrenceScope } from './calendar-editor-model';
import { LocalDateTimeField } from './LocalDateTimeField';
import type { WebCalendarEvent, WebCalendarSource } from './owner-agenda';
import { ErrorNotice } from './ErrorNotice';
import { plural, t } from './i18n';
import { subjectHref } from './work-hrefs';
import { readStored, StorageKeys, writeStored } from './storage';
import { SearchablePicker } from './SearchablePicker';
import type { CalendarQuickAddResponse } from '@starlings/contracts';
import { cn } from '@/lib/utils';
import { editorDialogClass, editorFieldsetClass, editorHeaderClass, editorTitleClass } from './editor-dialog';

/** A group's name: a heading over the controls, not a field label. */
const groupLabelClass = 'mt-[18px] mb-1.5 block text-sm font-medium text-foreground';
/** Starts and Ends side by side; stacked on a phone. */
const dateGridClass = 'grid grid-cols-2 gap-3 max-[560px]:grid-cols-1 max-[560px]:gap-0';
/** A note under the fields: the timezone, the one-occurrence warning. */
const noteClass = 'my-3 text-sm text-muted-foreground';

/** The travel row's choices, the same five on Mac, iOS and web (#238). */
const TRAVEL_CHOICES = CALENDAR_TRAVEL_MINUTES;

/** `room`: the member's permanent room, when they have one — a new event can carry its link the way the Mac inspector and the iOS composer do. */
export function CalendarEventEditor({ event, sources, room, prefill, onClose, onSaved, onDeleted }: {
  event?: WebCalendarEvent; sources: WebCalendarSource[]; room?: { slug: string; joinURL: string }; onClose: () => void;
  /** What Quick add event… read: a new event opens filled in, for review and Save. */
  prefill?: CalendarQuickAddResponse;
  /** `notice` says what went out to guests, when anything did. */
  onSaved: (notice?: string) => void;
  /** Fires before `onSaved` once Google took the delete, so the page can drop the row without waiting on the reload. */
  onDeleted?: (event: WebCalendarEvent) => void;
}) {
  const initialAttendees = event?.attendees.filter(attendee => !attendee.self).map(attendee => (attendee.email || attendee.name).toLowerCase()) ?? [];
  const uid = useId();
  const [title, setTitle] = useState(event?.title ?? '');
  // Timed and all-day keep their own fields, so switching the box back and
  // forth loses nothing typed. An all-day event opens on its days; a timed
  // one on its times, with the days ready underneath.
  const [allDay, setAllDay] = useState(event?.allDay ?? false);
  // A new event starts on the next quarter hour, never 08:03.
  const [newStart] = useState(() => nextEventStart(new Date()));
  const [start, setStart] = useState(localDateTime(event && !event.allDay ? event.start : newStart));
  const [end, setEnd] = useState(localDateTime(event && !event.allDay ? event.end : new Date(newStart.getTime() + 3600000)));
  const initialDays = event?.allDay ? allDayRange(event) : { startDay: localDay(event?.start ?? new Date()), endDay: localDay(event?.start ?? new Date()) };
  const [startDay, setStartDay] = useState(initialDays.startDay);
  const [endDay, setEndDay] = useState(initialDays.endDay);
  // A recurring Google instance: this occurrence, or the whole series. The
  // web offers the same two the Mac inspector does; nothing else is cheap.
  const canScope = Boolean(event?.recurring && event.recurringEventId);
  const [scope, setScope] = useState<RecurrenceScope>('this');
  // A new event goes where the last one did, while that calendar is still writable here;
  // else the primary. The choice is this browser's, as the Mac's and the phone's are theirs.
  const rememberedTarget = readStored(StorageKeys.calendarWriteTarget);
  const [calendar, setCalendar] = useState(event?.calendarId
    ?? sources.find(source => source.writable && source.id === rememberedTarget)?.id
    ?? sources.find(source => source.writable && source.primary)?.id
    ?? sources.find(source => source.writable)?.id ?? '');
  const calendarOptions = sources
    .filter(source => source.writable || source.id === calendar)
    .map(source => ({ id: source.id, title: source.summary, context: source.accountEmail, color: source.backgroundColor }));
  const [description, setDescription] = useState(event?.description ?? '');
  const [location, setLocation] = useState(event?.location ?? '');
  // Minutes to get there, the owner's own number (#238). Off is 0; Meet
  // never estimates one. Offered once there is somewhere to get to.
  const [travel, setTravel] = useState(event?.travelTimeMinutes ?? 0);
  const showsTravel = location.trim().length > 0 || travel > 0;
  const [attendees, setAttendees] = useState<string[]>(initialAttendees);
  const [includeMeetLink, setIncludeMeetLink] = useState(Boolean(room));
  // Empty with a call on the event: the Worker stores the link in the
  // location slot on save, so Google and Apple Calendar show Join.
  const locationPlaceholder = event?.joinUrl || (!event && room && includeMeetLink && !allDay ? t('Room link') : '');
  // The call link, in full and one press from the clipboard: the room a new
  // event will carry, or the link the event already has.
  const callLink = event ? (event.joinUrl || event.conferenceUrl || '') : (room && includeMeetLink && !allDay ? room.joinURL : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Quick add: the + menu read a sentence; the form
  // opens filled in from it, and says here what it understood.
  const [described, setDescribed] = useState('');
  const [prefilled, setPrefilled] = useState(false);
  if (prefill && !event && !prefilled) {
    setPrefilled(true);
    const draft = prefill.draft;
    setTitle(draft.title);
    if (draft.location) setLocation(draft.location);
    // Names after "with" stay in the title; the invitee list takes
    // addresses, and a name is not one until Core resolves it.
    if (draft.all_day && draft.start && draft.end) {
      setAllDay(true);
      setStartDay(draft.start);
      setEndDay(shiftDay(draft.end, -1) < draft.start ? draft.start : shiftDay(draft.end, -1));
    } else if (draft.start && draft.end) {
      setAllDay(false);
      setStart(draft.start);
      setEnd(draft.end);
    } else if (draft.start) {
      // A date without a time: the day is set, the time is the person's.
      setAllDay(false);
      setStart(`${draft.start}T${start.split('T')[1] ?? '09:00'}`);
      setEnd(`${draft.start}T${end.split('T')[1] ?? '10:00'}`);
    }
    setDescribed(prefill.source === 'model' ? t('Read by the notes engine. Check the times.') : draft.confidence === 0 ? t('No date read; the title is set.') : draft.confidence < 1 ? t('Day read; set the time.') : t('Filled in from the sentence.'));
  }

  async function save() {
    if (busy) return;
    setError('');
    try {
      const dates = allDay ? allDayPatch(startDay, endDay, event) : eventTimePatch(start, end, event);
      setBusy(true);
      if (event && calendar !== event.calendarId) {
        await apiFetch('/calendar/event/move', {
          method: 'POST',
          body: { calendar_id: event.calendarId, event_id: rawCalendarEventId(event.calendarId, event.id), destination_id: calendar },
          fallbackError: t('Couldn’t move this event to that calendar.'),
        });
      }
      const attendeeEmails = attendees;
      const attendeesChanged = attendees.length !== initialAttendees.length || attendees.some((address, index) => address !== initialAttendees[index]);
      const body = event ? {
        calendar_id: calendar, event_id: rawCalendarEventId(event.calendarId, recurrenceTarget(event, scope)),
        ...(title.trim() !== event.title ? { title: title.trim() } : {}),
        ...(description !== (event.description ?? '') ? { description } : {}),
        ...(location !== event.location ? { location } : {}),
        ...(attendeesChanged ? { attendees: attendeeEmails } : {}),
        ...(travel !== (event.travelTimeMinutes ?? 0) ? { travel_time_minutes: travel } : {}),
        ...dates,
      } : {
        title: title.trim(), ...dates, calendar_id: calendar, description, location,
        ...(travel > 0 ? { travel_time_minutes: travel } : {}),
        ...(allDay ? {} : { time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
        attendees: attendeeEmails,
        // A room link is a window on a room; an all-day event has none.
        ...(room && includeMeetLink && !allDay ? { join_url: room.joinURL, room_slug: room.slug } : {}),
      };
      await apiFetch(event ? '/calendar/event' : '/calendar/events', { method: event ? 'PATCH' : 'POST', body, fallbackError: t('Couldn’t save this event. Your changes are still here.') });
      if (!event && calendar) writeStored(StorageKeys.calendarWriteTarget, calendar);
      // What went out. The Worker asks Google to mail the guests when the
      // list changed or the meeting moved; say so, as the Mac and iOS do.
      // eventTimePatch is empty when the times were left alone.
      const moved = Boolean(event && dates.start !== undefined);
      const count = attendeeEmails.length;
      const verb = !event ? t('Invites sent') : moved ? t('Updates sent') : t('Invites updated');
      onSaved(count > 0 ? `${verb} · ${plural(count, { one: '{count} guest', other: '{count} guests' })}` : undefined);
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('Couldn’t save this event.')); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!event || busy) return;
    const title = !event.recurring ? t('Delete “{title}”?', { title: event.title })
      : scope === 'all' ? t('Delete every occurrence of “{title}”?', { title: event.title })
      : t('Delete this occurrence of “{title}”?', { title: event.title });
    if (!await confirmDataLoss({ title, body: t('This can’t be undone.'), action: t('Delete') })) return;
    setBusy(true); setError('');
    try {
      await apiFetch('/calendar/event', { method: 'DELETE', body: { calendar_id: event.calendarId, event_id: rawCalendarEventId(event.calendarId, recurrenceTarget(event, scope)) }, fallbackError: t('Couldn’t delete this event.') });
      onDeleted?.(event); onSaved(); onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('Couldn’t delete this event.')); }
    finally { setBusy(false); }
  }
  // shadcn Dialog: Radix traps focus, inerts the page and locks
  // its scroll, which the native <dialog> did not do on Safari.
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent
      showCloseButton={false}
      aria-describedby={undefined}
      className={cn(editorDialogClass, 'gap-3 bg-card p-5 sm:max-w-[520px]')}
      // An editor keeps its draft: only Esc or Close leaves, never a stray click outside.
      onInteractOutside={(event) => event.preventDefault()}
      // Focus starts in the first field, not on Close: Close is first in the
      // tab order, and focus there would make Enter close the editor.
      onOpenAutoFocus={(event) => {
        const field = (event.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>('input, textarea, select');
        if (!field) return;
        event.preventDefault();
        field.focus();
      }}
    >
    <form className="m-0" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className={editorHeaderClass}>
        <DialogTitle asChild><h2 className={editorTitleClass}>{event ? t('Edit event') : t('New event')}</h2></DialogTitle>
        <Button type="button" variant="ghost" size="icon" className="rounded-full text-muted-foreground" aria-label={t('Close event editor')} disabled={busy} onClick={onClose}>
          <CloseIcon />
        </Button>
      </div>
      {event?.recurring && !canScope && <p className={noteClass}>{t('Only this occurrence changes.')}</p>}
      {error && <ErrorNotice message={error} />}
      <fieldset className={editorFieldsetClass} disabled={busy}>
        <FormRow id={`${uid}-title`} label={t('Title')}>
          <Input id={`${uid}-title`} required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} />
          {described && <small role="status" className="mt-1 block text-xs text-muted-foreground">{described}</small>}
        </FormRow>
        <SearchablePicker
          label={t('Calendar')}
          placeholder={t('Choose a calendar')}
          options={calendarOptions}
          value={calendar}
          onChange={setCalendar}
          emptyMessage={t('No options match that search.')}
          className="my-2"
        />
        {!event && room && !allDay && <CheckRow id={`${uid}-room`} label={t('Add my room link')}><Checkbox id={`${uid}-room`} checked={includeMeetLink} onCheckedChange={(checked) => setIncludeMeetLink(checked === true)} /></CheckRow>}
        {callLink && <CallLinkField href={callLink} />}
        {event?.subject && (
          <p className={noteClass}>
            {t('Filed on')}{' '}
            <a href={subjectHref(event.subject)}>{event.subject.kind === 'project' ? t('Project') : event.subject.kind === 'organization' ? t('Partner') : t('Lead')} · {event.subject.title}</a>
          </p>
        )}
        {canScope && (
          // Chosen before the write, and it governs Save and Delete alike;
          // the labels say what each does, as the Mac's do.
          <fieldset className="m-0 mt-1.5 min-w-0 border-0 p-0">
            <legend className={cn(groupLabelClass, 'mt-0')}>{t('Applies to')}</legend>
            <RadioGroup value={scope} onValueChange={(value) => setScope(value as RecurrenceScope)} className="gap-2">
              <CheckRow id={`${uid}-this`} label={t('This event')} className="my-0"><RadioGroupItem id={`${uid}-this`} value="this" /></CheckRow>
              <CheckRow id={`${uid}-all`} label={t('All events in the series')} className="my-0"><RadioGroupItem id={`${uid}-all`} value="all" /></CheckRow>
            </RadioGroup>
          </fieldset>
        )}
        <CheckRow id={`${uid}-allday`} label={t('All day')}><Checkbox id={`${uid}-allday`} checked={allDay} onCheckedChange={(checked) => setAllDay(checked === true)} /></CheckRow>
        {allDay ? <div className={dateGridClass}>
          <FormRow id={`${uid}-startday`} label={t('Starts')}><DatePicker id={`${uid}-startday`} required value={startDay} onChange={setStartDay} ariaLabel={t('Starts')} /></FormRow>
          <FormRow id={`${uid}-endday`} label={t('Ends')}><DatePicker id={`${uid}-endday`} required min={startDay} value={endDay} onChange={setEndDay} ariaLabel={t('Ends')} /></FormRow>
        </div> : <div className={dateGridClass}>
          <LocalDateTimeField label={t('Starts')} value={start} onChange={setStart} />
          <LocalDateTimeField label={t('Ends')} value={end} onChange={setEnd} />
        </div>}
        {!allDay && <p className={noteClass}>{t('Timezone: {zone}.', { zone: Intl.DateTimeFormat().resolvedOptions().timeZone })}</p>}
        <FormRow id={`${uid}-location`} label={t('Location')}><Input id={`${uid}-location`} maxLength={1024} value={location} placeholder={locationPlaceholder} onChange={event => setLocation(event.target.value)} /></FormRow>
        {showsTravel && <FormRow id={`${uid}-travel`} label={t('Travel time')}><NativeSelect id={`${uid}-travel`} value={travel} onChange={event => setTravel(Number(event.target.value))}>
          {TRAVEL_CHOICES.map(minutes => <NativeSelectOption key={minutes} value={minutes}>{minutes === 0 ? 'Off' : `${minutes} min`}</NativeSelectOption>)}
        </NativeSelect></FormRow>}
        <FormRow id={`${uid}-description`} label={t('Description')}><Textarea id={`${uid}-description`} rows={5} maxLength={4000} value={description} onChange={event => setDescription(event.target.value)} /></FormRow>
        <div>
          <span className={groupLabelClass}>{t('Invitees')}</span>
          <InviteesEditor value={attendees} onChange={setAttendees} existing={event?.attendees ?? []} />
        </div>
      </fieldset>
      <div className="mt-[18px] flex flex-wrap items-center justify-end gap-2">
        <Button disabled={busy || !title.trim() || !calendar}>{t('Save')}</Button>
        {event?.htmlLink && <Tip label={t('Open in Google Calendar')}><Button asChild variant="secondary" size="icon-lg"><a href={event.htmlLink} target="_blank" rel="noreferrer" aria-label={t('Open in Google Calendar')}><GoogleCalendarIcon /></a></Button></Tip>}
        {event && <Tip label={t('Delete event')}><Button type="button" variant="ghost" size="icon" className="ml-auto rounded-full text-muted-foreground hover:text-destructive" aria-label={t('Delete event')} disabled={busy} onClick={() => void remove()}><TrashIcon /></Button></Tip>}
      </div>
    </form>
    </DialogContent>
  </Dialog>;
}

/** The call link, whole and selectable, with a copy button beside it. */
function CallLinkField({ href }: { href: string }) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(href).then(
      () => { setCopied(true); toast(t('Link copied')); window.setTimeout(() => setCopied(false), 1200); },
      () => toast(t('Couldn’t copy the link.'), 'danger'),
    );
  };
  return <FormRow id={id} label={t('Call link')}>
    <span className="flex items-center gap-2">
      <Input id={id} readOnly value={href} className="flex-1" onFocus={event => event.currentTarget.select()} />
      <Tip label={t('Copy link')}><Button type="button" variant="secondary" size="icon" aria-label={t('Copy link')} onClick={copy}><CopyLinkIcon copied={copied} /></Button></Tip>
    </span>
  </FormRow>;
}
