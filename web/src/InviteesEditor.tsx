import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { CrmContact } from '@starlings/contracts';
import { Command as CommandPrimitive } from 'cmdk';
import { CommandItem, CommandList } from '@/ui/command';
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/ui/item';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import type { WebCalendarAttendee } from './owner-agenda';
import { fetchPeers, isAgent, peerDisplayName } from './team-presence';
import { AttendeeAvatar } from './AttendeeAvatar';
import { CloseIcon } from './action-icons';
import { isWorkspaceMemberEmail } from './workspace-identity';
import { t } from './i18n';
import { contactLookupEmails, contactsByAddress, contactsByEmail } from './contacts';
import { contactHref, subjectHref } from './work-hrefs';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

type Suggestion = { email: string; name: string; avatarUpdatedAt: number | null };

type InviteesEditorProps = {
  /** Everyone but you — what the save writes. */
  value: string[];
  onChange: (next: string[]) => void;
  /** The event's own list, for reply marks and names. Empty for a new event. */
  existing?: WebCalendarAttendee[];
};

/**
 * The event editor's invite list: one row per person with their reply, and
 * an Add invitee line that completes from the workspace roster. The same
 * shape as the Mac's CalendarInviteesEditorView and iOS's
 * MobileInviteesEditor (the Fantastical shape). A row whose address is not
 * on the event was added here and draws no reply badge.
 *
 * The completions are cmdk: ↑ ↓ move, Enter takes the
 * highlighted person, Escape hides the list without closing the editor.
 * The editor's Radix Dialog hears Escape on the document in the capture
 * phase, before this field; while the list shows, a window capture listener
 * takes Escape first.
 */
export function InviteesEditor({ value, onChange, existing = [] }: InviteesEditorProps) {
  const [draft, setDraft] = useState('');
  const [roster, setRoster] = useState<Suggestion[]>([]);
  const [focused, setFocused] = useState(false);
  /** Escape hid the completions; typing brings them back. */
  const [dismissed, setDismissed] = useState(false);
  /** The highlighted completion: cmdk's value, which is the address. */
  const [highlight, setHighlight] = useState('');

  useEffect(() => {
    let cancelled = false;
    // The roster, asked once per editor: people, not agents, with names.
    fetchPeers().then((response) => {
      if (cancelled) return;
      const seen = new Set<string>();
      const people: Suggestion[] = [];
      for (const peer of response.peers) {
        if (isAgent(peer) || !peer.email) continue;
        const email = peer.email.toLowerCase();
        if (seen.has(email)) continue;
        seen.add(email);
        people.push({ email, name: peerDisplayName(peer), avatarUpdatedAt: peer.avatar_updated_at });
      }
      setRoster(people);
    }).catch(() => { /* no roster, no completion; typing still works */ });
    return () => { cancelled = true; };
  }, []);

  // The event's attendees from outside the workspace, named as contacts:
  // one read per open event. Decoration only: a failed read leaves the rows
  // as they are and says nothing.
  const lookupKey = contactLookupEmails(existing
    .filter((attendee) => !attendee.self && attendee.email && !isWorkspaceMemberEmail(attendee.email))
    .map((attendee) => attendee.email)).join(',');
  const [contacts, setContacts] = useState<{ key: string; byAddress: Map<string, CrmContact> } | null>(null);
  useEffect(() => {
    if (!lookupKey) return;
    let cancelled = false;
    contactsByEmail(lookupKey.split(',')).then(
      (found) => { if (!cancelled) setContacts({ key: lookupKey, byAddress: contactsByAddress(found) }); },
      () => { /* best effort: the rows stay as they are */ },
    );
    // A response for another event's attendees is dropped.
    return () => { cancelled = true; };
  }, [lookupKey]);
  const contactByAddress = useMemo(
    () => (contacts && contacts.key === lookupKey ? contacts.byAddress : new Map<string, CrmContact>()),
    [contacts, lookupKey],
  );

  const you = existing.find((attendee) => attendee.self);
  const byEmail = new Map(existing.map((attendee) => [attendee.email.toLowerCase(), attendee] as const));

  function commit(raw: string): string {
    const parts = raw.split(/[;,\s]+/u).map((part) => part.trim().toLowerCase()).filter(Boolean);
    const accepted = parts.filter((part) => EMAIL.test(part) && !value.includes(part) && part !== you?.email.toLowerCase());
    const rejected = parts.filter((part) => !EMAIL.test(part));
    if (accepted.length > 0) onChange([...value, ...accepted]);
    return rejected.join(' ');
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Enter on a highlighted completion is cmdk's; it takes that person.
    if (event.key === 'Enter' && showing && matches.some((person) => person.email === highlight)) return;
    if (event.key === 'Enter' || event.key === ',' || event.key === ';') {
      event.preventDefault();
      if (draft.trim()) setDraft(commit(draft));
    }
  }

  const typed = draft.trim().toLowerCase();
  const matches = typed
    ? roster
      .filter((person) => !value.includes(person.email) && person.email !== you?.email.toLowerCase())
      .filter((person) => person.email.startsWith(typed) || person.name.toLowerCase().split(/\s+/u).some((word) => word.startsWith(typed)))
      .slice(0, 6)
    : [];
  const showing = focused && !dismissed && matches.length > 0;

  // Esc hides the list; the dialog's own Esc (close the editor) waits for the next one.
  useEffect(() => {
    if (!showing) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [showing]);

  return (
    <div className="relative grid gap-1.5">
      <ul className="m-0 grid list-none gap-0.5 p-0">
        {value.map((address) => {
          const known = byEmail.get(address);
          const person = roster.find((candidate) => candidate.email === address);
          const name = known?.name || person?.name || address;
          return (
            <InviteeRow
              key={address}
              name={name}
              email={address}
              avatarUpdatedAt={person?.avatarUpdatedAt ?? null}
              status={known?.status ?? 'new'}
              contact={known ? contactByAddress.get(address) : undefined}
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="rounded-full text-muted-foreground"
                aria-label={t('Remove {name}', { name })}
                onClick={() => onChange(value.filter((candidate) => candidate !== address))}
              >
                <CloseIcon />
              </Button>
            </InviteeRow>
          );
        })}
        {you && (
          <InviteeRow
            name={you.name || you.email}
            email={you.email}
            detail="you"
            avatarUpdatedAt={roster.find((candidate) => candidate.email === you.email.toLowerCase())?.avatarUpdatedAt ?? null}
            status={you.status}
          />
        )}
      </ul>
      <CommandPrimitive shouldFilter={false} loop value={highlight} onValueChange={setHighlight} className="relative">
        <CommandPrimitive.Input
          // shadcn Input's look on cmdk's own input, which keeps the
          // combobox roles. `data-slot` keeps the page's field rules off it.
          data-slot="input"
          className="h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring md:text-sm dark:bg-input/30"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder={t('Add invitee')}
          aria-label={t('Add invitee')}
          value={draft}
          onValueChange={(next) => { setDraft(next); setDismissed(false); }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => { setFocused(false); if (draft.trim()) setDraft(commit(draft)); }}
        />
        {showing && (
          <CommandList className="absolute inset-x-0 top-full z-10 mt-1 rounded-md border bg-popover p-1 shadow-md">
            {matches.map((person) => (
              <CommandItem
                key={person.email}
                value={person.email}
                // mousedown, so the input's blur (which commits the draft)
                // does not fire first and eat the click.
                onMouseDown={(event) => event.preventDefault()}
                onSelect={() => setDraft(commit(person.email))}
              >
                <span>{person.name}</span>
                <small className="text-muted-foreground">{person.email}</small>
              </CommandItem>
            ))}
          </CommandList>
        )}
      </CommandPrimitive>
    </div>
  );
}

/**
 * One person on the invite: face, name and address, their reply, then any
 * action. A contact draws the contact's name, opening the contact, over its
 * title and organization, the organization opening its subject in Work.
 */
function InviteeRow({ name, email, detail, avatarUpdatedAt, status, contact, children }: {
  name: string;
  email: string;
  /** The line under the name. Default: the address, when it is not the name. */
  detail?: string;
  avatarUpdatedAt: number | null;
  status: WebCalendarAttendee['status'] | 'new';
  /** The contact this address belongs to, when the event's read found one. */
  contact?: CrmContact;
  children?: ReactNode;
}) {
  const contactName = contact?.name?.trim() || '';
  const shownName = contactName || name;
  const title = contact?.title?.trim() || '';
  const organization = contact?.organization_name?.trim() || '';
  const line = detail ?? (shownName !== email ? email : '');
  const contactLine = title || organization
    ? (
      <>
        {title}
        {title && organization && ' · '}
        {organization && (contact?.organization_id
          ? <a className={inviteeLinkClass} href={subjectHref({ kind: 'organization', id: contact.organization_id })}>{organization}</a>
          : organization)}
      </>
    )
    : null;
  return (
    <Item asChild size="sm" className="flex-nowrap gap-2.5 px-0 py-1">
      <li>
        <ItemMedia>
          {/* The reply rides the face's corner (meet#623). */}
          <AttendeeAvatar
            name={shownName}
            email={email}
            status={status === 'new' ? undefined : status}
            member={isWorkspaceMemberEmail(email)}
            size={28}
            version={avatarUpdatedAt}
          />
        </ItemMedia>
        <ItemContent className="min-w-0 gap-0">
          <ItemTitle className={cn('block w-full truncate text-[13px] text-foreground', status === 'declined' && 'opacity-55')}>
            {contact ? <a className={inviteeLinkClass} href={contactHref(contact.id)}>{shownName}</a> : name}
          </ItemTitle>
          {contactLine
            ? <ItemDescription className="truncate text-xs" title={email}>{contactLine}</ItemDescription>
            : line && <ItemDescription className="truncate text-xs">{line}</ItemDescription>}
        </ItemContent>
        <ItemActions className="gap-1">
          {children}
        </ItemActions>
      </li>
    </Item>
  );
}

/** A name on an invitee row that opens its record: the attendee rows' underline. */
const inviteeLinkClass = 'text-inherit underline decoration-muted-foreground/55 underline-offset-2 hover:decoration-current';
