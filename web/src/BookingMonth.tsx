import { ComponentProps, useEffect, useState } from 'react';
import { enGB, ptBR } from 'react-day-picker/locale';
import { Calendar, CalendarDayButton } from '@/ui/calendar';
import { WorkspaceMark } from './action-icons';
import { t, uiLanguage } from './i18n';

/** The glyph under an event day's number, and in the legend that names it. */
const EVENT_MARK_SIZE = 12;

/** An event day carries the Envisioning glyph under its number. */
function BookingDayButton({ children, ...props }: ComponentProps<typeof CalendarDayButton>) {
  return (
    <CalendarDayButton {...props}>
      {children}
      {props.modifiers.event && <WorkspaceMark size={EVENT_MARK_SIZE} />}
    </CalendarDayButton>
  );
}

function firstOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/**
 * The booking page's month on shadcn Calendar. Open days are
 * enabled, closed days disabled. An event day is closed to 1:1s but stays
 * selectable, so the sidebar can show what is on. Days are local calendar
 * days keyed by the availability the guest's time zone returned. The legend
 * under the month names the glyph; it shows only when an event is in range.
 *
 * Lazy: react-day-picker must stay off the guest entry, and ScheduleScreen is
 * in App's static graph.
 */
export default function BookingMonth({
  start,
  end,
  selected,
  onSelect,
  isOpen,
  hasEvent,
  showLegend,
}: {
  start: Date;
  end: Date;
  selected: Date | null;
  onSelect: (day: Date) => void;
  isOpen: (day: Date) => boolean;
  hasEvent: (day: Date) => boolean;
  showLegend: boolean;
}) {
  const [month, setMonth] = useState(() => firstOfMonth(selected ?? start));
  const selectedTime = selected?.getTime();
  // Follow the selection when it lands in another month (the first open day
  // may be next month).
  useEffect(() => {
    if (selectedTime !== undefined) setMonth(firstOfMonth(new Date(selectedTime)));
  }, [selectedTime]);

  return (
    <>
      <Calendar
        mode="single"
        required
        selected={selected ?? undefined}
        onSelect={(day) => { if (day) onSelect(day); }}
        month={month}
        onMonthChange={setMonth}
        startMonth={start}
        endMonth={end}
        showOutsideDays={false}
        weekStartsOn={1}
        locale={uiLanguage === 'pt-BR' ? ptBR : enGB}
        disabled={(day) => day < start || day > end || (!isOpen(day) && !hasEvent(day))}
        modifiers={{ event: hasEvent }}
        className="bg-transparent p-0 [--cell-size:--spacing(10)]"
        classNames={{ root: 'w-full' }}
        components={{ DayButton: BookingDayButton }}
      />
      {showLegend && (
        <p className="mt-4 flex items-center gap-2 text-[13px] text-muted-foreground">
          <WorkspaceMark size={EVENT_MARK_SIZE} />
          {t('Event day, closed to bookings')}
        </p>
      )}
    </>
  );
}
