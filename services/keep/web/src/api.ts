// Typed client for the Keep API. People ride a cookie. An agent token never
// reaches this SPA: the broker holds it (ADR 0007).

import type {
  AgentSummary,
  ReleaseSummary,
  VaultAccess,
  CreateMachineItemInput,
  CreateMachineVaultInput,
  ItemSummary,
  MachineVaultDetail,
  MachineVaultSummary,
  UpdateMachineItemInput,
  WrappedToPublicKey,
  AddWrapInput,
  AuditEvent,
  CreateItemInput,
  CreateVaultInput,
  DirectoryEntry,
  EnrolInput,
  ItemDetail,
  KeepErrorCode,
  RecoveryKey,
  RotateVaultInput,
  StaffKey,
  VaultDetail,
  VaultSummary,
  DeploymentInfo,
} from '@keep/contracts';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: KeepErrorCode,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`/api${path}`, { ...init, headers, credentials: 'same-origin' });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const isJSON = response.headers.get('content-type')?.includes('application/json');
  const body: unknown = isJSON && text ? JSON.parse(text) : text;
  if (!response.ok) {
    const error = body as { error?: string; code?: KeepErrorCode };
    throw new ApiError(error?.error ?? 'Request failed.', response.status, error?.code ?? 'internal');
  }
  return body as T;
}

export interface Me {
  email: string;
  name: string;
  picture: string | null;
  enrolled: boolean;
  key: StaffKey | null;
  core_web_origin: string;
}

export const api = {
  me: () => request<Me>('/me'),
  deployment: () => request<DeploymentInfo>('/deployment'),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),

  enrol: (body: EnrolInput, replace = false) =>
    request<StaffKey>(`/keys/me${replace ? '?replace=1' : ''}`, { method: 'PUT', body: JSON.stringify(body) }),
  addWrap: (body: AddWrapInput) => request<StaffKey>('/keys/me/wraps', { method: 'POST', body: JSON.stringify(body) }),
  directory: () => request<{ entries: DirectoryEntry[] }>('/keys/directory'),
  recovery: () => request<{ recovery: RecoveryKey | null }>('/recovery'),
  setRecovery: (body: { suite: 'keep-v1'; public_key: string; holders: string[] }) =>
    request<RecoveryKey>('/recovery', { method: 'PUT', body: JSON.stringify(body) }),

  vaults: () => request<{ vaults: VaultSummary[] }>('/vaults'),
  vault: (id: string) => request<VaultDetail>(`/vaults/${id}`),
  createVault: (body: CreateVaultInput) => request<VaultDetail>('/vaults', { method: 'POST', body: JSON.stringify(body) }),
  updateVault: (id: string, body: { name?: string; icon?: string | null; project_id?: string | null }) =>
    request<VaultDetail>(`/vaults/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteVault: (id: string) => request<void>(`/vaults/${id}`, { method: 'DELETE' }),
  grant: (id: string, body: CreateVaultInput['members'][number]) =>
    request<VaultDetail>(`/vaults/${id}/members`, { method: 'POST', body: JSON.stringify(body) }),
  rotate: (id: string, body: RotateVaultInput) => request<VaultDetail>(`/vaults/${id}/rotate`, { method: 'POST', body: JSON.stringify(body) }),
  access: (id: string, itemId?: string) => request<VaultAccess>(`/vaults/${id}/access${itemId ? `?item=${itemId}` : ''}`),
  /** End a release early. Any member may. */
  endRelease: (vaultId: string, releaseId: string) => request<ReleaseSummary>(`/vaults/${vaultId}/releases/${releaseId}/end`, { method: 'POST' }),
  vaultAudit: (id: string) => request<{ events: AuditEvent[] }>(`/vaults/${id}/audit`),
  audit: () => request<{ events: AuditEvent[] }>('/audit'),

  createItem: (vaultId: string, body: CreateItemInput) =>
    request<ItemDetail>(`/vaults/${vaultId}/items`, { method: 'POST', body: JSON.stringify(body) }),
  reveal: (vaultId: string, itemId: string) => request<ItemDetail>(`/vaults/${vaultId}/items/${itemId}`),
  updateItem: (vaultId: string, itemId: string, body: Record<string, unknown>) =>
    request<ItemDetail>(`/vaults/${vaultId}/items/${itemId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteItem: (vaultId: string, itemId: string) => request<void>(`/vaults/${vaultId}/items/${itemId}`, { method: 'DELETE' }),

  // Agents and machine vaults. Writes only: nothing here returns a value.
  agents: () => request<{ agents: AgentSummary[] }>('/agents'),
  machineVaults: () => request<{ vaults: MachineVaultSummary[] }>('/machine-vaults'),
  machineVault: (id: string) => request<MachineVaultDetail>(`/machine-vaults/${id}`),
  createMachineVault: (body: CreateMachineVaultInput) =>
    request<MachineVaultDetail>('/machine-vaults', { method: 'POST', body: JSON.stringify(body) }),
  grantAgent: (id: string, wrapped_key: WrappedToPublicKey) =>
    request<MachineVaultDetail>(`/machine-vaults/${id}/agent`, { method: 'POST', body: JSON.stringify({ wrapped_key }) }),
  revokeAgent: (id: string) => request<MachineVaultDetail>(`/machine-vaults/${id}/revoke`, { method: 'POST' }),
  machineAccess: (id: string, itemId?: string) =>
    request<VaultAccess>(`/machine-vaults/${id}/access${itemId ? `?item=${itemId}` : ''}`),
  machineAudit: (id: string) => request<{ events: AuditEvent[] }>(`/machine-vaults/${id}/audit`),
  createMachineItem: (vaultId: string, body: CreateMachineItemInput) =>
    request<ItemSummary>(`/machine-vaults/${vaultId}/items`, { method: 'POST', body: JSON.stringify(body) }),
  updateMachineItem: (vaultId: string, itemId: string, body: UpdateMachineItemInput) =>
    request<ItemSummary>(`/machine-vaults/${vaultId}/items/${itemId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteMachineItem: (vaultId: string, itemId: string) => request<void>(`/machine-vaults/${vaultId}/items/${itemId}`, { method: 'DELETE' }),
};

export function signInURL(returnTo: string): string {
  return `/api/auth/google/start?return_to=${encodeURIComponent(returnTo)}`;
}
