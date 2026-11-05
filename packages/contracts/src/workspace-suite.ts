// Where a workspace's mail and calendar live. No imports, so the Node scripts
// (provision-workspace, check-production-config) load it as is and a web
// entry that reads the suite carries no zod. The schema is in
// workspace-profile.ts.

/**
 * Where a workspace's mail and calendar live. Signup asks; an admin can change
 * it in Admin › People. Stored in D1 (`workspace_settings`, key `suite`);
 * before an admin saves, the Worker's `WORKSPACE_SUITE` var answers, and
 * without it, `google`. Sign-in is Google for every suite.
 *
 * Calendar connects only on `google`. Clients hide Connect Calendar on the
 * others until Meet speaks Microsoft 365.
 */
export const WORKSPACE_SUITES = ['google', 'microsoft', 'other'] as const;
export type WorkspaceSuite = (typeof WORKSPACE_SUITES)[number];
export const DEFAULT_WORKSPACE_SUITE: WorkspaceSuite = 'google';

/** The suite's name in signup, the operator console and Admin. */
export const WORKSPACE_SUITE_LABELS: Record<WorkspaceSuite, string> = {
  google: 'Google Workspace',
  microsoft: 'Microsoft 365',
  other: 'Other',
};

/** The suite named by a stored or configured value, or null for anything else. */
export function parseWorkspaceSuite(value: unknown): WorkspaceSuite | null {
  if (typeof value !== 'string') return null;
  const suite = value.trim().toLowerCase();
  return (WORKSPACE_SUITES as readonly string[]).includes(suite) ? (suite as WorkspaceSuite) : null;
}

