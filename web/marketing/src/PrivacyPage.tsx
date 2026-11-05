import type { ReactNode } from 'react';
import { CONTACT_EMAIL, PRIVACY_CONTACT_EMAIL, ORG_WEB_ORIGIN, PRIVACY_OFFICER_NAME } from '@starlings/contracts/deployment';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { t } from '@shared/i18n';
import { AppShell } from './SiteChrome';
import { DocArticle, DocNote } from '@shared/DocArticle';
import { DocToc } from '@shared/DocToc';
import { useDocumentTitle } from './document-title';
import { TABLE_FRAME } from './bento';
import { cn } from '@/lib/utils';

/*
 * The privacy notice (/privacy) and the terms of use (/terms) for Starlings.
 * The site is English only. Strings still go through t(), which returns them
 * as written.
 *
 * Written 2026-10-04 without legal review (MZ decided). Each claim is checked
 * against the code and docs/PRIVACY.md (locations: §Data region), docs/OPERATIONS.md §Backups and
 * services/control-plane/wrangler.jsonc. A change to a processor, a store's
 * location or a retention period changes this file in the same commit, and
 * moves the date in UPDATED.
 *
 * The company (MZ, 2026-10-04): Envisioning OÜ, Pärnu mnt 10, 10148 Tallinn,
 * Estonia, VAT EE101979991. Estonian law and Harju County Court follow from
 * the company's seat; MZ can change them. COMPANY below is the one place
 * that names it.
 */

const COMPANY = () => t('Starlings is provided by Envisioning OÜ, Pärnu mnt 10, 10148 Tallinn, Estonia. VAT number EE101979991.');

/** The date both pages show. Move it with every change of substance. */
const UPDATED = () => t('Updated 3 November 2026.');

/** "Data retention": one well per fact, the term in small caps over it. */
const FACTS = 'm-0 grid gap-3.5';
const FACT = 'grid gap-1 rounded-lg border border-border bg-muted px-4 py-3.5';
const FACT_TERM = 'text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase';
const FACT_TEXT = 'm-0 text-[15px] leading-normal font-light text-foreground';
const PROVIDER = 'px-3.5 py-3 align-top font-semibold text-foreground';
const PROVIDER_CELL = 'px-3.5 py-3 align-top font-light whitespace-normal text-muted-foreground';

/** A list item with a bold lead-in: two keys, because the prerender checks each text node. */
function Lead({ term, children }: { term: string; children: ReactNode }) {
  return <li><strong>{term}</strong> {children}</li>;
}

/** A mail link whose text is one whole sentence. */
function MailLink({ address, sentence }: { address: string; sentence: string }) {
  return <a href={`mailto:${address}`}>{sentence}</a>;
}

export function PrivacyPage() {
  useDocumentTitle(t('Privacy'));

  const providers: ReadonlyArray<readonly [string, string, string, string]> = [
    [t('Cloudflare'), t('Runs Starlings and this site: servers, databases, file storage and queues. Its Workers AI writes notes when Claude is not used, and suggests tasks during a call.'), t('Everything a workspace stores. Transcript text, for notes and task suggestions.'), t('In the workspace’s data region. See Where data is stored.')],
    [t('LiveKit'), t('Carries live audio, video and screen share. Recording is off.'), t('Live media for the length of the call, and display names.'), t('Unknown. We have not confirmed a region yet.')],
    [t('Google'), t('Member sign-in. Google Calendar, when a member connects it.'), t('Member identity. The calendar events a member creates or reads in Starlings.'), t('Unknown.')],
    [t('Anthropic'), t('Writes meeting notes with Claude. Turns text a member sends into calendar events. A member’s own Claude, when the member connects it.'), t('Transcript text and speaker names, and the title of the calendar event a recorded meeting matches. The text a member sends. What a member asks their Claude to read.'), t('Stores data in the United States. Claude can run in any region.')],
    [t('Postmark'), t('Sends email: your copy of the early-access form, and alerts to our operators.'), t('Your email address and your answers.'), t('United States.')],
    [t('GitHub'), t('Issues and pull requests, when a workspace links repositories.'), t('What a member reads or writes there.'), t('Unknown.')],
    [t('Slack'), t('Imports the channels a workspace maps to its projects, when the workspace connects Slack.'), t('The messages in those channels.'), t('Unknown.')],
    [t('Granola'), t('Imports the meeting notes a member chooses, when the member connects Granola.'), t('Those notes and their transcripts.'), t('United States.')],
    [t('TypeSafe AI'), t('Suggests where an imported Granola note belongs, through Cloudflare Workers AI or Vercel AI Gateway.'), t('The note’s title, participant names and email domains, its text and the start of its transcript.'), t('Unknown.')],
    [t('Plausible'), t('Counts visits to this site, and use of the Envisioning workspace. Sets no cookies.'), t('The page name and the site you came from. Your network address and browser, which Plausible turns into a daily count and does not store.'), t('Germany.')],
    [t('Open-Meteo'), t('Weather in the calendar, when a member names a city.'), t('A rounded location and a time zone. No identity or calendar data.'), t('Europe and North America.')],
    [t('Envisioning Core'), t('Envisioning’s own CRM. The Envisioning workspace only.'), t('A record of each call: summary, transcript, and the names and email addresses of the people in it.'), t('Unknown.')],
  ];

  const retention: ReadonlyArray<readonly [string, string]> = [
    [t('Live audio and video'), t('Not stored.')],
    [t('Audio on the host device'), t('In memory only, discarded once it is text. A call transcribed from another service is kept in temporary files on the Mac until its transcript is saved, then deleted.')],
    [t('Transcripts, notes and workspace records'), t('Kept until someone deletes them. There is no automatic expiry yet.')],
    [t('Messages'), t('Kept until the author withdraws them. There is no automatic expiry yet.')],
    [t('Waiting room requests'), t('End with the call.')],
    [t('Join-page presence'), t('About a minute.')],
    [t('Sign-in'), t('A session lasts 8 hours. A device stays signed in until it is signed out or unused for 60 days.')],
    [t('Daily backups'), t('Expire after 30 days. Something you delete can stay in a backup until then.')],
    [t('What a connected Claude asked'), t('90 days.')],
    [t('Error reports'), t('30 days. They hold no names, email addresses or content.')],
    [t('Early-access answers'), t('Kept until you ask us to delete them.')],
  ];

  return (
    <AppShell variant="document" current="privacy" product={null}>
      <DocArticle>
        <h1>{t('How Starlings handles your data')}</h1>
        <p className="lede">
          <a href={ORG_WEB_ORIGIN}>{t('Envisioning')}</a>{t(' makes Starlings. In this notice, “we” means Envisioning.')}
        </p>
        <p className="text-sm text-muted-foreground">{UPDATED()}</p>

        <DocToc
          label={t('On this page')}
          links={[
            { href: '#workspaces', label: t('Workspaces') },
            { href: '#collect', label: t('What we collect') },
            { href: '#calls', label: t('Calls') },
            { href: '#providers', label: t('Providers') },
            { href: '#location', label: t('Where data is stored') },
            { href: '#retention', label: t('Retention') },
            { href: '#rights', label: t('Your rights') },
            { href: '#contact', label: t('Contact') },
            { href: '/terms', label: t('Terms of use') },
          ]}
        />

        <section id="workspaces">
          <h2>{t('Workspaces and who decides')}</h2>
          <p>{t('Each organization that uses Starlings gets its own workspace. A workspace is a separate deployment with its own databases and file storage. Workspaces do not share records.')}</p>
          <p>{t('Envisioning uses Starlings for its own work, in a separate workspace.')}</p>
          <p>{t('The organization that runs a workspace decides who joins it and what goes in it. For that data the organization is the controller, and we process it for them. For the Envisioning workspace, and for anything you send through this site, Envisioning is the controller.')}</p>
        </section>

        <section id="collect">
          <h2>{t('What we collect and why')}</h2>
          <ul>
            <Lead term={t('Members.')}>{t('Members sign in with Google. We receive your name, email address, Google account ID and profile picture. We use them to sign you in and to show colleagues who you are. You can replace or remove the picture.')}</Lead>
            <Lead term={t('Devices and presence.')}>{t('We keep a list of the devices you signed in on and when each was last active, so you can sign a lost device out. Colleagues in your workspace can see whether you are online and when you were last active. They never see where you are.')}</Lead>
            <Lead term={t('Profile details.')}>{t('A job title, pronouns, time zone or working hours, if you add them. Colleagues in your workspace can see them.')}</Lead>
            <Lead term={t('Workspace records.')}>{t('The messages, tasks, projects, documents, decisions and notes that members write. We store them so the workspace works.')}</Lead>
            <Lead term={t('Connected services.')}>{t('When a member connects Google Calendar, GitHub, Slack, Granola or their own Claude, we exchange data with that service as the member asked. We store Google Calendar access encrypted.')}</Lead>
            <Lead term={t('Google user data.')}>{t('Starlings’ use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements. We never sell it, and we never use it to train AI models.')} <a href="https://developers.google.com/terms/api-services-user-data-policy">{t('Read the policy')}</a></Lead>
            <Lead term={t('Guests.')}>{t('Guests join a call without an account. A guest gives a name and an email address, and we keep both with the record of the call. A third-party notetaker gives a name only.')}</Lead>
            <Lead term={t('Join pages.')}>{t('While you are on a join page, the host can see that someone is there, the name you typed, and your approximate city and country, taken from your network connection. The host does not see your email address until you ask to join. This disappears about a minute after you leave.')}</Lead>
            <Lead term={t('This site.')}>{t('This site counts visits with Plausible, which sets no cookies and keeps no personal data. It runs no advertising trackers. It remembers your light or dark setting in your browser. If you send the early-access form, we keep your answers and email you a copy. We use your network address to limit abuse of the form, and we do not store it with your answers.')}</Lead>
            <Lead term={t('Logs.')}>{t('Our servers log errors. The logs hold no access tokens, transcript text, message text or full email addresses.')}</Lead>
          </ul>
        </section>

        <section id="calls">
          <h2>{t('Calls')}</h2>
          <ul>
            <li>{t('Starlings does not record the audio, video or screen share of a call.')}</li>
            <li>{t('Speech-to-text runs on the device that hosts the call. The audio stays in that device’s memory and is discarded once it is text. Only the text leaves the device: who spoke, in which language, when, and what they said.')}</li>
            <li>{t('We keep the transcript and the notes written from it, so people with access can read them after the call. We do not email them to anyone.')}</li>
            <li>{t('Guests wait in a waiting room until the host lets them in. Nobody gets the call’s audio or video before that.')}</li>
            <li>{t('If the host lets a third-party notetaker in, that service may record what it receives, under its own terms. Starlings marks it in the call, and the host can refuse notetakers.')}</li>
            <li>{t('With the Mac app, a member can also transcribe a call held on another service, such as Zoom or Teams. The audio then stays in temporary files on that Mac until the transcript is saved, and is deleted after. The audio never leaves the Mac. Starlings does not tell the other people in that call, so the member must.')}</li>
          </ul>
        </section>

        <section id="providers">
          <h2>{t('Who processes data for us')}</h2>
          <p>{t('These companies process data on our behalf. Some of them apply only when a workspace turns a feature on.')}</p>
          <div className={cn(TABLE_FRAME, 'mb-3.5')}>
            <Table className="leading-[1.45]">
              <TableHeader className="bg-muted">
                <TableRow>
                  <TableHead scope="col" className="px-3.5 text-muted-foreground">{t('Provider')}</TableHead>
                  <TableHead scope="col" className="px-3.5 text-muted-foreground">{t('What it does')}</TableHead>
                  <TableHead scope="col" className="px-3.5 text-muted-foreground">{t('What it receives')}</TableHead>
                  <TableHead scope="col" className="px-3.5 text-muted-foreground">{t('Where')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {providers.map(([name, role, data, where]) => (
                  <TableRow key={name}>
                    <TableCell className={PROVIDER}>{name}</TableCell>
                    <TableCell className={PROVIDER_CELL}>{role}</TableCell>
                    <TableCell className={PROVIDER_CELL}>{data}</TableCell>
                    <TableCell className={PROVIDER_CELL}>{where}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p>{t('Under their terms, Anthropic and Cloudflare do not train their models on this content. No cloud service ever receives the audio of a call.')}</p>
        </section>

        <section id="location">
          <h2>{t('Where data is stored')}</h2>
          <ul>
            <li>{t('Each workspace has a data region, the EU or the US, chosen when it is created.')}</li>
            <li>{t('In the EU region, we store messages, calls, transcripts, quick notes and daily backups in the EU. The Envisioning workspace is still moving its calls and quick notes to the EU.')}</li>
            <li>{t('Workspaces created from now on store files and profile pictures in the EU. Older workspaces are moving theirs.')}</li>
            <li>{t('In the US region, we place messages, calls, transcripts, quick notes, files, workspace databases and daily backups in the United States. Cloudflare treats this placement as a preference and does not guarantee it.')}</li>
            <li>{t('In the EU region, workspace databases are placed in western Europe. Sign-in and signup are placed there too, and serve every workspace from there, whatever its region. Cloudflare treats this placement as a preference and does not guarantee it.')}</li>
            <li>{t('Our servers run on Cloudflare’s network around the world, close to each user. Workers AI runs on that network too.')}</li>
            <li>{t('Postmark, Anthropic and Granola store data in the United States. LiveKit may route live media outside the EU.')}</li>
            <li>{t('Where data leaves the EU, it does so under each provider’s data protection terms.')}</li>
          </ul>
        </section>

        <section id="retention">
          <h2>{t('How long we keep it')}</h2>
          <dl className={FACTS}>
            {retention.map(([term, text]) => (
              <div key={term} className={FACT}>
                <dt className={FACT_TERM}>{term}</dt>
                <dd className={FACT_TEXT}>{text}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section id="rights">
          <h2>{t('Your rights')}</h2>
          <p>{t('You can ask to see, correct, export or delete your data, to limit how we use it, or to object to it. You can withdraw any consent you gave.')}</p>
          <p>{t('Some of this you can do yourself today:')}</p>
          <ul>
            <li>{t('Copy or download any transcript you can read, as Markdown or plain text.')}</li>
            <li>{t('As host, delete lines from a transcript or correct a speaker’s name.')}</li>
            <li>{t('Withdraw a message you wrote.')}</li>
            <li>{t('Remove your profile picture, delete your quick notes, disconnect Google Calendar and sign out any of your devices.')}</li>
          </ul>
          <p>{t('Exporting a whole workspace and deleting a whole workspace are planned and not built yet. Until then, write to us and we do it by hand.')}</p>
          <p>{t('If your data is in a workspace another organization runs, that organization decides on your request. Send it to them, or to us and we pass it on.')}</p>
          <p>{t('You can also complain to a data protection authority: the Estonian Data Protection Inspectorate (Andmekaitse Inspektsioon), or the authority where you live or work.')}</p>
        </section>

        <section id="basis">
          <h2>{t('Legal basis')}</h2>
          <ul>
            <Lead term={t('Members.')}>{t('To provide Starlings under the agreement with their organization, and our legitimate interest in keeping it secure.')}</Lead>
            <Lead term={t('Guests.')}>{t('To provide the call you asked to join.')}</Lead>
            <Lead term={t('Transcripts and notes.')}>{t('The workspace’s legitimate interest in a record of its calls.')}</Lead>
            <Lead term={t('Envisioning’s own records.')}>{t('Envisioning keeps a record of who it met and when, as ordinary business records (legitimate interest).')}</Lead>
            <Lead term={t('Early-access answers.')}>{t('Your request, as a step before an agreement.')}</Lead>
          </ul>
          <p>{t('This notice follows Brazil’s LGPD and the EU GDPR. You can complain to Brazil’s data protection authority (ANPD), or to the supervisory authority where you live in the EU.')}</p>
        </section>

        <section id="changes">
          <h2>{t('Changes to this notice')}</h2>
          <p>{t('When Starlings changes how it handles data, we update this page and the date at the top.')}</p>
        </section>

        <section id="contact">
          <h2>{t('Contact')}</h2>
          <p>{COMPANY()}</p>
          <p>{t('Envisioning’s privacy contact is {name}, our data protection officer (encarregado) under the LGPD.', { name: PRIVACY_OFFICER_NAME })}</p>
          <p><MailLink address={PRIVACY_CONTACT_EMAIL} sentence={t('Write to {email}', { email: PRIVACY_CONTACT_EMAIL })} /></p>
        </section>

        <DocNote>
          <a href="/terms">{t('Terms of use')}</a>
          {' · '}
          <a href="/security">{t('Security')}</a>
        </DocNote>
      </DocArticle>
    </AppShell>
  );
}

export function TermsPage() {
  useDocumentTitle(t('Terms'));
  return (
    <AppShell variant="document" current="terms" product={null}>
      <DocArticle>
        <h1>{t('Terms of use')}</h1>
        <p className="lede">
          {t('These terms apply to Starlings and this site, which ')}<a href={ORG_WEB_ORIGIN}>{t('Envisioning')}</a>{t(' makes. In these terms, “we” means Envisioning.')}
        </p>
        <p className="text-sm text-muted-foreground">{UPDATED()}</p>

        <DocToc
          label={t('On this page')}
          links={[
            { href: '#early-access', label: t('Early access') },
            { href: '#accounts', label: t('Accounts') },
            { href: '#use', label: t('Acceptable use') },
            { href: '#content', label: t('Your content') },
            { href: '#availability', label: t('Availability') },
            { href: '#ending', label: t('Ending') },
            { href: '#law', label: t('Law') },
            { href: '#contact', label: t('Contact') },
            { href: '/privacy', label: t('Privacy') },
          ]}
        />

        <section id="agreement">
          <h2>{t('Agreeing to these terms')}</h2>
          <ul>
            <li>{t('By using Starlings, joining a call or sending a form on this site, you accept these terms. If you use Starlings for an organization, you accept them for that organization too, and you confirm that you may.')}</li>
            <li>{t('If your organization has a separate written agreement with us, that agreement wins where the two differ.')}</li>
            <li>{t('Starlings is not for anyone under 16.')}</li>
          </ul>
        </section>

        <section id="early-access">
          <h2>{t('Early access')}</h2>
          <ul>
            <li>{t('Starlings is in early access. There is no paid plan yet, and you cannot buy Starlings on this site. Organizations use it in a pilot we agree with them.')}</li>
            <li>{t('The plans and prices on the pricing page are proposals. Features, limits and prices can change before launch, and a feature can go away.')}</li>
            <li>{t('We do not charge you without a separate agreement or a checkout you confirm.')}</li>
          </ul>
        </section>

        <section id="accounts">
          <h2>{t('Accounts and workspaces')}</h2>
          <ul>
            <li>{t('Members sign in with a Google account their organization controls. Keep your devices secure. If you lose one, sign it out under Settings › Account › Devices.')}</li>
            <li>{t('The organization that runs a workspace decides who is a member and what each person can see. It is responsible for what its members and agents do there.')}</li>
            <li>{t('Guests need no account. The host decides who joins a call, and can remove anyone or end the call at any time.')}</li>
          </ul>
        </section>

        <section id="use">
          <h2>{t('Acceptable use')}</h2>
          <ul>
            <li>{t('Use your real name when you join a call.')}</li>
            <li>{t('Do not try to get past the waiting room, and do not use someone else’s access.')}</li>
            <li>{t('Share a room link only with the people the host means it for.')}</li>
            <li>{t('Tell people before you transcribe a call held on another service. Starlings does not tell them, and the law may require their consent.')}</li>
            <li>{t('Do not upload malware, or anything unlawful or that infringes someone else’s rights.')}</li>
            <li>{t('Do not use Starlings to spam or harass people.')}</li>
            <li>{t('Do not overload, probe or break into the service, and do not scrape it. To report a security problem, write to us.')}</li>
            <li>{t('You are responsible for what an agent or a connected Claude does in your name.')}</li>
          </ul>
        </section>

        <section id="content">
          <h2>{t('Your content')}</h2>
          <ul>
            <li>{t('What you and your workspace put into Starlings stays yours. You let us store, process and show it only to run Starlings for you.')}</li>
            <li>{t('We do not sell your content, and we do not use it to train AI models.')}</li>
            <li>{t('Transcripts, captions and AI-written notes can be wrong. Check them before you rely on them.')}</li>
            <li>{t('Services you connect, such as Google, GitHub, Slack, Granola or your own Claude, work under their own terms. So does a third-party notetaker the host lets into a call.')}</li>
          </ul>
        </section>

        <section id="availability">
          <h2>{t('Availability and liability')}</h2>
          <ul>
            <li>{t('We work to keep Starlings running and your data safe. During early access we provide it as it is, with no promise that it is always available or free of errors.')}</li>
            <li>{t('If the device hosting a call goes offline, new guests cannot join until it is back.')}</li>
            <li>{t('As far as the law allows, we are not liable for indirect or consequential loss. Nothing in these terms takes away a right that the law does not let a contract remove.')}</li>
          </ul>
        </section>

        <section id="ending">
          <h2>{t('Ending')}</h2>
          <ul>
            <li>{t('You can stop using Starlings at any time. The organization that runs a workspace can ask us to close it.')}</li>
            <li>{t('We can suspend or end access when someone breaks these terms, puts the service or other people at risk, or when a pilot ends. Where we can, we tell the organization first.')}</li>
            <li>{t('Before a workspace closes, its organization can ask for a copy of its data. Self-serve export and deletion are planned; until then we do both by hand.')}</li>
            <li>{t('When a workspace closes, we delete its data. Copies in daily backups expire within 30 days.')}</li>
          </ul>
        </section>

        <section id="changes">
          <h2>{t('Changes to these terms')}</h2>
          <p>{t('We may change these terms. We update the date at the top, and we tell each workspace’s organization about a change that matters before it applies. If you keep using Starlings after that, the new terms apply.')}</p>
        </section>

        <section id="law">
          <h2>{t('Law and courts')}</h2>
          <p>{t('Estonian law governs these terms. Disputes go to Harju County Court in Tallinn. If the law where you live gives you the right to use your own courts or your own consumer law, that right stays.')}</p>
        </section>

        <section id="contact">
          <h2>{t('Contact')}</h2>
          <p>{COMPANY()}</p>
          <p>{t('For a question about a specific call, ask the host who sent you the link.')}</p>
          <ul>
            <li><MailLink address={PRIVACY_CONTACT_EMAIL} sentence={t('Privacy requests: {email}', { email: PRIVACY_CONTACT_EMAIL })} /></li>
            <li><MailLink address={CONTACT_EMAIL} sentence={t('Everything else: {email}', { email: CONTACT_EMAIL })} /></li>
          </ul>
        </section>

        <DocNote>
          <a href="/privacy">{t('How Starlings handles your data')}</a>
        </DocNote>
      </DocArticle>
    </AppShell>
  );
}
