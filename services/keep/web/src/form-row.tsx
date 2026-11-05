import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Field, FieldLabel } from '@/ui/field';

/*
 * The app's form rows, on shadcn Field. One source for the label
 * over a control and the box beside its label, in place of a `<label>` that
 * wraps its control with copied classes. The caller owns the id (`useId`)
 * and puts it on the control, so the label binds by htmlFor. The labels keep
 * the app's type: small and muted over a field, body size beside a box.
 */

/** A label over its control. Field stretches the control to the row. */
export function FormRow({ id, label, className, children }: {
  id: string;
  label: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Field className={cn('my-2 gap-1.5', className)}>
      <FieldLabel htmlFor={id} className="text-xs font-normal text-muted-foreground">{label}</FieldLabel>
      {children}
    </Field>
  );
}

/** A checkbox or radio item, then its label. */
export function CheckRow({ id, label, className, children }: {
  id: string;
  label: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Field orientation="horizontal" className={cn('my-2 gap-2', className)}>
      {children}
      <FieldLabel htmlFor={id} className="font-normal">{label}</FieldLabel>
    </Field>
  );
}
