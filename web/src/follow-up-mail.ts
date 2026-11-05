/**
 * The follow-up as a mail draft in the host's own mail app.
 * Starlings sends nothing. A mail link carries about 2,000 characters; past
 * that the body goes to the clipboard and the link carries the recipients and
 * the subject only.
 */
export const MAIL_LINK_MAX = 1_900;

export function followUpMailHref(mail: { to: string[]; subject: string; body: string }, withBody = true): string {
  const query = [`subject=${encodeURIComponent(mail.subject)}`, ...(withBody ? [`body=${encodeURIComponent(mail.body)}`] : [])].join('&');
  return `mailto:${mail.to.map(encodeURIComponent).join(',')}?${query}`;
}

/** Opens the draft. Answers whether the body had to go to the clipboard. */
export async function openFollowUpMail(mail: { to: string[]; subject: string; body: string }): Promise<'opened' | 'copied'> {
  const full = followUpMailHref(mail);
  if (full.length <= MAIL_LINK_MAX) {
    window.location.assign(full);
    return 'opened';
  }
  try {
    await navigator.clipboard.writeText(mail.body);
  } catch {
    // The link still opens; the dialog says the body is not in it.
  }
  window.location.assign(followUpMailHref(mail, false));
  return 'copied';
}
