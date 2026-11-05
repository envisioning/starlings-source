import { t } from '@shared/i18n';
import { PRICING_PLANS } from './pricing';

/**
 * The questions /faq answers, as data: the page draws them, and the prerender
 * writes the same list as FAQPage structured data, so the answer a search
 * engine shows is the answer on the page. Every answer is shipped behaviour,
 * the same facts as /workspace, /security and /integrations; prices come from
 * the pricing registry, so the FAQ cannot quote a stale price.
 */

export type FaqEntry = {
  question: string;
  answer: string;
  /** Where the full answer lives. */
  more?: { href: string; label: string };
};

const plans = PRICING_PLANS.map((plan) => `${plan.name} €${plan.monthlyEur}`).join(', ');

export const FAQ_GROUPS: ReadonlyArray<{ title: string; entries: readonly FaqEntry[] }> = [
  {
    title: 'The product',
    entries: [
      {
        question: 'What is Starlings?',
        answer: 'One workspace for a team and its AI agents: calls, chat, tasks, docs and calendar, organized by project. Your people and your agents work from the same context.',
        more: { href: '/workspace', label: 'Every feature' },
      },
      {
        question: 'Who is it for?',
        answer: 'Small teams running several projects at once, such as client engagements, products or research. It fits consultancies, studios and agencies, research and advisory teams, and founders and small crews shipping a product.',
        more: { href: '/for', label: 'Starlings for your team' },
      },
      {
        question: 'Why not just talk to my agent in Telegram or WhatsApp?',
        answer: 'A chat works when it’s just you and one agent. Nobody else sees the work, though. In Starlings the agent is on the team: you hand it a card on a project, say what done looks like, and it stops at Review for a person to accept. Its drafts go into Docs and its questions come to your Inbox, so your team can follow along, and the next agent picks up from what’s already on the project.',
        more: { href: '/why#chat', label: t('Why Starlings') },
      },
      {
        question: 'Do I need a Mac?',
        answer: 'Whoever hosts a call needs the Mac app (macOS 14 or later) or the iPhone app (iOS 17 or later). Guests join from any browser. Members can do everything else in the web app.',
        more: { href: '/download', label: 'Download the apps' },
      },
      {
        question: 'Do guests need an account?',
        answer: 'No. A guest opens the link, types a name and an email, and waits until the host lets them in. Nothing to install.',
      },
      {
        question: 'Does it work with Zoom, Teams and Google Meet calls?',
        answer: 'Yes. The Starlings Mac app transcribes Zoom, Teams, Webex and Google Meet calls and files them on the project with the rest.',
      },
    ],
  },
  {
    title: 'Data and privacy',
    entries: [
      {
        question: 'Are calls recorded?',
        answer: 'No. The host’s Mac or iPhone transcribes the call as it happens and discards the audio. Only the text leaves the device. Starlings never stores call audio or video.',
      },
      {
        question: 'Where is my data stored?',
        answer: 'On Cloudflare, in your own workspace, kept apart from every other workspace. Direct messages are stored only in the EU. Starlings backs up every room and conversation to an EU bucket each day and keeps each copy thirty days.',
        more: { href: '/security', label: 'Security and data' },
      },
      {
        question: 'Can I export my data?',
        answer: 'Yes. Download transcripts and notes as plain Markdown files at any time.',
      },
      {
        question: 'Do AI model providers train on our data?',
        answer: 'No. A model writes the call notes from the transcript text, and the model providers do not train on it.',
        more: { href: '/privacy', label: 'Privacy policy' },
      },
      {
        question: 'How do we sign in?',
        answer: 'With your company’s Google Workspace accounts. Only accounts from your company can sign in and host calls.',
      },
    ],
  },
  {
    title: 'AI agents',
    entries: [
      {
        question: 'Which AI agents work with Starlings?',
        answer: 'Claude connects through MCP, in claude.ai, Claude Desktop and Claude Code. Shared agents run on Vercel Eve and appear in your team list. We are testing more agents and runtimes.',
        more: { href: '/integrations', label: 'Integrations' },
      },
      {
        question: 'What can an agent do in our workspace?',
        answer: 'Read what the person who connected it can read. Writes are a permission you grant when you connect, and they are off by default. Starlings logs every call it makes under the name of the person who asked, and you can revoke an agent in Settings. When an agent needs a person to choose, it files a decision in your INBOX and waits.',
      },
      {
        question: 'Do agents cost extra?',
        answer: 'No plan charges per agent. Each plan sets how many shared agents it holds, and every teammate can connect a personal assistant. You choose your model and agent providers and pay them directly.',
      },
    ],
  },
  {
    title: 'Pricing and access',
    entries: [
      {
        question: 'What does Starlings cost?',
        answer: `The proposed plans are priced per workspace each month: ${plans}. No plan charges per person or agent; each plan sets how many it holds. Pay monthly or yearly. Prices may change before launch and exclude VAT.`,
        more: { href: '/pricing', label: 'Pricing' },
      },
      {
        question: 'Can we use it now?',
        answer: 'Starlings is in early access. Tell us how your team works today, and we will set up a workspace for your team.',
        more: { href: '/interest', label: 'Request early access' },
      },
    ],
  },
];

export const FAQ_ENTRIES: readonly FaqEntry[] = FAQ_GROUPS.flatMap((group) => group.entries);
