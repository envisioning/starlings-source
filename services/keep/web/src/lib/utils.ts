import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Joins class names and lets a later Tailwind utility replace an earlier one. The shadcn components import it from `@/lib/utils`. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
