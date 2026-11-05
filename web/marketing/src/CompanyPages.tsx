import { ORG_WEB_ORIGIN } from '@starlings/contracts/deployment';
import type { ReactNode } from 'react';
import { t } from '@shared/i18n';
import { cn } from '@/lib/utils';
import { Card } from '@/ui/card';
import { AppShell } from './SiteChrome';
import { useDocumentTitle } from './document-title';
import { GRID, HERO, PAGE, SECTION_HERO, TILE } from './bento';
import { Ext } from './feature-tiles';
import { FAQ_GROUPS } from './faq';
import { NextSteps } from './SolutionPages';

/**
 * /faq, /about and /customers/envisioning: the pages a prospect reads to
 * decide whether to trust Starlings. Each claim is shipped behaviour or a fact
 * MZ confirmed (2026-10-03): the tools Envisioning retired, the agent jobs it
 * runs, and that /about names the company, not people.
 */

export function FaqPage() {
  useDocumentTitle('Questions and answers');
  return (
    <AppShell variant="wide" product="faq">
      <div className={PAGE}>
        <header className={HERO}>
          <h1>Questions and answers.</h1>
          <p className="lede">What teams ask before they try Starlings. Not here? <a href="/interest">Ask us</a>.</p>
        </header>
        {FAQ_GROUPS.map((group) => (
          <section key={group.title} aria-labelledby={slugOf(group.title)} className="mb-14 max-w-[44rem]">
            <h2 id={slugOf(group.title)} className="mb-5">{group.title}</h2>
            <dl className="m-0 grid gap-6">
              {group.entries.map((entry) => (
                <div key={entry.question}>
                  <dt className="mb-1.5 text-[17px] font-semibold">{entry.question}</dt>
                  <dd className="m-0 text-[16px] leading-[1.55] text-muted-foreground">
                    {entry.answer}
                    {entry.more && <> <a href={entry.more.href}>{entry.more.label}</a>.</>}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <NextSteps />
      </div>
    </AppShell>
  );
}

export function AboutPage() {
  useDocumentTitle('About');
  return (
    <AppShell variant="wide" product="about">
      <div className={PAGE}>
        <header className={HERO}>
          <h1>About Starlings.</h1>
          <p className="lede">
            Starlings is built by <Ext href={ORG_WEB_ORIGIN}>Envisioning</Ext>,
            a research institute that studies how institutions adapt to
            technological change.
          </p>
        </header>

        <Prose title="Why we built it.">
          <p>
            Our work is conversations with clients and partners, and more of it
            is now done with AI agents. We ran it the usual way: calls on one
            tool, notes on another, chat, tasks and documents each somewhere
            else, joined by integrations. Our agents could read every tool, but
            nothing told them which client a note was about.
          </p>
          <p>
            So we built one workspace where calls, chat, tasks, docs and the
            calendar share one record, and where agents work from the same
            context as people. We run our own client work on it every day.
          </p>
        </Prose>

        <Prose title="What we hold to.">
          <ul className="m-0 grid gap-2 pl-5">
            <li>Your data stays yours, in a workspace kept apart from every other team’s, and you can take it with you.</li>
            <li>Every action an agent takes is logged under the name of the person who asked.</li>
            <li>{t('Agents file their work on the project it’s for, where the whole team can see it.')}</li>
            <li>Calls are transcribed on the host’s device, and audio and video are never stored.</li>
            <li>Pricing is per workspace. Adding a person or an agent never adds a seat.</li>
          </ul>
        </Prose>

        <Prose title="Where we are.">
          <p>
            Starlings is in early access. We are opening it to a few small teams
            beyond Envisioning. <a href="/customers/envisioning">Read how Envisioning uses it</a>, or{' '}
            <a href="/interest">request early access</a>.
          </p>
        </Prose>

        <NextSteps />
      </div>
    </AppShell>
  );
}

const RETIRED = ['Zoom and Google Meet for client calls', 'A meeting notetaker', 'Slack', 'Notion and a separate task tool'];

const AGENT_JOBS: ReadonlyArray<{ title: string; body: string }> = [
  { title: 'Call briefs', body: 'Before a client call, a member asks Claude for a brief. Claude reads the last calls, the open tasks and the decisions on the client through MCP, and files the brief there.' },
  { title: 'Tasks', body: t('Shared agents are listed with the team. A member hands one a card in Work and says what done looks like. The agent stops at Review, and a person accepts the result.') },
  { title: 'Documents', body: 'Agents draft proposals, briefs and follow-ups from the client’s history and file them in Docs, where the team reviews them.' },
  { title: 'Code', body: t('Repositories are mapped to projects. Hand an agent a GitHub issue from the project’s board, and each change appears in the project’s thread.') },
];

export function CustomerPage() {
  useDocumentTitle('How Envisioning runs on Starlings');
  return (
    <AppShell variant="wide" product="customers">
      <div className={PAGE}>
        <header className={HERO}>
          <p className="mb-3 text-[15px] font-medium text-muted-foreground">Customer story: Envisioning</p>
          <h1>How Envisioning runs its client work on Starlings.</h1>
          <p className="lede">
            Envisioning is a research institute. Its work is calls with clients
            and partners, and the research, documents and follow-ups around
            them, with AI agents doing a growing share. All of it now happens in
            Starlings.
          </p>
        </header>

        <Prose title="Before.">
          <p>
            Client calls ran on Zoom and Google Meet. A notetaker wrote the
            notes, chat lived in Slack, and tasks and documents lived in Notion
            and a task tool. Each tool worked. The history of a client was spread
            across all of them, and every agent needed a connection to each one
            and still had to guess which client a note was about.
          </p>
        </Prose>

        <header className={SECTION_HERO}>
          <h2>What the team retired.</h2>
        </header>
        <ul className="m-0 grid max-w-[44rem] gap-2 pl-5 text-[16px] leading-[1.55]">
          {RETIRED.map((tool) => <li key={tool}>{tool}</li>)}
        </ul>

        <Prose title="After." className={cn(SECTION_HERO, 'max-w-none')}>
          <p>
            Clients join calls from a link in their browser. The host’s Mac
            transcribes the call, and when it ends, Starlings files the
            transcript, a summary and suggested tasks on the client. The chat,
            the tasks, the documents and every past call sit on the same record,
            so anyone who opens a client sees where things stand.
          </p>
        </Prose>

        <header className={SECTION_HERO}>
          <h2>The jobs agents do.</h2>
          <p className="lede">{t('Each one works from the same client record as the team, and each job names the person who asked for it.')}</p>
        </header>
        <ol className={cn(GRID, 'm-0 list-none p-0')}>
          {AGENT_JOBS.map((job) => (
            <Card asChild key={job.title} className={cn(TILE, 'col-span-3 max-[960px]:col-span-6 max-[640px]:col-span-12')}>
              <li>
                <h2>{job.title}</h2>
                <p>{job.body}</p>
              </li>
            </Card>
          ))}
        </ol>

        <NextSteps />
      </div>
    </AppShell>
  );
}

function Prose({ title, className, children }: { title: string; className?: string; children: ReactNode }) {
  return (
    <section className={cn('mb-12 max-w-[44rem] text-[17px] leading-[1.55] [&_p]:mb-3.5', className)}>
      <h2 className="mb-4">{title}</h2>
      {children}
    </section>
  );
}

const slugOf = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/gu, '-');
