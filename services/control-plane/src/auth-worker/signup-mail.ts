// The signup mails (docs/ONBOARDING.md §Mails): plain text, short, from
// Starlings. E1 the link, E2 the receipt, E2b declined or a question, O1 the
// operator's notice. Copy follows the copy law: no em dashes, one idea a line.
import { INTEREST_AGENTS, INTEREST_ROLES, INTEREST_SIZES, type InterestOption } from '@starlings/contracts/interest';
import type { SignupForm } from '@starlings/contracts/signup';
import { setupStepsFor } from '@starlings/contracts/setup-steps';
import { WORKSPACE_SUITE_LABELS } from '@starlings/contracts/workspace-profile';
import { WORKSPACE_REGION_LABELS } from '@starlings/contracts/workspace-region';
import { WORKSPACE_HOST_SUFFIX } from '@starlings/contracts/workspace-slug';

interface Mail { subject: string; text: string }

function label(options: readonly InterestOption[], id: string): string {
  return options.find((option) => option.id === id)?.label ?? id;
}

/** `2026-10-18`. Dates in mail are ISO, the same for every reader. */
function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function who(form: SignupForm): string {
  return form.membership.mode === 'invite' ? 'Only people you invite' : `Anyone at ${form.membership.domains.join(', ')}`;
}

function summary(form: SignupForm, email: string): string {
  return [
    `Workspace: ${form.workspace_name}`,
    `Address: ${form.slug}.${WORKSPACE_HOST_SUFFIX}`,
    `Accent: ${form.accent || 'Starlings default'}`,
    `Mail and calendar: ${WORKSPACE_SUITE_LABELS[form.suite]}`,
    `Data region: ${WORKSPACE_REGION_LABELS[form.region]}`,
    `Who can join: ${who(form)}`,
    `First admin: ${form.name} (${email}), ${label(INTEREST_ROLES, form.role)}`,
    `Team: ${label(INTEREST_SIZES, form.team_size)}. Agents: ${label(INTEREST_AGENTS, form.agents)}.`,
    ...(form.note ? ['', form.note] : []),
  ].join('\n');
}

/** E1: the link. */
export function linkMail(url: string, expiresAt: number): Mail {
  return {
    subject: 'Your Starlings workspace',
    text: [
      'Set up your Starlings workspace here:',
      '',
      url,
      '',
      `The link works once, until ${day(expiresAt)}. Do not forward it: it signs up whoever opens it, as you.`,
    ].join('\n'),
  };
}

/** E2: the receipt. */
export function receiptMail(form: SignupForm, email: string): Mail {
  return {
    subject: `${form.workspace_name} on Starlings: we got your request`,
    text: [
      'Thanks. During the pilot, someone on our team sets up each workspace by hand. We’ll email you when yours is ready.',
      '',
      summary(form, email),
      '',
      'Reply to this mail to change anything.',
    ].join('\n'),
  };
}

/** O1: the operator's notice. */
export function operatorRequestMail(form: SignupForm, email: string, consoleURL: string): Mail {
  return {
    subject: `Workspace request: ${form.workspace_name} (${form.slug})`,
    text: [summary(form, email), '', consoleURL].join('\n'),
  };
}

/** E2b, a question. The applicant answers by replying; Reply-To is the operator. */
export function operatorQuestionMail(workspaceName: string, question: string): Mail {
  return {
    subject: `${workspaceName} on Starlings: a question`,
    text: [question, '', 'Reply to this mail to answer.'].join('\n'),
  };
}

/**
 * E3's first steps: the admin's first three required setup steps, less
 * `membership`, which signup settled. Titles and routes come from the setup
 * registry, so the mail and the checklist the admin lands on say the same
 * thing (registry first; the mail once said "Admin, Workspace" and "Connect
 * Claude" after the app had moved on).
 */
export function readyMailSteps(origin: string): Array<{ title: string; url: string }> {
  return setupStepsFor('admin')
    .filter((step) => step.required && step.id !== 'membership')
    .slice(0, 3)
    .map((step) => ({ title: step.title, url: step.route.startsWith('https://') ? step.route : `${origin}${step.route}` }));
}

/** E3: the workspace is ready. `host` is the bare host the request records. */
export function readyMail(workspaceName: string, host: string, email: string): Mail {
  const origin = `https://${host.replace(/^https?:\/\//u, '').replace(/\/+$/u, '')}`;
  return {
    subject: `${workspaceName} is ready`,
    text: [
      `Your workspace is at ${origin}`,
      '',
      `Sign in as ${email}.`,
      '',
      'Start here:',
      ...readyMailSteps(origin).map((step, index) => `${index + 1}. ${step.title}: ${step.url}`),
      '',
      'Reply to this mail with any questions.',
    ].join('\n'),
  };
}

/** E2b, declined. No reason is given (MZ, 2026-10-04). */
export function declinedMail(workspaceName: string): Mail {
  return {
    subject: `${workspaceName} on Starlings`,
    text: [
      'We can’t set up this workspace right now.',
      '',
      'Reply to this mail with any questions.',
    ].join('\n'),
  };
}
