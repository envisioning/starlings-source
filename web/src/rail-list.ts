/**
 * A list of `RailRow`s (SurfaceShell.tsx). In a column it is one bordered
 * card; in the shell's rail and in an inspector's context group it sits
 * flat on the panel. Its own file, with no Radix, so a page outside the
 * shell can draw the same list without loading the shell.
 */
export const railListClass = [
  'm-0 list-none overflow-hidden rounded-[12px] border bg-card p-0',
  'in-[.surface-rail]:overflow-visible in-[.surface-rail]:rounded-none in-[.surface-rail]:border-0 in-[.surface-rail]:bg-transparent',
  'in-[.work-context-group-body]:mt-1 in-[.work-context-group-body]:rounded-none in-[.work-context-group-body]:border-0 in-[.work-context-group-body]:bg-transparent',
].join(' ');
