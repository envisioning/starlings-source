import type { SupportRequest, SupportRequestCreateResponse, SupportRequestsResponse } from '@starlings/contracts';
import { apiFetch } from './api';
import { t } from './i18n';

/*
 * Support requests (docs/SUPPORT.md): a card a member makes from one line a
 * guest or an organization wrote in a subject's guest thread.
 */

/** The cards already made from a guest thread's lines, by the line they came from. */
export async function fetchSupportRequests(threadId: string): Promise<Map<string, SupportRequest>> {
  const body = await apiFetch<SupportRequestsResponse>(`/threads/${encodeURIComponent(threadId)}/requests`, {
    fallbackError: t('Couldn’t read the cards for this thread.'),
  });
  return new Map(body.requests.map((request) => [request.message_id, request]));
}

/** A card on the thread's subject from one outside line. */
export async function createSupportRequest(threadId: string, messageId: string): Promise<SupportRequestCreateResponse> {
  return apiFetch<SupportRequestCreateResponse>(
    `/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/request`,
    { method: 'POST', body: {}, fallbackError: t('Couldn’t make a card from that message.') },
  );
}
