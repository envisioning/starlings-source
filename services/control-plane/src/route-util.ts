import type { z } from 'zod';

/** A route's query string, parsed with the schema the contract names. */
export function parseQuery<Schema extends z.ZodType>(schema: Schema, url: URL): z.infer<Schema> {
  return schema.parse(Object.fromEntries(url.searchParams));
}

export function log(level: 'info' | 'warn' | 'error', message: string, data: Record<string, unknown>): void {
  const entry = JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...data });
  if (level === 'error') console.error(entry);
  else if (level === 'warn') console.warn(entry);
  else console.log(entry);
}

export function boundedNumber(raw: string | null, min: number, max: number): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return undefined;
  return value;
}
