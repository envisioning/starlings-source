import type { ComponentProps, KeyboardEvent, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Card } from '@/ui/card';
import { Label } from '@/ui/label';
import { formField, formFieldCaption, isFormFieldRequired, type FormID } from '@starlings/contracts/form-fields';
import { t } from './i18n';

/**
 * The parts Work's panes are made of, on shadcn Card and
 * Tailwind utilities over the `--ui-*` theme. One helper per concept, so a
 * subject pane, the goal and decision forms and an issue read alike. The
 * rows are `RailRow` (SurfaceShell.tsx), shadcn Item.
 */

/** A plan heading: caption, uppercase, quiet (TODAY, INBOX, GOALS). */
export const planHeadClass = cn('m-0 text-xs font-medium tracking-[0.08em] uppercase opacity-60');

export function PlanHead({ as: Tag = 'h3', className, ...props }: ComponentProps<'h3'> & { as?: 'h2' | 'h3' }) {
  return <Tag className={cn(planHeadClass, 'mb-1.5', className)} {...props} />;
}

/** A heading with its controls at the end, on one baseline. */
export function HeadRow({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex items-baseline justify-between gap-2', className)} {...props} />;
}

/** Small decisions beside a row or a heading: Star / Mute, Accept / Decline. */
export const stateActionsClass = 'flex flex-none items-center gap-1';

export function StateActions({ className, ...props }: ComponentProps<'span'>) {
  return <span className={cn(stateActionsClass, className)} {...props} />;
}

/** The head of a pane or a reader: the title left, its controls right. */
export function DetailHead({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex items-center justify-between gap-3', className)} {...props} />;
}

/** A pane's title, in the head. */
export const detailTitleClass = 'm-0 text-lg font-medium';

/** One line of the pane's explanation under its head. */
export const paneHelpClass = 'mt-1.5 mb-0 max-w-[60ch] text-[13px] text-muted-foreground';

/**
 * A form in the column (task, subject, goal, decision, issue): a Card, the
 * title on top, the fields stacked. It reads where the thing it edits
 * reads, never over the page.
 */
export function SheetCard({ title, className, children, ...props }: ComponentProps<'form'> & { title?: ReactNode }) {
  return (
    <Card className={cn('w-full max-w-[520px] gap-3 p-5 shadow-none', className)}>
      <form className="flex flex-col gap-3" {...props}>
        {title && <h3 className="m-0 text-[17px] font-medium">{title}</h3>}
        {children}
      </form>
    </Card>
  );
}

/** A labelled field on a sheet. A NativeSelect fills the row, as an Input does. */
export function SheetField({ label, className, children }: { label: ReactNode; className?: string; children: ReactNode }) {
  return (
    <Label className={cn('flex flex-col gap-1.5 text-xs [&>[data-slot=native-select-wrapper]]:w-full font-normal leading-normal items-stretch', className)}>
      <span className="text-muted-foreground">{label}</span>
      {children}
    </Label>
  );
}

/**
 * A form field's caption from `FORM_FIELDS`: its label, and the mark when the
 * form requires it. The Mac and the phone draw the same caption.
 */
export function fieldCaption(form: FormID, id: string): string {
  const spec = formField(form, id);
  return formFieldCaption(spec, t(spec.label));
}

/** The input's cap and required state, from the same row. */
export function fieldProps(form: FormID, id: string): { maxLength?: number; 'aria-required'?: true } {
  const spec = formField(form, id);
  return {
    ...(spec.maxLength === null ? {} : { maxLength: spec.maxLength }),
    ...(isFormFieldRequired(spec) ? { 'aria-required': true as const } : {}),
  };
}

/** A sheet's keydown: Escape inside the form cancels it. */
export function cancelOnEscape(onCancel: () => void) {
  return (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    onCancel();
  };
}

/** Cancel and Save, at the end of a sheet. */
export function SheetActions({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mt-1 flex justify-end gap-2', className)} {...props} />;
}

/** A reader's facts: two columns of label and value between two lines. */
export function ReaderFacts({ facts }: { facts: Array<[label: string, value: ReactNode] | false | null | undefined | ''> }) {
  return (
    <dl className="mt-6 mb-0 grid grid-cols-2 gap-x-5 gap-y-3 border-y py-4">
      {facts.filter((fact): fact is [string, ReactNode] => Array.isArray(fact)).map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">{label}</dt>
          <dd className="mx-0 mt-[3px] mb-0 [overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A quiet underlined link or button inside a reader. */
export const readerLinkClass = 'cursor-pointer border-0 bg-transparent p-0 text-inherit underline decoration-border underline-offset-3 hover:decoration-current';
