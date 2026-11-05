import type { Config } from './config';

export class DocsAPIError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export function client(config: Config) {
  if (!config.token) {
    throw new DocsAPIError('No token. Run `docsctl login` first.', 401, 'unauthorized');
  }

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${config.token}`);
    headers.set('x-docs-client', 'docsctl');
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

    const response = await fetch(`${config.origin}/api${path}`, { ...init, headers });
    if (response.status === 204) return undefined as T;

    const text = await response.text();
    const isJSON = response.headers.get('content-type')?.includes('application/json');
    const body: unknown = isJSON && text ? JSON.parse(text) : text;

    if (!response.ok) {
      const error = body as { error?: string; code?: string };
      throw new DocsAPIError(error?.error ?? text ?? 'Request failed.', response.status, error?.code ?? 'internal');
    }
    return body as T;
  }

  return {
    call,
    me: () => call<Record<string, unknown>>('/me'),
    list: (query: Record<string, string>) =>
      call<{ documents: Array<Record<string, any>>; total: number }>(`/docs?${new URLSearchParams(query)}`),
    get: (reference: string) => call<Record<string, any>>(`/docs/${encodeURIComponent(reference)}`),
    raw: (reference: string) => call<string>(`/docs/${encodeURIComponent(reference)}/raw`),
    create: (body: unknown) => call<Record<string, any>>('/docs', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: unknown) =>
      call<Record<string, any>>(`/docs/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    search: (q: string, limit = 20) =>
      call<{ hits: Array<Record<string, any>> }>(`/search?${new URLSearchParams({ q, limit: String(limit) })}`),
    manifest: (prefix?: string) =>
      call<{
        entries: Array<{
          path: string;
          content_hash: string;
          updated_at: string;
          version: number;
          kind: 'markdown' | 'pdf';
          editable: boolean;
        }>;
        truncated: boolean;
      }>(
        `/sync/manifest?${new URLSearchParams(prefix ? { prefix, limit: '20000' } : { limit: '20000' })}`,
      ),
    push: (body: unknown) =>
      call<{
        written: Array<{ path: string; version: number; content_hash: string }>;
        skipped: Array<{ path: string; reason: string }>;
        conflicts: Array<{ path: string; expected: string; actual: string }>;
      }>('/sync/push', { method: 'POST', body: JSON.stringify(body) }),
  };
}

export type DocsClient = ReturnType<typeof client>;
