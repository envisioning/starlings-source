// Personal access tokens, for a person rather than a curl.
//
// `/api/tokens` has existed since the beginning and nothing called it, so the
// only way to get a credential was a `fetch` pasted into devtools — and
// `docsctl login` pointed at a Settings screen that did not exist. That is
// fine for the person who wrote the API and a wall for the second person.
//
// The one rule this page exists to enforce: the secret is shown once, on
// create, and never again. Docs stores only its hash. So the created token
// gets the whole width of the page, a copy button, and stays there until it
// is dismissed: never a toast that can be missed by looking away.

import { useCallback, useEffect, useId, useState } from 'react';
import { AGENT_SCOPES, AGENT_SCOPE_DESCRIPTIONS, type AgentScope, type TokenSummary } from '@docs/contracts';
import { api, ApiError } from './api';
import { ErrorNotice } from './ErrorNotice';
import { FormRow } from './form-row';
import { cn } from '@/lib/utils';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/alert-dialog';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/ui/card';
import { Checkbox } from '@/ui/checkbox';
import { Field, FieldLabel, FieldLegend, FieldSet } from '@/ui/field';
import { Input } from '@/ui/input';
import { LoadingIndicator, Spinner } from '@/ui/spinner';

/** What `docsctl` needs, which is what most people are here for. */
const DEFAULT_SCOPES: AgentScope[] = ['docs:read', 'docs:write', 'folders:write', 'sync:write'];

export function TokensPage() {
  const [tokens, setTokens] = useState<TokenSummary[] | null>(null);
  const [created, setCreated] = useState<(TokenSummary & { token: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .tokens()
      .then((result) => setTokens(result.tokens))
      .catch((cause: unknown) => setError(cause instanceof ApiError ? cause.message : 'Couldn’t load tokens.'));
  }, []);

  useEffect(load, [load]);

  return (
    <article className="grid max-w-[68ch] gap-7">
      <header>
        <h1 className="mt-0 mb-1.5">Tokens</h1>
        <p className="m-0 text-muted-foreground">A token lets a command line, an agent or a script act as you.</p>
      </header>

      {error ? <ErrorNotice message={error} onDismiss={() => setError(null)} /> : null}
      {created ? <CreatedToken created={created} onDismiss={() => setCreated(null)} /> : null}

      <NewToken
        onCreated={(token) => {
          setCreated(token);
          load();
        }}
        onError={setError}
      />

      <section className="grid gap-3">
        <h2 className="m-0 text-[15px]">Your tokens</h2>
        {tokens === null ? (
          <LoadingIndicator placement="section" />
        ) : tokens.length === 0 ? (
          <p className="m-0 text-muted-foreground">No tokens yet.</p>
        ) : (
          <TokenList tokens={tokens} onChanged={load} onError={setError} />
        )}
      </section>
    </article>
  );
}

/** Shown once, so it gets the room: the secret, Copy, and how to use it. */
function CreatedToken({
  created,
  onDismiss,
}: {
  created: TokenSummary & { token: string };
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Card className="gap-4 border-primary">
      <CardHeader>
        <CardTitle className="text-[15px]">Copy “{created.name}” now</CardTitle>
        <CardDescription>You see it only once. If you lose it, revoke it and make another.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex items-center gap-2.5">
          <code className="min-w-0 flex-1 overflow-x-auto rounded-md border px-2.5 py-2 text-[13px] whitespace-nowrap">
            {created.token}
          </code>
          <Button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(created.token).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p className="m-0 text-[13px] leading-normal text-muted-foreground">
          For <code>docsctl</code>: run <code>docsctl login</code>, press Enter at the origin prompt, and paste this at
          “Token:”.
        </p>
      </CardContent>
      <CardFooter>
        <Button type="button" variant="outline" size="sm" onClick={onDismiss}>
          Done
        </Button>
      </CardFooter>
    </Card>
  );
}

function NewToken({
  onCreated,
  onError,
}: {
  onCreated: (token: TokenSummary & { token: string }) => void;
  onError: (message: string | null) => void;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<AgentScope[]>(DEFAULT_SCOPES);
  const [pathPrefix, setPathPrefix] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('');
  const [busy, setBusy] = useState(false);
  const id = useId();

  const toggle = (scope: AgentScope) =>
    setScopes((current) => (current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope]));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    onError(null);
    setBusy(true);
    try {
      const created = await api.createToken({
        name: name.trim(),
        scopes,
        ...(pathPrefix.trim() ? { path_prefix: pathPrefix.trim() } : {}),
        ...(expiresInDays.trim() ? { expires_in_days: Number(expiresInDays) } : {}),
      });
      onCreated(created);
      setName('');
      setPathPrefix('');
      setExpiresInDays('');
      setScopes(DEFAULT_SCOPES);
    } catch (cause: unknown) {
      onError(cause instanceof ApiError ? cause.message : 'Couldn’t create the token.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="grid gap-3.5" onSubmit={submit}>
      <h2 className="m-0 text-[15px]">New token</h2>

      <FormRow id={`${id}-name`} label="What it’s for" className="my-0">
        <Input
          id={`${id}-name`}
          type="text"
          value={name}
          required
          maxLength={200}
          placeholder="docsctl on my laptop"
          onChange={(event) => setName(event.target.value)}
        />
      </FormRow>

      <FieldSet className="rounded-lg border p-3">
        <FieldLegend variant="label" className="px-1.5 font-normal text-muted-foreground">
          Scopes
        </FieldLegend>
        {AGENT_SCOPES.map((scope) => (
          <Field key={scope} orientation="horizontal" className="items-start gap-2">
            <Checkbox
              id={`${id}-${scope}`}
              className="mt-0.5"
              checked={scopes.includes(scope)}
              onCheckedChange={() => toggle(scope)}
            />
            <FieldLabel htmlFor={`${id}-${scope}`} className="block font-normal">
              <code>{scope}</code> <span className="text-muted-foreground">{AGENT_SCOPE_DESCRIPTIONS[scope]}</span>
            </FieldLabel>
          </Field>
        ))}
      </FieldSet>

      <div className="grid grid-cols-2 gap-3.5 max-sm:grid-cols-1">
        <FormRow id={`${id}-prefix`} label="Confine to a folder" className="my-0">
          <Input
            id={`${id}-prefix`}
            type="text"
            value={pathPrefix}
            placeholder="/work (optional)"
            onChange={(event) => setPathPrefix(event.target.value)}
          />
        </FormRow>
        <FormRow id={`${id}-expires`} label="Expires in" className="my-0">
          <Input
            id={`${id}-expires`}
            type="number"
            min={1}
            max={3650}
            value={expiresInDays}
            placeholder="Days (optional)"
            onChange={(event) => setExpiresInDays(event.target.value)}
          />
        </FormRow>
      </div>

      <Button className="justify-self-start" type="submit" disabled={busy || !name.trim() || scopes.length === 0}>
        {busy ? <Spinner /> : null}
        {busy ? 'Creating…' : 'Create token'}
      </Button>
    </form>
  );
}

function TokenList({
  tokens,
  onChanged,
  onError,
}: {
  tokens: TokenSummary[];
  onChanged: () => void;
  onError: (message: string | null) => void;
}) {
  const [revoking, setRevoking] = useState<TokenSummary | null>(null);
  return (
    <ul className="m-0 grid list-none gap-3.5 p-0">
      {tokens.map((token) => (
        <li key={token.id} className={cn('grid gap-1.5 border-t pt-3', state(token) !== 'active' && 'opacity-55')}>
          <div className="flex flex-wrap items-baseline gap-2.5 text-sm">
            <strong>{token.name}</strong>
            <code className="text-muted-foreground">{token.prefix}…</code>
            <span className="text-muted-foreground">{label(token)}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {token.scopes.map((scope) => (
              <Badge key={scope} variant="outline" className="rounded-sm font-mono font-normal text-muted-foreground">
                {scope}
              </Badge>
            ))}
            {token.path_prefix ? (
              <Badge variant="outline" className="rounded-sm font-mono font-normal text-muted-foreground">
                under {token.path_prefix}
              </Badge>
            ) : null}
          </div>
          {state(token) === 'active' ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="justify-self-start text-muted-foreground"
              onClick={() => setRevoking(token)}
            >
              Revoke
            </Button>
          ) : null}
        </li>
      ))}
      <AlertDialog open={revoking !== null} onOpenChange={(open) => { if (!open) setRevoking(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke “{revoking?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>Anything that uses it stops working now. This can’t be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (!revoking) return;
                onError(null);
                api
                  .revokeToken(revoking.id)
                  .then(onChanged)
                  .catch((cause: unknown) => onError(cause instanceof ApiError ? cause.message : 'Couldn’t revoke the token.'));
              }}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ul>
  );
}

function state(token: TokenSummary): 'active' | 'revoked' | 'expired' {
  if (token.revoked_at) return 'revoked';
  if (token.expires_at && Date.parse(token.expires_at) < Date.now()) return 'expired';
  return 'active';
}

/** Last use is the useful fact: it says whether a token is still load-bearing. */
function label(token: TokenSummary): string {
  switch (state(token)) {
    case 'revoked':
      return `Revoked ${day(token.revoked_at!)}`;
    case 'expired':
      return `Expired ${day(token.expires_at!)}`;
    default:
      return token.last_used_at ? `Last used ${day(token.last_used_at)}` : 'Never used';
  }
}

function day(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}
