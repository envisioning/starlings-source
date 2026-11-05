import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { AppShell } from './SiteChrome';
import { useDocumentTitle } from './document-title';
import { PersonGlyph, RosterFigure, SampleAgentFace } from './bento-figures';
import { feature } from './features';
import { DISPLAY, HEADING_SMALL, HERO, ILLUSTRATION, PAGE } from './bento';
import { MiniMeet } from './MiniMeet';
import { ThreadsSim } from './sim/ThreadsSim';
import { EarlyAccess } from './EarlyAccess';
import { LinkTile, Callout } from './feature-tiles';
import { t } from '@shared/i18n';

/**
 * /why — the argument, where /workspace is the inventory.
 *
 * Two readers, one argument (MZ, 2026-10-04): a small firm that works
 * with outsiders all day, and a crew starting something, both already
 * handing part of the work to agents (STRATEGY (HQ Docs) §Who it is for).
 * Each reader has its own /for page. The page opens on the two moments MZ
 * named: people and agents on one project, and a few people working like a
 * bigger team. Their stack is
 * wired together: calls in one tool, transcripts in another, tasks, chat and
 * documents each in their own, joined by APIs, webhooks and MCP servers. Each
 * section names a situation they are in, then the outcome Starlings gives instead.
 * Headlines state the outcome; the surface is named once, in the body.
 *
 * Product claims describe shipped behavior. Speaking agents are marked
 * `Direction`; the ecosystem comparison marks unvalidated integrations.
 *
 * The figures are the feature library's (`features.tsx`), read by id: the
 * argument and the inventory show a reader the same pictures, so the product
 * page they meet second is recognisably the one they met first. Each one repeats what the
 * prose beside it says, so it is decorative and hidden from the reader who
 * is listening rather than looking.
 */
export function WhyPage() {
  useDocumentTitle('Why Starlings');

  return (
    <AppShell variant="wide" product="why">
      <div className={PAGE}>
        <header className={cn(HERO, 'max-w-[48rem]')}>
          <h1>{t('A few people and their agents, working as one team.')}</h1>
          <p className="lede">
            {t('Work, messages, calls and docs share one project record. Your team and your agents can use the same context, build on what the company knows, and see which questions need a person’s answer.')}
          </p>
          <p className="mt-3 mb-0 text-[15px] text-muted-foreground">
            {t('For small teams, from a firm with clients to a crew starting something new. Hosts run calls from a Mac or iPhone, and guests join from a browser.')}
          </p>
        </header>

        {/* The app, before the argument about it: the same carousel the
            features page shows, so the reader sees Starlings running before
            reading a word about why it runs that way. */}
        <MiniMeet />

        {/* Two readers, one argument (STRATEGY (HQ Docs) §Who it is for): the
            firm with clients and the new crew. Each has its own /for page. */}
        <Section id="who" title={t('Firms with clients, and crews starting something new.')}>
          <p>
            {t('Some teams already run several projects at once: client engagements, products, studies. Consultancies, studios, research teams and small funds that already hand part of the work to Claude or another agent.')}
          </p>
          <p>
            {t('Others are just starting. Founders, small crews and collectives build a company with agents from the first day. They have nothing to migrate, so all of their work is in Starlings from the start.')}
          </p>
          <p>
            See how it works for <a href="/for/consultancies">consultancies</a>,{' '}
            <a href="/for/studios">studios and agencies</a>,{' '}
            <a href="/for/research">research and advisory teams</a>,{' '}
            <a href="/for/product-teams">{t('product crews')}</a> and{' '}
            <a href="/for/new-companies">{t('new companies')}</a>.
          </p>
        </Section>

        {/* The two moments MZ named as the heart of it (2026-10-04): people
            and agents in one room, and a few people working like a bigger
            team. Shipped behaviour only. */}
        <Section id="together" title={t('People and agents, on the same project.')} figure={feature('shared-agents').figure}>
          <Instead>{t('Instead of agents that work off to the side and report back to one person.')}</Instead>
          <p>
            {t('In Starlings an agent is a member of the team. Team lists it next to the people, and shows who is free, who is in a call and which agent is working.')}
          </p>
          <p>
            {t('Everyone works on the same project. After a call, its transcript is on the project, and each task from it can go to a person or to an agent. In the project’s thread you mention an agent the way you mention a colleague, and its reply appears there for everyone. When it needs a decision, it asks, and the answer goes on the project.')}
          </p>
          <p>
            {t('Nobody has to forward anything. The next person on the project, or the next agent, reads the same history and carries on.')}
          </p>
        </Section>

        <Section id="crew" title={t('A small team that works like a bigger one.')}>
          <Instead>{t('Instead of hiring someone to keep the notes, the follow-ups and the status updates.')}</Instead>
          <p>
            {t('Agents take the work that usually needs another person: the brief before a call, the follow-up after it, the first draft of the proposal, the list of what is still open. They do it on the project, under the name of the person who asked, so you always know who did what.')}
          </p>
          <p>
            {t('Pricing is per workspace. Adding a person or an agent never adds a seat, so the team can grow with agents and the bill does not grow per head.')}
          </p>
          <p>
            {t('A new company starts with a clean record. From the first call, every decision, task and document is on the project it belongs to.')}
          </p>
        </Section>

        <Section id="stack" title="Seven tools, and no single place for the project.">
          <p>
            The call is on Zoom. Fireflies posts the transcript to Slack.
            A Zap opens the Linear issue. The deck is in Drive, the contact is in
            HubSpot, and an MCP server on each side lets Claude read all of it.
            Each tool has its own idea of what a project is, who a person is and
            what counts as done, and someone on your team keeps the connections
            running. Two weeks later, nobody can find the decision.
          </p>
          <p>
            Envisioning worked this way. We built Starlings to replace it.
          </p>
        </Section>

        <Section id="one-place" title="Every part of the work, on the project it belongs to." figure={feature('project').figure}>
          <Instead>Instead of one project spread across seven tools.</Instead>
          <p>
            {t('In Starlings, calls, messages, tasks, issues and documents attach to the project they are about. Open the project to see its history and follow its links to the work and documents behind it.')}
          </p>
        </Section>

        <Section id="memory" title={t('Docs is your company’s second brain.')} figure={feature('docs').figure}>
          <p>{feature('docs').fact}</p>
          <p>{t('A brief belongs to its project. A playbook explains how the team works. Research links to the sources behind it. Keep that knowledge in Docs so a colleague or an authorized agent can use it for the next assignment.')}</p>
          <p>{t('Ask an agent to prepare a proposal from the project’s brief and your company playbook. It can read those documents through its permitted connection and save a draft back to the project for the team to review.')}</p>
          <p><a href="/workspace/capabilities#feature-docs">{t('Explore Docs')}</a></p>
        </Section>

        <Section id="attention" title={t('Know when your agents need you.')} figure={feature('attention').figure}>
          <p>{feature('attention').fact}</p>
          <p>{t('An agent preparing the proposal needs to know which audience to write for. On web, its assigned question appears in the conversation and in Home and Work Inbox. Answer in one view and the others show the same result. Opening the message leaves the question pending.')}</p>
          <p>{t('A decision is a different request: it includes options, a recommendation and a default-by day, and can be answered from Inbox on Mac, iPhone, iPad or web. The date does not decide for you. An informational question supplies an answer; it does not grant permission to act.')}</p>
          <p className="text-muted-foreground!">{t('Mac and iPhone question replies work in chat. Connected question Inbox controls and focus-aware notification coordination are still planned.')}</p>
          <p><a href="/integrations#feature-attention">{t('Explore the attention queue')}</a></p>
        </Section>

        {/* Not a library figure: this roster argues that agents sit beside people. */}
        <Section id="agents" title="Your agents work from the same context as your team." figure={(
            <RosterFigure rows={[
              { mark: <PersonGlyph />, label: 'A colleague', presence: 'on' },
              { mark: <SampleAgentFace className="size-full" />, label: 'Your Claude, working as you', presence: 'on' },
              { mark: <SampleAgentFace seed="shared" className="size-full" />, label: 'A shared agent, hosted on Eve', presence: 'on' },
            ]} />
          )}>
          <Instead>Instead of an MCP server per tool and an agent that pieces the company back together.</Instead>
          <p>
            An agent preparing for a call needs the last conversation, the
            open tasks, the documents and the decisions already made. In
            Starlings they’re all on the same project, so the agent reads them
            in one place and files its work where the team will look for it.
          </p>
          <p>
            {t('Connect an OAuth-capable MCP client and it works with the access you grant: reads first, writes only when allowed. Starlings logs each tool call. Shared agents have their own identity in Team and reply in the conversations where you address them. Envisioning’s shared agents run on Vercel Eve.')}
          </p>
          <p>
            {t('Ask an agent to prepare a brief before a call, review open tasks, or draft a document and file it on the project. The next person or authorized agent can continue from that shared record.')}
          </p>
          <Callout>
            <strong>Coming later.</strong> Agents will be able to join a call
            as participants. The host admits them like any guest, and Starlings
            transcribes what they say.
          </Callout>
        </Section>

        {/* The other thing the reader has today: not seven tools, but one
            private chat per agent. Only shipped behaviour here: tasks in Work,
            drafts in Docs, decisions in INBOX, the record on the project. */}
        <Section id="chat" title={t('Your team sees what your agents do.')} figure={feature('decisions').figure}>
          <Instead>{t('Instead of a private chat with each agent that only you can read.')}</Instead>
          <p>
            {t('Lots of people already work with an agent through a bot in Telegram or WhatsApp, or a Claude window. For one person and one agent, that works. The trouble is that the work stays in your thread. Your colleagues never see it, and the next agent you try starts from nothing.')}
          </p>
          <p>
            {t('In Starlings the agent is on the team. You hand it a card on a project and say what done looks like. It stops at Review, and a person accepts the work. Drafts go into Docs. If it needs you to decide something, the question appears in your Inbox and your answer is saved on the project. Anyone who opens the card can see what the agent did and who asked for it.')}
          </p>
          <p>
            {t('Switch to another agent and the task, its thread and its documents are still there. The new agent reads them from the project.')}
          </p>
        </Section>

        <Section id="agent-ecosystem" title="Bring the agents you already use.">
          <p>
            Claude works with Starlings today, and Envisioning’s shared agents
            run on Vercel Eve. We’re building common integration points so
            agents from other providers can join too, including personal
            assistants, coding and research agents, and agents you run yourself.
          </p>
          <p>
            Whichever agent does the work, Starlings keeps the assignment, its
            context and the result on the project, with the name of the person
            who asked. <a href="/integrations#agent-ecosystem">See which agents work today</a>.
          </p>
          <ThreadsSim className="my-8" />
        </Section>

        <Section id="transcript" title="Calls write their own notes." figure={feature('captions').figure}>
          <Instead>Instead of a notetaker bot and a transcript posted to a channel.</Instead>
          <p>
            The host’s Mac or iPhone transcribes the call as it happens, with
            each speaker named. Everyone in the call sees live captions. When
            the call ends, the transcript is on the project with everything
            else. The same Mac also transcribes your Zoom, Teams and Google Meet
            calls and files them in Starlings.
          </p>
        </Section>

        <Section id="guests" title="Guests join from a link." figure={feature('join-link').figure}>
          <Instead>Instead of an install, an account and a mic nobody enabled.</Instead>
          <p>
            A guest opens the link, types a name and waits until you let them
            in. Your booking page gives them a time and the same link. Guests
            don’t install anything or create an account.
          </p>
        </Section>

        <Section id="follow-up" title="Starlings drafts the summary and the tasks." figure={feature('transcript-tasks').figure}>
          <Instead>Instead of copying action items out of a transcript.</Instead>
          <p>
            {t('After a call, its transcript and notes stay with the project. Starlings proposes tasks from commitments in the transcript; accepted tasks link to their source call. Participants with artifact access can return to the notes in Starlings.')}
          </p>
        </Section>

        <Section id="yours" title="Home shows your day first.">
          <Instead>Instead of a company-wide feed.</Instead>
          <p>
            Home shows your next call, the tasks due and the threads that moved.
            Quick Notes and your personal calendars stay private until you file
            them. When you file something, it takes the access rules of the
            place you file it into.
          </p>
        </Section>

        <Section id="own" title="Your data stays yours." figure={feature('building-blocks').figure}>
          <Instead>Instead of a platform that keeps every company’s data in one place.</Instead>
          <p>
            Calls run from the Mac or iPhone in front of you, under your Google
            account. Video passes through without being stored. Records,
            documents and passwords each live in a separate service with its
            own storage and its own key. You can download transcripts and notes
            as plain files.
          </p>
          <Callout>
            <strong>Early access.</strong> Today Starlings runs Envisioning.
            We’re setting it up for a few teams we already work with, each in a
            separate workspace.
          </Callout>
        </Section>

        <EarlyAccess links={<>
          <LinkTile href="/workspace" title={t('Every feature')} text={t('What Starlings does today, on each platform.')} />
          <LinkTile href="/pricing" title={t('Pricing')} text={t('Plans per workspace, never per person or agent.')} />
        </>} />
      </div>
    </AppShell>
  );
}

/**
 * One argument: the outcome as the heading,
 * the prose under it, and the drawing of the thing beside it. A section
 * without a figure is not a gap — the rhythm of some sections standing on
 * their words alone is what keeps the drawings worth looking at.
 */
function Section({ id, title, figure, children }: {
  id: string;
  title: string;
  figure?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn(
        'mx-0 mt-0 mb-20 max-w-[44rem] scroll-mt-[88px] max-[800px]:mb-14',
        // A section with a drawing reads as two columns: the argument, then
        // the thing it is about. The prose column keeps its own measure, so a
        // wide window makes the picture bigger rather than the sentences longer.
        figure && 'grid max-w-[68rem] grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] items-start gap-8 max-[860px]:grid-cols-[minmax(0,1fr)] max-[860px]:gap-[18px]',
      )}
    >
      <div className="min-w-0 [&_p]:mx-0 [&_p]:mt-0 [&_p]:mb-3.5 [&_p]:text-[17px] [&_p]:leading-[1.55] [&_p]:text-foreground">
        <h2 className={cn(DISPLAY, HEADING_SMALL, 'mx-0 mt-1.5 mb-2.5 text-balance')}>{title}</h2>
        {children}
      </div>
      {figure && <div className={cn(ILLUSTRATION, 'mt-[30px] min-w-0 max-[860px]:mt-0')} aria-hidden="true">{figure}</div>}
    </section>
  );
}

/** The thing the reader has today, named before the thing Starlings gives instead. */
function Instead({ children }: { children: ReactNode }) {
  // The prose rule above sets ink on every paragraph as a descendant variant, which outranks a plain utility.
  return <p className="text-muted-foreground! italic">{children}</p>;
}

function ArrowGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}
