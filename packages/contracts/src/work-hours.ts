/** Weekday bits for PeerWorkingHours, shared by the Worker and clients. */
export const WORK_DAY_BITS = { mon: 1, tue: 2, wed: 4, thu: 8, fri: 16, sat: 32, sun: 64 } as const;
export const WORK_DAYS_WEEKDAYS = WORK_DAY_BITS.mon | WORK_DAY_BITS.tue | WORK_DAY_BITS.wed
  | WORK_DAY_BITS.thu | WORK_DAY_BITS.fri;

export interface WorkingHoursPattern {
  start_minute: number;
  end_minute: number;
  days: number;
}

/** Whether somebody is inside their own local working hours, or undecidable. */
export function isWithinWorkingHours(
  hours: WorkingHoursPattern | null,
  localMinuteOfDay: number,
  localWeekdayBit: number,
): boolean | null {
  if (!hours) return null;
  if ((hours.days & localWeekdayBit) === 0) return false;
  return hours.end_minute >= hours.start_minute
    ? localMinuteOfDay >= hours.start_minute && localMinuteOfDay < hours.end_minute
    : localMinuteOfDay >= hours.start_minute || localMinuteOfDay < hours.end_minute;
}
