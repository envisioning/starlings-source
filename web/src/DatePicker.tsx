import { useState } from 'react';
import { enGB, ptBR } from 'react-day-picker/locale';
import { Button } from '@/ui/button';
import { Calendar } from '@/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { CalendarIcon } from './action-icons';
import { dateLocale, t, uiLanguage } from './i18n';

/** `YYYY-MM-DD` as a local calendar day: no time zone, so no day drift. */
function parseDay(value: string | undefined): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value ?? '');
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : undefined;
}

function formatDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * A day, picked on shadcn's Calendar in a Popover — the web's
 * replacement for `<input type="date">`, whose picker and label were the
 * browser's. The value stays the plain `YYYY-MM-DD` string the forms and
 * the Worker already use; an optional field is cleared by picking its day
 * again. The calendar speaks the interface language (week start included).
 */
export function DatePicker({ id, value, onChange, min, required = false, ariaLabel }: {
  /** The trigger's id, for a label's htmlFor. */
  id?: string;
  value: string;
  onChange: (value: string) => void;
  /** The first day that may be picked, `YYYY-MM-DD`. */
  min?: string;
  /** A required day cannot be cleared. */
  required?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = parseDay(value);
  const first = parseDay(min);
  const label = selected
    // A date-only label: toLocaleDateString is the approved spelling (scripts/check-time-format.sh).
    ? selected.toLocaleDateString(dateLocale, { day: 'numeric', month: 'short', year: 'numeric' })
    : t('Pick a date');
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* The name carries the picked day: a bare field name would hide it from a screen reader. */}
        <Button id={id} type="button" variant="outline" className="w-full justify-start font-normal" aria-label={ariaLabel ? `${ariaLabel}, ${label}` : undefined}>
          <CalendarIcon />
          <span className={selected ? undefined : 'text-muted-foreground'}>{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected ?? first}
          disabled={first ? { before: first } : undefined}
          locale={uiLanguage === 'pt-BR' ? ptBR : enGB}
          onSelect={(date) => {
            if (!date && required) return;
            onChange(date ? formatDay(date) : '');
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
