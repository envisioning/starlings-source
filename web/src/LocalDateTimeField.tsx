import { useId } from 'react';
import { Input } from '@/ui/input';
import { DatePicker } from './DatePicker';
import { FormRow } from './form-row';
import { combineLocalDateTime, splitLocalDateTime, stepTime } from './calendar-editor-model';
import { t } from './i18n';

/**
 * A day and a 24-hour clock, as one local `YYYY-MM-DDTHH:MM` value: the
 * calendar event editor's Starts and Ends, and History's Date and time.
 */
export function LocalDateTimeField({ label, value, onChange, className }: { label: string; value: string; onChange: (value: string) => void; className?: string }) {
  const id = useId();
  const parts = splitLocalDateTime(value);
  return <FormRow id={id} label={label} className={className}>
    <span className="grid grid-cols-[minmax(0,1fr)_7.5rem] gap-2">
      <DatePicker id={id} required value={parts.date} ariaLabel={label} onChange={(day) => onChange(combineLocalDateTime(day, parts.time))} />
      {/* Native clock controls are locale-rendered; this field must stay explicit. */}
      <Input
        type="text"
        required
        value={parts.time}
        inputMode="numeric"
        pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]"
        maxLength={5}
        placeholder={t('HH:MM')}
        aria-label={t('{label} time, 24-hour', { label })}
        className="w-30 min-w-0"
        onChange={event => onChange(combineLocalDateTime(parts.date, event.target.value))}
        // Arrow Up / Down move the clock in 5-minute steps; typing stays exact.
        onKeyDown={event => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          const next = stepTime(parts.time, event.key === 'ArrowUp' ? 1 : -1);
          if (!next) return;
          event.preventDefault();
          onChange(combineLocalDateTime(parts.date, next));
        }}
      />
    </span>
  </FormRow>;
}
