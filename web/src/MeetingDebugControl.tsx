import { useCallback, useState } from 'react';
import { useChat, useRoomContext } from '@livekit/components-react';
import { Button } from '@/ui/button';
import { Label } from '@/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Textarea } from '@/ui/textarea';
// Subpath import: the contracts root pulls zod in, and this is browser code.
import { FEEDBACK_MESSAGE_MAX_CHARS, FEEDBACK_REPORT_MAX_CHARS } from '@starlings/contracts/limits';
import { apiFetch } from './api';
import { errorCodeOf } from './config';
import { buildMeetingDebugReport } from './meeting-debug-report';
import type { ConnectionDetails } from './meeting-types';
import { turnstileToken } from './turnstile';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';

/** Stay under LiveKit's ~64 KiB reliable data packet limit. */
const CHAT_MESSAGE_MAX_BYTES = 60 * 1024;

/**
 * Turnstile is optional on the wire, so a challenge that fails — blocked
 * script, offline, no widget configured yet — must not swallow the report.
 * Send without a token and let the Worker decide: once its secret is set that
 * comes back as a readable `turnstile_failed` instead of a dead button.
 */
async function turnstileField(): Promise<{ turnstile_token?: string }> {
  try {
    const token = await turnstileToken('feedback');
    return token ? { turnstile_token: token } : {};
  } catch {
    return {};
  }
}

/**
 * Quiet header control that samples LiveKit + browser stats into a pasteable
 * support dump (no tokens / emails / captions). Opens a shadcn Dialog
 * first; copy, send-in-chat and file are explicit actions from there.
 */
export function MeetingDebugControl({
  roomSlug,
  connection,
}: {
  roomSlug: string;
  connection: ConnectionDetails;
}) {
  const room = useRoomContext();
  const { send: sendChatMessage } = useChat();
  const [status, setStatus] = useState<'idle' | 'busy' | 'copied' | 'sent' | 'filed' | 'failed'>('idle');
  const [report, setReport] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [note, setNote] = useState('');

  const close = useCallback(() => {
    setReport(null);
    setStatus('idle');
    setActionError('');
    setNote('');
  }, []);

  async function openReport() {
    if (status === 'busy') return;
    setStatus('busy');
    setActionError('');
    try {
      const next = await buildMeetingDebugReport(room, roomSlug, connection);
      setReport(next);
      setStatus('idle');
    } catch {
      setStatus('failed');
      window.setTimeout(() => setStatus('idle'), 2000);
    }
  }

  async function copyReport() {
    if (!report || status === 'busy') return;
    setActionError('');
    try {
      await navigator.clipboard.writeText(report);
      setStatus('copied');
      window.setTimeout(() => setStatus('idle'), 1600);
    } catch {
      // Report is already visible for manual select/copy.
      setStatus('failed');
      setActionError(t('Copy failed — select the text above.'));
      window.setTimeout(() => setStatus('idle'), 2000);
    }
  }

  async function sendInChat() {
    if (!report || status === 'busy') return;
    setActionError('');
    const bytes = new TextEncoder().encode(report).byteLength;
    if (bytes > CHAT_MESSAGE_MAX_BYTES) {
      setStatus('failed');
      setActionError(t('Report is too large for one chat message — copy instead.'));
      window.setTimeout(() => setStatus('idle'), 2400);
      return;
    }

    setStatus('busy');
    try {
      // Use the same chat hook as the visible Chat prefab. Besides publishing
      // the text stream, it adds the returned message to the local list, so a
      // browser sender sees the report they just sent.
      await sendChatMessage(report);
      setStatus('sent');
      window.setTimeout(() => setStatus('idle'), 1600);
    } catch {
      setStatus('failed');
      setActionError(t('Couldn’t send in chat — copy instead.'));
      window.setTimeout(() => setStatus('idle'), 2400);
    }
  }

  /**
   * File the report as a GitHub issue. The typed note is required: a dump with
   * no account of what went wrong is an issue nobody can triage, and the button
   * is cheap enough to press by accident.
   */
  async function fileReport() {
    if (!report || status === 'busy') return;
    const message = note.trim();
    if (!message) {
      setActionError(t('Say what went wrong first — a report with no description can’t be acted on.'));
      return;
    }

    setActionError('');
    setStatus('busy');
    try {
      await apiFetch('/feedback', {
        body: {
          message: message.slice(0, FEEDBACK_MESSAGE_MAX_CHARS),
          room_slug: roomSlug,
          report: report.slice(0, FEEDBACK_REPORT_MAX_CHARS),
          ...(await turnstileField()),
        },
        fallbackError: t('Couldn’t send the report.'),
      });
      setStatus('filed');
      window.setTimeout(close, 1600);
    } catch (error) {
      setStatus('failed');
      setActionError(
        errorCodeOf(error) === 'not_configured'
          ? t('Reporting isn’t switched on yet — copy the report and send it to us instead.')
          : errorCodeOf(error) === 'rate_limited'
            ? t('That’s a few reports in quick succession — wait a minute, or copy instead.')
            : errorCodeOf(error) === 'turnstile_failed'
              ? t('The bot check didn’t pass — copy the report and send it to us instead.')
              : t('Couldn’t send the report — copy it instead.'),
      );
      window.setTimeout(() => setStatus('idle'), 2400);
    }
  }

  const label =
    status === 'busy' && !report ? 'Collecting…' : status === 'failed' && !report ? 'Failed' : 'Debug';

  const fileLabel =
    status === 'busy' && report ? 'Sending…' : status === 'filed' ? 'Sent' : 'Report a bug';

  const copyLabel =
    status === 'copied' ? 'Copied' : status === 'failed' && actionError.startsWith('Copy')
      ? t('Copy failed')
      : t('Copy');

  const chatLabel =
    status === 'busy' && report ? 'Sending…' : status === 'sent' ? 'Sent' : 'Send in chat';

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-9 px-2.5 text-[11px] font-semibold tracking-[0.02em] text-muted-foreground/55 hover:text-muted-foreground disabled:cursor-progress disabled:opacity-70"
        onClick={() => void openReport()}
        disabled={status === 'busy' && !report}
      >
        {label}
      </Button>
      <Dialog open={report !== null} onOpenChange={(open) => { if (!open) close(); }}>
        <DialogContent aria-describedby={undefined} className="gap-3 p-4 sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="text-base">{t('Debug report')}</DialogTitle>
          </DialogHeader>
          <Label className="text-xs font-semibold text-foreground leading-normal" htmlFor="meeting-debug-note">
            {t('What went wrong?')}
          </Label>
          <Textarea
            id="meeting-debug-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={FEEDBACK_MESSAGE_MAX_CHARS}
            rows={3}
            className="field-sizing-fixed"
            placeholder={t('My camera froze when I turned on the background blur.')}
          />
          <p className="m-0 text-xs text-muted-foreground">{t('Sent with this connection report (no tokens or captions):')}</p>
          <Textarea
            readOnly
            value={report ?? ''}
            rows={10}
            spellCheck={false}
            aria-label={t('Debug report')}
            className="field-sizing-fixed font-mono text-[11px] leading-snug md:text-[11px]"
          />
          {actionError && <ErrorNotice inline className="text-xs" message={actionError} />}
          <DialogFooter className="flex-row flex-wrap justify-end">
            <Button type="button" variant="outline" size="sm" onClick={close}>
              {t('Close')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void sendInChat()}
              disabled={status === 'busy'}
            >
              {chatLabel}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void copyReport()}
              disabled={status === 'busy'}
            >
              {copyLabel}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void fileReport()}
              disabled={status === 'busy'}
            >
              {fileLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
