import { useState } from 'react';
import type { ItemBody, ItemKind, VaultDetail } from '@keep/contracts';
import { sealItem, uuid } from '@keep/crypto';
import { Button } from '@/ui/button';
import { Item, ItemContent, ItemDescription, ItemTitle } from '@/ui/item';
import { Textarea } from '@/ui/textarea';
import { api } from './api';
import * as session from './session';
import { ErrorNotice, Fine, Panel, errorMessage } from './parts';

/**
 * Import from 1Password. The input is the JSON that the `op` CLI prints:
 *
 *   op item list --vault "Client A" --format json \
 *     | op item get - --format json > items.json
 *
 * (`op item get -` reads ids from stdin and prints one JSON object per
 * item; wrap them in `[…]` or paste them one after another — both parse.)
 *
 * Everything is sealed here before it is sent. The pasted text lives in
 * component state until the drawer closes and never touches the server.
 */
export function Import({ vault, onClose, onDone }: { vault: VaultDetail; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<ParsedItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  function parse(): void {
    setError(null);
    try {
      const parsed = parseOnePassword(text);
      if (parsed.length === 0) throw new Error('No items found in that JSON.');
      setPreview(parsed);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function run(): Promise<void> {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const key = await session.vaultKey(vault.id, vault.key_version, vault.wrapped_key);
      for (const [index, entry] of preview.entries()) {
        const id = uuid();
        const sealed = await sealItem(key, vault.id, id, vault.key_version, entry.body);
        await api.createItem(vault.id, { id, name: entry.name, kind: entry.kind, sealed, key_version: vault.key_version });
        setProgress(index + 1);
      }
      setText('');
      setPreview(null);
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Import from 1Password" onClose={onClose}>
      {preview === null ? (
        <>
          <Fine>
            Paste the output of <code className="font-mono">op item get … --format json</code>. It is parsed and sealed here; the server never sees it.
          </Fine>
          <Textarea
            aria-label="1Password JSON"
            className="font-mono text-xs"
            value={text}
            spellCheck={false}
            onChange={(event) => setText(event.target.value)}
            rows={12}
            placeholder="[ { &quot;title&quot;: … } ]"
          />
          {error && <ErrorNotice message={error} />}
          <Button className="w-fit" disabled={text.trim() === ''} onClick={parse}>
            Preview
          </Button>
        </>
      ) : (
        <>
          <Fine>
            {preview.length} {preview.length === 1 ? 'item' : 'items'} will be added to <strong className="text-foreground">{vault.name}</strong>.
          </Fine>
          <ul className="m-0 grid list-none gap-1.5 p-0">
            {preview.map((entry, index) => (
              <li key={index}>
                <Item variant="outline" size="sm" className="bg-(--surface-raised)">
                  <ItemContent className="min-w-0 gap-0">
                    <ItemTitle className="w-full min-w-0"><span className="truncate">{entry.name}</span></ItemTitle>
                    <ItemDescription className="text-[11.5px]">
                      {entry.kind}
                      {entry.body.username ? ` · ${entry.body.username}` : ''}
                    </ItemDescription>
                  </ItemContent>
                </Item>
              </li>
            ))}
          </ul>
          {error && <ErrorNotice message={error} />}
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={busy} onClick={() => void run()}>
              {busy ? `Sealing ${progress}/${preview.length}…` : 'Import'}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => setPreview(null)}>
              Back
            </Button>
          </div>
          <Fine>After importing, delete the items in 1Password. Two copies is worse than one.</Fine>
        </>
      )}
    </Panel>
  );
}

interface ParsedItem {
  name: string;
  kind: ItemKind;
  body: ItemBody;
}

interface OPField {
  id?: string;
  label?: string;
  purpose?: string;
  type?: string;
  value?: string;
}

interface OPItem {
  title?: string;
  category?: string;
  fields?: OPField[];
  urls?: Array<{ href?: string; primary?: boolean }>;
}

/** Accepts a JSON array, one object, or several objects back to back. */
function parseOnePassword(text: string): ParsedItem[] {
  const trimmed = text.trim();
  let objects: unknown[];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    objects = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // `op item get -` prints objects separated by newlines, not an array.
    objects = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    for (let index = 0; index < trimmed.length; index += 1) {
      const char = trimmed[index];
      if (inString) {
        if (char === '\\') index += 1;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') {
        if (depth === 0) start = index;
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          objects.push(JSON.parse(trimmed.slice(start, index + 1)));
          start = -1;
        }
      }
    }
  }
  return objects.filter(isObject).map(toParsed);
}

function isObject(value: unknown): value is OPItem {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toParsed(item: OPItem): ParsedItem {
  const fields = item.fields ?? [];
  const byPurpose = (purpose: string) => fields.find((field) => field.purpose === purpose)?.value ?? '';
  const byLabel = (...labels: string[]) => fields.find((field) => labels.includes((field.label ?? field.id ?? '').toLowerCase()))?.value ?? '';
  const totpField = fields.find((field) => field.type === 'OTP');
  const url = item.urls?.find((entry) => entry.primary)?.href ?? item.urls?.[0]?.href ?? byLabel('url', 'website', 'hostname', 'server');
  const category = (item.category ?? '').toUpperCase();

  let kind: ItemKind = 'other';
  if (category === 'LOGIN') kind = 'login';
  else if (category === 'API_CREDENTIAL') kind = 'api_key';
  else if (category === 'SECURE_NOTE') kind = 'note';
  else if (category === 'DATABASE') kind = 'database';
  else if (category === 'SSH_KEY') kind = 'ssh_key';

  const password = byPurpose('PASSWORD') || byLabel('password', 'credential', 'private key', 'api key', 'token');
  const username = byPurpose('USERNAME') || byLabel('username', 'email', 'user');
  const notes = byPurpose('NOTES') || byLabel('notesplain', 'notes');

  return {
    name: item.title?.trim() || 'Untitled',
    kind,
    body: { username, password, url, notes, totp: totpField?.value ?? '' },
  };
}
