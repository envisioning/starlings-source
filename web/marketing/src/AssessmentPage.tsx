import { useEffect, useId, useRef, useState } from 'react';
import { Checkbox } from '@/ui/checkbox';
import { Alert, AlertDescription } from '@/ui/alert';
import { Button } from '@/ui/button';
import { Card } from '@/ui/card';
import { Field, FieldLabel } from '@/ui/field';
import { Input } from '@/ui/input';
import { RadioGroup, RadioGroupItem } from '@/ui/radio-group';
import { cn } from '@/lib/utils';
import { ChevronDown } from 'lucide-react';
import {
  INTEREST_AGENT_ACCESS,
  INTEREST_AGENT_REVIEWS,
  INTEREST_AGENT_RUNTIMES,
  INTEREST_AGENT_USE_CASES,
  INTEREST_AGENT_USES,
  INTEREST_ORG_KINDS,
  INTEREST_OUTSIDE_WORK,
  INTEREST_QUESTIONS,
  INTEREST_SIZES,
  INTEREST_TIMELINES,
  INTEREST_WORK_UNITS,
  INTEREST_READINESS_STORAGE_KEY,
  interestReadinessAnswersSchema,
  interestReadinessDraftSchema,
  scoreAgentReadiness,
  type AgentReadinessDimensionID,
  type InterestOption,
  type InterestReadinessAnswers,
} from '@starlings/contracts/interest';
import { Arrow, AppShell, Meter } from './SiteChrome';
import { Other } from './InterestPage';
import { HERO, PAGE, TILE } from './bento';
import { useDocumentTitle } from './document-title';
import { t } from '@shared/i18n';

const QUESTIONS: ReadinessQuestion[] = [
  { field: 'org_kind', label: INTEREST_QUESTIONS.org_kind.label, mode: 'single', options: INTEREST_ORG_KINDS },
  { field: 'team_size', label: INTEREST_QUESTIONS.team_size.label, mode: 'single', options: INTEREST_SIZES },
  { field: 'work_unit', label: INTEREST_QUESTIONS.work_unit.label, mode: 'single', options: INTEREST_WORK_UNITS },
  { field: 'outside_work', label: INTEREST_QUESTIONS.outside_work.label, mode: 'multi', options: INTEREST_OUTSIDE_WORK },
  { field: 'agent_use', label: INTEREST_QUESTIONS.agent_use.label, mode: 'single', options: INTEREST_AGENT_USES },
  { field: 'agent_use_cases', label: INTEREST_QUESTIONS.agent_use_cases.label, mode: 'multi', options: INTEREST_AGENT_USE_CASES },
  { field: 'agent_runtimes', label: INTEREST_QUESTIONS.agent_runtimes.label, mode: 'multi', options: INTEREST_AGENT_RUNTIMES },
  { field: 'agent_review', label: INTEREST_QUESTIONS.agent_review.label, mode: 'single', options: INTEREST_AGENT_REVIEWS },
  { field: 'agent_access', label: INTEREST_QUESTIONS.agent_access.label, mode: 'single', options: INTEREST_AGENT_ACCESS },
  { field: 'timeline', label: INTEREST_QUESTIONS.timeline.label, mode: 'single', options: INTEREST_TIMELINES },
];

/** How long a number-key pick stays on screen before the next question. */
const PICK_SHOWN_MS = 300;

const OTHER_FIELDS = ['org_kind', 'agent_use_cases', 'agent_runtimes'] as const;
type OtherField = (typeof OTHER_FIELDS)[number];
type OtherTexts = Partial<Record<OtherField, string>>;

function isOtherField(field: string): field is OtherField {
  return (OTHER_FIELDS as readonly string[]).includes(field);
}

/** The typed text of an "Other" pick, kept only while Other is still picked. */
function pickedOther(answers: Partial<InterestReadinessAnswers>, other: OtherTexts): OtherTexts {
  const kept: OtherTexts = {};
  for (const field of OTHER_FIELDS) {
    const value = answers[field];
    const picked = Array.isArray(value) ? value.includes('other') : value === 'other';
    const text = other[field];
    if (picked && text) kept[field] = text;
  }
  return kept;
}

type ReadinessQuestion = {
  field: keyof InterestReadinessAnswers;
  label: string;
  mode: 'single' | 'multi';
  options: readonly InterestOption[];
};

const BAND_LABEL: Record<ReturnType<typeof scoreAgentReadiness>['band'], string> = {
  exploring: 'Exploring',
  building: 'Building',
  'ready-to-pilot': 'Ready to pilot',
};

const DIMENSION_LABEL: Record<AgentReadinessDimensionID, string> = {
  'agent-practice': 'Agent practice',
  'human-review': 'Human review',
  'access-boundaries': 'Access boundaries',
  'pilot-horizon': 'Pilot horizon',
};

const NEXT_STEP: Record<AgentReadinessDimensionID, string> = {
  'agent-practice': 'Choose one repeatable team task and try an agent alongside the person who owns it.',
  'human-review': 'Name the person who reviews an agent’s result, and agree what must be checked before it is sent or acted on.',
  'access-boundaries': 'Decide which tools and data an agent needs for one task, and keep the rest out of reach.',
  'pilot-horizon': 'Pick one small workflow, a person responsible for it and a date to review the result.',
};

/** A ten-question, ungated self-assessment. Its answers are shared with /interest in this tab. */
export function AssessmentPage() {
  useDocumentTitle(t('Agentic readiness assessment'));
  const [started, setStarted] = useState(false);
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Partial<InterestReadinessAnswers>>({});
  const [other, setOther] = useState<OtherTexts>({});
  const [needsAnswer, setNeedsAnswer] = useState(false);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [restored, setRestored] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(INTEREST_READINESS_STORAGE_KEY);
      if (!raw) return;
      const saved = interestReadinessDraftSchema.safeParse(JSON.parse(raw));
      if (!saved.success) {
        window.sessionStorage.removeItem(INTEREST_READINESS_STORAGE_KEY);
        return;
      }
      const complete = interestReadinessAnswersSchema.safeParse(saved.data.answers);
      setAnswers(saved.data.answers);
      setOther(saved.data.other ?? {});
      setStarted(true);
      setStep(saved.data.step === 10 && complete.success ? 10 : Math.min(saved.data.step, 9));
      setRestored(true);
    } catch {
      setStorageAvailable(false);
    }
  }, []);

  useEffect(() => {
    if (started) heading.current?.focus();
  }, [started, step]);

  const question = QUESTIONS[step];
  const resultAnswers = interestReadinessAnswersSchema.safeParse(answers);
  const result = step === 10 && resultAnswers.success ? scoreAgentReadiness(resultAnswers.data) : null;
  const unanswered = question ? answers[question.field] : undefined;

  function saveDraft(nextAnswers: Partial<InterestReadinessAnswers>, nextStep: number, nextOther: OtherTexts = other) {
    const parsed = interestReadinessDraftSchema.safeParse({ version: 1, step: nextStep, answers: nextAnswers, other: pickedOther(nextAnswers, nextOther) });
    if (!parsed.success) return;
    try {
      window.sessionStorage.setItem(INTEREST_READINESS_STORAGE_KEY, JSON.stringify(parsed.data));
      setStorageAvailable(true);
    } catch {
      setStorageAvailable(false);
    }
  }

  function updateAnswer(field: keyof InterestReadinessAnswers, value: string | string[]) {
    const next = { ...answers, [field]: value } as Partial<InterestReadinessAnswers>;
    setAnswers(next);
    setNeedsAnswer(false);
    saveDraft(next, step);
  }

  function updateOther(field: OtherField, text: string) {
    const next = { ...other, [field]: text };
    setOther(next);
    saveDraft(answers, step, next);
  }

  function toggleAnswer(field: keyof InterestReadinessAnswers, option: InterestOption, selected: boolean) {
    const current = answers[field];
    const values = Array.isArray(current) ? current : [];
    const next = selected
      ? option.exclusive
        ? [option.id]
        : [...values.filter((id) => !question?.options.some((candidate) => candidate.id === id && candidate.exclusive)), option.id]
      : values.filter((id) => id !== option.id);
    updateAnswer(field, next);
  }

  function start() {
    setStarted(true);
    setStep(0);
    saveDraft(answers, 0);
  }

  function continueAssessment(current: Partial<InterestReadinessAnswers> = answers) {
    window.clearTimeout(advance.current);
    const value = question ? current[question.field] : undefined;
    if (!question || !(Array.isArray(value) ? value.length > 0 : Boolean(value))) {
      setNeedsAnswer(true);
      return;
    }
    const nextStep = step + 1;
    if (nextStep === 10) {
      const complete = interestReadinessAnswersSchema.safeParse(current);
      if (!complete.success) {
        setNeedsAnswer(true);
        return;
      }
      document.dispatchEvent(new Event('meet:assessment-completed'));
      setStep(10);
      saveDraft(complete.data, 10);
      return;
    }
    setStep(nextStep);
    saveDraft(current, nextStep);
  }

  function goBack() {
    window.clearTimeout(advance.current);
    if (step === 0) {
      setStarted(false);
      saveDraft(answers, 0);
      return;
    }
    const previous = Math.max(0, step - 1);
    setStep(previous);
    setNeedsAnswer(false);
    saveDraft(answers, previous);
  }

  /** Each earlier question with the answer given, in the person's words. */
  const earlier = QUESTIONS.slice(0, step).map((entry, index) => {
    const value = answers[entry.field];
    const ids = Array.isArray(value) ? value : value ? [value] : [];
    const text = ids.map((id) => {
      const option = entry.options.find((candidate) => candidate.id === id);
      const typed = id === 'other' && isOtherField(entry.field) ? other[entry.field] : '';
      return typed ? `${t(option?.label ?? id)}: ${typed}` : t(option?.label ?? id);
    });
    return { index, label: entry.label, text: text.join(', ') };
  });

  /** Keys 1-9 pick the numbered option, and on a single-choice question move on; Enter continues. Lists over nine options are searched, not numbered. */
  const advance = useRef(0);
  useEffect(() => () => window.clearTimeout(advance.current), []);
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => {});
  keyHandler.current = (event) => {
    if (!started || !question || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const typing = target?.tagName === 'TEXTAREA' || (target?.tagName === 'INPUT' && (target as HTMLInputElement).type === 'search');
    if (typing) return;
    if (event.key === 'Enter') {
      if ((target?.tagName === 'BUTTON' && target.getAttribute('role') !== 'radio' && target.getAttribute('role') !== 'checkbox') || target?.tagName === 'A') return;
      event.preventDefault();
      continueAssessment();
      return;
    }
    if (target?.tagName === 'INPUT' && (target as HTMLInputElement).type === 'text') return;
    const number = /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1;
    const option = question.options.length <= 9 ? question.options[number] : undefined;
    if (!option) return;
    event.preventDefault();
    if (question.mode === 'single') {
      // A number picks and moves on. "Other" stays, so its text can be typed.
      const next = { ...answers, [question.field]: option.id } as Partial<InterestReadinessAnswers>;
      setAnswers(next);
      setNeedsAnswer(false);
      if (option.other) saveDraft(next, step);
      else {
        // Hold a beat so the pick shows before the next question replaces it.
        if (advance.current) window.clearTimeout(advance.current);
        advance.current = window.setTimeout(() => { advance.current = 0; continueAssessment(next); }, PICK_SHOWN_MS);
      }
    }
    else toggleAnswer(question.field, option, !(Array.isArray(unanswered) && (unanswered as readonly string[]).includes(option.id)));
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandler.current(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  const weakest = result?.dimensions.reduce((lowest, dimension) => (
    dimension.score / dimension.max < lowest.score / lowest.max ? dimension : lowest
  ));

  return (
    <AppShell variant="wide">
      <div className={PAGE}>
        {!started && (
          <>
            <header className={cn(HERO, 'mb-8 max-w-[52rem]')}>
              <h1>{t('How ready is your organization to work with AI agents?')}</h1>
              <p className="lede">{t('Answer ten questions about your team, its work with agents and how that work is reviewed. See a score and a practical next step before deciding whether to request early access.')}</p>
            </header>
            <div className="grid max-w-[52rem] gap-3 sm:grid-cols-3">
              <Card className={cn(TILE, 'p-5')}>
                <h2 className="m-0! text-base!">{t('Ten questions')}</h2>
                <p>{t('No email address or contact details required.')}</p>
              </Card>
              <Card className={cn(TILE, 'p-5')}>
                <h2 className="m-0! text-base!">{t('See your result first')}</h2>
                <p>{t('Your score and suggested next step appear before the interest form.')}</p>
              </Card>
              <Card className={cn(TILE, 'p-5')}>
                <h2 className="m-0! text-base!">{t('Your answers stay in this tab')}</h2>
                <p>{t('We do not send your answers anywhere unless you submit the early-access form.')}</p>
              </Card>
            </div>
            <p className="mt-5 max-w-[52rem] text-sm leading-relaxed text-muted-foreground">
              {t('Use this as a starting point for deciding what to try next. We have not compared it with pilot outcomes. The score covers agent use, human review, access limits and pilot timing. Organization type, team size, work shape and outside collaboration help us understand your team; they do not affect the score.')}
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-4">
              <Button size="lg" data-event="Assessment started" onClick={start}>{t('Start the assessment')} <Arrow direction="next" /></Button>
              <a href="/workspace">{t('Explore Starlings first')}</a>
            </div>
          </>
        )}

        {started && question && (
          <section className="mx-auto max-w-[52rem]" aria-labelledby="assessment-question">
            <div className="mb-6 flex items-center justify-between gap-4">
              <span className="text-sm text-muted-foreground">{t('Question {current} of {total}', { current: step + 1, total: QUESTIONS.length })}</span>
              <a className="text-sm" href="/privacy">{t('Privacy')}</a>
            </div>
            <Meter className="mb-7" max={QUESTIONS.length} value={step + 1} label={t('Assessment progress')} />
            <Card className={cn(TILE, 'gap-6 p-6 max-[640px]:p-4')}>
              {earlier.length > 0 && (
                <dl className="m-0 grid gap-1 border-b border-border pb-5" aria-label={t('Your answers so far')}>
                  {earlier.map((entry) => (
                    <Button
                      key={entry.index}
                      type="button"
                      variant="ghost"
                      className="grid h-auto cursor-pointer justify-start gap-x-4 whitespace-normal px-2 py-1.5 text-left font-normal sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
                      onClick={() => { setStep(entry.index); setNeedsAnswer(false); saveDraft(answers, entry.index); }}
                    >
                      <dt className="text-sm text-muted-foreground">{t(entry.label)}</dt>
                      <dd className="m-0 text-sm">{entry.text}</dd>
                    </Button>
                  ))}
                </dl>
              )}
              <header>
                <h1 id="assessment-question" ref={heading} tabIndex={-1} className="m-0! text-[clamp(24px,3.2vw,34px)]! outline-none">{t(question.label)}</h1>
                {step < 4 && <p className="mt-3 mb-0 text-sm leading-relaxed text-muted-foreground">{t('These first four answers give us context about your organization and work. The score starts with how your team uses agents.')}</p>}
              </header>
              {question.mode === 'single' ? (
                <SingleChoices
                  label={t(question.label)}
                  options={question.options}
                  value={typeof unanswered === 'string' ? unanswered : ''}
                  onChange={(value) => updateAnswer(question.field, value)}
                  other={isOtherField(question.field) ? { value: other[question.field] ?? '', onChange: (text) => updateOther(question.field as OtherField, text) } : undefined}
                />
              ) : (
                <MultiChoices
                  field={question.field}
                  label={t(question.label)}
                  options={question.options}
                  value={Array.isArray(unanswered) ? unanswered : []}
                  onToggle={(option, selected) => toggleAnswer(question.field, option, selected)}
                  other={isOtherField(question.field) ? { value: other[question.field] ?? '', onChange: (text) => updateOther(question.field as OtherField, text) } : undefined}
                />
              )}
              {needsAnswer && <Alert variant="destructive"><AlertDescription>{t('Choose an answer to continue.')}</AlertDescription></Alert>}
              <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
                <Button variant="outline" onClick={goBack}>{t('Back')}</Button>
                <Button onClick={() => continueAssessment()}>
                  {step === 9 ? t('See my result') : t('Continue')}<Arrow direction="next" />
                </Button>
              </div>
            </Card>
            {restored && <p className="mt-3 text-xs text-muted-foreground">{t('Your saved answers were restored from this tab.')}</p>}
          </section>
        )}

        {started && step === 10 && result && (
          <section className="mx-auto max-w-[52rem]" aria-labelledby="assessment-result">
            <Card className={cn(TILE, 'gap-6 p-6 max-[640px]:p-4')}>
              <header>
                <h1 id="assessment-result" ref={heading} tabIndex={-1} className="m-0! text-[clamp(28px,4vw,42px)]! outline-none">{t(BAND_LABEL[result.band])}</h1>
                <p className="mt-3 mb-0 max-w-[44rem] text-base leading-relaxed text-muted-foreground">
                  {t(result.band === 'exploring'
                    ? 'You are still working out where agents fit. Pick one small, low-risk task your team repeats and name who will review the result.'
                    : result.band === 'building'
                      ? 'You have a few practices in place. Before using agents in more work, choose one recurring task and agree on review and access rules.'
                      : 'A pilot sounds within reach. Pick a task, limit the agent’s access and name who will check the result. Decide what success looks like before you start.')}
                </p>
              </header>

              <div className="grid gap-2 rounded-md border border-border bg-muted p-5 sm:grid-cols-[auto_1fr] sm:items-center">
                <div className="min-w-28">
                  <p className="m-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('Readiness score')}</p>
                  <p className="m-0 mt-1 text-4xl tabular-nums">{result.score}<span className="text-base text-muted-foreground"> / 100</span></p>
                </div>
                <p className="m-0 max-w-[34rem] text-sm leading-relaxed text-muted-foreground">
                  {t('Your score uses agent use, review, access limits and pilot timing. The organization questions give us context about your team. We have not compared this rubric with pilot outcomes.')}
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                {result.dimensions.map((dimension) => (
                  <div key={dimension.id}>
                    <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
                      <span>{t(DIMENSION_LABEL[dimension.id])}</span>
                      <span className="tabular-nums text-muted-foreground">{dimension.score} / {dimension.max}</span>
                    </div>
                    <Meter max={dimension.max} value={dimension.score} label={t(DIMENSION_LABEL[dimension.id])} />
                  </div>
                ))}
              </div>

              {weakest && <div className="border-t border-border pt-5">
                <h2 className="m-0! text-lg!">{t('A useful next step')}</h2>
                <p className="mt-2 mb-0 text-sm leading-relaxed">{t(NEXT_STEP[weakest.id])}</p>
              </div>}

              <div className="border-t border-border pt-5">
                <h2 className="m-0! text-lg!">{t('What happens if I continue?')}</h2>
                <p className="mt-2 mb-0 text-sm leading-relaxed text-muted-foreground">
                  {storageAvailable
                    ? t('We’ve filled in the ten questions you just answered. Add the details for an early-access request. You can review or change those answers first. We save them to HQ only when you submit.')
                    : t('This tab couldn’t keep your answers. You can still open the early-access form, but you’ll need to answer its questions there.')}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3 border-t border-border pt-5">
                <Button asChild size="lg"><a href="/interest?flow=readiness" data-event="Assessment interest opened">{t('Request early access')} <Arrow direction="next" /></a></Button>
                <Button variant="outline" onClick={goBack}>{t('Review your answers')}</Button>
                <a className="ml-auto" href="/workspace">{t('Explore Starlings')}</a>
              </div>
            </Card>
          </section>
        )}
      </div>
    </AppShell>
  );
}

/** The number key that picks this option, drawn at the row's right edge. */
function KeyHint({ n }: { n: number }) {
  return <kbd aria-hidden className="ml-auto hidden h-6 min-w-6 shrink-0 items-center justify-center rounded border border-border bg-muted px-1.5 font-sans text-xs text-muted-foreground sm:inline-flex">{n}</kbd>;
}

interface OtherInput { value: string; onChange: (text: string) => void }

function SingleChoices({ label, options, value, onChange, other }: {
  label: string;
  options: readonly InterestOption[];
  value: string;
  onChange: (value: string) => void;
  other?: OtherInput;
}) {
  const name = useId();
  const [query, setQuery] = useState('');
  const visible = filterOptions(options, query);
  return (
    <fieldset className="m-0 grid gap-2 border-0 p-0" aria-label={label}>
      {options.length > 8 && <Input type="search" value={query} placeholder={t('Search options')} aria-label={t('Search options')} onChange={(event) => setQuery(event.target.value)} />}
      <RadioGroup value={value} onValueChange={(next) => { onChange(next); setQuery(''); }} aria-label={label} className="gap-2">
        {visible.map((option, index) => {
          const id = `${name}-${option.id}`;
          return (
            <div key={option.id} className="flex min-h-12 items-center rounded-md border border-border bg-card p-3 transition-colors hover-lift hover-edge has-data-[state=checked]:border-primary has-data-[state=checked]:bg-muted">
              <Field orientation="horizontal" className="gap-3">
                <RadioGroupItem id={id} value={option.id} />
                <FieldLabel htmlFor={id} className="font-normal leading-relaxed">{t(option.label)}</FieldLabel>
              </Field>
              {options.length <= 9 && <KeyHint n={index + 1} />}
            </div>
          );
        })}
      </RadioGroup>
      {other && options.some((option) => option.other && option.id === value) && <Other label={t(options.find((option) => option.id === value)?.label ?? '')} {...other} />}
      {query && visible.length === 0 && <p className="m-0 text-sm text-muted-foreground">{t('No options match.')}</p>}
    </fieldset>
  );
}

function MultiChoices({ field, label, options, value, onToggle, other }: {
  field: string;
  label: string;
  options: readonly InterestOption[];
  value: string[];
  onToggle: (option: InterestOption, selected: boolean) => void;
  other?: OtherInput;
}) {
  const [query, setQuery] = useState('');
  const visible = filterOptions(options, query);
  return (
    <fieldset className="m-0 grid gap-2 border-0 p-0" aria-label={label}>
      {options.length > 8 && <Input type="search" value={query} placeholder={t('Search options')} aria-label={t('Search options')} onChange={(event) => setQuery(event.target.value)} />}
      {visible.map((option, index) => {
        const checked = value.includes(option.id);
        const id = `${field}-${option.id}`;
        return (
          <div key={option.id} className="flex min-h-12 items-center rounded-md border border-border bg-card p-3 transition-colors hover-lift hover-edge has-data-[state=checked]:border-primary has-data-[state=checked]:bg-muted">
            <Field orientation="horizontal" className="gap-3">
              <Checkbox id={id} checked={checked} onCheckedChange={(next) => onToggle(option, next === true)} />
              <FieldLabel htmlFor={id} className="font-normal leading-relaxed">{t(option.label)}</FieldLabel>
            </Field>
            {options.length <= 9 && <KeyHint n={index + 1} />}
          </div>
        );
      })}
      {other && options.some((option) => option.other && value.includes(option.id)) && <Other label={t(options.find((option) => option.other)?.label ?? '')} {...other} />}
      {query && visible.length === 0 && <p className="m-0 text-sm text-muted-foreground">{t('No options match.')}</p>}
      <p className="m-0 text-xs text-muted-foreground">{t('Choose all that apply.')}</p>
    </fieldset>
  );
}

function filterOptions(options: readonly InterestOption[], query: string): InterestOption[] {
  const needle = fold(query);
  return needle ? options.filter((option) => fold(option.label).includes(needle)) : [...options];
}

function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase();
}
