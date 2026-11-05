/**
 * A room on this workspace. The Worker names it `starlings`; `envisioning`
 * is the old name, still in an answer cached before. Its own
 * module, with no imports, so the marketing bundle can use it.
 */
export function isStarlingsRoom(platform: string): boolean {
  return platform === 'envisioning' || platform === 'starlings';
}
