import type {
  PeerWorkspace,
  PeerWorkspacesResponse,
  PeerWorkspaceTokenResponse,
  SubjectAccessResponse,
  SubjectGrantUpdate,
  SubjectVisibility,
} from '@starlings/contracts/subject-access';
import { apiFetch } from './api';
import { t } from './i18n';

/**
 * Who reaches a subject (docs/ACCESS.md), for the web's Share dialog, the
 * guest thread on a subject's Overview and Admin's peer organizations. One
 * module: every call here reads or changes a subject grant.
 */

type SubjectRef = { kind: string; id: string };

export function readSubjectAccess(subject: SubjectRef): Promise<SubjectAccessResponse> {
  return apiFetch<SubjectAccessResponse>(`/crm/subjects/${subject.kind}/${encodeURIComponent(subject.id)}/access`, { noStore: true, fallbackError: t('Couldn’t load who has access.') });
}

export function setSubjectVisibility(subject: SubjectRef, visibility: SubjectVisibility): Promise<SubjectAccessResponse> {
  return apiFetch<SubjectAccessResponse>(`/crm/subjects/${subject.kind}/${encodeURIComponent(subject.id)}/visibility`, {
    method: 'PUT',
    body: { visibility },
    fallbackError: t('Couldn’t change who can see this.'),
  });
}

export function putSubjectGrant(subject: SubjectRef, update: SubjectGrantUpdate): Promise<SubjectAccessResponse> {
  return apiFetch<SubjectAccessResponse>(`/crm/subjects/${subject.kind}/${encodeURIComponent(subject.id)}/grants`, {
    method: 'PUT',
    body: update,
    fallbackError: t('Couldn’t share it.'),
  });
}

export function revokeSubjectGrant(subject: SubjectRef, grantId: string): Promise<SubjectAccessResponse> {
  return apiFetch<SubjectAccessResponse>(`/crm/subjects/${subject.kind}/${encodeURIComponent(subject.id)}/grants/${encodeURIComponent(grantId)}`, {
    method: 'DELETE',
    fallbackError: t('Couldn’t remove access.'),
  });
}

export async function listPeerOrganizations(): Promise<PeerWorkspace[]> {
  return (await apiFetch<PeerWorkspacesResponse>('/peer-workspaces', { noStore: true, fallbackError: t('Couldn’t load organizations.') })).peers;
}

export async function revokePeerOrganization(organizationId: string): Promise<PeerWorkspace> {
  return (await apiFetch<{ peer: PeerWorkspace }>(`/peer-workspaces/${encodeURIComponent(organizationId)}`, {
    method: 'DELETE',
    fallbackError: t('Couldn’t revoke the organization.'),
  })).peer;
}

export function newPeerToken(organizationId: string): Promise<PeerWorkspaceTokenResponse> {
  return apiFetch<PeerWorkspaceTokenResponse>(`/peer-workspaces/${encodeURIComponent(organizationId)}/token`, {
    method: 'POST',
    fallbackError: t('Couldn’t issue a new token.'),
  });
}
