import { useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Label } from '@/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/ui/toggle-group';
import { Card } from '@/ui/card';
import { HERO, PAGE, TILE } from './bento';
import { LinkTile, Callout } from './feature-tiles';
import { useDocumentTitle } from './document-title';
import { AppShell } from './SiteChrome';
import { dateLocale, plural, t } from '@shared/i18n';
import { PRICING_PLANS, SELF_SERVE_PLANS, STACK_TOOLS, planAction, planFacts, planForTeam, planHeadline, stackToolCost, type PlanLimits, type PricingPlan, type StackTool } from './pricing';
import { EarlyAccess } from './EarlyAccess';

/** Proposed workspace plans. No checkout or production entitlement claims. */
const count = new Intl.NumberFormat(dateLocale);

const notes = (n: number) => (n === 0 ? t('Your own agent') : count.format(n));

/** One row per limit, read from the registry so the table cannot drift from the cards. */
const LIMIT_ROWS: readonly { label: string; value: (limits: PlanLimits) => string }[] = [
  { label: t('Teammates'), value: (l) => count.format(l.teammates) },
  { label: t('Guests on shared projects'), value: (l) => count.format(l.guests) },
  { label: t('Shared agents'), value: (l) => count.format(l.sharedAgents) },
  { label: t('Personal assistants'), value: () => t('One per teammate') },
  { label: t('Active projects'), value: (l) => count.format(l.activeProjects) },
  { label: t('People in one call'), value: (l) => count.format(l.peopleInCall) },
  { label: t('Call minutes a month, per person'), value: (l) => count.format(l.callMinutes) },
  { label: t('Call length'), value: (l) => (l.callLength === null ? t('No limit') : t('{n} minutes', { n: l.callLength })) },
  { label: t('Calls with built-in notes a month'), value: (l) => notes(l.notedCalls) },
  { label: t('Storage'), value: (l) => (l.storageGb >= 1000 ? t('{n} TB', { n: l.storageGb / 1000 }) : t('{n} GB', { n: l.storageGb })) },
];

const FEATURE_ROWS: readonly { label: string; values: Record<PricingPlan['id'], string> }[] = [
  { label: t('Scheduled and event-triggered workflows'), values: { free: '–', starter: '–', team: '–', pro: t('Planned') } },
  { label: t('Permissions, action log and export'), values: { free: t('Included'), starter: t('Included'), team: t('Included'), pro: t('Included') } },
];

/** Team sizes the comparison offers, one inside each paid plan. */
const TEAM_SIZES = [5, 10, 20, 40] as const;

const euro = (value: number) => `€${count.format(Math.round(value))}`;

/**
 * What the per-person stack costs a team, beside the plan that holds it.
 * Pick a size and the tools you pay for; each row says what does that job in
 * Starlings. Typical list prices, examples of a category, never a verdict.
 */
function StackComparison() {
  const [people, setPeople] = useState<number>(10);
  const [on, setOn] = useState<ReadonlySet<StackTool['id']>>(() => new Set(STACK_TOOLS.filter((tool) => tool.common).map((tool) => tool.id)));
  const plan = planForTeam(people);
  const stack = STACK_TOOLS.filter((tool) => on.has(tool.id)).reduce((sum, tool) => sum + stackToolCost(tool, people), 0);
  const toggle = (id: StackTool['id'], checked: boolean) => setOn((current) => {
    const next = new Set(current);
    if (checked) next.add(id); else next.delete(id);
    return next;
  });

  return (
    <Card asChild className={cn(TILE, 'mb-4 gap-4')}>
      <section aria-labelledby="stack-comparison">
        <h2 id="stack-comparison">{t('What it replaces')}</h2>
        <p className="m-0 text-sm text-muted-foreground">{t('Tick the tools your team pays for. Typical list prices per person, ex VAT; yours may differ.')}</p>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium" id="stack-team-size">{t('Team size')}</span>
          <ToggleGroup type="single" variant="outline" spacing={2} aria-labelledby="stack-team-size" value={String(people)} onValueChange={(next) => { if (next) setPeople(Number(next)); }}>
            {TEAM_SIZES.map((size) => <ToggleGroupItem key={size} value={String(size)}>{t('{count} people', { count: size })}</ToggleGroupItem>)}
          </ToggleGroup>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[200px] whitespace-normal">{t('You pay for')}</TableHead>
              <TableHead className="min-w-[200px] whitespace-normal">{t('In Starlings')}</TableHead>
              <TableHead className="text-right">{t('A month')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {STACK_TOOLS.map((tool) => {
              const id = `stack-${tool.id}`;
              const checked = on.has(tool.id);
              return (
                <TableRow key={tool.id} className={checked ? undefined : 'text-muted-foreground'}>
                  <TableCell className="whitespace-normal">
                    <Label htmlFor={id} className="items-start gap-2.5 font-normal leading-normal">
                      <Checkbox id={id} checked={checked} onCheckedChange={(next) => toggle(tool.id, next === true)} className="mt-0.5" />
                      <span><span className="font-medium text-foreground">{tool.label}</span><br /><span className="text-xs text-muted-foreground">{tool.examples}</span></span>
                    </Label>
                  </TableCell>
                  <TableCell className="whitespace-normal text-muted-foreground">{tool.replaces}</TableCell>
                  <TableCell className="text-right tabular-nums">{checked ? euro(stackToolCost(tool, people)) : '–'}</TableCell>
                </TableRow>
              );
            })}
            <TableRow className="font-semibold">
              <TableCell colSpan={2}>{t('The stack')}</TableCell>
              <TableCell className="text-right tabular-nums">{euro(stack)}</TableCell>
            </TableRow>
            <TableRow className="font-semibold">
              <TableCell colSpan={2}>{t('Starlings {name}, up to {n} teammates', { name: plan.name, n: count.format(plan.limits.teammates) })}</TableCell>
              <TableCell className="text-right tabular-nums">{euro(plan.monthlyEur)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <p className="m-0 text-sm text-muted-foreground">{t('Google Workspace or Microsoft 365 stays: Starlings uses it for sign-in, calendar and mail.')}</p>
      </section>
    </Card>
  );
}

/** The plan's call to action, pinned to the bottom of its card. */
function PlanButton({ plan }: { plan: PricingPlan }) {
  const action = planAction(plan);
  return (
    <Button asChild variant={plan.highlighted ? 'default' : 'outline'} className="mt-auto self-start hover:no-underline">
      <a href={action.href} aria-label={`${action.label}: ${plan.name}`} data-event="Plan picked" data-event-plan={plan.id}>{action.label}</a>
    </Button>
  );
}

export function PricingPage() {
  useDocumentTitle(t('What Starlings costs'));

  return (
    <AppShell variant="wide" product="pricing">
      <div className={PAGE}>
        <header className={HERO}>
          <h1>{t('One workspace. Room to grow.')}</h1>
          <p className="lede">{t('Pay per workspace, not per person. Each plan sets how many people, guests and agents it holds, and each step up gives you more room than it costs.')}</p>
          <Callout className="mt-4 mb-0 max-w-[48rem] text-sm leading-normal">
            <strong>{t('Proposed plans, not available to buy yet.')}</strong>{' '}
            {t('Prices and limits may change before launch. Prices exclude VAT. Pay monthly or yearly; a year costs ten months.')}
          </Callout>
        </header>

        <div className="mb-4 grid grid-cols-4 gap-4 max-[1000px]:grid-cols-2 max-[640px]:grid-cols-1">
          {SELF_SERVE_PLANS.map((plan) => (
            <Card asChild key={plan.id} className={cn(TILE, 'gap-4', plan.highlighted && 'border-2 border-(--accent)')}>
              <section aria-labelledby={`plan-${plan.id}`}>
                <div>
                  <h2 id={`plan-${plan.id}`}>{plan.name}</h2>
                  <p className="m-0 text-sm text-muted-foreground">{plan.purpose}</p>
                </div>
                <div>
                  <p className="m-0 text-[36px] font-semibold tracking-tight tabular-nums">€{plan.monthlyEur}</p>
                  <p className="m-0 text-sm text-muted-foreground">{t('Per workspace / month')}</p>
                </div>
                <p className="font-semibold text-foreground!">{planHeadline(plan)}</p>
                <ul className="m-0 grid gap-3 pl-5 text-sm leading-relaxed text-muted-foreground">
                  {planFacts(plan).map((fact) => <li key={fact}>{fact}</li>)}
                </ul>
                {plan.id === 'pro' ? <p className="text-sm font-medium text-foreground!">{t('Scheduled agent work planned')}</p> : null}
                <PlanButton plan={plan} />
              </section>
            </Card>
          ))}
        </div>

        <Card asChild className={cn(TILE, 'mb-4 gap-4')}>
          <section>
            <h2>{t('Compare the proposed plans')}</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[200px] whitespace-normal">{t('Each workspace gets')}</TableHead>
                  {PRICING_PLANS.map((plan) => <TableHead key={plan.id} className="min-w-[96px]">{plan.name}</TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {LIMIT_ROWS.map((row) => (
                  <TableRow key={row.label}>
                    <TableCell className="whitespace-normal font-medium">{row.label}</TableCell>
                    {PRICING_PLANS.map((plan) => <TableCell key={plan.id} className="whitespace-normal tabular-nums text-muted-foreground">{row.value(plan.limits)}</TableCell>)}
                  </TableRow>
                ))}
                {FEATURE_ROWS.map((row) => (
                  <TableRow key={row.label}>
                    <TableCell className="whitespace-normal font-medium">{row.label}</TableCell>
                    {PRICING_PLANS.map((plan) => <TableCell key={plan.id} className="whitespace-normal text-muted-foreground">{row.values[plan.id]}</TableCell>)}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p>{t('A plan upgrade never expands someone’s access to private data.')}</p>
          </section>
        </Card>

        <StackComparison />

        <div className="grid grid-cols-2 gap-4 max-[800px]:grid-cols-1">
          <Card asChild className={cn(TILE, 'gap-3')}>
            <section>
              <h2>{t('When to move up')}</h2>
              <p>{t('Start free on one project. Move to Starter for built-in call notes and more projects. Move to Team or Pro when your team, your clients or your projects outgrow the plan.')}</p>
              <p>{t('Limits are soft. At a limit you can’t add the next person, project or call. Nothing you have stops working, and a call in progress never ends early.')}</p>
              <p>{t('People who join a call from a link don’t count as guests.')}</p>
            </section>
          </Card>
          <Card asChild className={cn(TILE, 'gap-3')}>
            <section>
              <h2>{t('Free, trials and providers')}</h2>
              <p>{t('Free is a permanent plan, not a trial. It never turns into a paid subscription unless you choose to upgrade. You can try one paid plan free for 14 days.')}</p>
              <p>{t('You choose your model and agent providers and pay them directly. No plan charges per person or per agent.')}</p>
            </section>
          </Card>
        </div>

        <EarlyAccess links={<LinkTile href="/faq" title={t('Questions and answers')} text={t('What teams ask about data, agents, pricing and early access.')} />} />
      </div>
    </AppShell>
  );
}
