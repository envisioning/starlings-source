import type { ReactNode, RefObject } from 'react';
import { t } from '@shared/i18n';
import { Button } from '@/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs';
import { cn } from '@/lib/utils';
import { WIDGET } from '../bento';
import type { SampleMeeting } from './sample-meeting';
import { SimWindow } from './SimWindow';

/**
 * Everything a simulation draws around its scene: the bar above the window
 * (SimBar: the scene's steps, then Pause, Play or Play from the start), the
 * window, the tour's pointer, and the caption under it. The window is
 * inert (SimWindow.tsx): the visitor steers the tour with the bar above it,
 * never by clicking the drawn interface.
 */
export function SimStage({ stage, sim, ariaLabel, steps, windowLabel, workspace, windowClassName, contentKey, caption, captions, className, children }: {
  stage: RefObject<HTMLDivElement | null>;
  sim: SimControls & { pointer: { x: number; y: number; pressed: boolean } | null };
  ariaLabel: string;
  steps?: SimSteps;
  windowLabel: string;
  /** The window's workspace, when the scene draws its own sample meeting. */
  workspace?: SampleMeeting['workspace'];
  windowClassName?: string;
  /** A new key fades the content in, as a step or a view changes. */
  contentKey?: string | number;
  caption: ReactNode;
  /** Every caption the scene can show. The caption keeps the height of the longest, so nothing under it moves. */
  captions?: readonly ReactNode[];
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn('min-w-0', className)} aria-label={ariaLabel}>
      <SimBar sim={sim} steps={steps} />

      {/* The showcase: the window sits on the day's wallpaper (house.css). */}
      <div ref={stage} className={cn('relative', WALLPAPER_STAGE)}>
        {/* On a phone the window fits the screen; what does not fit scrolls inside it, so nothing clips and the page does not grow (MZ, 2026-10-04). */}
        <SimWindow label={windowLabel} workspace={workspace} ariaLabel="Simulated Starlings window" className={cn('h-[480px] max-[641px]:h-[min(640px,calc(100svh-150px))]', windowClassName)}>
          <div key={contentKey} className="flex min-h-0 flex-1 flex-col overflow-y-auto motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300">
            {children}
          </div>
        </SimWindow>
        {sim.pointer && <Pointer x={sim.pointer.x} y={sim.pointer.y} pressed={sim.pointer.pressed} />}
      </div>

      <SimCaption caption={caption} captions={captions} steered={sim.steered} />
    </section>
  );
}

/**
 * The caption under a scene. Every caption the scene can show sits in the
 * same grid cell, hidden, so the cell is as tall as the longest at every
 * width: a step change never moves the page below it. Silent while the tour
 * plays by itself; announced once the visitor steers it.
 */
export function SimCaption({ caption, captions = [], steered, className }: { caption: ReactNode; captions?: readonly ReactNode[]; steered: boolean; className?: string }) {
  return (
    <div className={cn('mt-3 grid text-[14px] leading-normal text-muted-foreground', className)}>
      {captions.map((entry, index) => <p key={index} aria-hidden="true" className="invisible col-start-1 row-start-1 m-0">{entry}</p>)}
      <p className="col-start-1 row-start-1 m-0" aria-live={steered ? 'polite' : 'off'}>{caption}</p>
      <span className="block text-[12px]">{t('This is a simulation with sample data.')}</span>
    </div>
  );
}

/** A label as wide as the widest of its options, so a button that changes its words keeps its size. */
function SteadyLabel({ label, options }: { label: string; options: readonly string[] }) {
  return (
    <span className="grid">
      {options.map((option) => <span key={option} aria-hidden="true" className="invisible col-start-1 row-start-1">{option}</span>)}
      <span className="col-start-1 row-start-1">{label}</span>
    </span>
  );
}

/** What the bar reads from a running script (useScript). */
type SimControls = {
  running: boolean;
  resumable: boolean;
  steered: boolean;
  pause: () => void;
  play: () => void;
  restart: () => void;
};

/** A scene's steps: their labels, the current one, and what a press does (the scene decides: jump the tour, or take it over). */
export type SimSteps = { labels: readonly string[]; current: number; onSelect: (step: number) => void; ariaLabel?: string };

/**
 * The one bar every simulation draws: numbered step tabs, then Pause, Play
 * or Play from the start. SimStage draws it above its window; a scene with a
 * window of its own (TentpoleMini) draws it directly, so every tour on the
 * site is steered the same way.
 */
export function SimBar({ sim, steps }: { sim: SimControls; steps?: SimSteps }) {
  return (
    <div className={cn('mb-3.5 flex items-center gap-3 max-[640px]:flex-wrap', steps ? 'justify-between' : 'justify-end')}>
      {steps && (
        <Tabs value={String(steps.current)} onValueChange={(value) => steps.onSelect(Number(value))} className="min-w-0">
          <TabsList aria-label={steps.ariaLabel ?? t('Example steps')} className="max-w-full max-[640px]:h-auto max-[640px]:flex-wrap">
            {steps.labels.map((label, index) => (
              <TabsTrigger key={label} value={String(index)} aria-label={label} className="px-3 max-[640px]:min-h-10">
                <span className="text-muted-foreground tabular-nums" aria-hidden="true">{index + 1}</span>{label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}
      {/* One button, as wide as its longest label: Pause, Play and Play from the start never reflow the bar. */}
      <div className="flex flex-none gap-1.5">
        <Button type="button" variant="outline" size="sm" className={PHONE_CONTROL} onClick={sim.running ? sim.pause : sim.resumable ? sim.play : sim.restart}>
          <SteadyLabel label={sim.running ? t('Pause') : sim.resumable ? t('Play') : t('Play from the start')} options={[t('Pause'), t('Play'), t('Play from the start')]} />
        </Button>
      </div>
    </div>
  );
}

/** The showcase every drawn window sits on: the day's wallpaper (house.css). */
export const WALLPAPER_STAGE = `rounded-(--radius) bg-(image:--wallpaper) bg-cover bg-center p-[clamp(14px,4vw,44px)] max-[520px]:p-3 ${WIDGET}`;

/** A control in the bar: 40px tall where a finger presses it. */
export const PHONE_CONTROL = 'max-[640px]:h-10';

/** The tour's pointer: the iPad's round one. It glides to where the next tap lands, then shrinks as it presses. */
function Pointer({ x, y, pressed }: { x: number; y: number; pressed: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute top-0 left-0 z-10 size-[22px] rounded-full border border-[rgb(255_255_255/0.55)] bg-[rgb(120_120_128/0.42)] shadow-[0_2px_8px_rgb(0_0_0/0.28)] backdrop-blur-[2px] transition-transform duration-[650ms] ease-[cubic-bezier(.3,.7,.2,1)]"
      style={{ transform: `translate(${x - 11}px, ${y - 11}px) scale(${pressed ? 0.72 : 1})` }}
    />
  );
}
