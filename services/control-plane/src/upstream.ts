// Every body an upstream sends back (Core, GitHub, Docs) runs through a zod
// schema before the Worker reads it or passes it on. A mismatch is
// a logged 502 `upstream_shape` that names the field path, so a shape change
// upstream shows as upstream's fault and not as a `keyNotFound` on the Mac.
import { z } from 'zod';
import type { ControlError } from './errors';
import type { ControlErrorCode } from './contracts';

export type UpstreamSource = 'core' | 'github' | 'docs';

const SOURCE_NAME: Record<UpstreamSource, string> = { core: 'Core', github: 'GitHub', docs: 'Docs' };

/** The error class of the calling module: `CrmSyncError`, `GithubError`, `DocsError`. */
export type UpstreamErrorClass = new (message: string, status: number, code?: ControlErrorCode) => ControlError;

export interface UpstreamRead {
  source: UpstreamSource;
  /** Method and path, no query values: a query can hold an address. */
  route: string;
  error: UpstreamErrorClass;
}

/**
 * The schema as the native clients decode it, and no stricter. The generated
 * Swift reads a value set as an open enum (a value this build never saw
 * decodes as itself) and ignores a field it does not know. So here an enum
 * reads as a string and every object is loose. Required fields, `null`,
 * numbers, literals and string checks stay as written: the wire schemas put
 * no check on a string, and a worker-local check is the Worker's own.
 */
const lenientCache = new WeakMap<z.ZodType, z.ZodType>();

export function lenient(schema: z.ZodType): z.ZodType {
  const cached = lenientCache.get(schema);
  if (cached) return cached;
  const result = relax(schema);
  lenientCache.set(schema, result);
  return result;
}

function relax(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodObject) {
    const shape: Record<string, z.ZodType> = {};
    for (const [key, field] of Object.entries(schema.shape as Record<string, z.ZodType>)) shape[key] = lenient(field);
    return z.looseObject(shape);
  }
  if (schema instanceof z.ZodArray) return z.array(lenient(schema.element as z.ZodType));
  if (schema instanceof z.ZodOptional) return lenient(schema.unwrap() as z.ZodType).optional();
  if (schema instanceof z.ZodNullable) return lenient(schema.unwrap() as z.ZodType).nullable();
  if (schema instanceof z.ZodDefault) {
    const inner = lenient(schema.unwrap() as z.ZodType);
    return inner.default(schema._zod.def.defaultValue as never);
  }
  if (schema instanceof z.ZodEnum) return z.string();
  // A preprocess (the kind aliases, ADR 0006) keeps its first step and relaxes the rest.
  if (schema instanceof z.ZodPipe) return z.pipe(schema._zod.def.in as z.ZodType, lenient(schema._zod.def.out as z.ZodType));
  if (schema instanceof z.ZodRecord) return z.record(z.string(), lenient(schema.valueType as z.ZodType));
  if (schema instanceof z.ZodUnion) {
    const options = (schema.options as readonly z.ZodType[]).map(lenient);
    return z.union(options as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  }
  return schema;
}

function issuePath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '(body)' : path.map(String).join('.');
}

/**
 * Check a value an upstream sent against `schema`, read leniently (see
 * `lenient`). A mismatch logs the source, the route and the failing field
 * paths, never the values (they can hold personal data), and throws a 502
 * `upstream_shape` in the caller's error class that names the first path.
 */
export function parseUpstream<S extends z.ZodType>(schema: S, body: unknown, read: UpstreamRead): z.output<S> {
  const parsed = lenient(schema).safeParse(body);
  if (parsed.success) return parsed.data as z.output<S>;
  const issues = parsed.error.issues.slice(0, 10).map((issue) => ({ path: issuePath(issue.path), code: issue.code }));
  console.error(JSON.stringify({ level: 'error', message: 'upstream.shape', source: read.source, route: read.route, issues }));
  throw new read.error(
    `${SOURCE_NAME[read.source]} answered an unexpected shape at ${issues[0]?.path ?? '(body)'}.`,
    502,
    'upstream_shape',
  );
}

/** Read a response as JSON and check it. A body that is not JSON fails at `(body)`. */
export async function readUpstreamJson<S extends z.ZodType>(response: Response, schema: S, read: UpstreamRead): Promise<z.output<S>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return parseUpstream(schema, body, read);
}

/**
 * An upstream's refusal body. Read on an error status only, so a body that
 * does not match is simply no detail: the status already says what failed.
 */
export const upstreamRefusalSchema = z.looseObject({
  error: z.string().optional(),
  code: z.string().optional(),
  details: z.unknown().optional(),
});

export function readRefusal(body: unknown): z.output<typeof upstreamRefusalSchema> {
  const parsed = upstreamRefusalSchema.safeParse(body);
  return parsed.success ? parsed.data : {};
}
