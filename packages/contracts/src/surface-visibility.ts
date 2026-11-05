import { MEMBER_SURFACES, type MemberSurfaceId } from './member-surfaces';

/**
 * Which member destinations a client lists: the web's workspace nav, the
 * Mac's surface switcher and Window menu, the phone's tab bar and the search
 * palette's Go to doors. The member does not choose; the system
 * hides a destination that has nothing to show. The order stays the
 * `MEMBER_SURFACES` order, and a hidden destination still opens from a link.
 *
 * The cases are `fixtures/surface-visibility.json`, read by the web and the
 * Swift tests (`docs/agents/areas/registries.md`, "Rules with cases").
 */
export interface SurfaceVisibilityInput {
  /**
   * Whether the member has a calendar source: `sources` from
   * `GET /api/calendar/status`, or Apple Calendar on a device that reads it.
   * `null` while unknown. Unknown shows Calendar, so a slow or failed status
   * call never hides it from a member who has a calendar.
   */
  calendarSources: boolean | null;
  /** Whether this workspace has the Docs service. */
  docs: boolean;
}

export function isSurfaceVisible(id: MemberSurfaceId, input: SurfaceVisibilityInput): boolean {
  switch (id) {
    case 'calendar': return input.calendarSources !== false;
    case 'docs': return input.docs;
    case 'home':
    case 'work':
    case 'team':
      return true;
  }
}

export function visibleSurfaces(input: SurfaceVisibilityInput): MemberSurfaceId[] {
  return MEMBER_SURFACES.filter(({ id }) => isSurfaceVisible(id, input)).map(({ id }) => id);
}
