import { CONTACT_EMAIL } from '@starlings/contracts/deployment';
import { useEffect, useState } from 'react';
import { INTEREST_BOOKING_URL } from '@starlings/contracts/interest';
import { t } from '@shared/i18n';
import { ErrorNotice } from '@shared/ErrorNotice';
import { Button } from '@/ui/button';
import { HERO, PAGE } from './bento';
import { confirmInterest, errorCodeOf } from './public-api';
import { useDocumentTitle } from './document-title';
import { AppShell } from './SiteChrome';

/**
 * /interest/confirm#<token>: the person sends what their agent filled in
 * (docs/FORMS.md §Agents). The mail lists the answers; this page only sends
 * them. A press, not the visit, sends them, so a mail scanner that opens the
 * link sends nothing.
 */
export function InterestConfirmPage() {
  useDocumentTitle(t('Send your request'));
  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<'ready' | 'busy' | 'sent' | 'gone' | 'failed'>('ready');
  const [call, setCall] = useState(false);

  useEffect(() => {
    const value = window.location.hash.slice(1);
    if (/^[A-Za-z0-9_-]{32,128}$/u.test(value)) setToken(value);
    else setState('gone');
  }, []);

  async function send() {
    if (!token || state === 'busy') return;
    setState('busy');
    try {
      const answer = await confirmInterest(token, t('Couldn’t send this. Try again, or write to {email}.', { email: CONTACT_EMAIL }));
      setCall(answer.call);
      setState('sent');
    } catch (caught) {
      setState(errorCodeOf(caught) === 'link_expired' ? 'gone' : 'failed');
    }
  }

  return (
    <AppShell variant="wide" product={null}>
      <div className={PAGE}>
        <header className={HERO}>
          {state === 'sent' ? (
            <>
              <h1>{t('Thank you.')}</h1>
              <p className="lede">
                {call
                  ? t('You asked for a call. Pick a time, and we show you Starlings live. You join from your browser, with no account.')
                  : t('We read every one of these. If Starlings fits your team, we set up a workspace for you.')}
              </p>
              {call && <div className="mt-5"><Button asChild><a href={INTEREST_BOOKING_URL}>{t('Book the call')}</a></Button></div>}
            </>
          ) : state === 'gone' ? (
            <h1>{t('This link has expired or was already used.')}</h1>
          ) : (
            <>
              <h1>{t('Send your request')}</h1>
              <p className="lede">{t('Your agent filled in the early access form. The answers are in the mail we sent you.')}</p>
              {state === 'failed' && <ErrorNotice className="mt-4" message={t('Couldn’t send this. Try again, or write to {email}.', { email: CONTACT_EMAIL })} />}
              <div className="mt-5"><Button onClick={() => void send()} disabled={!token || state === 'busy'}>{t('Send')}</Button></div>
            </>
          )}
        </header>
      </div>
    </AppShell>
  );
}
