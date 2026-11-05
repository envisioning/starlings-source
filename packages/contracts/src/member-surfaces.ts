/**
 * The member destinations, in the order every client lists them: the Mac's
 * surface switcher, the phone's tab bar, the web's workspace nav and the
 * search palette's Go to doors. Each says what it is called, where the web
 * keeps it, and the `docs/help/surfaces/<id>.md` page it is described on.
 * The generator writes the Swift `MemberSurface`
 * (`Sources/Generated/MemberSurfacesRegistry.swift`).
 */
export const MEMBER_SURFACES = [
  { id: 'home', title: 'Home', path: '/' },
  { id: 'calendar', title: 'Calendar', path: '/calendar' },
  { id: 'work', title: 'Work', path: '/work' },
  { id: 'team', title: 'Team', path: '/team' },
  { id: 'docs', title: 'Docs', path: '/docs' },
] as const;

export type MemberSurfaceId = (typeof MEMBER_SURFACES)[number]['id'];
