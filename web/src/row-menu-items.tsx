import { Fragment, type ReactNode } from 'react';
import type { FavoriteTarget } from '@starlings/contracts/favorites';
import type { SearchDoor } from '@starlings/contracts/search-values';
import {
  rowMenuGroups,
  WORK_ROW_ACTION_DEFINITIONS,
  type WorkRowActionFacts,
  type WorkRowActionID,
  type WorkRowKind,
  type WorkRowMenuContext,
} from '@starlings/contracts/work-actions';
import type { CoreSubjectKind } from '@starlings/contracts/deployment';
import { coreContactURL, coreDashboardURL, coreSubjectURL } from './workspace-core';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/ui/dropdown-menu';
import { isFavorite, setFavorite, useFavorites } from './favorites';
import { t } from './i18n';
import { workSubjectOf } from './work-hrefs';
import { toast } from './Toast';
import { MenuIcon, type MenuIconName } from './menu-icons';

/**
 * The items more than one row kind shares: Open, Copy link,
 * Star / Unstar, and the groups they sit in. A row's menu is its own
 * decisions first, then these, in the Mac's order: the doors and the link
 * in one group, the star in the last (`NSMenu.addFavoriteAction`).
 */

/** Groups with a line between them; an empty group draws nothing. */
export function MenuGroups({ groups }: { groups: ReactNode[][] }) {
  const drawn = groups.filter((group) => group.length > 0);
  return (
    <>
      {drawn.map((group, index) => (
        <Fragment key={index}>
          {index > 0 && <DropdownMenuSeparator />}
          {group}
        </Fragment>
      ))}
    </>
  );
}

/**
 * The groups, or nothing when every group is empty: a row whose actions the
 * web cannot do draws no `…` (`useRowMenu`'s `panel` reads `null`).
 */
export function menuGroupsOrNull(groups: ReactNode[][]): ReactNode {
  return groups.some((group) => group.length > 0) ? <MenuGroups groups={groups} /> : null;
}

/** Text on the clipboard, and a toast that says so: an email, a message. */
export function CopyTextItem({ text, label, copied, failed, icon }: { text: string; label: string; copied: string; failed?: string; icon?: ReactNode }) {
  return (
    <DropdownMenuItem
      onSelect={() => {
        void navigator.clipboard.writeText(text).then(
          () => toast(copied),
          () => toast(failed ?? t('Couldn’t copy that.'), 'danger'),
        );
      }}
    >
      {icon}{label}
    </DropdownMenuItem>
  );
}

/** A door as a menu item. `external` opens beside the app, as the row does. */
export function OpenItem({ href, label, external = false, icon, variant }: { href: string; label?: ReactNode; external?: boolean; icon?: MenuIconName; variant?: 'default' | 'destructive' }) {
  return (
    <DropdownMenuItem asChild variant={variant}>
      <a href={href} {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}>
        <MenuIcon name={icon ?? (external ? 'openExternal' : 'open')} />
        {label ?? t('Open')}
      </a>
    </DropdownMenuItem>
  );
}

export type RowMenuRun = Partial<Record<WorkRowActionID, () => void>>;
export type RowMenuDoor = { href: string; label?: ReactNode; external?: boolean };
export type RowMenuDoors = Partial<Record<WorkRowActionID, RowMenuDoor>>;
export type RowMenuLabels = Partial<Record<WorkRowActionID, ReactNode>>;
export type RowMenuRender = Partial<Record<WorkRowActionID, () => ReactNode>>;
export type RowMenuDisabled = Partial<Record<WorkRowActionID, boolean>>;

export function coreSubjectDoor(kind: CoreSubjectKind | null | undefined, id: string | null | undefined): RowMenuDoor | undefined {
  if (!kind || !id) return undefined;
  const href = coreSubjectURL(kind, id);
  return href ? { href, label: t('Open full record'), external: true } : undefined;
}

export function coreContactDoor(raw: string | null | undefined): RowMenuDoor | undefined {
  const href = coreContactURL(raw);
  return href ? { href, label: t('Open full record'), external: true } : undefined;
}

export function coreTaskDoor(task: { project_id?: string | null; lead_id?: string | null; event_id?: string | null; organization_id?: string | null; meeting_id?: string | null; signals_account_id?: string | null }): RowMenuDoor | undefined {
  const subject = workSubjectOf(task);
  return subject ? coreSubjectDoor(subject.kind, subject.id) : undefined;
}

export function issueFavoriteTarget(issue: { owner: string; repo: string; number: number }): FavoriteTarget {
  return { kind: 'github.issue', target_ref: `${issue.owner.toLowerCase()}/${issue.repo.toLowerCase()}#${issue.number}` };
}

const ACTION_LABELS: Partial<Record<WorkRowActionID, () => ReactNode>> = {
  accept: () => t('Accept'),
  decline: () => t('Decline'),
  complete: () => t('Done'),
  cancel: () => t('Cancel task'),
  'mark-seen': () => t('Seen'),
  'file-github': () => t('File on GitHub'),
  'open-subject': () => t('Open'),
  'open-mine': () => t('Open in Mine'),
  'open-core': () => t('Open full record'),
  'close-issue': () => t('Close issue'),
  'close-not-planned': () => t('Close as not planned'),
  'reopen-issue': () => t('Reopen issue'),
  open: () => t('Open'),
  'open-github': () => t('Open on GitHub'),
  'copy-link': () => t('Copy link'),
  'mark-read': () => t('Mark as read'),
  mute: () => t('Mute'),
  archive: () => t('Archive'),
  'start-lead': () => t('Start a lead…'),
  dismiss: () => t('Dismiss'),
  'undo-dismiss': () => t('Undo dismiss'),
  'copy-email': () => t('Copy contact email'),
  'open-document': () => t('Open document'),
  resolve: () => t('Resolve'),
  'open-calendar': () => t('Open in Calendar'),
  edit: () => t('Edit'),
  'file-note': () => t('File…'),
  delete: () => t('Delete'),
  'edit-details': () => t('Edit details…'),
  rename: () => t('Rename…'),
  'win-lead': () => t('Win…'),
  'open-talk': () => t('Open talk'),
  'open-history': () => t('Open history'),
  'open-tasks': () => t('Open tasks'),
  'open-issues': () => t('Open issues'),
  'new-task': () => t('New task'),
  'new-issue': () => t('New issue'),
  'new-document': () => t('New document'),
  'start-room': () => t('Meet about this'),
  'link-repository': () => t('Link GitHub repository…'),
  'keep-vault': () => t('Keep vault'),
  met: () => t('Met'),
  drop: () => t('Drop'),
  reopen: () => t('Reopen'),
  'open-floating': () => t('Open in new window'),
  'open-page': () => t('Open page'),
  'copy-page-link': () => t('Copy page link'),
  'file-document': () => t('Move to…'),
  'open-conversation': () => t('Open conversation'),
  'move-stage': () => t('Move to stage'),
  'hand-off': () => t('Hand off…'),
  copy: () => t('Copy'),
  reply: () => t('Reply'),
  decide: () => t('Decide'),
  'make-card': () => t('Make a card'),
  'save-note': () => t('Save as Quick Note'),
  withdraw: () => t('Withdraw'),
  'copy-forwarding-address': () => t('Copy forwarding address'),
  message: () => t('Message'),
  wave: () => t('Wave'),
  call: () => t('Call'),
  'join-room': () => t('Join room'),
  'notes-self': () => t('Notes to self'),
  'set-status': () => t('Set status'),
  assign: () => t('Assign to'),
  'make-responsible': () => t('Make responsible'),
};

/**
 * One glyph per registry verb, matched to `WorkRowActionID.menuSymbol`
 * (Sources/WorkRowActions.swift). Exhaustive, so a new verb must name one.
 */
const ACTION_ICONS: Record<WorkRowActionID, MenuIconName> = {
  accept: 'accept',
  decline: 'decline',
  complete: 'done',
  'close-issue': 'done',
  met: 'done',
  cancel: 'cancel',
  drop: 'cancel',
  'mark-seen': 'seen',
  'file-github': 'openExternal',
  open: 'open',
  'open-subject': 'open',
  'open-mine': 'open',
  'open-core': 'openCore',
  'close-not-planned': 'notPlanned',
  'reopen-issue': 'reopen',
  reopen: 'reopen',
  'undo-dismiss': 'reopen',
  'open-github': 'openExternal',
  'open-page': 'openExternal',
  'copy-link': 'copyLink',
  'copy-page-link': 'copyLink',
  star: 'star',
  'star-person': 'star',
  'star-thread': 'star',
  'mark-read': 'markRead',
  mute: 'mute',
  archive: 'archive',
  'start-lead': 'startLead',
  dismiss: 'dismiss',
  'copy-email': 'copy',
  copy: 'copy',
  'copy-forwarding-address': 'copy',
  'open-document': 'openDocument',
  resolve: 'resolve',
  'open-calendar': 'openCalendar',
  edit: 'edit',
  'edit-details': 'edit',
  'file-note': 'file',
  'move-workspace': 'move',
  delete: 'delete',
  withdraw: 'delete',
  rename: 'rename',
  'win-lead': 'winLead',
  'open-talk': 'openTalk',
  'open-conversation': 'openTalk',
  'open-history': 'openHistory',
  'open-tasks': 'openTasks',
  'open-issues': 'openIssues',
  'new-task': 'newTask',
  'new-issue': 'newIssue',
  'new-document': 'newDocument',
  'start-room': 'call',
  'link-repository': 'copyLink',
  'keep-vault': 'vault',
  'open-floating': 'floating',
  'file-document': 'move',
  'move-stage': 'moveStage',
  'hand-off': 'handOff',
  react: 'react',
  'save-note': 'notes',
  reply: 'reply',
  decide: 'decide',
  'make-card': 'newTask',
  message: 'message',
  wave: 'wave',
  call: 'call',
  'join-room': 'join',
  'notes-self': 'notes',
  'set-status': 'status',
  assign: 'assign',
  'make-responsible': 'assign',
  // Each answer draws its own glyph (`RSVP_MENU_ICONS`); this is the verb's.
  rsvp: 'accept',
};

/** The actions that only navigate. `preferDoor` lifts their group first. */
const DOOR_ACTIONS: ReadonlySet<WorkRowActionID> = new Set(['open', 'open-subject', 'open-mine']);

/**
 * Render a row menu from the shared kind/context table. Views provide only
 * the actions they can perform; the resolver owns ordering and the registry
 * owns client availability, fact filters, and destructive styling.
 */
export function RowMenuItems<K extends WorkRowKind>({
  kind,
  context,
  facts,
  run = {},
  doors = {},
  labels = {},
  render = {},
  disabled = {},
  preferDoor = false,
}: {
  kind: K;
  context: WorkRowMenuContext<K>;
  facts?: WorkRowActionFacts;
  run?: RowMenuRun;
  doors?: RowMenuDoors;
  labels?: RowMenuLabels;
  render?: RowMenuRender;
  disabled?: RowMenuDisabled;
  /** Put navigation first, so a glance card's first keyboard action cannot change state. */
  preferDoor?: boolean;
}) {
  const resolved = rowMenuGroups(kind, context, 'web', facts);
  const hasDoor = (group: WorkRowActionID[]) => group.some((action) => DOOR_ACTIONS.has(action) && (doors[action] || run[action]));
  const ordered = preferDoor
    ? [...resolved.filter(hasDoor), ...resolved.filter((group) => !hasDoor(group))]
    : resolved;
  const groups = ordered.map((group) => group.flatMap((action) => {
    const content = render[action];
    const destructive = WORK_ROW_ACTION_DEFINITIONS[action].destructive;
    if (content) {
      const item = content();
      return item ? [<Fragment key={action}>{item}</Fragment>] : [];
    }
    const door = doors[action];
    if (door) {
      return [<OpenItem key={action} href={door.href} label={door.label ?? labels[action] ?? ACTION_LABELS[action]?.()} external={door.external} icon={door.external && ACTION_ICONS[action] === 'open' ? 'openExternal' : ACTION_ICONS[action]} variant={destructive ? 'destructive' : undefined} />];
    }
    const handler = run[action];
    const label = labels[action] ?? ACTION_LABELS[action]?.();
    if (!handler || label === undefined) return [];
    return [<DropdownMenuItem key={action} variant={destructive ? 'destructive' : undefined} disabled={disabled[action]} onSelect={handler}><MenuIcon name={ACTION_ICONS[action]} />{label}</DropdownMenuItem>];
  }));
  return <MenuGroups groups={groups} />;
}

/**
 * The row's address on the clipboard, absolute, the way the Mac copies it.
 * `label` names another address, such as the page a link save points at.
 */
export function CopyLinkItem({ href, label }: { href: string; label?: string }) {
  return (
    <DropdownMenuItem
      onSelect={() => {
        // The copy lands somewhere you cannot see: a toast says so (docs/DESIGN.md, "Toast").
        void navigator.clipboard.writeText(new URL(href, window.location.origin).href).then(
          () => toast(t('Link copied')),
          () => toast(t('Couldn’t copy the link.'), 'danger'),
        );
      }}
    >
      <MenuIcon name="copyLink" />
      {label ?? t('Copy link')}
    </DropdownMenuItem>
  );
}

/**
 * An address on the clipboard: a contact's (Copy contact email on every client),
 * or a colleague's, where `label` says Copy email.
 */
export function CopyEmailItem({ email, label }: { email: string; label?: string }) {
  return (
    <CopyTextItem
      text={email}
      label={label ?? t('Copy contact email')}
      copied={t('Email copied')}
      failed={t('Couldn’t copy the email.')}
      icon={<MenuIcon name="copy" />}
    />
  );
}

/** Star or Unstar, through the one favorites path every surface writes. */
export function StarItem({ target }: { target: FavoriteTarget }) {
  const { rows } = useFavorites();
  const starred = isFavorite(rows, target);
  return (
    <DropdownMenuItem
      onSelect={() => {
        void setFavorite(target, !starred).catch((cause: unknown) => {
          toast(cause instanceof Error ? cause.message : t('Couldn’t update favorites.'), 'danger');
        });
      }}
    >
      <MenuIcon name={starred ? 'unstar' : 'star'} />
      {starred ? t('Unstar') : t('Star')}
    </DropdownMenuItem>
  );
}

/**
 * The favorite a search row's door names, when the door carries the
 * reference Core stores. A person's favorite is keyed by their account id
 * and an issue's by `owner/repo#number`; a door carries neither, so those
 * rows have no Star here.
 */
export function favoriteTargetForDoor(door: SearchDoor): FavoriteTarget | null {
  switch (door.to) {
    case 'subject':
      return {
        kind: ({ lead: 'crm.lead', project: 'crm.project', organization: 'crm.partner', event: 'cms.event' } as const)[door.subjectKind],
        target_ref: door.id,
      };
    case 'task': return { kind: 'crm.task', target_ref: door.id };
    case 'document': return { kind: 'docs.document', target_ref: door.id };
    case 'folder': return { kind: 'docs.folder', target_ref: door.id };
    case 'thread': return { kind: 'meet.thread', target_ref: door.id };
    default: return null;
  }
}
