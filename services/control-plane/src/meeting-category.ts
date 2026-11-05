/** The CRM subject a meeting is filed under, or null when it is not filed. */
export function subjectOfCategory(category: {
  meetingKind: string;
  leadId: string | null;
  projectId: string | null;
  partnerOrganizationId?: string | null;
}): { kind: 'project' | 'lead' | 'organization'; id: string } | null {
  if (category.meetingKind === 'project' && category.projectId) {
    return { kind: 'project', id: category.projectId };
  }
  if (category.meetingKind === 'lead' && category.leadId) {
    return { kind: 'lead', id: category.leadId };
  }
  if (category.meetingKind === 'partner' && category.partnerOrganizationId) {
    return { kind: 'organization', id: category.partnerOrganizationId };
  }
  return null;
}
