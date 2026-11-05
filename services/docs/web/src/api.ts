// Typed client for the Docs API.
//
// Two credential shapes: staff ride a cookie (nothing to attach), guests hold a
// bearer token kept in sessionStorage. `request` picks whichever applies, so no
// call site has to think about it.

import type {
  Annotation,
  DeploymentInfo,
  DocumentDetail,
  DocsErrorCode,
  GuestSession,
  SignatureRequestDetail,
  TokenSummary,
} from '@docs/contracts';

const GUEST_TOKEN_KEY = 'docs.guest.token';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: DocsErrorCode,
  ) {
    super(message);
  }
}

export function guestToken(): string | null {
  try {
    return sessionStorage.getItem(GUEST_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setGuestToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(GUEST_TOKEN_KEY, token);
    else sessionStorage.removeItem(GUEST_TOKEN_KEY);
  } catch {
    /* private browsing — the session simply will not survive a reload */
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = guestToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

  const response = await fetch(`/api${path}`, { ...init, headers, credentials: 'include' });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const isJSON = response.headers.get('content-type')?.includes('application/json');
  const body: unknown = isJSON && text ? JSON.parse(text) : text;

  if (!response.ok) {
    const error = body as { error?: string; code?: DocsErrorCode };
    throw new ApiError(error?.error ?? 'Request failed.', response.status, error?.code ?? 'internal');
  }
  return body as T;
}

export type Me =
  | { kind: 'staff'; email: string; name: string; picture?: string }
  | { kind: 'guest'; email: string; role: string; verified: boolean; document_id: string | null }
  | { kind: 'agent'; owner: string; agent_name: string | null; scopes: string[] };

export const api = {
  me: () => request<Me>('/me'),
  deployment: () => request<DeploymentInfo>('/deployment'),

  document: (reference: string) => request<DocumentDetail>(`/docs/${encodeURIComponent(reference)}`),

  tokens: () => request<{ tokens: TokenSummary[] }>('/tokens'),

  // The only response that ever carries the secret. Nothing stores it.
  createToken: (body: Record<string, unknown>) =>
    request<TokenSummary & { token: string }>('/tokens', { method: 'POST', body: JSON.stringify(body) }),

  revokeToken: (id: string) => request<void>(`/tokens/${id}`, { method: 'DELETE' }),

  annotations: (id: string) => request<{ annotations: Annotation[] }>(`/docs/${id}/annotations`),

  addAnnotation: (id: string, body: Record<string, unknown>) =>
    request<Annotation>(`/docs/${id}/annotations`, { method: 'POST', body: JSON.stringify(body) }),

  resolveAnnotation: (annotationId: string, status: 'open' | 'resolved') =>
    request<Annotation>(`/annotations/${annotationId}`, { method: 'PATCH', body: JSON.stringify({ status }) }),

  // --- share links -------------------------------------------------------

  grantInfo: (token: string) =>
    request<{
      role: string;
      requires_verification: boolean;
      email_hint: string | null;
      document: { title: string; kind: string } | null;
    }>(`/access/${token}`),

  claim: (token: string, email: string, name?: string) =>
    request<
      | { status: 'ready'; token: string; session: GuestSession }
      | { status: 'verify'; email: string }
    >('/access/claim', { method: 'POST', body: JSON.stringify({ token, email, name }) }),

  verify: (token: string, email: string, code: string) =>
    request<{ status: 'ready'; token: string; session: GuestSession }>('/access/verify', {
      method: 'POST',
      body: JSON.stringify({ token, email, code }),
    }),

  visit: (id: string) =>
    request<void>(`/docs/${id}/visit`, {
      method: 'POST',
      body: JSON.stringify({
        referrer: document.referrer || undefined,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        language: navigator.language,
      }),
    }).catch(() => {}),

  // A link opened from inside the document body.
  // keepalive, so it outlives the navigation it rides on, and never awaited.
  // Not sendBeacon: a guest's credential is a bearer header, which a beacon
  // cannot carry.
  click: (id: string, href: string) => {
    const headers = new Headers({ 'content-type': 'application/json' });
    const token = guestToken();
    if (token) headers.set('authorization', `Bearer ${token}`);
    void fetch(`/api/docs/${id}/click`, {
      method: 'POST',
      headers,
      credentials: 'include',
      keepalive: true,
      body: JSON.stringify({ href }),
    }).catch(() => {});
  },

  // --- signing -----------------------------------------------------------

  signatureRequests: (id: string) =>
    request<{ requests: SignatureRequestDetail[] }>(`/docs/${id}/signature-requests`),

  sign: (requestId: string, body: Record<string, unknown>) =>
    request<{ id: string; sealed_at: string }>(`/signature-requests/${requestId}/sign`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  decline: (requestId: string, reason: string) =>
    request<void>(`/signature-requests/${requestId}/decline`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  certificate: (requestId: string) =>
    request<string>(`/signature-requests/${requestId}/certificate`),
};

export function signInURL(returnTo: string): string {
  return `/api/auth/google/start?return_to=${encodeURIComponent(returnTo)}`;
}
