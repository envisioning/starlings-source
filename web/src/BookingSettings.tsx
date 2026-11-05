import { useEffect, useMemo, useState } from 'react';
import {
  BOOKING_WEEKDAYS,
  type BookingDayHours,
  type BookingSettingsResponse,
  type BookingSettingsUpdate,
  type BookingWeekday,
  type BookingWeeklyHours,
} from '@starlings/contracts/booking-settings';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { PlaceholderRows } from '@/ui/placeholder-rows';
import { apiFetch } from './api';
import { ErrorNotice } from './ErrorNotice';
import { SectionCard } from './SectionCard';
import { dateLocale, t } from './i18n';
import { localTimeZone } from './meeting-time';

/**
 * Settings › Calendar › Booking hours (docs/CORE_FOLD_PLAN.md §Phase 3d).
 * The hours and the zone are the member's profile hours, the ones Team shows
 * as "their time"; the rest is how a guest books a slot inside them.
 */
export function BookingSettingsSection({ calendarConnected }: {
  /** Undefined while the connection is still being checked. */
  calendarConnected?: boolean;
}) {
  const [saved, setSaved] = useState<BookingSettingsResponse | undefined>();
  const [draft, setDraft] = useState<BookingSettingsUpdate | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [message, setMessage] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    apiFetch<BookingSettingsResponse>('/calendar/booking-settings', {
      fallbackError: t('Couldn’t read your booking hours.'),
      noStore: true,
    })
      .then((loaded) => {
        if (cancelled) return;
        setSaved(loaded);
        setDraft(draftFrom(loaded));
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : t('Couldn’t read your booking hours.'));
      });
    return () => { cancelled = true; };
  }, []);

  const zones = useMemo(() => timeZones(draft?.timezone), [draft?.timezone]);

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const next = await apiFetch<BookingSettingsResponse>('/calendar/booking-settings', {
        method: 'PUT',
        body: draft,
        fallbackError: t('Couldn’t save your booking hours.'),
      });
      setSaved(next);
      setDraft(draftFrom(next));
      setMessage(t('Saved. Your hours on Team follow the same setting.'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('Couldn’t save your booking hours.'));
    } finally {
      setSaving(false);
    }
  }

  function change(update: Partial<BookingSettingsUpdate>) {
    setDraft((current) => (current ? { ...current, ...update } : current));
    setMessage(undefined);
  }

  function changeDay(day: BookingWeekday, update: Partial<BookingDayHours>) {
    setDraft((current) => (current
      ? { ...current, weekly_hours: { ...current.weekly_hours, [day]: { ...current.weekly_hours[day], ...update } } }
      : current));
    setMessage(undefined);
  }

  return (
    <SectionCard id="settings-booking" title={t('Booking hours')}>
      <p className={NOTE}>
        {saved?.room
          ? t('Guests book a time on {path} inside these hours, around your busy times.', { path: `/book/${saved.room}` })
          : t('These are your working hours. You have no booking page yet.')}
      </p>
      {saved?.room && calendarConnected === false && (
        <ErrorNotice message={t('Connect Google Calendar above to take bookings. Until then your booking page says you are not taking bookings.')} />
      )}
      {!draft ? (
        error ? <ErrorNotice message={error} /> : <PlaceholderRows count={3} />
      ) : (
        <>
          <Label className="flex items-center gap-3 font-normal">
            <Checkbox checked={draft.active} disabled={saving} onCheckedChange={(value) => change({ active: value === true })} />
            <span className="text-[13px]">{t('Take bookings')}</span>
          </Label>

          <Field label={t('Time zone')} id="booking-zone">
            <NativeSelect id="booking-zone" value={draft.timezone} disabled={saving} onChange={(event) => change({ timezone: event.target.value })}>
              {zones.map((zone) => <NativeSelectOption key={zone} value={zone}>{zone}</NativeSelectOption>)}
            </NativeSelect>
          </Field>

          <fieldset className="m-0 grid gap-2 border-0 p-0">
            <legend className="sr-only">{t('Days')}</legend>
            {DAYS.map(({ day, label }) => {
              const hours = draft.weekly_hours[day];
              return (
                <div key={day} className="flex flex-wrap items-center gap-3">
                  <Label className="flex w-24 items-center gap-2 font-normal">
                    <Checkbox checked={hours.enabled} disabled={saving} onCheckedChange={(value) => changeDay(day, { enabled: value === true })} />
                    <span className="text-[13px]">{label}</span>
                  </Label>
                  <NativeSelect
                    aria-label={t('{day} from', { day: label })}
                    value={String(hours.start_minute)}
                    disabled={saving || !hours.enabled}
                    onChange={(event) => changeDay(day, { start_minute: Number(event.target.value) })}
                  >
                    {CLOCK_MINUTES.map((minute) => <NativeSelectOption key={minute} value={String(minute)}>{clock(minute)}</NativeSelectOption>)}
                  </NativeSelect>
                  <span className={NOTE}>{t('to')}</span>
                  <NativeSelect
                    aria-label={t('{day} until', { day: label })}
                    value={String(hours.end_minute)}
                    disabled={saving || !hours.enabled}
                    onChange={(event) => changeDay(day, { end_minute: Number(event.target.value) })}
                  >
                    {CLOCK_MINUTES.map((minute) => <NativeSelectOption key={minute} value={String(minute)}>{clock(minute)}</NativeSelectOption>)}
                  </NativeSelect>
                </div>
              );
            })}
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-3">
            <NumberField label={t('Meeting length (minutes)')} id="booking-duration" value={draft.duration_minutes} min={15} max={240} disabled={saving} onChange={(value) => change({ duration_minutes: value })} />
            <NumberField label={t('Start a slot every (minutes)')} id="booking-step" value={draft.slot_step_minutes} min={5} max={240} disabled={saving} onChange={(value) => change({ slot_step_minutes: value })} />
            <NumberField label={t('Gap around meetings (minutes)')} id="booking-buffer" value={draft.buffer_minutes} min={0} max={120} disabled={saving} onChange={(value) => change({ buffer_minutes: value })} />
            <NumberField label={t('Notice (hours)')} id="booking-notice" value={draft.min_notice_hours} min={0} max={168} disabled={saving} onChange={(value) => change({ min_notice_hours: value })} />
            <NumberField label={t('Book up to (days ahead)')} id="booking-horizon" value={draft.max_booking_days} min={1} max={365} disabled={saving} onChange={(value) => change({ max_booking_days: value })} />
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <Button type="button" disabled={saving} onClick={() => { void save(); }}>
              {saving ? t('Saving…') : t('Save booking hours')}
            </Button>
            {message && <span className={NOTE}>{message}</span>}
          </div>
          {error && <ErrorNotice message={error} />}
        </>
      )}
    </SectionCard>
  );
}

const NOTE = 'm-0 text-[13px] leading-normal text-muted-foreground';

/** Monday first; the names are this language's short weekday names. */
const DAYS = BOOKING_WEEKDAYS.map((day, index) => ({
  day,
  // 2024-01-01 was a Monday.
  label: new Date(Date.UTC(2024, 0, 1 + index)).toLocaleDateString(dateLocale, { weekday: 'short', timeZone: 'UTC' }),
}));

const DEFAULT_WEEK = Object.fromEntries(BOOKING_WEEKDAYS.map((day) => [day, {
  enabled: day !== 'sat' && day !== 'sun',
  start_minute: 9 * 60,
  end_minute: 17 * 60,
}])) as BookingWeeklyHours;

/** Every quarter hour of the day, as minutes after midnight. */
const CLOCK_MINUTES = Array.from({ length: 96 }, (_, index) => index * 15);

function clock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/** The form's starting values: the saved ones, else 09:00 to 17:00 on weekdays in this browser's zone. */
function draftFrom(settings: BookingSettingsResponse): BookingSettingsUpdate {
  return {
    active: settings.active,
    duration_minutes: settings.duration_minutes,
    buffer_minutes: settings.buffer_minutes,
    min_notice_hours: settings.min_notice_hours,
    max_booking_days: settings.max_booking_days,
    slot_step_minutes: settings.slot_step_minutes,
    timezone: settings.timezone ?? localTimeZone(),
    weekly_hours: settings.weekly_hours ?? DEFAULT_WEEK,
  };
}

/** The zones this browser knows, with the current one first when it is not among them. */
function timeZones(current: string | undefined): string[] {
  const known = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return current && !known.includes(current) ? [current, ...known] : known;
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <Label htmlFor={id} className="text-[12px] font-normal text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function NumberField({ label, id, value, min, max, disabled, onChange }: {
  label: string;
  id: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label} id={id}>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, Math.round(next))));
        }}
      />
    </Field>
  );
}
