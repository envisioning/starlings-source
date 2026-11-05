import { CONTACT_EMAIL } from '@starlings/contracts/deployment';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/ui/toggle-group';
import { Checkbox } from '@/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet, FieldTitle } from '@/ui/field';
import { ChevronDown } from 'lucide-react';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Textarea } from '@/ui/textarea';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import { Card } from '@/ui/card';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { HERO, PAGE, TILE } from './bento';
import {
  INTEREST_AGENTS,
  INTEREST_AGENT_USES,
  INTEREST_AGENT_RUNTIMES,
  INTEREST_AGENT_USE_CASES,
  INTEREST_AGENT_REVIEWS,
  INTEREST_AGENT_ACCESS,
  INTEREST_BOOKING_URL,
  INTEREST_COMMUNITY_GROUP_URL,
  INTEREST_DEPLOYMENTS,
  INTEREST_DEVICES,
  INTEREST_IDENTITIES,
  INTEREST_IDENTITY_TOOLS,
  INTEREST_LIVE,
  INTEREST_ORG_KINDS,
  INTEREST_OUTSIDE_WORK,
  INTEREST_PAINS,
  INTEREST_PARTS,
  INTEREST_QUESTIONS,
  INTEREST_RELATIONSHIPS,
  INTEREST_REASONS,
  INTEREST_ROLES,
  INTEREST_SECTIONS,
  INTEREST_SIZES,
  INTEREST_SOURCES,
  INTEREST_TIMELINES,
  INTEREST_TOOLS,
  INTEREST_TOOL_GROUPS,
  INTEREST_TOOL_LIVE_STYLES,
  INTEREST_WORK_UNITS,
  INTEREST_LONG_TEXT_MAX_CHARS,
  INTEREST_TEXT_MAX_CHARS,
  interestShowsCommunityGroup,
  interestSourceFromQuery,
  interestPlanFromQuery,
  INTEREST_READINESS_STORAGE_KEY,
  interestReadinessAnswersSchema,
  interestReadinessDraftSchema,
  type InterestInput,
  type InterestOption,
  type InterestLiveStyle,
  type InterestOtherKey,
  type InterestToolGroup,
} from '@starlings/contracts/interest';
import { INTEREST_GUIDE_PATH, INTEREST_SCHEMA_PATH } from '@starlings/contracts/interest';
import { interestAgentPrompt, interestAgentSteps } from '@starlings/contracts/interest-agent';
import { PRODUCT_SITE_ORIGIN } from '@starlings/contracts/deployment';
import { PRICING_PLANS, planFacts, planHeadline } from './pricing';
import { apiFetch } from './public-api';
import { errorCodeOf } from './public-api';
import { useDocumentTitle } from './document-title';
import { ErrorNotice } from '@shared/ErrorNotice';
import { AppShell, Meter } from './SiteChrome';
import { turnstileToken } from '@shared/turnstile';
import { plural, t } from '@shared/i18n';

/**
 * /interest — a firm asks about a pilot. Meet is not for sale yet; the
 * answers tell us who it should be for, first among them whether
 * we already work together and how far agents are into their work. Each
 * submission lands as one row and a lead in hq (`services/control-plane/src/interest.ts`).
 *
 * Every pick list comes from `@starlings/contracts/interest`, so the ids the Worker
 * validates are the ids drawn here.
 */
/** Where "we would take a call" leads once sent: the owner's booking page. The mailed copy links the same (`interest.ts`). */

export function InterestPage() {
  useDocumentTitle(t('Request early access'));

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [role, setRole] = useState<InterestInput['role'] | ''>('');
  const [orgKind, setOrgKind] = useState<NonNullable<InterestInput['org_kind']> | ''>('');
  const [outsideWork, setOutsideWork] = useState<string[]>([]);
  const [workUnit, setWorkUnit] = useState<NonNullable<InterestInput['work_unit']> | ''>('');
  const [companySize, setCompanySize] = useState<InterestInput['company_size'] | ''>('');
  const [teamSize, setTeamSize] = useState<InterestInput['team_size'] | ''>('');
  const [agents, setAgents] = useState<NonNullable<InterestInput['agents']> | ''>('');
  const [agentUse, setAgentUse] = useState<NonNullable<InterestInput['agent_use']> | ''>('');
  const [agentUseCases, setAgentUseCases] = useState<string[]>([]);
  const [agentRuntimes, setAgentRuntimes] = useState<string[]>([]);
  const [agentReview, setAgentReview] = useState<NonNullable<InterestInput['agent_review']> | ''>('');
  const [agentAccess, setAgentAccess] = useState<NonNullable<InterestInput['agent_access']> | ''>('');
  const [agentExample, setAgentExample] = useState('');
  const [relationship, setRelationship] = useState<NonNullable<InterestInput['relationship']> | ''>('');
  const [country, setCountry] = useState('');
  const [tools, setTools] = useState<Record<InterestToolGroup, string[]>>({ video: [], notes: [], booking: [], work: [], chat: [], agents: [] });
  const [identity, setIdentity] = useState<InterestInput['identity'] | ''>('');
  const [devices, setDevices] = useState<string[]>([]);
  const [live, setLive] = useState<string[]>([]);
  const [pains, setPains] = useState<string[]>([]);
  const [other, setOther] = useState<Partial<Record<InterestOtherKey, string>>>({});
  const [painsText, setPainsText] = useState('');
  const [parts, setParts] = useState<string[]>([]);
  const [missing, setMissing] = useState('');
  const [deployment, setDeployment] = useState<InterestInput['deployment'] | ''>('');
  const [reason, setReason] = useState<InterestInput['reason'] | ''>('');
  const [timeline, setTimeline] = useState<InterestInput['timeline'] | ''>('');
  const [pilot, setPilot] = useState(false);
  const [call, setCall] = useState(false);
  const [source, setSource] = useState<NonNullable<InterestInput['source']> | ''>('');
  const community = interestShowsCommunityGroup(source || undefined);
  // A link may prefill the source (?source=<id>). Read it once, after
  // hydration, so the prerendered page and the first render agree. The
  // address is not written back.
  const [plan, setPlan] = useState<NonNullable<InterestInput['plan']> | ''>('');
  const [assessmentImported, setAssessmentImported] = useState(false);
  const [assessmentTransferMissing, setAssessmentTransferMissing] = useState(false);
  useEffect(() => {
    const prefill = interestSourceFromQuery(window.location.search);
    if (prefill) setSource(prefill);
    // A pricing button names its plan (?plan=<id>), read the same way.
    const planPrefill = interestPlanFromQuery(window.location.search);
    if (planPrefill) setPlan(planPrefill);

    if (new URLSearchParams(window.location.search).get('flow') !== 'readiness') return;
    try {
      const raw = window.sessionStorage.getItem(INTEREST_READINESS_STORAGE_KEY);
      if (!raw) {
        setAssessmentTransferMissing(true);
        return;
      }
      const saved = interestReadinessDraftSchema.safeParse(JSON.parse(raw));
      const answers = saved.success ? interestReadinessAnswersSchema.safeParse(saved.data.answers) : null;
      if (!answers?.success) {
        setAssessmentTransferMissing(true);
        return;
      }
      setOrgKind(answers.data.org_kind);
      setTeamSize(answers.data.team_size);
      setWorkUnit(answers.data.work_unit);
      setOutsideWork([...answers.data.outside_work]);
      setAgentUse(answers.data.agent_use);
      setAgentUseCases([...answers.data.agent_use_cases]);
      setAgentRuntimes([...answers.data.agent_runtimes]);
      setAgentReview(answers.data.agent_review);
      setAgentAccess(answers.data.agent_access);
      setTimeline(answers.data.timeline);
      setOther((current) => ({ ...current, ...(saved.success ? saved.data.other : {}) }));
      setAssessmentImported(true);
    } catch {
      setAssessmentTransferMissing(true);
    }
  }, []);


  /**
   * An answer ticks what it implies, but only in a list the person has not
   * touched: a sign-in ticks its suite's call and chat apps, and a live tool
   * ticks how the team wants to talk. Every tick can be cleared.
   */
  function fillLive(video: readonly string[]) {
    setLive((current) => current.length > 0 ? current
      : [...new Set(video.map((id) => INTEREST_TOOL_LIVE_STYLES[id as keyof typeof INTEREST_TOOL_LIVE_STYLES]).filter((style): style is InterestLiveStyle => Boolean(style)))]);
  }
  function changeTools(group: InterestToolGroup, next: string[]) {
    setTools((current) => ({ ...current, [group]: next }));
    if (group === 'video') fillLive(next);
  }
  function chooseIdentity(next: InterestInput['identity']) {
    setIdentity(next);
    const implied = INTEREST_IDENTITY_TOOLS[next];
    if (!implied) return;
    const filled = { ...tools };
    for (const group of INTEREST_TOOL_GROUPS) {
      const picks = implied[group];
      if (picks && filled[group].length === 0) filled[group] = [...picks];
    }
    setTools(filled);
    fillLive(filled.video);
  }

  const [status, setStatus] = useState<'idle' | 'busy' | 'sent'>('idle');
  /** A failed send. It shows while the answers are the ones that failed; any change clears it. */
  const [failure, setFailure] = useState<{ message: string; retry: boolean; answers: string } | null>(null);
  /** Set by the first submit: from then on each missing answer is marked, and the mark goes once it is answered. */
  const [attempted, setAttempted] = useState(false);
  const thanks = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (status !== 'sent') return;
    window.scrollTo(0, 0);
    thanks.current?.focus();
  }, [status]);

  /** The text field a list's Other opens, bound to its slot in `other`. */
  function otherFor(key: InterestOtherKey): OtherText {
    return { value: other[key] ?? '', onChange: (text) => setOther((current) => ({ ...current, [key]: text })) };
  }

  /** Every required answer, in the order the form draws it, with what is wrong when it is wrong. */
  const checks: [RequiredKey, string | null][] = [
    ['name', name.trim() ? null : t('Fill this in.')],
    ['email', !email.trim() ? t('Fill this in.') : EMAIL.test(email.trim()) ? null : t('Type a full email address.')],
    ['company', company.trim() ? null : t('Fill this in.')],
    ['role', role ? null : t('Pick one.')],
    ['org_kind', orgKind ? null : t('Pick one.')],
    ['company_size', companySize ? null : t('Pick one.')],
    ['team_size', teamSize ? null : t('Pick one.')],
    ['work_unit', workUnit ? null : t('Pick one.')],
    ['agents', agents ? null : t('Pick one.')],
    ['agent_use', agentUse ? null : t('Pick one.')],
    ['relationship', relationship ? null : t('Pick one.')],
    ['agent_example', !agentUse || agentUse === 'none' || agentExample.trim() ? null : t('Fill this in.')],
    ['identity', identity ? null : t('Pick one.')],
    ['deployment', deployment ? null : t('Pick one.')],
    ['reason', reason ? null : t('Pick one.')],
    ['timeline', timeline ? null : t('Pick one.')],
  ];
  const invalid = checks.filter(([, problem]) => problem !== null);
  const percentDone = Math.round(((checks.length - invalid.length) / checks.length) * 100);
  const marks: Partial<Record<RequiredKey, string>> = attempted ? Object.fromEntries(invalid) : {};
  const answers = JSON.stringify([name, email, company, role, orgKind, outsideWork, workUnit, companySize, teamSize, agents, agentUse, agentUseCases,
    agentRuntimes, agentReview, agentAccess, agentExample, relationship, country, tools, identity, devices, live, pains, other, painsText, parts, missing,
    deployment, reason, timeline, pilot, call, source, plan]);
  const shownFailure = failure && failure.answers === answers ? failure : null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === 'busy') return;
    setAttempted(true);
    const first = invalid[0];
    if (first) {
      const field = event.currentTarget.querySelector<HTMLElement>(`[data-field="${first[0]}"]`);
      field?.scrollIntoView({ block: 'center' });
      field?.querySelector<HTMLElement>('input, textarea, button')?.focus({ preventScroll: true });
      return;
    }
    void send();
  }

  async function send() {
    if (status === 'busy' || !role || !companySize || !teamSize || !identity || !deployment || !reason || !timeline) return;
    setFailure(null);
    setStatus('busy');
    const body: InterestInput = {
      name: name.trim(),
      email: email.trim(),
      company: company.trim(),
      role,
      org_kind: orgKind || undefined,
      outside_work: outsideWork as InterestInput['outside_work'],
      work_unit: workUnit || undefined,
      company_size: companySize,
      team_size: teamSize,
      agents: agents || undefined,
      agent_use: agentUse || undefined,
      agent_use_cases: agentUseCases as InterestInput['agent_use_cases'],
      agent_runtimes: agentRuntimes as InterestInput['agent_runtimes'],
      agent_review: agentReview || undefined,
      agent_access: agentAccess || undefined,
      agent_inventory: [],
      agent_example: agentExample.trim() || undefined,
      relationship: relationship || undefined,
      country: country.trim() || undefined,
      deployment,
      reason,
      timeline,
      identity,
      devices: devices as InterestInput['devices'],
      live: live as InterestInput['live'],
      tools: tools as InterestInput['tools'],
      pains: pains as InterestInput['pains'],
      pains_text: painsText.trim() || undefined,
      other: Object.fromEntries(Object.entries(other)
        .filter(([key]) => key !== 'org_kind' || orgKind === 'other')
        .filter(([key]) => key !== 'agent_use_cases' || agentUseCases.includes('other'))
        .filter(([key]) => key !== 'agent_runtimes' || agentRuntimes.includes('other'))
        .map(([key, text]) => [key, text.trim()]).filter(([, text]) => text)),
      parts: parts as InterestInput['parts'],
      missing: missing.trim() || undefined,
      pilot,
      call,
      source: source || undefined,
      plan: plan || undefined,
      readiness_assessment: assessmentImported ? 'v1' : undefined,
      filled_by: 'form',
    };
    try {
      let turnstile_token: string | undefined;
      try {
        turnstile_token = await turnstileToken('interest');
      } catch {
        // A blocked widget must not lose the form; the Worker decides.
      }
      await apiFetch('/interest', {
        body: { ...body, ...(turnstile_token ? { turnstile_token } : {}) },
        fallbackError: t('Couldn’t send this.'),
      });
      try { window.sessionStorage.removeItem(INTEREST_READINESS_STORAGE_KEY); } catch { /* The tab may block storage. */ }
      setStatus('sent');
    } catch (caught) {
      setStatus('idle');
      const code = errorCodeOf(caught);
      // A blocked bot check posts without a token, and the Worker answers turnstile_failed.
      setFailure(
        code === 'not_configured'
          ? { message: t('The form is not switched on yet. Write to {email} instead.', { email: CONTACT_EMAIL }), retry: false, answers }
          : code === 'invalid_request'
            ? { message: t('Couldn’t send this. Check your answers, or write to {email}.', { email: CONTACT_EMAIL }), retry: false, answers }
            : code === 'rate_limited'
              ? { message: t('Too many in a minute. Wait, then try again.'), retry: true, answers }
              : code === 'turnstile_failed'
                ? { message: t('Couldn’t run the bot check. Try again, or write to {email}.', { email: CONTACT_EMAIL }), retry: true, answers }
                : { message: t('Couldn’t send this. Try again, or write to {email}.', { email: CONTACT_EMAIL }), retry: true, answers },
      );
    }
  }

  if (status === 'sent') {
    return (
      <AppShell variant="wide" product={null}>
        <div className={PAGE}>
          <header className={cn(HERO, 'mb-7')}>
            <h1 ref={thanks} tabIndex={-1} className="outline-none">{t('Thank you.')}</h1>
            <p className="lede">
              {t('A copy of your answers is on its way to {email}.', { email: email.trim() })}{' '}
              {call
                ? t('You asked for a call. Pick a time, and we show you Starlings live. You join from your browser, with no account.')
                : t('We read every one of these. If Starlings fits your team, we set up a workspace for you.')}
              {community && <>{' '}{t('You came from Artificial Insights, so there’s a pilot group on WhatsApp for you. We post news there first and set up the first workspaces from it. We let people in once we’ve read their answers.')}</>}
            </p>
            <div className="mt-5 flex flex-wrap gap-2.5">
              {call && <Button asChild><a href={INTEREST_BOOKING_URL}>{t('Book the call')}</a></Button>}
              {community && <Button asChild variant={call ? 'secondary' : 'default'}><a href={INTEREST_COMMUNITY_GROUP_URL} target="_blank" rel="noopener noreferrer">{t('Join the pilot group')}</a></Button>}
              <Button asChild variant="secondary"><a href="/workspace">{t('Back to features')}</a></Button>
            </div>
          </header>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell variant="wide" product={null}>
      <div className={PAGE}>
        <header className={cn(HERO, 'mb-7')}>
          <h1>{t('Request early access')}</h1>
          <p className="lede">
            {t('Starlings is one workspace for your team and your AI agents: calls, chat, tasks, docs and calendar, organized by project. We’re opening it to a few small teams. Tell us how you work today, and we’ll set up a workspace for your team.')}
          </p>
        </header>

        {assessmentTransferMissing && (
          <p role="status" className="mb-6 max-w-[44rem] rounded-md border border-border bg-muted p-4 text-sm leading-relaxed">
            {t('Your browser did not carry the assessment answers into this form. You can still request early access by filling in the questions below.')}
          </p>
        )}

        <AgentGuide />

        <div className="grid grid-cols-[minmax(0,44rem)_minmax(15rem,20rem)] items-start gap-6 max-[960px]:grid-cols-1">
        <form className="grid max-w-[44rem] grid-cols-1 gap-6 *:col-span-full" onSubmit={submit} noValidate>
          <Section title={t(INTEREST_SECTIONS.who.title)}>
            <div className={TWO}>
              <Text field="name" label={t(INTEREST_QUESTIONS.name.label)} value={name} onChange={setName} required error={marks.name} />
              <Text field="email" label={t(INTEREST_QUESTIONS.email.label)} value={email} onChange={setEmail} required type="email" error={marks.email} />
            </div>
            <div className={TWO}>
              <Text field="company" label={t(INTEREST_QUESTIONS.company.label)} value={company} onChange={setCompany} required error={marks.company} />
              <Text label={t(INTEREST_QUESTIONS.country.label)} value={country} onChange={setCountry} />
            </div>
            <Pick field="role" error={marks.role} label={t(INTEREST_QUESTIONS.role.label)} options={INTEREST_ROLES} value={role} onChange={setRole} other={otherFor('role')} />
            {!assessmentImported && <Pick field="org_kind" error={marks.org_kind} label={t(INTEREST_QUESTIONS.org_kind.label)} options={INTEREST_ORG_KINDS} value={orgKind} onChange={setOrgKind} other={otherFor('org_kind')} />}
            {assessmentImported
              ? <Pick field="company_size" error={marks.company_size} label={t(INTEREST_QUESTIONS.company_size.label)} options={INTEREST_SIZES} value={companySize} onChange={setCompanySize} />
              : <div className={TWO}>
                <Pick field="company_size" error={marks.company_size} label={t(INTEREST_QUESTIONS.company_size.label)} options={INTEREST_SIZES} value={companySize} onChange={setCompanySize} />
                <Pick field="team_size" error={marks.team_size} label={t(INTEREST_QUESTIONS.team_size.label)} options={INTEREST_SIZES} value={teamSize} onChange={setTeamSize} />
              </div>}
            {!assessmentImported && <>
              <Pick field="work_unit" error={marks.work_unit} label={t(INTEREST_QUESTIONS.work_unit.label)} options={INTEREST_WORK_UNITS} value={workUnit} onChange={setWorkUnit} />
              <Picks label={t(INTEREST_QUESTIONS.outside_work.label)} options={INTEREST_OUTSIDE_WORK} value={outsideWork} onChange={setOutsideWork} />
            </>}
            <Pick field="agents" error={marks.agents} label={t(INTEREST_QUESTIONS.agents.label)} options={INTEREST_AGENTS} value={agents} onChange={setAgents} />
            {!assessmentImported && <Pick field="agent_use" error={marks.agent_use} label={t(INTEREST_QUESTIONS.agent_use.label)} options={INTEREST_AGENT_USES} value={agentUse} onChange={setAgentUse} />}
            <Pick field="relationship" error={marks.relationship} label={t(INTEREST_QUESTIONS.relationship.label)} options={INTEREST_RELATIONSHIPS} value={relationship} onChange={setRelationship} />
          </Section>

          {assessmentImported && (
            <Section title={t('Your assessment answers')} lede={t('We’ve filled in the ten questions you just answered. Add the details for an early-access request. We save everything only when you submit this form.')}>
              <Collapsible>
                <CollapsibleTrigger className="group flex w-fit cursor-pointer items-center gap-2 rounded-md px-1 py-2 text-sm font-medium hover-lift hover-edge focus-visible:outline-2 focus-visible:outline-ring">
                  {t('Review or change the ten answers')}
                  <ChevronDown aria-hidden="true" className="size-4 transition-transform group-data-[state=open]:rotate-180" />
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-5 grid gap-7">
                  <Pick field="org_kind" label={t(INTEREST_QUESTIONS.org_kind.label)} options={INTEREST_ORG_KINDS} value={orgKind} onChange={setOrgKind} other={otherFor('org_kind')} />
                  <Pick field="team_size" label={t(INTEREST_QUESTIONS.team_size.label)} options={INTEREST_SIZES} value={teamSize} onChange={setTeamSize} />
                  <Pick field="work_unit" label={t(INTEREST_QUESTIONS.work_unit.label)} options={INTEREST_WORK_UNITS} value={workUnit} onChange={setWorkUnit} />
                  <Picks label={t(INTEREST_QUESTIONS.outside_work.label)} options={INTEREST_OUTSIDE_WORK} value={outsideWork} onChange={setOutsideWork} minimumSelection={1} />
                  <Pick field="agent_use" label={t(INTEREST_QUESTIONS.agent_use.label)} options={INTEREST_AGENT_USES} value={agentUse} onChange={setAgentUse} />
                  <Picks label={t(INTEREST_QUESTIONS.agent_use_cases.label)} options={INTEREST_AGENT_USE_CASES} value={agentUseCases} onChange={setAgentUseCases} other={otherFor('agent_use_cases')} minimumSelection={1} />
                  <Picks label={t(INTEREST_QUESTIONS.agent_runtimes.label)} options={INTEREST_AGENT_RUNTIMES} value={agentRuntimes} onChange={setAgentRuntimes} other={otherFor('agent_runtimes')} minimumSelection={1} />
                  <Pick field="agent_review" optional label={t(INTEREST_QUESTIONS.agent_review.label)} options={INTEREST_AGENT_REVIEWS} value={agentReview} onChange={setAgentReview} />
                  <Pick field="agent_access" optional label={t(INTEREST_QUESTIONS.agent_access.label)} options={INTEREST_AGENT_ACCESS} value={agentAccess} onChange={setAgentAccess} />
                  <Pick field="timeline" label={t(INTEREST_QUESTIONS.timeline.label)} options={INTEREST_TIMELINES} value={timeline} onChange={setTimeline} />
                </CollapsibleContent>
              </Collapsible>
            </Section>
          )}
          <Section title={t(INTEREST_SECTIONS.today.title)} lede={t('The tools you use now. This tells us what Starlings would replace.')}>
            <Pick
              field="identity"
              error={marks.identity}
              label={t(INTEREST_QUESTIONS.identity.label)}
              note={t('Starlings signs in with Google Workspace today. Microsoft 365 is next.')}
              options={INTEREST_IDENTITIES}
              value={identity}
              onChange={chooseIdentity}
              other={otherFor('identity')}
            />
            {INTEREST_TOOL_GROUPS.map((group) => (
              <Picks
                key={group}
                label={t(INTEREST_TOOLS[group].label)}
                options={INTEREST_TOOLS[group].options}
                value={tools[group]}
                onChange={(next) => changeTools(group, next)}
                other={otherFor(`tools.${group}`)}
              />
            ))}
            {!assessmentImported && <Picks
              label={t(INTEREST_QUESTIONS.agent_use_cases.label)}
              options={INTEREST_AGENT_USE_CASES}
              value={agentUseCases}
              onChange={setAgentUseCases}
              other={otherFor('agent_use_cases')}
            />}
            {!assessmentImported && <Picks
              label={t(INTEREST_QUESTIONS.agent_runtimes.label)}
              options={INTEREST_AGENT_RUNTIMES}
              value={agentRuntimes}
              onChange={setAgentRuntimes}
              other={otherFor('agent_runtimes')}
            />}
            {!assessmentImported && <Pick
              field="agent_review"
              optional
              label={t(INTEREST_QUESTIONS.agent_review.label)}
              options={INTEREST_AGENT_REVIEWS}
              value={agentReview}
              onChange={setAgentReview}
            />}
            {!assessmentImported && <Pick
              field="agent_access"
              optional
              label={t(INTEREST_QUESTIONS.agent_access.label)}
              options={INTEREST_AGENT_ACCESS}
              value={agentAccess}
              onChange={setAgentAccess}
            />}
            <Long
              field="agent_example"
              label={t(INTEREST_QUESTIONS.agent_example.label)}
              value={agentExample}
              onChange={setAgentExample}
              required={Boolean(agentUse) && agentUse !== 'none'}
              error={marks.agent_example}
            />
            <Picks label={t(INTEREST_QUESTIONS.devices.label)} options={INTEREST_DEVICES} value={devices} onChange={setDevices} />
          </Section>

          <Section title={t(INTEREST_SECTIONS.pains.title)}>
            <Picks label={t(INTEREST_QUESTIONS.pains.label)} options={INTEREST_PAINS} value={pains} onChange={setPains} other={otherFor('pains')} />
            <Long label={t(INTEREST_QUESTIONS.pains_text.label)} value={painsText} onChange={setPainsText} />
          </Section>

          <Section
            title={t(INTEREST_SECTIONS.parts.title)}
            lede={(
              <>
                {t('Pick the parts you would use. Each one is described in full on the')}{' '}
                <a href="/workspace">{t('features page')}</a>.
              </>
            )}
          >
            <Picks label={t(INTEREST_QUESTIONS.parts.label)} options={INTEREST_PARTS} value={parts} onChange={setParts} />
            <Long label={t(INTEREST_QUESTIONS.missing.label)} value={missing} onChange={setMissing} />
          </Section>

          <Section title={t(INTEREST_SECTIONS.wants.title)}>
            <Picks label={t(INTEREST_LIVE.label)} options={INTEREST_LIVE.options} value={live} onChange={setLive} />
            <Pick field="deployment" error={marks.deployment} label={t(INTEREST_QUESTIONS.deployment.label)} options={INTEREST_DEPLOYMENTS} value={deployment} onChange={setDeployment} />
            <Pick field="reason" error={marks.reason} label={t(INTEREST_QUESTIONS.reason.label)} options={INTEREST_REASONS} value={reason} onChange={setReason} other={otherFor('reason')} />
            {!assessmentImported && <Pick field="timeline" error={marks.timeline} label={t(INTEREST_QUESTIONS.timeline.label)} options={INTEREST_TIMELINES} value={timeline} onChange={setTimeline} />}
            <FieldGroup className="gap-3">
              <Check label={t(INTEREST_QUESTIONS.pilot.label)} checked={pilot} onChange={setPilot} />
              <Check label={t(INTEREST_QUESTIONS.call.label)} checked={call} onChange={setCall} />
            </FieldGroup>
            <Pick optional label={t(INTEREST_QUESTIONS.source.label)} options={INTEREST_SOURCES} value={source} onChange={setSource} other={otherFor('source')} />
          </Section>

          <p className="m-0 text-[13px] text-muted-foreground">
            {t('Envisioning keeps your answers in its private records and nowhere else. You get a copy by email. After that, we write to you once at most.')}
          </p>
          {shownFailure && (
            <ErrorNotice
              message={shownFailure.message}
              action={shownFailure.retry && (
                <Button type="button" variant="outline" size="xs" onClick={() => void send()}>{t('Retry')}</Button>
              )}
            />
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button type="submit" disabled={status === 'busy'}>
              {status === 'busy' ? t('Sending…') : t('Request early access')}
            </Button>
            <p className="m-0 text-sm text-destructive" role="status">
              {attempted && invalid.length > 0
                ? plural(invalid.length, { one: 'Answer the question marked.', other: 'Answer the {count} questions marked.' })
                : null}
            </p>
          </div>
        </form>

        <Card asChild className={cn(TILE, 'sticky top-[84px] gap-2.5 max-[960px]:static')}>
          <aside aria-label={t('Your plan')}>
            <div className="grid gap-1.5">
              <p className="m-0 flex items-baseline justify-between text-sm"><span>{t('Form')}</span><span className="tabular-nums text-muted-foreground">{t('{percent}% complete', { percent: percentDone })}</span></p>
              <Meter max={100} value={percentDone} label={t('Form progress')} />
            </div>
            <h2 className="m-0! text-lg!">{t('Your plan')}</h2>
            <PlanChoice plan={plan} onChange={setPlan} />
            <p className={ASIDE_NOTE}>{t('Priced per workspace, never per person. Prices aren’t final, and your answers about the tools you pay for today help us set them.')}</p>
            <a className="text-sm" href="/pricing">{t('Compare plans')}</a>
          </aside>
        </Card>
        </div>
      </div>
    </AppShell>
  );
}

/*
 * The form's repeated classes. TILE (bento.ts) styles every h2 in a tile as
 * a descendant variant, which outranks a plain utility, so a `!` utility is
 * the one way past it.
 */
export const TWO = 'grid grid-cols-2 gap-x-4 gap-y-8 max-[640px]:grid-cols-1';
/** The answers the form will not send without, by their contract names. */
type RequiredKey = 'name' | 'email' | 'company' | 'role' | 'org_kind' | 'company_size' | 'team_size' | 'work_unit' | 'agents' | 'agent_use'
  | 'agent_example' | 'relationship' | 'identity' | 'deployment' | 'reason' | 'timeline';
/** Something, an @, something with a dot: the shape a typo breaks. The Worker holds the real rule. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
export const LEGEND_NOTE = 'ml-1 text-xs font-normal text-muted-foreground';
const ASIDE_NOTE = 'm-0 text-sm leading-normal text-muted-foreground';

type PlanPick = NonNullable<InterestInput['plan']> | '';

/**
 * The plan the request names. The list is always there, prefilled when a
 * pricing button picked the plan; under it, what the picked plan costs and
 * holds. Prices and limits come from the pricing registry, so this box
 * cannot go stale.
 */
function PlanChoice({ plan, onChange }: { plan: PlanPick; onChange: (plan: PlanPick) => void }) {
  const id = useId();
  const picked = PRICING_PLANS.find((option) => option.id === plan);
  return (
    <div className="grid gap-2.5">
      <div className="grid gap-1.5">
        <Label htmlFor={id}>{t(INTEREST_QUESTIONS.plan.label)}</Label>
        <NativeSelect id={id} value={plan} onChange={(event) => onChange(event.target.value as PlanPick)}>
          <NativeSelectOption value="">{t('Not sure yet')}</NativeSelectOption>
          {PRICING_PLANS.map((option) => <NativeSelectOption key={option.id} value={option.id}>{option.name}</NativeSelectOption>)}
        </NativeSelect>
      </div>
      {picked ? (
        <div className="grid gap-1.5 rounded-md border border-border p-3">
          <p className="m-0 text-2xl font-semibold tracking-tight tabular-nums">
            €{picked.monthlyEur}<span className="text-sm font-normal text-muted-foreground"> {t('/ month')}</span>
          </p>
          <p className="m-0 text-sm text-muted-foreground">{picked.purpose}</p>
          <p className="m-0 text-sm font-semibold">{planHeadline(picked)}</p>
          <ul className="m-0 grid gap-1 pl-5 text-sm text-muted-foreground">
            {planFacts(picked).map((fact) => <li key={fact}>{fact}</li>)}
          </ul>
        </div>
      ) : (
        <p className={ASIDE_NOTE}>{t('Pick a plan to see what it includes.')}</p>
      )}
    </div>
  );
}

export function Section({ title, lede, children }: { title: string; lede?: ReactNode; children: ReactNode }) {
  return (
    <Card asChild className={cn(TILE, 'gap-8')}>
      <section>
        <div className="grid gap-2">
          <h2 className="m-0!">{title}</h2>
          {lede && <p className="m-0 text-sm leading-normal text-muted-foreground">{lede}</p>}
        </div>
        {children}
      </section>
    </Card>
  );
}

/**
 * The way in for a person's own agent (docs/FORMS.md §Agents): the sentence
 * to paste into it, and the steps it follows, in the page itself so an agent
 * driving a browser reads them too. The steps stay English: agents read them.
 */
function AgentGuide() {
  const prompt = interestAgentPrompt(PRODUCT_SITE_ORIGIN);
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
    } catch {
      // No clipboard: the sentence stays on the page to select by hand.
    }
  }
  return (
    <section aria-labelledby="agent-guide" className="mb-7 grid max-w-[44rem] gap-3 rounded-xl border p-5" data-agent-guide="">
      <h2 id="agent-guide" className="m-0 text-base font-semibold">{t('Let your agent fill it in')}</h2>
      <div className="flex items-start gap-2 max-[640px]:flex-col">
        <code className="block flex-1 rounded-md bg-muted px-3 py-2 text-sm break-words">{prompt}</code>
        <Button type="button" variant="secondary" onClick={() => void copy()}>{copied ? t('Copied') : t('Copy')}</Button>
      </div>
      <ol className={cn(ASIDE_NOTE, 'grid list-decimal gap-1 pl-5')}>
        {interestAgentSteps(PRODUCT_SITE_ORIGIN).map((step) => <li key={step}>{step}</li>)}
      </ol>
      <p className={ASIDE_NOTE}>
        <a href={INTEREST_GUIDE_PATH}>{t('Guide for agents')}</a> · <a href={INTEREST_SCHEMA_PATH}>{t('JSON Schema')}</a>
      </p>
    </section>
  );
}

/*
 * Required answers carry the mark, optional ones carry none: fifteen
 * required, one more (the agent task) once agents are in use, against
 * eighteen optional.
 */
function Text({ field, label, value, onChange, required, error, type = 'text' }: {
  field?: RequiredKey;
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  /** What is wrong with the answer, drawn under the field. */
  error?: string;
  type?: 'text' | 'email';
}) {
  const id = useId();
  const errorId = useId();
  return (
    <Field data-field={field}>
      <FieldLabel htmlFor={id}>{label}{required && <small className={LEGEND_NOTE}>{t('required')}</small>}</FieldLabel>
      <Input
        id={id}
        type={type}
        value={value}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        maxLength={type === 'email' ? 254 : INTEREST_TEXT_MAX_CHARS}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldError id={errorId}>{error}</FieldError>
    </Field>
  );
}

function Long({ field, label, value, onChange, required, error }: {
  field?: RequiredKey;
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  /** What is wrong with the answer, drawn under the field. */
  error?: string;
}) {
  const id = useId();
  const errorId = useId();
  return (
    <Field data-field={field}>
      <FieldLabel htmlFor={id}>{label}{required && <small className={LEGEND_NOTE}>{t('required')}</small>}</FieldLabel>
      <Textarea
        id={id}
        rows={3}
        value={value}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        maxLength={INTEREST_LONG_TEXT_MAX_CHARS}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldError id={errorId}>{error}</FieldError>
    </Field>
  );
}

/** A yes/no answer: one Checkbox and its label, the shadcn Field way. */
function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  const id = useId();
  return (
    <Field orientation="horizontal">
      <Checkbox id={id} checked={checked} onCheckedChange={(next) => onChange(next === true)} />
      <FieldLabel htmlFor={id} className="font-normal">{label}</FieldLabel>
    </Field>
  );
}

/**
 * One of many: a radio group drawn as pills. The legend says "pick one" and
 * the pills are round; `Picks` says "pick any" and draws a box on each
 * choice, so the two read apart before anything is clicked.
 */
export function Pick<T extends string>({ field, error, label, note, options, value, onChange, other, optional }: {
  /** The answer's contract name, which a submit that stops scrolls to. Absent on an optional Pick. */
  field?: string;
  /** What is wrong with the answer, drawn under the pills. */
  error?: string;
  /** A Pick is required unless this says otherwise. */
  optional?: boolean;
  label: string;
  /** One plain line under the legend: a fact the answer depends on. */
  note?: string;
  options: readonly InterestOption<T>[];
  value: T | '';
  onChange: (value: T) => void;
  other?: OtherText;
}) {
  const [query, setQuery] = useState('');
  const opened = options.find((option) => option.other && option.id === value);
  const errorId = useId();
  const visibleOptions = filterOptions(options, query);
  return (
    <FieldSet className="gap-3" data-field={field}>
      <FieldLegend variant="label">{label} <small className={LEGEND_NOTE}>{optional ? t('pick one') : t('required, pick one')}</small></FieldLegend>
      {note && <FieldDescription>{note}</FieldDescription>}
      {options.length > 8 && <Input type="search" value={query} placeholder={t('Search options')} aria-label={t('Search options')} onChange={(event) => setQuery(event.target.value)} />}
      {/* shadcn ToggleGroup, single: a radio group of pills; picking the chosen one again keeps it. */}
      <ToggleGroup
        type="single"
        variant="outline"
        spacing={2}
        className="flex-wrap"
        aria-describedby={error ? errorId : undefined}
        value={value}
        onValueChange={(next) => { if (next) onChange(next as typeof options[number]['id']); }}
      >
        {visibleOptions.map((option) => (
          <ToggleGroupItem
            key={option.id}
            value={option.id}
            onClick={() => setQuery('')}
            aria-invalid={error ? true : undefined}
            className="rounded-full font-normal data-[state=on]:border-foreground data-[state=on]:bg-foreground data-[state=on]:text-background"
          >
            {t(option.label)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {query && visibleOptions.length === 0 && <FieldDescription>{t('No options match.')}</FieldDescription>}
      <FieldError id={errorId}>{error}</FieldError>
      {opened && other && <Other label={t(opened.label)} {...other} />}
    </FieldSet>
  );
}

export interface OtherText {
  value: string;
  onChange: (value: string) => void;
}

/** The short field an Other opens: what the list did not offer. */
export function Other({ label, value, onChange }: OtherText & { label: string }) {
  return (
    <Input
      className="w-[min(100%,24rem)]"
      type="text"
      value={value}
      placeholder={t('Which?')}
      aria-label={label}
      maxLength={INTEREST_TEXT_MAX_CHARS}
      autoFocus
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/**
 * Any of many: shadcn choice cards, each a FieldLabel around a Checkbox. A
 * list whose options carry a hint shows one line of plain words under each
 * name, two cards a row, so a stranger can answer without knowing what the
 * names mean.
 */
export function Picks({ label, options, value, onChange, other, minimumSelection }: {
  label: string;
  options: readonly InterestOption[];
  value: string[];
  onChange: (value: string[]) => void;
  other?: OtherText;
  minimumSelection?: number;
}) {
  const [query, setQuery] = useState('');
  const cards = options.some((option) => option.hint);
  const exclusive = options.filter((option) => option.exclusive).map((option) => option.id);
  const opened = options.find((option) => option.other && value.includes(option.id));
  const visibleOptions = filterOptions(options, query);
  return (
    <FieldSet className="gap-3">
      <FieldLegend variant="label">{label} <small className={LEGEND_NOTE}>{t('pick any')}</small></FieldLegend>
      {options.length > 8 && <Input type="search" value={query} placeholder={t('Search options')} aria-label={t('Search options')} onChange={(event) => setQuery(event.target.value)} />}
      <div className={cards ? 'grid grid-cols-2 gap-2 max-[640px]:grid-cols-1' : 'flex flex-wrap gap-2'}>
        {visibleOptions.map((option) => {
          const on = value.includes(option.id);
          const toggle = () => {
            if (on) {
              if (value.length <= (minimumSelection ?? 0)) return;
              return onChange(value.filter((id) => id !== option.id));
            }
            if (option.exclusive) return onChange([option.id]);
            return onChange([...value.filter((id) => !exclusive.includes(id)), option.id]);
          };
          return (
            <FieldLabel key={option.id} className={cards ? undefined : 'w-auto!'}>
              <Field orientation="horizontal">
                <Checkbox checked={on} onCheckedChange={toggle} />
                {cards ? (
                  <FieldContent>
                    <FieldTitle>{t(option.label)}</FieldTitle>
                    {option.hint && <FieldDescription className="text-xs">{t(option.hint)}</FieldDescription>}
                  </FieldContent>
                ) : <FieldTitle className="font-normal">{t(option.label)}</FieldTitle>}
              </Field>
            </FieldLabel>
          );
        })}
      </div>
      {query && visibleOptions.length === 0 && <FieldDescription>{t('No options match.')}</FieldDescription>}
      {opened && other && <Other label={t(opened.label)} {...other} />}
    </FieldSet>
  );
}

function filterOptions<T extends InterestOption>(options: readonly T[], query: string): T[] {
  const needle = foldOptionText(query);
  return needle ? options.filter((option) => foldOptionText(option.label).includes(needle)) : [...options];
}

function foldOptionText(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase();
}
