import type { AttentionListQuery, AttentionListResponse, AttentionRequest, AttentionResolveInput, AttentionResolveResponse } from '@starlings/contracts/attention';
import { apiFetch } from './api';
import { invalidateFor } from './snapshot-store';
import { t } from './i18n';

export function fetchAttention(query: Partial<AttentionListQuery> = {}): Promise<AttentionListResponse> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, value);
  return apiFetch(`/attention${params.size ? `?${params}` : ''}`, { noStore: true, fallbackError: t('Couldn’t load this question.') });
}
export function readAttention(id: string): Promise<AttentionRequest> {
  return apiFetch(`/attention/${encodeURIComponent(id)}`, { noStore: true, fallbackError: t('Couldn’t load this question.') });
}
export async function resolveAttention(id: string, command: AttentionResolveInput): Promise<AttentionResolveResponse> {
  const result = await apiFetch<AttentionResolveResponse>(`/attention/${encodeURIComponent(id)}/resolve`, {
    method: 'POST', body: command, fallbackError: t('Couldn’t submit this answer.'),
  });
  invalidateFor('attention.resolve');
  return result;
}
export function attentionStatus(request: AttentionRequest): string | null {
  switch (request.state) {
    case 'open': return null;
    case 'dismissed': return t('Dismissed');
    case 'withdrawn': return t('Withdrawn');
    case 'defaulted': return t('Default applied');
    case 'answered': return t('Answered');
  }
}
