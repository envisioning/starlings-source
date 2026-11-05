import { useEffect, useRef, useState } from 'react';
import { isTrackReference, type TrackReferenceOrPlaceholder } from '@livekit/components-react';
import { MeetParticipantTile } from './MeetParticipantTile';
import { squareGridPlan } from './stage-layout';
import { t } from './i18n';

const GRID_GAP = 12;

export function SquareGridLayout({ tracks }: { tracks: TrackReferenceOrPlaceholder[] }) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const plan = squareGridPlan(tracks.length, size.width, size.height, GRID_GAP);

  useEffect(() => {
    const element = gridRef.current;
    if (!element) return undefined;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={gridRef}
      // Equal camera and avatar cells, the same square-cell rule as native.
      className="grid size-full min-h-0 min-w-0 content-center justify-center overflow-hidden"
      style={{
        gridTemplateColumns: t('repeat({columns}, {cell}px)', { columns: plan.columns, cell: plan.cell }),
        gridAutoRows: `${plan.cell}px`,
        gap: `${GRID_GAP}px`,
      }}
    >
      {tracks.map((track) => (
        <MeetParticipantTile key={trackKey(track)} trackRef={track} className="aspect-square size-full min-h-0 min-w-0" />
      ))}
    </div>
  );
}

function trackKey(track: TrackReferenceOrPlaceholder): string {
  const sid = isTrackReference(track) ? track.publication?.trackSid ?? 'placeholder' : 'placeholder';
  return `${track.participant.identity}:${track.source}:${sid}`;
}
