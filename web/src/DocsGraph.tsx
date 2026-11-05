import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/ui/button';
import type { DocsDocumentSummary } from './docs';
import { fetchDocsGraph, type DocsGraphEdge, type DocsGraphProgress } from './docs';
import { ErrorNotice } from './ErrorNotice';
import { plural, t } from './i18n';
import { LoadingIndicator } from '@/ui/spinner';
import graphConfig from '../../packages/contracts/src/docs-graph-config.json';
import { compareGraphStrings, graphFolder } from './docs-graph-layout';
import type { DocsGraphCanvasControls, DocsGraphCanvasDocument } from './DocsGraphCanvas';

const DocsGraphCanvas = lazy(() => import('./DocsGraphCanvas'));

/** Links stream in far faster than anyone can watch them land. */
const EDGE_PUBLISH_MS = 250;

interface GraphGroup {
  name: string;
  color: string;
  count: number;
}

const GROUP_COLORS = graphConfig.folderColors;

const EMPTY_DOCUMENTS: DocsDocumentSummary[] = [];
const EMPTY_EDGES: DocsGraphEdge[] = [];

export function DocsGraph({ selectedID, onOpen }: {
  selectedID: string | null;
  onOpen: (id: string) => void;
}) {
  const [data, setData] = useState<{ documents: DocsDocumentSummary[]; edges: DocsGraphEdge[] } | null>(null);
  const [progress, setProgress] = useState<DocsGraphProgress>({ phase: 'documents', loaded: 0, total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(() => new Set());
  const [currentZoom, setCurrentZoom] = useState(1);
  const [canvasReady, setCanvasReady] = useState(false);
  const canvasControlsRef = useRef<DocsGraphCanvasControls | null>(null);

  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    let pendingEdges: DocsGraphEdge[] | null = null;
    let edgeTimer: ReturnType<typeof setTimeout> | null = null;
    const flushEdges = () => {
      edgeTimer = null;
      const edges = pendingEdges;
      pendingEdges = null;
      if (current && edges) setData((previous) => previous ? { ...previous, edges } : previous);
    };
    setError('');
    setLoading(true);
    setProgress({ phase: 'documents', loaded: 0, total: 0 });
    void fetchDocsGraph({
      onDocuments: (documents) => {
        if (!current) return;
        setData((previous) => {
          const ids = new Set(documents.map((document) => document.id));
          return { documents, edges: (previous?.edges ?? []).filter((edge) => ids.has(edge.source) && ids.has(edge.target)) };
        });
      },
      onEdges: (edges) => {
        pendingEdges = edges;
        edgeTimer ??= setTimeout(flushEdges, EDGE_PUBLISH_MS);
      },
      onProgress: (nextProgress) => {
        if (current) setProgress(nextProgress);
      },
    }, controller.signal).then((graph) => {
      if (edgeTimer) clearTimeout(edgeTimer);
      pendingEdges = null;
      if (current) setData(graph);
    }).catch((cause: unknown) => {
      if (current) setError(cause instanceof Error ? cause.message : t('Couldn’t load the Docs graph.'));
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => {
      current = false;
      if (edgeTimer) clearTimeout(edgeTimer);
      controller.abort();
    };
  }, [attempt]);

  const graphDocuments = data?.documents ?? EMPTY_DOCUMENTS;
  const graphEdges = data?.edges ?? EMPTY_EDGES;
  const groups = useMemo<GraphGroup[]>(() => {
    const counts = new Map<string, number>();
    for (const document of graphDocuments) {
      const name = graphFolder(document.path);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts]
      .sort(([left], [right]) => compareGraphStrings(left, right))
      .map(([name, count], index) => ({ name, count, color: GROUP_COLORS[index % GROUP_COLORS.length]! }));
  }, [graphDocuments]);

  const groupColors = useMemo(() => new Map(groups.map((group) => [group.name, group.color])), [groups]);
  const degree = useMemo(() => {
    const counts = new Map<string, number>();
    for (const edge of graphEdges) {
      counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
      counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
    }
    return counts;
  }, [graphEdges]);

  const documents = useMemo<DocsGraphCanvasDocument[]>(() => graphDocuments.map((document) => {
    const group = graphFolder(document.path);
    return { ...document, group, color: groupColors.get(group) ?? GROUP_COLORS[0]!, degree: degree.get(document.id) ?? 0 };
  }), [graphDocuments, degree, groupColors]);
  const allHidden = groups.length > 0 && groups.every((group) => hiddenGroups.has(group.name));

  const registerCanvasControls = useCallback((controls: DocsGraphCanvasControls | null) => {
    canvasControlsRef.current = controls;
    setCanvasReady(controls !== null);
  }, []);

  const updateCurrentZoom = useCallback((zoom: number) => setCurrentZoom(zoom), []);

  function setGroupVisible(group: string, visible: boolean) {
    setHiddenGroups((current) => {
      const next = new Set(current);
      if (visible) next.delete(group); else next.add(group);
      return next;
    });
  }

  return (
    <section className="docs-graph" aria-labelledby="docs-graph-title" aria-busy={loading}>
      <header className="docs-graph-head">
        <div>
          <h2 id="docs-graph-title">{t('Graph')}</h2>
          <p>{t('Each dot is a document; lines are wikilinks. Colors group documents by folder.')}</p>
        </div>
        <div className="docs-graph-tools" aria-label={t('Graph controls')}>
          <Button type="button" variant="outline" size="icon-sm" aria-label={t('Zoom out')} title={t('Zoom out')} onClick={() => canvasControlsRef.current?.zoomOut()} disabled={!canvasReady || currentZoom <= graphConfig.zoom.min + 1e-6}>−</Button>
          <Button type="button" variant="outline" size="icon-sm" aria-label={t('Zoom in')} title={t('Zoom in')} onClick={() => canvasControlsRef.current?.zoomIn()} disabled={!canvasReady || currentZoom >= graphConfig.zoom.max - 1e-6}>+</Button>
          <Button type="button" variant="outline" size="sm" onClick={() => canvasControlsRef.current?.fitVisible()} disabled={!canvasReady}>{t('Fit')}</Button>
        </div>
      </header>

      {groups.length > 0 && (
        <div className="docs-graph-groups" aria-label={t('Folder groups')}>
          <span className="docs-graph-groups-label">{t('Folders')}</span>
          {groups.map((group) => {
            const visible = !hiddenGroups.has(group.name);
            return (
              <Button
                key={group.name}
                type="button"
                variant="ghost"
                size="xs"
                className={`docs-graph-group${visible ? '' : ' docs-graph-group--hidden'}`}
                aria-pressed={visible}
                aria-label={t('{group} · {documents}', {
                  group: group.name,
                  documents: plural(group.count, { one: t('{count} document'), other: t('{count} documents') }),
                })}
                onClick={() => setGroupVisible(group.name, !visible)}
              >
                <span aria-hidden="true" className="docs-graph-dot" style={{ backgroundColor: group.color }} />
                {group.name}
                <small>{plural(group.count, { one: t('{count} document'), other: t('{count} documents') })}</small>
              </Button>
            );
          })}
          {hiddenGroups.size > 0 && (
            <Button type="button" variant="link" size="xs" onClick={() => setHiddenGroups(new Set())}>{t('Show all groups')}</Button>
          )}
        </div>
      )}

      {error && <ErrorNotice message={error} action={<Button type="button" variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>{t('Retry')}</Button>} />}
      {!error && !data && loading && (
        <LoadingIndicator
          placement="section"
          label={progress.phase === 'documents' ? t('Loading documents…') : t('Loading document links…')}
          labelVisibility="visible"
          className="docs-graph-loading"
        />
      )}
      {data && data.documents.length === 0 && !loading && <p className="docs-muted">{t('There are no documents to show yet.')}</p>}
      {data && data.documents.length > 0 && (
        <>
          <Suspense fallback={null}>
            <DocsGraphCanvas
              documents={documents}
              edges={graphEdges}
              hiddenGroups={hiddenGroups}
              selectedID={selectedID}
              onOpen={onOpen}
              loading={loading}
              progress={progress}
              onControlsReady={registerCanvasControls}
              onZoomLevelChange={updateCurrentZoom}
            />
          </Suspense>
          {allHidden && <p className="docs-muted">{t('All folder groups are hidden.')}</p>}
        </>
      )}
    </section>
  );
}
