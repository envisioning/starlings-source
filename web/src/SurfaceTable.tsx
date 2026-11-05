import type { ReactNode } from 'react';
import { Badge } from '@/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import {
  CAPABILITY_SURFACES,
  SURFACE_LABEL,
  SURFACE_STATUS_LABEL,
  type Capability,
  type SurfaceStatus,
} from '@starlings/contracts/capabilities';
import { StatusIcon } from './action-icons';
import { cn } from '@/lib/utils';
import { t } from './i18n';

/**
 * Four neutral fills, graduated by how done the surface is. The icon names
 * the state; the ink ramp adds the at-a-glance weight a hue used to (the
 * accent budget in docs/DESIGN.md).
 */
const TONE: Record<SurfaceStatus, string> = {
  works: 'bg-foreground/85 text-background',
  partial: 'bg-foreground/30 text-foreground',
  handoff: 'bg-foreground/18 text-foreground',
  'not-available': 'bg-foreground/12 text-foreground/70',
};

/** The status as a round mark with its icon. The label is for the reader beside it, or hidden. */
export function SurfaceStatusMark({ status, label = 'hidden' }: { status: SurfaceStatus; label?: 'shown' | 'hidden' }) {
  return (
    <span className="inline-flex items-center justify-center gap-[5px] whitespace-nowrap">
      <Badge aria-hidden="true" className={cn('size-5 rounded-full border-0 p-0 text-[13px] [&>svg]:size-4', TONE[status])}>
        <StatusIcon status={status} />
      </Badge>
      <span className={label === 'hidden' ? 'sr-only' : undefined}>{SURFACE_STATUS_LABEL[status]}</span>
    </span>
  );
}

/** The status written out, on the same fill as its mark. */
function SurfaceStatusBadge({ status }: { status: SurfaceStatus }) {
  return <Badge className={TONE[status]}>{SURFACE_STATUS_LABEL[status]}</Badge>;
}

/**
 * Which surface each capability works on: one row per capability, one column
 * per surface, and a last column the page chooses (Feature status writes the
 * notes, Help the agent's doors).
 */
export function SurfaceTable({ rows, last, marks = 'icon', name = (row) => row.name }: {
  rows: Capability[];
  /** A round icon per cell (a legend sits above), or the status written out. */
  marks?: 'icon' | 'label';
  last: { title: string; cell: (row: Capability) => ReactNode };
  name?: (row: Capability) => ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-[10px] border border-border">
      <Table className="min-w-[820px] text-xs">
        <TableHeader className="bg-foreground/4">
          <TableRow>
            <TableHead scope="col" className="text-foreground/60">{t('Capability')}</TableHead>
            {CAPABILITY_SURFACES.map((surface) => (
              <TableHead key={surface} scope="col" className="w-[82px] text-center text-foreground/60">{SURFACE_LABEL[surface]}</TableHead>
            ))}
            <TableHead scope="col" className="text-foreground/60">{last.title}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableHead scope="row" className="h-auto min-w-[210px] px-2 py-2.5 font-semibold whitespace-normal text-foreground/90">
                {name(row)}
              </TableHead>
              {CAPABILITY_SURFACES.map((surface) => (
                <TableCell key={surface} className="w-[82px] py-2.5 text-center">
                  {marks === 'icon'
                    ? <SurfaceStatusMark status={row.surfaces?.[surface] ?? 'not-available'} />
                    : <SurfaceStatusBadge status={row.surfaces?.[surface] ?? 'not-available'} />}
                </TableCell>
              ))}
              <TableCell className="min-w-[250px] py-2.5 leading-[1.45] whitespace-normal text-foreground/65">{last.cell(row)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
