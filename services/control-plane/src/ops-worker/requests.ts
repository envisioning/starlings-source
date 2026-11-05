// The console's Requests page (docs/ONBOARDING.md §The operator's side):
// mint a signup link, and accept, decline or ask on each workspace request.
// The data lives in starlings-auth's D1; this Worker reaches it over one
// service binding, SIGNUP_ADMIN, to the `SignupAdminService` entrypoint, and
// keeps nothing itself.
//
// The forms post back to this host only. Every POST passes the operator check
// (index.ts) and a same-origin check here, so a page elsewhere cannot make an
// operator's browser act.
import { WORKSPACE_HOST_SUFFIX } from '@starlings/contracts/workspace-slug';
import { signupAddressProblem, type SignupInterest, type SignupLinkSummary, type SignupPrefill, type SignupRequest } from '@starlings/contracts/signup';
import { WORKSPACE_SUITE_LABELS } from '@starlings/contracts/workspace-profile';
import { WORKSPACE_REGION_LABELS } from '@starlings/contracts/workspace-region';
import { escapeHTML, formatUTC, opsDocument } from './page';

/** The RPC surface of starlings-auth's `SignupAdminService`, as this Worker calls it. */
export interface SignupAdminStub {
  mint(input: { email: string; interest_id: string | null; prefill?: SignupPrefill; operator: string }): Promise<{ email: string; expires_at: number; replaced?: number }>;
  revoke(input: { email: string; operator: string }): Promise<{ email: string; revoked: number }>;
  list(): Promise<{ requests: SignupRequest[]; links: SignupLinkSummary[]; interest_links?: SignupLinkSummary[] }>;
  decide(input: { id: string; action: 'accept' | 'decline' | 'ask' | 'ready'; message: string; operator: string }):
    Promise<{ ok: true; request: SignupRequest; command: string | null } | { ok: false; message: string }>;
}

export interface Notice { kind: 'ok' | 'error'; text: string; command?: string | null }

const FORM_LIMIT = 8_192;

/** True when the POST came from a page on this host. */
export function sameOrigin(request: Request): boolean {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin !== url.origin) return false;
  const site = request.headers.get('sec-fetch-site');
  return site === null || site === 'same-origin';
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return null;
  const text = await request.text();
  return text.length > FORM_LIMIT ? null : new URLSearchParams(text);
}

/**
 * The RPC surface of the workspace that holds interest requests (hq: the
 * product site forwards the form there), over its `InterestService`.
 */
export interface InterestSourceStub {
  interests(): Promise<SignupInterest[]>;
  interest(id: string): Promise<SignupInterest | null>;
}

/** Run one posted action. The answer is a notice for the page, never a redirect that carries data. */
export async function handleRequestsPost(
  request: Request,
  signup: SignupAdminStub,
  operator: string,
  path: string,
  interests: InterestSourceStub | null = null,
): Promise<Notice> {
  const form = await readForm(request);
  if (!form) return { kind: 'error', text: 'The form did not arrive.' };
  try {
    if (path === '/requests/mint') {
      const interestID = form.get('interest_id') || null;
      // An answer to an interest request: the address and the prefill come
      // from hq's row, never from the posted form.
      if (interestID) {
        if (!interests) return { kind: 'error', text: 'hq is not bound (HQ_INTERESTS), so the interest request cannot be read.' };
        const interest = await interests.interest(interestID);
        if (!interest) return { kind: 'error', text: 'That interest request is not in hq.' };
        const minted = await signup.mint({ email: interest.email, interest_id: interest.id, prefill: interest.prefill, operator });
        return { kind: 'ok', text: `Link sent to ${minted.email} for ${interest.company}. It works until ${formatUTC(minted.expires_at)}.` };
      }
      const minted = await signup.mint({ email: form.get('email') ?? '', interest_id: null, operator });
      // Minting again for an address revokes its open link: a resend.
      const replaced = minted.replaced ? ' The earlier open link to it no longer works.' : '';
      return { kind: 'ok', text: `Link sent to ${minted.email}. It works until ${formatUTC(minted.expires_at)}.${replaced}` };
    }
    if (path === '/requests/revoke') {
      const revoked = await signup.revoke({ email: form.get('email') ?? '', operator });
      return revoked.revoked > 0
        ? { kind: 'ok', text: `The open link for ${revoked.email} no longer works.` }
        : { kind: 'error', text: `${revoked.email} has no open link.` };
    }
    const action = form.get('action');
    if (action !== 'accept' && action !== 'decline' && action !== 'ask' && action !== 'ready') return { kind: 'error', text: 'Unknown action.' };
    const answer = await signup.decide({ id: form.get('id') ?? '', action, message: form.get('message') ?? '', operator });
    if (!answer.ok) return { kind: 'error', text: answer.message };
    const done = { accept: 'Accepted', decline: 'Declined', ask: 'Question sent for', ready: 'Ready mail sent for' }[action];
    return { kind: 'ok', text: `${done} ${answer.request.workspace_name} (${answer.request.slug}).`, command: answer.command };
  } catch (error) {
    // The RPC refuses bad input with a message; nothing in it is secret.
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'error', text: message.slice(0, 300) || 'The action failed.' };
  }
}

/** The mails about this request that did not go out. */
function mailFailed(request: SignupRequest): string {
  const lines = request.mail_failed.map((kind) => (kind === 'receipt'
    ? `The receipt to ${escapeHTML(request.email)} did not go out. Write to them yourself.`
    : 'The mail to operators about this request did not go out.'));
  return lines.map((line) => `<p class="error">${line}</p>`).join('\n');
}

function membership(request: SignupRequest): string {
  return request.membership.mode === 'invite' ? 'Invite only' : `Anyone at ${request.membership.domains.join(', ')}`;
}

/** The states that wait for the operator: a card each, with its next step. The rest are rows. */
const OPEN_STATES: ReadonlySet<SignupRequest['state']> = new Set(['submitted', 'approved', 'provisioning', 'failed']);

function requestCard(request: SignupRequest): string {
  const id = escapeHTML(request.id);
  const accent = request.accent
    ? `<span class="swatch" style="background:${escapeHTML(request.accent)}"></span> ${escapeHTML(request.accent)}`
    : 'Default';
  const fields: [string, string][] = [
    ['Owner', `${escapeHTML(request.name)}, ${escapeHTML(request.role)}<br><span class="muted">${escapeHTML(request.email)}</span>`],
    ['Who joins', escapeHTML(membership(request))],
    ['Mail and calendar', escapeHTML(WORKSPACE_SUITE_LABELS[request.suite])],
    ['Data', `In the ${escapeHTML(WORKSPACE_REGION_LABELS[request.region])}`],
    ['Accent', accent],
    ['Team', `${escapeHTML(request.answers.team_size)}, agents ${escapeHTML(request.answers.agents)}`],
    ['Payment', escapeHTML(request.payment)],
    ['Sent', escapeHTML(formatUTC(request.created_at))],
  ];
  const command = `<pre>node scripts/provision-workspace.mjs --from-request ${id} --apply</pre>`;
  const decided = request.decided_by ? ` by ${escapeHTML(request.decided_by)} ${escapeHTML(formatUTC(request.decided_at))}` : '';
  return `<div class="card" id="${id}">
<h3>${escapeHTML(request.workspace_name)} <code>${escapeHTML(request.slug)}.${WORKSPACE_HOST_SUFFIX}</code> <span class="muted">${escapeHTML(request.state)}${decided}</span></h3>
<dl class="fields">${fields.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>
${request.answers.note ? `<pre>${escapeHTML(request.answers.note)}</pre>` : ''}
${mailFailed(request)}
${nextStep(request, id, command)}
</div>`;
}

/** A request nobody has to act on any more (ready, declined, expired): one row. */
function closedRow(request: SignupRequest): string {
  const workspace = request.state === 'ready' && request.host
    ? `<a href="${escapeHTML(request.host)}/">${escapeHTML(request.workspace_name)}</a>`
    : escapeHTML(request.workspace_name);
  return `<tr id="${escapeHTML(request.id)}"><td>${workspace} <code class="muted">${escapeHTML(request.slug)}</code></td><td>${escapeHTML(request.email)}</td><td>${escapeHTML(request.state)}</td><td>${escapeHTML(formatUTC(request.decided_at ?? request.created_at))}</td></tr>`;
}

/** Accept, Ask and Decline; Ask and its question only where the server allows Ask (`submitted`). */
function decisionForm(id: string, actions: ('accept' | 'ask' | 'decline')[]): string {
  const button = { accept: '<button name="action" value="accept">Accept</button>', ask: '<button class="secondary" name="action" value="ask">Ask</button>', decline: '<button class="secondary" name="action" value="decline">Decline</button>' };
  return `<form method="post" action="/requests/decide">
<input type="hidden" name="id" value="${id}">
${actions.includes('ask') ? '<textarea name="message" placeholder="A question for the applicant (Ask)"></textarea>\n' : ''}<p class="inline">${actions.map((action) => button[action]).join(' ')}</p>
</form>`;
}

function readyForm(id: string, text: string): string {
  return `<form method="post" action="/requests/decide"><input type="hidden" name="id" value="${id}"><p class="inline">${text} <button name="action" value="ready">Send ready mail</button></p></form>`;
}

/** What the operator does next, for each state. */
function nextStep(request: SignupRequest, id: string, command: string): string {
  const host = escapeHTML(request.host ?? '');
  switch (request.state) {
    case 'submitted':
      return decisionForm(id, ['accept', 'ask', 'decline']);
    case 'approved':
      return `${command}
<p class="muted">Run it. When it ends, come back here and press Send ready mail.</p>
${decisionForm(id, ['decline'])}`;
    case 'provisioning': {
      if (request.provisioned_at === null) return readyForm(id, `Provisioning at ${host}: the run has not finished.`);
      const agent = request.agent_state ? `<p class="muted">Meeting agent: ${escapeHTML(request.agent_state)}. The ready mail does not wait for it.</p>` : '';
      return `${readyForm(id, `Provisioned at ${host} ${escapeHTML(formatUTC(request.provisioned_at))}. Send the ready mail.`)}
${agent}`;
    }
    case 'failed':
      return `<p class="error">Failed at ${escapeHTML(request.failure ?? 'an unknown step')}</p>
${command}
<p class="muted">Fix what the run printed, then run it again: it continues where it stopped.</p>
${decisionForm(id, ['decline'])}`;
    case 'ready':
      return request.host ? `<p><a href="${host}/">${host}</a></p>` : '';
    default:
      return '';
  }
}

function linkRow(link: SignupLinkSummary, now: number): string {
  const open = !link.used_at && !link.revoked_at && link.expires_at > now;
  const state = link.used_at ? `Used ${formatUTC(link.used_at)}`
    : link.revoked_at ? `Revoked ${formatUTC(link.revoked_at)}`
      : link.expires_at <= now ? 'Expired' : `Open until ${formatUTC(link.expires_at)}`;
  // Resend mints a new link for the address and revokes this one.
  const email = escapeHTML(link.email);
  const actions = link.used_at || link.interest_id ? '' : `<form method="post" action="/requests/mint" class="inline"><input type="hidden" name="email" value="${email}"><button class="secondary">Resend</button></form>`
    + (open ? ` <form method="post" action="/requests/revoke" class="inline"><input type="hidden" name="email" value="${email}"><button class="secondary">Revoke</button></form>` : '');
  return `<tr><td>${email}</td><td>${escapeHTML(formatUTC(link.created_at))}</td><td>${escapeHTML(state)}</td><td class="muted">${escapeHTML(link.created_by)}</td><td>${actions}</td></tr>`;
}

/** The interest rows, each with its link state or a Send signup link button. */
function interestSection(interests: SignupInterest[] | { error: string } | null, answered: SignupLinkSummary[], now: number): string {
  if (interests === null) return '';
  const head = '<h2>Interest</h2>';
  if ('error' in interests) return `${head}<p class="error">${escapeHTML(interests.error)}</p>`;
  if (interests.length === 0) return `${head}<p class="muted">No interest requests yet.</p>`;
  // `answered` is newest first, so the first link per request is its latest.
  const latest = new Map<string, SignupLinkSummary>();
  for (const link of answered) if (link.interest_id && !latest.has(link.interest_id)) latest.set(link.interest_id, link);
  const rows = interests.map((interest) => {
    const link = latest.get(interest.id);
    let action: string;
    if (link) {
      const state = link.used_at ? `Used ${formatUTC(link.used_at)}` : link.expires_at <= now ? 'Link expired' : `Link sent ${formatUTC(link.created_at)}`;
      // An expired or unused link can be sent again; a used one became a request above.
      action = link.used_at ? escapeHTML(state) : `${escapeHTML(state)} ${sendForm(interest.id, 'Send again')}`;
    } else if (signupAddressProblem(interest.email)) {
      action = '<span class="muted">Personal address: ask for a work address</span>';
    } else {
      action = sendForm(interest.id, 'Send signup link');
    }
    return `<tr><td>${escapeHTML(formatUTC(interest.created_at))}</td><td>${escapeHTML(interest.name)}</td><td>${escapeHTML(interest.company)}</td><td>${escapeHTML(interest.email)}</td><td>${escapeHTML(interest.team_size ?? '')}</td><td>${action}</td></tr>`;
  }).join('');
  return `${head}<div class="wrap"><table>
<thead><tr><th>Asked</th><th>Name</th><th>Company</th><th>Address</th><th>Team</th><th>Signup link</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>`;
}

function sendForm(interestID: string, label: string): string {
  return `<form class="inline" method="post" action="/requests/mint"><input type="hidden" name="interest_id" value="${escapeHTML(interestID)}"><button class="secondary">${escapeHTML(label)}</button></form>`;
}

export function renderRequestsPage(
  data: { requests: SignupRequest[]; links: SignupLinkSummary[]; interest_links?: SignupLinkSummary[] } | { error: string },
  notice: Notice | null,
  now = Date.now(),
  interests: SignupInterest[] | { error: string } | null = null,
): string {
  const top = notice
    ? `<div class="card ${notice.kind === 'error' ? 'error' : 'ok'}">${escapeHTML(notice.text)}${notice.command ? `<pre>${escapeHTML(notice.command)}</pre>` : ''}</div>`
    : '';
  if ('error' in data) {
    return opsDocument('Requests', `<h1>Requests</h1>${top}<p class="error">${escapeHTML(data.error)}</p>`);
  }
  // In the order the work goes: what waits for a decision, who asked, the
  // links sent, the workspaces made. Cards only where there is a decision.
  const open = data.requests.filter((request) => OPEN_STATES.has(request.state));
  const closed = data.requests.filter((request) => !OPEN_STATES.has(request.state));
  const waiting = open.length === 0 ? '<p class="muted">Nothing waits for you.</p>' : open.map(requestCard).join('');
  const links = data.links.length === 0
    ? '<tr><td colspan="5" class="muted">No links yet.</td></tr>'
    : data.links.map((link) => linkRow(link, now)).join('');
  const mint = `<form class="inline" method="post" action="/requests/mint">
<input type="email" name="email" required placeholder="name@company.com" autocomplete="off">
<button class="secondary">Send signup link</button>
</form>`;
  const made = closed.length === 0 ? '' : `<h2>Workspaces made</h2>
<div class="wrap"><table>
<thead><tr><th>Workspace</th><th>Owner</th><th>State</th><th>Decided</th></tr></thead>
<tbody>${closed.map(closedRow).join('')}</tbody>
</table></div>`;
  return opsDocument('Requests', `<h1>Requests</h1>
${top}
<h2>Waiting for you</h2>
${waiting}
${interestSection(interests, data.interest_links ?? [], now)}
<h2>Signup links</h2>
<p class="muted">To someone who did not use the interest form.</p>
${mint}
<div class="wrap"><table>
<thead><tr><th>Address</th><th>Sent</th><th>State</th><th>By</th><th></th></tr></thead>
<tbody>${links}</tbody>
</table></div>
${made}`);
}
