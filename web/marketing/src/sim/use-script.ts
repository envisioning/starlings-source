import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/*
 * The tour a simulation plays by itself, and the hand-off to the visitor.
 *
 * A script is a list of beats. Each beat waits `hold` ms, then applies its
 * change to the scene's state. While a beat waits, the drawn pointer moves to
 * the element the beat will act on (`target`, a selector inside the stage),
 * so the visitor sees where the click lands before it lands.
 *
 * The visitor steers with Pause, Play, Play from the start and the step
 * tabs; the drawn window is inert (SimWindow.tsx). The tour waits while the
 * stage is off-screen, and never starts on its own when the reader asks for
 * reduced motion: it plays only after the visitor presses Play.
 *
 * `running` is the tour as the visitor sees it: playing, and either motion
 * is welcome or the visitor started it. `resumable` says Play carries on
 * from where Pause stopped; once the visitor acts in the scene, or the tour
 * has no beat left, only Play from the start makes sense. `steered` turns
 * true at the visitor's first press, so a caption is announced only then.
 *
 * The first render is the initial state, with no timers and no pointer, so
 * the prerendered page and the first client render agree.
 */

export type Beat<S> = {
  hold: number;
  /** A selector inside the stage: where the pointer goes before the beat applies. */
  target?: string;
  apply: (state: S) => S;
};

type Run<S> = { state: S; next: number };

/** The pause after the last beat before the tour starts again. */
const LOOP_REST_MS = 5000;

export function useScript<S>({ initial, beats, stage, stepOf, onLoop }: {
  initial: S;
  /** Called instead of starting over when the tour ends, so a scene can draw its next run. */
  onLoop?: () => void;
  beats: readonly Beat<S>[];
  stage: RefObject<HTMLElement | null>;
  stepOf: (state: S) => number;
}) {
  const [run, setRun] = useState<Run<S>>({ state: initial, next: 0 });
  const [playing, setPlaying] = useState(true);
  const [visible, setVisible] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [pointer, setPointer] = useState<{ x: number; y: number; pressed: boolean } | null>(null);
  /** The visitor pressed Play or Play from the start: the tour plays even with reduced motion. */
  const [userStarted, setUserStarted] = useState(false);
  /** Pause stopped the tour mid-run, and Play can carry on from there. */
  const [resumable, setResumable] = useState(false);
  /** The visitor has pressed a control. */
  const [steered, setSteered] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => {
      setReduced(query.matches);
      if (query.matches) setPlaying(false);
    };
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)), { threshold: 0.35 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [stage]);

  const running = playing && (!reduced || userStarted);
  const active = running && visible;
  const beat = beats[run.next];

  // The pointer goes to the next beat's target while the beat waits.
  useLayoutEffect(() => {
    if (!active) return;
    const node = stage.current;
    const target = beat?.target ? node?.querySelector<HTMLElement>(beat.target) : null;
    if (!node || !target) return;
    const box = node.getBoundingClientRect();
    const spot = target.getBoundingClientRect();
    setPointer({ x: spot.left - box.left + Math.min(spot.width / 2, 48), y: spot.top - box.top + spot.height / 2, pressed: false });
  }, [active, beat, run.state, stage]);

  useEffect(() => {
    if (!active) return;
    if (!beat) {
      const rest = window.setTimeout(() => {
        if (onLoop) return onLoop();
        setRun({ state: initial, next: 0 });
        setPointer(null);
      }, LOOP_REST_MS);
      return () => window.clearTimeout(rest);
    }
    const timer = window.setTimeout(() => {
      if (beat.target) setPointer((current) => current && { ...current, pressed: true });
      setRun((current) => ({ state: beat.apply(current.state), next: current.next + 1 }));
    }, beat.hold);
    return () => window.clearTimeout(timer);
  }, [active, beat, initial, onLoop]);

  /** The visitor's own action: the tour stops and the scene is theirs. */
  const act = useCallback((change: (state: S) => S) => {
    setPlaying(false);
    setResumable(false);
    setSteered(true);
    setPointer(null);
    setRun((current) => ({ ...current, state: change(current.state) }));
  }, []);

  /**
   * Jump to a step. While the tour plays it carries on from the step's
   * start; while it is stopped the step opens at its end, every beat in it
   * applied, so a visitor who drives sees the whole step.
   */
  const goTo = useCallback((step: number) => {
    let state = initial;
    let next = 0;
    if (running) {
      while (next < beats.length && stepOf(state) < step) state = beats[next++]!.apply(state);
    } else {
      while (next < beats.length && stepOf(beats[next]!.apply(state)) <= step) state = beats[next++]!.apply(state);
    }
    setPointer(null);
    setSteered(true);
    // A stopped tour opened at a step's end can carry on from there.
    if (!running) setResumable(true);
    setRun({ state, next });
  }, [beats, initial, running, stepOf]);

  const restart = useCallback(() => {
    setPointer(null);
    setRun({ state: initial, next: 0 });
    setPlaying(true);
    setUserStarted(true);
    setSteered(true);
  }, [initial]);

  const pause = useCallback(() => {
    setPlaying(false);
    setResumable(true);
    setSteered(true);
    setPointer(null);
  }, []);

  const play = useCallback(() => {
    setPlaying(true);
    setUserStarted(true);
    setSteered(true);
  }, []);

  return {
    state: run.state,
    step: stepOf(run.state),
    playing,
    reduced,
    running,
    resumable: resumable && !running && beat !== undefined,
    steered,
    pointer: active ? pointer : null,
    act,
    goTo,
    restart,
    pause,
    play,
  };
}

/** One beat per character, typing `text` into the state through `write`. */
export function typing<S>(text: string, write: (state: S, typed: string) => S, target?: string): Beat<S>[] {
  return [...text].map((_, index) => ({
    hold: index === 0 ? 700 : 55,
    target: index === 0 ? target : undefined,
    apply: (state: S) => write(state, text.slice(0, index + 1)),
  }));
}
