import { useEffect, useId, useState } from 'react';
import { Download } from 'lucide-react';
import type { DocumentDetail, SignatureRequestDetail } from '@docs/contracts';
import { api, setGuestToken, ApiError } from './api';
import { DocumentReader } from './DocumentReader';
import { SignBox } from './SignBox';
import { useDeployment } from './deployment';
import { ErrorNotice } from './ErrorNotice';
import { FormRow } from './form-row';
import { Button } from '@/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/ui/card';
import { FieldDescription } from '@/ui/field';
import { Input } from '@/ui/input';
import { LoadingIndicator, Spinner } from '@/ui/spinner';

type Stage = 'loading' | 'email' | 'code' | 'open' | 'error';

/**
 * The share-link flow. Deliberately close to what www/private/docs does today
 * — state an email, read the document — with two additions: comments, and a
 * mailed code when the link is a signing link.
 */
export function GuestApp({ token }: { token: string }) {
  const deployment = useDeployment();
  const [stage, setStage] = useState<Stage>('loading');
  const [info, setInfo] = useState<{ role: string; requires_verification: boolean; email_hint: string | null; document: { title: string } | null } | null>(null);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [signature, setSignature] = useState<SignatureRequestDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const emailId = useId();
  const nameId = useId();
  const codeId = useId();

  useEffect(() => {
    api
      .grantInfo(token)
      .then((result) => {
        setInfo(result);
        setStage('email');
        // Convenience carried over from the current flow: ?email= in the URL
        // and a remembered address skip the gate.
        const fromURL = new URLSearchParams(window.location.search).get('email');
        const remembered = localStorage.getItem(`docs.email.${token}`);
        const candidate = fromURL ?? remembered;
        if (candidate && !result.requires_verification) {
          setEmail(candidate);
          void claim(candidate);
        }
      })
      .catch((cause: ApiError) => {
        setError(cause.message);
        setStage('error');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function claim(address: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.claim(token, address, name || undefined);
      if (result.status === 'verify') {
        setStage('code');
        return;
      }
      setGuestToken(result.token);
      localStorage.setItem(`docs.email.${token}`, address);
      await openDocument(result.session.documentId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t open that link.');
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.verify(token, email, code);
      setGuestToken(result.token);
      localStorage.setItem(`docs.email.${token}`, email);
      await openDocument(result.session.documentId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That code wasn’t accepted.');
    } finally {
      setBusy(false);
    }
  }

  async function openDocument(documentId: string | null) {
    if (!documentId) {
      setError('This link doesn’t point at a document.');
      setStage('error');
      return;
    }
    const detail = await api.document(documentId);
    setDoc(detail);
    const requests = await api.signatureRequests(documentId).catch(() => ({ requests: [] }));
    setSignature(requests.requests[0] ?? null);
    setStage('open');
  }

  if (stage === 'loading') return <LoadingIndicator placement="full-page" label="Opening…" labelVisibility="visible" />;

  if (stage === 'error') {
    return (
      <Gate title={deployment?.name ?? 'Docs'}>
        <ErrorNotice message={error ?? 'Couldn’t open that link.'} />
      </Gate>
    );
  }

  if (stage === 'email') {
    return (
      <Gate
        title={info?.document?.title ?? (deployment ? `A document from ${deployment.name}` : 'A document')}
        status={info?.role === 'signer' ? 'Signature requested.' : null}
      >
        <FormRow id={emailId} label="Email">
          <Input
            id={emailId}
            type="email"
            autoFocus
            placeholder="you@company.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void claim(email)}
          />
          {info?.email_hint ? <FieldDescription>Sent to {info.email_hint}</FieldDescription> : null}
        </FormRow>
        {info?.role === 'signer' ? (
          <FormRow id={nameId} label="Full name">
            <Input id={nameId} value={name} onChange={(event) => setName(event.target.value)} />
          </FormRow>
        ) : null}
        <Button disabled={busy || !email.includes('@')} onClick={() => void claim(email)}>
          {busy ? <Spinner /> : null}
          {busy ? 'Checking…' : 'Open document'}
        </Button>
        {error ? <ErrorNotice message={error} /> : null}
      </Gate>
    );
  }

  if (stage === 'code') {
    return (
      <Gate title="Check your email" status={`We sent a six-digit code to ${email}. It expires in 15 minutes.`}>
        <FormRow id={codeId} label="Code">
          <Input
            id={codeId}
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/gu, '').slice(0, 6))}
            onKeyDown={(event) => event.key === 'Enter' && void verify()}
          />
        </FormRow>
        <Button disabled={busy || code.length < 6} onClick={() => void verify()}>
          {busy ? <Spinner /> : null}
          {busy ? 'Verifying…' : 'Verify'}
        </Button>
        {error ? <ErrorNotice message={error} /> : null}
      </Gate>
    );
  }

  if (!doc) return <LoadingIndicator placement="full-page" label="Loading…" labelVisibility="visible" />;

  return (
    <div className="mx-auto max-w-[1200px] px-8 pt-6 pb-20 max-sm:px-4">
      <header className="mb-6 flex items-center gap-3 border-b pb-4">
        <span className="font-[620]">{deployment?.name ?? 'Docs'}</span>
        <span className="min-w-0 truncate text-muted-foreground">{doc.title}</span>
        {doc.kind === 'pdf' ? (
          <Button asChild variant="outline" className="ml-auto">
            <a href={`/api/docs/${doc.id}/raw?download=1`}>
              <Download aria-hidden="true" />
              Download PDF
            </a>
          </Button>
        ) : null}
      </header>

      {signature ? (
        <SignBox
          request={signature}
          document={doc}
          signerEmail={email}
          onDone={() => void openDocument(doc.id)}
        />
      ) : null}

      <DocumentReader document={doc} canComment={info?.role !== 'viewer'} />
    </div>
  );
}

/** A centred card: the title, at most one status line, then the form. */
function Gate({ title, status, children }: { title: string; status?: string | null; children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center p-6">
      <Card className="w-full max-w-[440px] shadow-(--shadow-raised)">
        <CardHeader>
          <h1 className="m-0 text-[26px]">{title}</h1>
          {status ? <CardDescription>{status}</CardDescription> : null}
        </CardHeader>
        <CardContent className="grid gap-3">{children}</CardContent>
      </Card>
    </div>
  );
}
