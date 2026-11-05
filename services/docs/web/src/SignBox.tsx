import { useId, useRef, useState } from 'react';
import { CONSENT_TEXT, type DocumentDetail, type SignatureRequestDetail } from '@docs/contracts';
import { api, ApiError } from './api';
import { ErrorNotice } from './ErrorNotice';
import { CheckRow, FormRow } from './form-row';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Card } from '@/ui/card';
import { Checkbox } from '@/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Field, FieldLabel } from '@/ui/field';
import { Input } from '@/ui/input';
import { RadioGroup, RadioGroupItem } from '@/ui/radio-group';
import { Spinner } from '@/ui/spinner';

/**
 * The signing affordance. Two things it must never do: let someone sign
 * without showing them the consent language, or send a signature for bytes
 * other than the ones on screen — hence `content_hash` travelling with the
 * request and being echoed back.
 */
export function SignBox({
  request,
  document: doc,
  signerEmail,
  onDone,
}: {
  request: SignatureRequestDetail;
  document: DocumentDetail;
  signerEmail: string;
  onDone: () => void;
}) {
  const [method, setMethod] = useState<'typed' | 'drawn'>('typed');
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [declining, setDeclining] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const hasInk = useRef(false);
  const typedId = useId();
  const drawnId = useId();
  const nameId = useId();
  const consentId = useId();

  const stale = request.content_hash !== doc.content_hash;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.sign(request.id, {
        content_hash: doc.content_hash,
        method,
        name,
        typed_text: method === 'typed' ? name : undefined,
        signature_image: method === 'drawn' ? canvasRef.current?.toDataURL('image/png') : undefined,
        consent: true,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      setDone(true);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t record the signature.');
    } finally {
      setBusy(false);
    }
  }

  function draw(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
    context.lineWidth = 2.5;
    context.lineCap = 'round';
    context.strokeStyle = '#111';
    context.lineTo(x, y);
    context.stroke();
    context.beginPath();
    context.moveTo(x, y);
    hasInk.current = true;
  }

  // Drive the confirmation off the server's record of this party, not off
  // local state alone: after signing, the request reloads as `completed`, and
  // a signer coming back to the link later must still see what they did.
  const me = request.parties.find((party) => party.email === signerEmail.toLowerCase());

  if (done || me?.status === 'signed') {
    return (
      <Box title="Signed" closed>
        <p className="m-0">
          {me?.signed_at ? `Recorded ${new Date(me.signed_at).toLocaleString(undefined, { hourCycle: 'h23' })}. ` : ''}
          Everyone on this request gets a copy and the audit certificate by email.
        </p>
        <Button asChild variant="link" className="h-auto justify-self-start p-0 text-foreground">
          <a href={`/certificate/${request.id}`} target="_blank" rel="noreferrer">
            View certificate
          </a>
        </Button>
      </Box>
    );
  }

  if (me?.status === 'declined') {
    return (
      <Box title="Declined" closed>
        <p className="m-0">{request.requested_by} has been told.</p>
      </Box>
    );
  }

  if (request.status !== 'pending') {
    return (
      <Box title="Not open for signature" closed>
        <p className="m-0">This request is {request.status}. Ask {request.requested_by} if you expected to sign it.</p>
      </Box>
    );
  }

  return (
    <Box title={request.subject ?? 'Signature requested'}>
      {request.message ? <p className="m-0">{request.message}</p> : null}

      {stale ? (
        <ErrorNotice message={`This document changed after the request was sent. Ask ${request.requested_by} for a new request.`} />
      ) : (
        <>
          <RadioGroup
            className="flex flex-wrap gap-4"
            value={method}
            onValueChange={(value) => setMethod(value === 'drawn' ? 'drawn' : 'typed')}
          >
            <CheckRow id={typedId} label="Type it" className="my-0 w-auto">
              <RadioGroupItem id={typedId} value="typed" />
            </CheckRow>
            <CheckRow id={drawnId} label="Draw it" className="my-0 w-auto">
              <RadioGroupItem id={drawnId} value="drawn" />
            </CheckRow>
          </RadioGroup>

          <FormRow id={nameId} label="Full legal name" className="my-0">
            <Input id={nameId} value={name} onChange={(event) => setName(event.target.value)} />
          </FormRow>

          {method === 'typed' ? (
            <p className="m-0 rounded-md border border-dashed bg-muted px-[18px] py-3.5 font-['Snell_Roundhand','Apple_Chancery',cursive] text-[30px] leading-[1.2]">
              {name || 'Your name appears here.'}
            </p>
          ) : (
            <div className="grid justify-items-start gap-1.5">
              {/* Stays white: these pixels become the signature image itself. */}
              <canvas
                ref={canvasRef}
                width={600}
                height={180}
                className="aspect-[600/180] w-full max-w-[600px] touch-none rounded-md border border-dashed bg-white"
                onPointerDown={(event) => {
                  drawing.current = true;
                  canvasRef.current?.getContext('2d')?.beginPath();
                  draw(event);
                }}
                onPointerMove={draw}
                onPointerUp={() => (drawing.current = false)}
                onPointerLeave={() => (drawing.current = false)}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => {
                  const context = canvasRef.current?.getContext('2d');
                  if (context && canvasRef.current) {
                    context.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
                    hasInk.current = false;
                  }
                }}
              >
                Clear
              </Button>
            </div>
          )}

          <Field orientation="horizontal" className="items-start gap-2">
            <Checkbox
              id={consentId}
              className="mt-0.5"
              checked={consent}
              onCheckedChange={(checked) => setConsent(checked === true)}
            />
            <FieldLabel htmlFor={consentId} className="text-[13px] font-normal leading-normal text-muted-foreground">
              {CONSENT_TEXT}
            </FieldLabel>
          </Field>

          <p className="m-0 text-[13px] leading-normal text-muted-foreground">
            You are signing version {doc.version}, SHA-256 <code>{doc.content_hash.slice(0, 24)}…</code>
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={busy || !consent || name.trim().length < 2} onClick={() => void submit()}>
              {busy ? <Spinner /> : null}
              {busy ? 'Signing…' : 'Sign'}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => setDeclining(true)}>
              Decline
            </Button>
          </div>
          {error ? <ErrorNotice message={error} /> : null}
          <DeclineDialog
            open={declining}
            onOpenChange={setDeclining}
            onDecline={async (reason) => {
              await api.decline(request.id, reason);
              onDone();
            }}
          />
        </>
      )}
    </Box>
  );
}

/**
 * Decline asks for an optional reason in a small dialog: a field and a
 * button. The kit's Dialog replaces `window.prompt` (MZ, 2026-10-06).
 */
function DeclineDialog({ open, onOpenChange, onDecline }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDecline: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) {
          setReason('');
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            onDecline(reason.trim())
              .catch((cause: unknown) => setError(cause instanceof ApiError ? cause.message : 'Couldn’t decline.'))
              .finally(() => setBusy(false));
          }}
        >
          <DialogHeader>
            <DialogTitle>Decline to sign</DialogTitle>
          </DialogHeader>
          <FormRow id={reasonId} label="Reason (optional)" className="my-0">
            <Input id={reasonId} value={reason} autoFocus onChange={(event) => setReason(event.target.value)} />
          </FormRow>
          {error ? <ErrorNotice message={error} /> : null}
          <DialogFooter>
            <Button type="submit" variant="destructive" disabled={busy}>
              {busy ? <Spinner /> : null}
              Decline
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The signature ask is the primary action on the page: accent earns its place
 * on the edge, not as a fill behind body text. A closed request takes the
 * success edge.
 */
function Box({ title, closed = false, children }: { title: string; closed?: boolean; children: React.ReactNode }) {
  return (
    <Card asChild className={cn('mb-8 gap-2.5 border-l-2 px-6 py-5', closed ? 'border-l-(--success)' : 'border-l-primary')}>
      <section>
        <h3 className="m-0 text-[17px]">{title}</h3>
        {children}
      </section>
    </Card>
  );
}
