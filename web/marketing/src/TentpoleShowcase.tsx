import { useMemo, useRef, type CSSProperties } from 'react';
import { Button } from '@/ui/button';
import { t } from '@shared/i18n';
import { themeHref, THEMES, TENTPOLES, TENTPOLES_TITLE, type Tentpole } from './features';
import { LinkPill } from './feature-tiles';
import { SimStage } from './sim/SimStage';
import { useScript, type Beat } from './sim/use-script';
import { AgentsScene, AttentionScene, MemoryScene, RecordScene, SCENE_SCRIPTS } from './sim/TentpoleScenes';

type State = { phase: number };
const INITIAL: State = { phase: 0 };

/**
 * Each signature capability's tone (house.css, `--tent-*`): the chapter's
 * mark, and the focal parts of its scene. An exception to the accent
 * budget, decided by MZ on 2026-10-09 (docs/DESIGN.md, Public site).
 */
const toneOf = (entry: Tentpole) => ({ '--tone': `var(--tent-${entry.id})` }) as CSSProperties;

/** Four signature chapters for /workspace, each a different surface of the app playing out its own workflow. */
export function TentpoleShowcase() {
  return <section aria-labelledby="tentpoles-title" className="my-10">
    <h2 id="tentpoles-title">{TENTPOLES_TITLE}</h2>
    <nav aria-label={t('Signature capabilities')} className="mb-10 flex flex-wrap gap-2">
      {TENTPOLES.map((entry) => <Button key={entry.id} asChild variant="outline" size="sm" style={toneOf(entry)}>
        <a href={`#tentpole-${entry.id}`}><span aria-hidden="true" className="size-2 rounded-full bg-(--tone)" />{entry.title}</a>
      </Button>)}
    </nav>
    <div className="grid gap-12">
      {TENTPOLES.map((entry, index) => <article key={entry.id} id={`tentpole-${entry.id}`} style={toneOf(entry)} className="col-span-full grid min-w-0 scroll-mt-24 grid-cols-[0.75fr_1.25fr] items-center gap-10 border-t border-border pt-8 max-[900px]:grid-cols-1 max-[900px]:gap-5">
          <div>
            <p className="m-0 mb-3 flex items-center gap-2 text-sm text-muted-foreground tabular-nums"><span aria-hidden="true" className="size-2.5 rounded-full bg-(--tone)" />{String(index + 1).padStart(2, '0')}</p>
            <h3 className="m-0 mb-4 text-4xl max-[520px]:text-3xl">{entry.title}</h3>
            <p className="m-0 mb-3 text-muted-foreground">{entry.headline}</p>
            <p className="m-0 mb-5 text-muted-foreground">{entry.summary}</p>
            <CapabilityLink entry={entry} />
          </div>
          <div className="min-w-0">
            <TentpoleMini entry={entry} />
            <p className="mt-2 text-xs text-muted-foreground">{entry.scope}</p>
          </div>
        </article>)}
    </div>
  </section>;
}

function CapabilityLink({ entry }: { entry: Tentpole }) {
  return <LinkPill href={`${themeHref(THEMES.find((theme) => theme.features.includes(entry.feature))!).split('#')[0]}#feature-${entry.feature}`}>
    {t('Explore {title}', { title: entry.title })}
  </LinkPill>;
}

const WINDOW_LABEL: Record<Tentpole['id'], () => string> = {
  attention: () => t('Inbox'),
  memory: () => t('Docs'),
  record: () => t('Work'),
  agents: () => t('Work'),
};

/**
 * One chapter's tour. A script is a list of phases, each in one of the
 * three steps (SCENE_SCRIPTS); the tour plays them in turn, and a step tab
 * opens its step at its last phase. Attention's tour stops at Opened:
 * reading never answers, so only the visitor's tab reaches Answered.
 */
export function TentpoleMini({ entry }: { entry: Tentpole }) {
  const stage = useRef<HTMLDivElement>(null);
  const script = SCENE_SCRIPTS[entry.id];
  const beats = useMemo<Beat<State>[]>(() => script.phases.slice(1, script.autoplay + 1)
    .map((phase, index) => ({ hold: phase.hold, target: phase.target, apply: () => ({ phase: index + 1 }) })), [script]);
  const stepOf = useMemo(() => (state: State) => script.phases[state.phase]!.step, [script]);
  const sim = useScript({ initial: INITIAL, beats, stage, stepOf });
  const lastPhaseOf = (step: number) => script.phases.reduce((last, phase, index) => (phase.step === step ? index : last), 0);
  const phase = sim.state.phase;
  return <SimStage
    stage={stage}
    sim={sim}
    ariaLabel={t('{title} example', { title: entry.title })}
    steps={{ labels: entry.steps, current: sim.step, onSelect: (step) => sim.act(() => ({ phase: lastPhaseOf(step) })) }}
    windowLabel={WINDOW_LABEL[entry.id]()}
    windowClassName="h-[460px]"
    caption={entry.captions[sim.step]}
    captions={entry.captions}
  >
    {entry.id === 'attention' ? <AttentionScene phase={phase} />
      : entry.id === 'memory' ? <MemoryScene phase={phase} />
        : entry.id === 'record' ? <RecordScene phase={phase} />
          : <AgentsScene phase={phase} />}
  </SimStage>;
}
