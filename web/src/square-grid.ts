/*
 * The square-cell grid: how many columns, and how big each square cell is,
 * for N tiles in a box. No LiveKit here, so the product site's drawn call
 * (MeetingSim) sizes its tiles with the same arithmetic as the stage.
 */

export interface SquareGridPlan {
  columns: number;
  rows: number;
  cell: number;
}

/** The browser spelling of the shared native square-cell grid arithmetic. */
export function squareGridPlan(
  tileCount: number,
  width: number,
  height: number,
  gap: number,
): SquareGridPlan {
  const count = Math.max(tileCount, 1);
  let best: SquareGridPlan | undefined;

  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns);
    const slotWidth = (width - (columns - 1) * gap) / columns;
    const slotHeight = (height - (rows - 1) * gap) / rows;
    const cell = Math.min(slotWidth, slotHeight);
    if (cell <= 0 || (best && cell <= best.cell)) continue;
    best = { columns, rows, cell };
  }

  if (best) return best;
  const cell = Math.max(1, Math.min(width / count, height));
  return { columns: count, rows: 1, cell };
}
