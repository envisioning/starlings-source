import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { XIcon } from 'lucide-react';
import {
  checkSignupSlug,
  emailDomain,
  PERSONAL_MAIL_DOMAINS,
  signupAddressProblem,
  SIGNUP_NOTE_MAX,
  SIGNUP_SLUG_MAX,
  SIGNUP_TEXT_MAX,
  signupFormSchema,
  signupLinkViewSchema,
  signupSlugAnswerSchema,
  signupSubmitAnswerSchema,
  signupTokenSchema,
  suggestSignupSlug,
  type SignupFormInput,
  type SignupPrefill,
  type SignupRequestStatus,
  type SignupSlugAnswer,
} from '@starlings/contracts/signup';
import { INTEREST_AGENTS, INTEREST_QUESTIONS, INTEREST_ROLES, INTEREST_SIZES } from '@starlings/contracts/interest';
import { accentPalette, type AccentPalette } from '@starlings/contracts/workspace-accent';
import { WORKSPACE_HOST_SUFFIX } from '@starlings/contracts/workspace-slug';
import { DEFAULT_WORKSPACE_SUITE, WORKSPACE_SUITES, WORKSPACE_SUITE_LABELS, parseWorkspaceSuite, type WorkspaceSuite } from '@starlings/contracts/workspace-suite';
import { DEFAULT_WORKSPACE_REGION, WORKSPACE_REGIONS, WORKSPACE_REGION_LABELS, parseWorkspaceRegion, type WorkspaceRegion } from '@starlings/contracts/workspace-region';
import { CONTACT_EMAIL } from '@starlings/contracts/deployment';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet, FieldTitle } from '@/ui/field';
import { Input } from '@/ui/input';
import { RadioGroup, RadioGroupItem } from '@/ui/radio-group';
import { Textarea } from '@/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/ui/toggle-group';
import { cn } from '@/lib/utils';
import { ErrorNotice } from '@shared/ErrorNotice';
import { t } from '@shared/i18n';
import { HERO, PAGE } from './bento';
import { useDocumentTitle } from './document-title';
import { LEGEND_NOTE, Pick, Section, TWO } from './InterestPage';
import { signupFetch } from './public-api';
import { AppShell } from './SiteChrome';

/**
 * /start: the signup page (docs/ONBOARDING.md §The signup page). The operator
 * mails a link with a single-use token in the address fragment (`#t=…`), so
 * the token never reaches a server log or a Referer. One form, one submit;
 * the same address then shows the request's state. Not prerendered, not in
 * the sitemap, noindex: the page means nothing without its token.
 *
 * Every rule the form checks is the contract's (`@starlings/contracts/signup`),
 * the same parse starlings-auth runs on submit.
 */
export function StartPage() {
  useDocumentTitle(t('Start your workspace'));
  const token = useMemo(readToken, []);
  const [view, setView] = useState<View>(token ? { kind: 'loading' } : { kind: 'closed' });

  const load = useCallback(async () => {
    if (!token) return;
    setView({ kind: 'loading' });
    try {
      const answer = await signupFetch('/signup/view', { body: { token }, schema: signupLinkViewSchema, fallbackError: t('Couldn’t load this link. Try again.') });
      setView(answer.state === 'open' ? { kind: 'open', email: answer.email, prefill: answer.prefill }
        : answer.state === 'request' ? { kind: 'request', request: answer.request }
          : { kind: 'closed' });
    } catch (caught) {
      setView({ kind: 'failed', message: caught instanceof Error ? caught.message : t('Couldn’t load this link. Try again.') });
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  return (
    <AppShell variant="document">
      <div className={PAGE}>
        {view.kind === 'loading' && <div className="min-h-[40vh]" aria-busy="true" />}
        {view.kind === 'closed' && <Closed />}
        {view.kind === 'failed' && (
          <ErrorNotice
            message={view.message}
            action={<Button type="button" variant="outline" size="xs" onClick={() => void load()}>{t('Retry')}</Button>}
          />
        )}
        {view.kind === 'request' && <RequestStatus request={view.request} />}
        {view.kind === 'open' && signupAddressProblem(view.email) && <PersonalAddress message={signupAddressProblem(view.email)!} />}
        {view.kind === 'open' && token && !signupAddressProblem(view.email) && (
          <SignupForm token={token} email={view.email} prefill={view.prefill} onSent={(request) => setView({ kind: 'request', request })} />
        )}
      </div>
    </AppShell>
  );
}

type View =
  | { kind: 'loading' }
  | { kind: 'closed' }
  | { kind: 'failed'; message: string }
  | { kind: 'open'; email: string; prefill: SignupPrefill }
  | { kind: 'request'; request: SignupRequestStatus };

/** The token from `#t=<token>`, or null. The query string is never read. */
function readToken(): string | null {
  if (typeof window === 'undefined') return null;
  const value = new URLSearchParams(window.location.hash.slice(1)).get('t');
  return signupTokenSchema.safeParse(value).success ? value : null;
}

/** A sentence with one `{slot}` drawn as `node`: the words stay one key. */
function withSlot(sentence: string, slot: string, node: ReactNode): ReactNode {
  const [before, after] = sentence.split(`{${slot}}`);
  return <>{before}{node}{after}</>;
}

const contactLink = <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>;

function Closed() {
  return (
    <header className={HERO}>
      <h1>{t('This link is no longer valid.')}</h1>
      <p className="lede">{withSlot(t('Write to {email}.'), 'email', contactLink)}</p>
    </header>
  );
}

/** A link to a personal address: the reason before any field. */
function PersonalAddress({ message }: { message: string }) {
  return (
    <header className={HERO}>
      <h1>{t('Use a work address')}</h1>
      <p className="lede">{message}</p>
    </header>
  );
}

function RequestStatus({ request }: { request: SignupRequestStatus }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const state = stateCopy(request.state);
  return (
    <header className={HERO}>
      <Badge variant="outline" className="mb-4">{state.label}</Badge>
      <h1 ref={heading} tabIndex={-1} className="outline-none">{request.workspace_name}</h1>
      {/* The address is a link once the workspace answers (meet#1171). Before
          ready the host has no Worker yet, so a link would open a dead page. */}
      <p className="lede">
        {request.state === 'ready' && request.host
          ? <a href={request.host}>{request.slug}.{WORKSPACE_HOST_SUFFIX}</a>
          : <>{request.slug}.{WORKSPACE_HOST_SUFFIX}</>}
      </p>
      {state.line && <p className="mt-3 text-muted-foreground">{state.line}</p>}
      {request.state === 'ready' && request.host && (
        <div className="mt-5"><Button asChild size="lg"><a href={request.host}>{t('Open workspace')}</a></Button></div>
      )}
    </header>
  );
}

function stateCopy(state: SignupRequestStatus['state']): { label: string; line: ReactNode } {
  switch (state) {
    case 'submitted': return { label: t('Received'), line: t('Thanks. During the pilot, someone on our team sets up each workspace by hand. We’ll email you when yours is ready.') };
    case 'approved': return { label: t('Accepted'), line: t('We’re setting up your workspace. We’ll email you when it’s ready.') };
    case 'provisioning': return { label: t('Setting up'), line: t('Almost there. We’ll email you when it’s ready.') };
    case 'ready': return { label: t('Ready'), line: null };
    case 'declined': return { label: t('Declined'), line: withSlot(t('Write to {email}.'), 'email', contactLink) };
    case 'failed': return { label: t('Stopped'), line: withSlot(t('Something went wrong on our side, and we’re fixing it. Questions? Write to {email}.'), 'email', contactLink) };
    case 'expired': return { label: t('Expired'), line: withSlot(t('Write to {email}.'), 'email', contactLink) };
  }
}

/** The form's answers by their contract names, in the order the form draws them. */
const FIELDS = ['name', 'role', 'workspace_name', 'slug', 'accent', 'membership', 'suite', 'region', 'team_size', 'agents', 'note', 'terms'] as const;
type FieldKey = (typeof FIELDS)[number];
const PICKED: ReadonlySet<FieldKey> = new Set(['role', 'team_size', 'agents']);
const MAX_DOMAINS = 5;
/** A few accents that carry readable text (`accentPalette`); any other #rrggbb goes in the field. */
const ACCENT_PRESETS = ['#2563eb', '#7c3aed', '#0f766e', '#dc2626', '#f59e0b', '#db2777'] as const;
const DEFAULT_SWATCH = 'default';

/** `#rrggbb` from what was typed: a missing `#` is added, case is kept for the contract to fold. */
function accentFrom(typed: string): string {
  const value = typed.trim();
  return /^[0-9a-fA-F]{6}$/u.test(value) ? `#${value}` : value;
}

/** `prefill` is what the link carries from the person's interest request: a start, every field still theirs to change. */
function SignupForm({ token, email, prefill, onSent }: { token: string; email: string; prefill: SignupPrefill; onSent: (request: SignupRequestStatus) => void }) {
  const ownDomain = emailDomain(email);
  const [name, setName] = useState(prefill.name ?? '');
  const [role, setRole] = useState<SignupFormInput['role'] | ''>(prefill.role ?? '');
  const [workspaceName, setWorkspaceName] = useState(prefill.workspace_name ?? '');
  /** The typed address, or null while the address follows the workspace name. */
  const [typedSlug, setTypedSlug] = useState<string | null>(null);
  const [accentText, setAccentText] = useState('');
  const [mode, setMode] = useState<'invite' | 'domains'>('invite');
  const [domains, setDomains] = useState<string[]>([PERSONAL_MAIL_DOMAINS.has(ownDomain) ? '' : ownDomain]);
  const [suite, setSuite] = useState<WorkspaceSuite>(DEFAULT_WORKSPACE_SUITE);
  const [region, setRegion] = useState<WorkspaceRegion>(DEFAULT_WORKSPACE_REGION);
  const [teamSize, setTeamSize] = useState<SignupFormInput['team_size'] | ''>(prefill.team_size ?? '');
  const [agents, setAgents] = useState<SignupFormInput['agents'] | ''>(prefill.agents ?? '');
  const [note, setNote] = useState('');
  const [terms, setTerms] = useState(false);

  const [touched, setTouched] = useState<ReadonlySet<FieldKey>>(new Set());
  const touch = (key: FieldKey) => setTouched((current) => current.has(key) ? current : new Set([...current, key]));
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  /** A refused or failed submit. It shows while the answers are the ones that failed; any change clears it. */
  const [failure, setFailure] = useState<{ field: FieldKey | null; message: string; retry: boolean; answers: string } | null>(null);
  /** starlings-auth's answer for one address, kept with the address it answers. */
  const [availability, setAvailability] = useState<{ slug: string; answer: SignupSlugAnswer } | null>(null);

  const slug = typedSlug ?? suggestSignupSlug(workspaceName);
  const accent = accentFrom(accentText);
  const palette = accent ? accentPalette(accent) : null;

  const input: SignupFormInput = {
    token,
    name,
    role: role as SignupFormInput['role'],
    workspace_name: workspaceName,
    slug,
    accent,
    membership: mode === 'invite' ? { mode: 'invite' } : { mode: 'domains', domains: domains.map((domain) => domain.trim()).filter(Boolean) },
    suite,
    region,
    team_size: teamSize as SignupFormInput['team_size'],
    agents: agents as SignupFormInput['agents'],
    note: note.trim() || undefined,
    terms: terms as true,
  };
  const answers = JSON.stringify(input);

  /** What is wrong with each answer, by the contract's own parse. */
  const parsedProblems = useMemo(() => {
    const parsed = signupFormSchema.safeParse(JSON.parse(answers));
    const found: Partial<Record<FieldKey, string>> = {};
    if (parsed.success) return found;
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0]) as FieldKey;
      if (!FIELDS.includes(key) || found[key]) continue;
      found[key] = issue.code === 'custom' ? issue.message
        : PICKED.has(key) ? t('Pick one.')
          : key === 'terms' ? t('Accept the terms to continue.')
            : t('Fill this in.');
    }
    return found;
  }, [answers]);

  // Availability: once the address passes the local rules, ask starlings-auth, debounced.
  const localSlug = checkSignupSlug(slug);
  const checkedSlug = localSlug.ok ? localSlug.slug : null;
  useEffect(() => {
    if (!checkedSlug) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      signupFetch('/signup/slug', { body: { token, slug: checkedSlug }, schema: signupSlugAnswerSchema, fallbackError: '', signal: controller.signal })
        .then((answer) => setAvailability({ slug: checkedSlug, answer }))
        // The submit checks again; a failed look-up only means no hint.
        .catch(() => undefined);
    }, 400);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [checkedSlug, token]);
  const known = availability && availability.slug === checkedSlug ? availability.answer : null;
  /** The contract's refusals, plus a taken address. */
  const problems: Partial<Record<FieldKey, string>> = known && !known.ok && !parsedProblems.slug
    ? { ...parsedProblems, slug: known.message }
    : parsedProblems;

  const shownFailure = failure && failure.answers === answers ? failure : null;
  const visible = (key: FieldKey) => attempted || touched.has(key) || (key === 'slug' && touched.has('workspace_name'));
  const errorOf = (key: FieldKey): string | undefined =>
    (shownFailure?.field === key ? shownFailure.message : undefined) ?? (visible(key) ? problems[key] : undefined);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setAttempted(true);
    const first = FIELDS.find((key) => problems[key]);
    if (first) {
      const field = event.currentTarget.querySelector<HTMLElement>(`[data-field="${first}"]`);
      field?.scrollIntoView({ block: 'center' });
      field?.querySelector<HTMLElement>('input, button, textarea')?.focus({ preventScroll: true });
      return;
    }
    void send();
  }

  async function send() {
    setBusy(true);
    setFailure(null);
    try {
      const answer = await signupFetch('/signup/submit', { body: input, schema: signupSubmitAnswerSchema, fallbackError: t('Couldn’t send this. Try again, or write to {email}.', { email: CONTACT_EMAIL }) });
      if (answer.ok) {
        window.scrollTo(0, 0);
        onSent(answer.request);
        return;
      }
      const at = answer.field?.split('.')[0] as FieldKey | undefined;
      setFailure({ field: at && FIELDS.includes(at) ? at : null, message: answer.message, retry: false, answers });
    } catch (caught) {
      setFailure({ field: null, message: caught instanceof Error ? caught.message : t('Couldn’t send this. Try again, or write to {email}.', { email: CONTACT_EMAIL }), retry: true, answers });
    } finally {
      setBusy(false);
    }
  }

  const slugId = useId();
  const slugErrorId = useId();
  const accentId = useId();
  const accentErrorId = useId();
  const membershipErrorId = useId();
  const termsId = useId();
  const termsErrorId = useId();
  const slugError = errorOf('slug');
  const accentError = errorOf('accent');
  const membershipError = errorOf('membership');
  const termsError = errorOf('terms');
  const swatch = ACCENT_PRESETS.find((preset) => preset === accent.toLowerCase()) ?? (accent ? '' : DEFAULT_SWATCH);

  return (
    <>
      <header className={cn(HERO, 'mb-7')}>
        <h1>{t('Start your workspace')}</h1>
      </header>
      <form className="grid max-w-[44rem] grid-cols-1 gap-6" onSubmit={submit} noValidate>
        {shownFailure && shownFailure.field === null && (
          <ErrorNotice
            message={shownFailure.message}
            action={shownFailure.retry && <Button type="button" variant="outline" size="xs" onClick={() => void send()}>{t('Retry')}</Button>}
          />
        )}

        <Section title={t('You')}>
          <div className={TWO}>
            <Text field="name" label={t(INTEREST_QUESTIONS.name.label)} value={name} onChange={setName} onBlur={() => touch('name')} error={errorOf('name')} />
            <Text label={t(INTEREST_QUESTIONS.email.label)} value={email} readOnly />
          </div>
          <Pick field="role" error={errorOf('role')} label={t(INTEREST_QUESTIONS.role.label)} options={INTEREST_ROLES} value={role} onChange={setRole} />
        </Section>

        <Section title={t('Workspace')}>
          <Text field="workspace_name" label={t('Workspace name')} value={workspaceName} onChange={setWorkspaceName} onBlur={() => touch('workspace_name')} error={errorOf('workspace_name')} maxLength={60} />
          <Field data-field="slug">
            <FieldLabel htmlFor={slugId}>{t('Address')}</FieldLabel>
            <div className="flex items-center gap-2 max-[520px]:flex-wrap">
              <Input
                id={slugId}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={slug}
                maxLength={SIGNUP_SLUG_MAX}
                aria-invalid={slugError ? true : undefined}
                aria-describedby={slugError ? slugErrorId : undefined}
                onChange={(event) => setTypedSlug(event.target.value.toLowerCase())}
                onBlur={() => touch('slug')}
                className="max-w-[18rem]"
              />
              <span className="text-muted-foreground">.{WORKSPACE_HOST_SUFFIX}</span>
            </div>
            {slugError
              ? <FieldError id={slugErrorId}>{slugError}</FieldError>
              : known?.ok && <FieldDescription>{t('Available.')}</FieldDescription>}
          </Field>
          <FieldSet className="gap-3" data-field="accent">
            <FieldLegend variant="label">{t('Accent colour')}</FieldLegend>
            <div className="flex flex-wrap items-center gap-3">
              {/* shadcn ToggleGroup, single: the swatches are a radio group; the field takes any other colour. */}
              <ToggleGroup
                type="single"
                variant="outline"
                spacing={2}
                className="flex-wrap"
                value={swatch}
                onValueChange={(next) => { if (next) { setAccentText(next === DEFAULT_SWATCH ? '' : next); touch('accent'); } }}
              >
                <ToggleGroupItem value={DEFAULT_SWATCH} className="rounded-full font-normal data-[state=on]:border-foreground">{t('Default')}</ToggleGroupItem>
                {ACCENT_PRESETS.map((preset) => (
                  <ToggleGroupItem
                    key={preset}
                    value={preset}
                    aria-label={preset}
                    className="size-9 rounded-full p-0 data-[state=on]:ring-2 data-[state=on]:ring-foreground data-[state=on]:ring-offset-2 data-[state=on]:ring-offset-background"
                    style={{ background: preset }}
                  />
                ))}
              </ToggleGroup>
              <Input
                id={accentId}
                aria-label={t('Accent colour')}
                autoComplete="off"
                spellCheck={false}
                value={accentText}
                maxLength={7}
                placeholder="#rrggbb"
                aria-invalid={accentError ? true : undefined}
                aria-describedby={accentError ? accentErrorId : undefined}
                onChange={(event) => setAccentText(event.target.value)}
                onBlur={() => touch('accent')}
                className="w-[8.5rem] font-mono"
              />
            </div>
            <FieldError id={accentErrorId}>{accentError}</FieldError>
          </FieldSet>
          <Field>
            <FieldTitle>{t('Preview')}</FieldTitle>
            <HeaderPreview name={workspaceName.trim() || t('Your workspace')} palette={palette} />
          </Field>
        </Section>

        <Section title={t('Who joins')}>
          <FieldSet className="gap-3" data-field="membership">
            <FieldLegend variant="label" className="sr-only">{t('Who joins')}</FieldLegend>
            <RadioGroup value={mode} onValueChange={(next) => setMode(next as 'invite' | 'domains')} aria-describedby={membershipError ? membershipErrorId : undefined}>
              <Choice value="invite" label={t('Only people I invite')} />
              <Choice value="domains" label={t('Anyone at a domain')} />
            </RadioGroup>
            {mode === 'domains' && (
              <div className="grid gap-2 pl-7">
                {domains.map((domain, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <span className="text-muted-foreground">@</span>
                    <Input
                      aria-label={t('Domain')}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      value={domain}
                      maxLength={253}
                      aria-invalid={membershipError ? true : undefined}
                      onChange={(event) => setDomains((current) => current.map((value, at) => at === index ? event.target.value : value))}
                      onBlur={() => touch('membership')}
                      className="max-w-[18rem]"
                    />
                    {domains.length > 1 && (
                      <Button type="button" variant="ghost" size="icon" aria-label={t('Remove')} onClick={() => setDomains((current) => current.filter((_, at) => at !== index))}>
                        <XIcon />
                      </Button>
                    )}
                  </div>
                ))}
                {domains.length < MAX_DOMAINS && (
                  <div><Button type="button" variant="outline" size="sm" onClick={() => setDomains((current) => [...current, ''])}>{t('Add domain')}</Button></div>
                )}
              </div>
            )}
            <FieldError id={membershipErrorId}>{membershipError}</FieldError>
          </FieldSet>
        </Section>

        <Section title={t('Mail and calendar')}>
          <FieldSet className="gap-3" data-field="suite">
            <FieldLegend variant="label" className="sr-only">{t('Mail and calendar')}</FieldLegend>
            <RadioGroup value={suite} onValueChange={(next) => { const parsed = parseWorkspaceSuite(next); if (parsed) setSuite(parsed); }}>
              {WORKSPACE_SUITES.map((value) => <Choice key={value} value={value} label={t(WORKSPACE_SUITE_LABELS[value])} />)}
            </RadioGroup>
          </FieldSet>
        </Section>

        <Section title={t('Data region')}>
          <FieldSet className="gap-3" data-field="region">
            <FieldLegend variant="label" className="sr-only">{t('Data region')}</FieldLegend>
            <RadioGroup value={region} onValueChange={(next) => { const parsed = parseWorkspaceRegion(next); if (parsed) setRegion(parsed); }}>
              {WORKSPACE_REGIONS.map((value) => <Choice key={value} value={value} label={t(WORKSPACE_REGION_LABELS[value])} />)}
            </RadioGroup>
            {/* Final: Cloudflare places each store when it is made, by jurisdiction (EU) or location hint (US), workspace-region.ts. */}
            <FieldDescription>{t('You can’t change the region later.')}</FieldDescription>
          </FieldSet>
        </Section>

        <Section title={t('About the work')}>
          <Pick field="team_size" error={errorOf('team_size')} label={t(INTEREST_QUESTIONS.team_size.label)} options={INTEREST_SIZES} value={teamSize} onChange={setTeamSize} />
          <Pick field="agents" error={errorOf('agents')} label={t(INTEREST_QUESTIONS.agents.label)} options={INTEREST_AGENTS} value={agents} onChange={setAgents} />
          <Long label={t('Anything else we should know')} value={note} onChange={setNote} error={errorOf('note')} />
        </Section>

        <Section title={t('Plan')}>
          <p className="m-0">{t('No payment during the pilot.')}</p>
          <Field orientation="horizontal" data-field="terms">
            <Checkbox
              id={termsId}
              checked={terms}
              aria-invalid={termsError ? true : undefined}
              aria-describedby={termsError ? termsErrorId : undefined}
              onCheckedChange={(next) => setTerms(next === true)}
            />
            <FieldLabel htmlFor={termsId} className="font-normal">
              {withSlot(t('I accept the {terms}.'), 'terms', <a href="/terms" target="_blank" rel="noreferrer">{t('terms')}</a>)}
            </FieldLabel>
          </Field>
          <FieldError id={termsErrorId}>{termsError}</FieldError>
        </Section>

        <div>
          <Button type="submit" size="lg" disabled={busy}>{busy ? t('Sending…') : t('Send request')}</Button>
        </div>
      </form>
    </>
  );
}

/** The workspace's header bar as the app draws it: the initial in a square and the name, on the accent. */
function HeaderPreview({ name, palette }: { name: string; palette: AccentPalette | null }) {
  const fill = palette?.dark.accent ?? 'var(--accent)';
  const ink = palette?.dark.onAccent ?? 'var(--on-accent)';
  const initial = Array.from(name)[0]?.toLocaleUpperCase() ?? '';
  return (
    <div aria-hidden="true" className="flex h-14 items-center gap-3 rounded-md px-4" style={{ background: fill, color: ink }}>
      <span className="inline-flex size-8 flex-none items-center justify-center rounded-[6px] text-base font-semibold" style={{ background: ink, color: fill }}>{initial}</span>
      <span className="truncate font-medium">{name}</span>
    </div>
  );
}

function Choice({ value, label }: { value: string; label: string }) {
  const id = useId();
  return (
    <Field orientation="horizontal">
      <RadioGroupItem id={id} value={value} />
      <FieldLabel htmlFor={id} className="font-normal">{label}</FieldLabel>
    </Field>
  );
}

function Text({ field, label, value, onChange, onBlur, error, readOnly, maxLength = SIGNUP_TEXT_MAX }: {
  field?: FieldKey;
  label: string;
  value: string;
  onChange?: (value: string) => void;
  onBlur?: () => void;
  error?: string;
  readOnly?: boolean;
  maxLength?: number;
}) {
  const id = useId();
  const errorId = useId();
  return (
    <Field data-field={field}>
      <FieldLabel htmlFor={id}>{label}{!readOnly && <small className={LEGEND_NOTE}>{t('required')}</small>}</FieldLabel>
      <Input
        id={id}
        value={value}
        readOnly={readOnly}
        className={readOnly ? 'text-muted-foreground' : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        maxLength={maxLength}
        onChange={(event) => onChange?.(event.target.value)}
        onBlur={onBlur}
      />
      <FieldError id={errorId}>{error}</FieldError>
    </Field>
  );
}

function Long({ label, value, onChange, error }: { label: string; value: string; onChange: (value: string) => void; error?: string }) {
  const id = useId();
  const errorId = useId();
  return (
    <Field data-field="note">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea
        id={id}
        rows={3}
        value={value}
        maxLength={SIGNUP_NOTE_MAX}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldError id={errorId}>{error}</FieldError>
    </Field>
  );
}
