import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { homeColumnsLopsided, packHomeColumns, type HomeModuleID } from '@starlings/contracts/home-layout-values';
import { useMediaQuery } from './use-media-query';

/** `OwnerLaunchView.minColumnWidth * 2 + columnGap + 2 * sideMargin`: two columns fit. */
const TWO_COLUMNS = '(min-width: 744px)';
/** Gap between two stacked cards, in px (`gap-3.5` on `HomeCard`'s margin). */
const CARD_GAP = 14;
/** Heights that stop changing for this long are settled; the packing then freezes. */
const SETTLE_MS = 700;
/** A slow card never keeps Home rearranging past this. */
const GIVE_UP_MS = 5_000;

/**
 * Home's module strip. With two columns, `packHomeColumns` (the packer the Mac
 * and the phone use, pinned by `fixtures/home-layout.json`) gives each module a
 * column from its measured height, so the columns end close together instead
 * of CSS columns splitting the sequence wherever the height halves. The person's
 * order is kept inside each column.
 *
 * Like the Mac, the result holds once Home has settled: a card that loads or
 * folds later leaves the others where they are, until the columns are
 * `homeColumnsLopsided`. Then it packs again. It also repacks when the
 * person's layout or the one/two-column mode changes. The first pass
 * alternates, then repacks as heights arrive until they hold still.
 *
 * Each module is one wrapper, measured whole; a module that draws nothing is a
 * zero-height wrapper and is packed as unmeasured.
 */
export function HomeColumns({ modules, nodes }: {
  modules: readonly HomeModuleID[];
  nodes: Record<HomeModuleID, ReactNode>;
}) {
  const wide = useMediaQuery(TWO_COLUMNS);
  const elements = useRef(new Map<HomeModuleID, HTMLElement>());
  const [heights, setHeights] = useState<Partial<Record<HomeModuleID, number>>>({});
  const [assignment, setAssignment] = useState<Partial<Record<HomeModuleID, boolean>>>({});
  const key = modules.join(',');

  const measure = useCallback(() => {
    setHeights((current) => {
      let next = current;
      for (const [id, element] of elements.current) {
        const height = Math.round(element.getBoundingClientRect().height);
        if (current[id] === height) continue;
        if (next === current) next = { ...current };
        next[id] = height;
      }
      return next;
    });
  }, []);

  useLayoutEffect(measure);

  useEffect(() => {
    const observer = new ResizeObserver(measure);
    for (const element of elements.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [measure, key, wide]);

  // Repack from the latest heights until they hold still, then freeze.
  const latest = useRef(heights);
  latest.current = heights;
  const [settled, setSettled] = useState(false);
  // Alternate until measured, and again whenever the layout or mode changes.
  useEffect(() => {
    setAssignment(alternating(modules));
    setSettled(false);
  }, [key, wide]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!wide || settled) return;
    const timer = window.setTimeout(() => {
      setAssignment(packHomeColumns(modules, latest.current, CARD_GAP));
      setSettled(true);
    }, SETTLE_MS);
    const giveUp = window.setTimeout(() => setSettled(true), GIVE_UP_MS);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(giveUp);
    };
  }, [wide, settled, heights, modules]); // eslint-disable-line react-hooks/exhaustive-deps

  // A settled placement holds until a late answer leaves it lopsided.
  useEffect(() => {
    if (!wide || !settled) return;
    if (!homeColumnsLopsided(modules, heights, assignment, CARD_GAP)) return;
    setAssignment(packHomeColumns(modules, heights, CARD_GAP));
  }, [wide, settled, heights, assignment, modules]);

  const slot = (id: HomeModuleID) => (
    <div
      key={id}
      data-home-module={id}
      ref={(element) => {
        if (element) elements.current.set(id, element);
        else elements.current.delete(id);
      }}
    >
      {nodes[id]}
    </div>
  );

  if (!wide) return <div className="min-w-0">{modules.map(slot)}</div>;
  return (
    <div className="grid min-w-0 grid-cols-2 items-start gap-x-4">
      <div className="min-w-0">{modules.filter((id) => !assignment[id]).map(slot)}</div>
      <div className="min-w-0">{modules.filter((id) => assignment[id]).map(slot)}</div>
    </div>
  );
}

function alternating(modules: readonly HomeModuleID[]): Partial<Record<HomeModuleID, boolean>> {
  const assignment: Partial<Record<HomeModuleID, boolean>> = {};
  modules.forEach((id, index) => { assignment[id] = index % 2 === 1; });
  return assignment;
}
