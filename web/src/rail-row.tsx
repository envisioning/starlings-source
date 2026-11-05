import { useState, type ComponentProps, type HTMLAttributes, type ReactNode, type Ref } from 'react';
import { railBlock, type RailSurface } from '@starlings/contracts/rail-blocks';
import type { CrmIssue } from '@starlings/contracts';
import { Avatar, AvatarFallback, AvatarImage } from '@/ui/avatar';
import { Badge } from '@/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { StarIcon } from 'lucide-react';
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/ui/item';
import { cn } from '@/lib/utils';
import { dateLocale, plural, t } from './i18n';
import { ChevronIcon, IssueStateIcon, TaskIcon } from './action-icons';
import { readStored, removeStored, StorageKeys, writeStored } from './storage';
import { GlyphMark } from './SubjectMark';

/*
 * The rail and its rows: the panel, a folding block, the Work row and its
 * starred mark, with no data of their own. The workspace shell re-exports
 * them; the product site draws the same rail with sample data, so this
 * module must not import a session, an API client or a store.
 */

/** The shared top-left favorite badge for a leading mark in a list or tile. */
export function StarredLeading({ starred, children }: { starred: boolean; children: ReactNode }) {
  return (
    <span className="relative inline-flex">
      {children}
      {starred && (
        <span aria-hidden="true" className="absolute -left-2 -top-2 inline-flex size-5 items-center justify-center rounded-full bg-card text-muted-foreground">
          <StarIcon strokeWidth={1.7} className="size-3 fill-current" />
        </span>
      )}
    </span>
  );
}


/**
 * A row — the Mac's `WorkSidebarRowView`: a leading mark, a title, a second
 * line, a badge after the title, an unread dot, and the highlight while it
 * is the thing the column shows. Clicking it is the way in; no button beside
 * it says the row does something else. Without `onSelect` it is a static
 * line in the same shape. Rows live in a `railListClass` list, in the rail
 * or in the column alike.
 *
 * shadcn's Item. One row, three settings, read from where it
 * sits (Tailwind's `in-[…]`): in a column's list it is a line of a
 * bordered card; in the rail and the inspector's context groups it is a
 * free-standing rounded row; in Team's person panel each row is its own
 * bordered card.
 */
export function RailRow({ leading, leadingAction, title, subtitle, badge, unread = false, active = false, muted = false, starred = false, trailing, swapTrailing = false, ariaLabel, selectRef, onSelect, menu, leaving = false }: {
  leading?: ReactNode;
  /** The leading well as a control — a task's tick. A button cannot sit
   * inside the select button, so it stands beside it in the same well. */
  leadingAction?: { label: string; onClick: () => void };
  title: ReactNode;
  subtitle?: ReactNode;
  /** After the title, on the same line: the star, a count. */
  badge?: ReactNode;
  unread?: boolean;
  active?: boolean;
  muted?: boolean;
  /** Starred: a star badge at the leading mark's top-left corner. */
  starred?: boolean;
  /** Outside the door, at the end: actions, a count. */
  trailing?: ReactNode;
  /**
   * `trailing` is a passive mark (a count, a star), not a control: on a
   * pointer device the row's `…` takes its place on hover, focus and while
   * its menu is open. Never set it when `trailing` holds a button.
   */
  swapTrailing?: boolean;
  ariaLabel?: string;
  /** The select button, for a caller that returns focus to the row after
   * closing what it opened. */
  selectRef?: Ref<HTMLButtonElement>;
  onSelect?: () => void;
  /** A task is completing; give its row an immediate exit before the write settles. */
  leaving?: boolean;
  /** The row's context menu (`useRowMenu`): the handlers for the `<li>`,
   * the attribute that marks the select button as the row's focus target,
   * and the panel, drawn under the row while open. The caller supplies the
   * attribute, so the shell does not load `home-keys` into the entry path. */
  menu?: { rowProps: HTMLAttributes<HTMLLIElement>; targetProps: Record<string, string>; panel: ReactNode };
}) {
  const body = (
    <>
      {!leadingAction && leading && <ItemMedia><StarredLeading starred={starred}>{leading}</StarredLeading></ItemMedia>}
      <ItemContent className="min-w-0 gap-0">
        <ItemTitle className="w-full min-w-0 gap-1.5">
          <strong className={cn('min-w-0 truncate text-sm font-medium', unread && 'font-semibold', muted && 'font-normal text-muted-foreground')}>{title}</strong>
          {badge}
          {starred && <span className="sr-only">{t('Starred')}</span>}
          {unread && <span className="ml-auto size-2 flex-none rounded-full bg-foreground" aria-label={t('Unread')} />}
        </ItemTitle>
        {subtitle && <ItemDescription className="line-clamp-none truncate text-xs">{subtitle}</ItemDescription>}
      </ItemContent>
    </>
  );
  // The door draws no focus ring of its own: Item's ring sat square and inset
  // inside the rounded selected row, apart from its `…`. The row
  // draws the one ring, on its own radius, for keyboard focus only.
  const door = cn('min-w-0 flex-auto flex-nowrap gap-2.5 rounded-none border-0 px-3 py-2 text-left focus-visible:border-transparent focus-visible:ring-0', leadingAction && 'pl-0');
  return (
    <li
      {...menu?.rowProps}
      aria-hidden={leaving || undefined}
      inert={leaving || undefined}
      className={cn(
        'relative flex items-center border-b last:border-b-0',
        (onSelect || active) && 'hover-lift',
        active && 'bg-(--selected)',
        'has-[>[data-slot=item]:focus-visible]:ring-[3px] has-[>[data-slot=item]:focus-visible]:ring-ring has-[>[data-slot=item]:focus-visible]:ring-inset',
        // In the rail and an inspector's context group: a free-standing row.
        'in-[.surface-rail]:rounded-lg in-[.surface-rail]:border-b-0 in-[.work-context-group-body]:rounded-lg in-[.work-context-group-body]:border-b-0',
        // In Team's person panel: each row its own bordered card.
        'in-[.team-person-work-list]:rounded-[9px] in-[.team-person-work-list]:border in-[.team-person-work-list]:bg-card in-[.team-person-work-list]:last:border-b',
        menu?.rowProps.className,
        leaving && 'task-row-leaving',
      )}
    >
      {leadingAction && (
        // shadcn: the leading slot of a rail row
        <button type="button" className="mr-2.5 flex flex-none cursor-pointer items-center border-0 bg-transparent py-2 pr-0 pl-3 opacity-70 hover:opacity-100" aria-label={leadingAction.label} onClick={leadingAction.onClick}><StarredLeading starred={starred}>{leading}</StarredLeading></button>
      )}
      {onSelect ? (
        <Item asChild size="sm" className={cn(door, 'cursor-pointer')}>
          {/* hover: the Item's door class lifts the row */}
          {/* shadcn: the whole rail row is the target, inside a shadcn Item */}
          <button type="button" ref={selectRef} aria-current={active ? 'page' : undefined} aria-label={ariaLabel} onClick={onSelect} {...menu?.targetProps}>{body}</button>
        </Item>
      ) : (
        <Item size="sm" className={door}>{body}</Item>
      )}
      {trailing && menu?.panel ? (
        // One column at the end, so the second line keeps the width: the
        // `…` at the top, the star or count under it.
        <div className={cn(
          'mr-1.5 flex flex-none flex-col items-end justify-between gap-0.5 self-stretch py-1 [&>[data-row-menu-button]]:mr-0',
          // On a pointer device the two share one cell: the mark, then the `…` over it.
          swapTrailing && '[@media(hover:hover)]:grid [@media(hover:hover)]:place-items-center [@media(hover:hover)]:py-0 [@media(hover:hover)]:*:col-start-1 [@media(hover:hover)]:*:row-start-1',
        )}>
          {menu.panel}
          <ItemActions className={cn(
            'pr-1 pb-0.5 [&_small]:text-[11px] [&_small]:text-muted-foreground',
            swapTrailing && '[@media(hover:hover)]:pr-0 [@media(hover:hover)]:pb-0 [@media(hover:hover)]:in-[[data-row-menu]:hover]:opacity-0 [@media(hover:hover)]:in-[[data-row-menu]:focus-within]:opacity-0 [@media(hover:hover)]:in-[[data-row-menu]:has([data-row-menu-button][data-state=open])]:opacity-0',
          )}>{trailing}</ItemActions>
        </div>
      ) : (
        <>
          {trailing && <ItemActions className="flex-none pr-2.5 in-[.surface-rail]:ml-auto [&_small]:text-[11px] [&_small]:text-muted-foreground">{trailing}</ItemActions>}
          {menu?.panel}
        </>
      )}
    </li>
  );
}

/** A task as Work draws it, with its starred state given. `TaskRow` in
 * WorkRows reads that state from the shared favorites. */
export function TaskRowView({ title, metadata, late = false, active = false, starred = false, onComplete, onOpen, menu, trailing, leaving = false }: {
  title: string;
  metadata: ReactNode;
  /** The section already says the row is late; the date only agrees. */
  late?: boolean;
  active?: boolean;
  starred?: boolean;
  /** Omit when the row is a link to somebody else's task. */
  onComplete?: () => void;
  onOpen: () => void;
  menu?: ComponentProps<typeof RailRow>['menu'];
  /** Outside the row's door, at the end: an action beside the task. */
  trailing?: ReactNode;
  leaving?: boolean;
}) {
  return (
    <RailRow
      leading={<GlyphMark shape="square"><TaskIcon size={14} /></GlyphMark>}
      leadingAction={onComplete ? { label: t('Complete {title}', { title }), onClick: onComplete } : undefined}
      title={title}
      // The section already says "Late": the weight agrees, never a colour.
      subtitle={late ? <span className="font-semibold text-foreground">{metadata}</span> : metadata}
      active={active}
      leaving={leaving}
      onSelect={onOpen}
      starred={starred}
      menu={menu}
      trailing={trailing}
    />
  );
}

/** One visible, theme-aware scrollbar for every viewport-bounded workspace pane. */
export const SCROLLBAR_AFFORDANCE_CLASS = [
  '[--scroll-thumb:color-mix(in_srgb,var(--ui-muted-foreground)_55%,transparent)]',
  '[--scroll-thumb-hover:var(--ui-muted-foreground)]',
  '[scrollbar-width:thin]',
  '[scrollbar-color:var(--scroll-thumb)_transparent]',
  '[&::-webkit-scrollbar]:w-2.5',
  '[&::-webkit-scrollbar-track]:bg-transparent',
  '[&::-webkit-scrollbar-thumb]:rounded-full',
  '[&::-webkit-scrollbar-thumb]:border-2',
  '[&::-webkit-scrollbar-thumb]:border-solid',
  '[&::-webkit-scrollbar-thumb]:border-transparent',
  '[&::-webkit-scrollbar-thumb]:bg-[var(--scroll-thumb)]',
  '[&::-webkit-scrollbar-thumb]:bg-clip-content',
  '[&::-webkit-scrollbar-thumb:hover]:bg-[var(--scroll-thumb-hover)]',
].join(' ');

export const surfaceScrollClass = cn(
  'min-[761px]:box-border min-[761px]:max-h-full min-[761px]:min-h-0 min-[761px]:overflow-y-auto min-[761px]:overscroll-contain',
  SCROLLBAR_AFFORDANCE_CLASS,
);

/**
 * The rail and the inspector are panels, the Mac's `StarlingsColors.panel`
 * column with its divider. Everything inside sits flat on the panel: no
 * list draws a box of its own on a box.
 */
export const surfacePanelClass = cn('min-w-0 rounded-xl border bg-card p-3', surfaceScrollClass);

/**
 * Whether a rail block is folded shut, remembered per block under one prefix
 * (the Mac's `meet.sidebarFold.<key>`). A fold is a preference and not a
 * session: somebody who keeps PEOPLE closed means it.
 */
export function useRailFold(key: string): [boolean, () => void] {
  const [folded, setFolded] = useState(() => readStored(StorageKeys.railFold + key) === '1');
  return [folded, () => setFolded((current) => {
    if (current) removeStored(StorageKeys.railFold + key); else writeStored(StorageKeys.railFold + key, '1');
    return !current;
  })];
}

/**
 * One block of the rail — the Mac's `SidebarSection`: an uppercase header
 * with a chevron, an optional accessory beside the header, and nothing at
 * all when it has nothing to list. No total on the header. shadcn's Collapsible
 *; the fold is remembered per block (`useRailFold`).
 */
/**
 * A rail block's fold key and empty rule, from the table every client reads
 * (`@starlings/contracts/rail-blocks`). Spread onto a `RailSection`; its title, rows and
 * empty message stay the page's.
 */
export function railBlockProps(surface: RailSurface, id: string): { storageKey: string; hidesWhenEmpty: boolean } {
  const block = railBlock(surface, id);
  return { storageKey: block.key, hidesWhenEmpty: block.hidesWhenEmpty };
}

export function RailSection({ title, storageKey, count, accessory, hidesWhenEmpty = false, forcedOpen = false, empty, children }: {
  title: string;
  storageKey: string;
  /** Open whatever the fold says, while a search thins the block (the Mac's `setForcedExpanded`). */
  forcedOpen?: boolean;
  /** How many rows the block lists. Never drawn; it says whether the block is empty. */
  count?: number;
  accessory?: ReactNode;
  hidesWhenEmpty?: boolean;
  /** Drawn under the header while the block is empty and shown. */
  empty?: ReactNode;
  children?: ReactNode;
}) {
  const [folded, toggle] = useRailFold(storageKey);
  const isEmpty = count === 0;
  if (hidesWhenEmpty && isEmpty) return null;
  const id = `rail-${storageKey.replace(/[^a-z0-9]+/gi, '-')}`;
  return (
    <Collapsible asChild open={forcedOpen || !folded} onOpenChange={() => { if (!forcedOpen) toggle(); }}>
      {/* rail-section / rail-section-head stay as hooks for Docs' first-row height. */}
      <section className="rail-section mb-3.5" aria-labelledby={id}>
        <div className="rail-section-head mb-1 flex min-h-[30px] items-center justify-between gap-2">
          <h2 id={id} className="m-0 min-w-0 flex-auto text-xs font-medium tracking-[0.08em] uppercase">
            <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent py-1 pr-2.5 pl-1 text-left text-muted-foreground hover-lift hover:text-foreground">
              <span className="inline-flex transition-transform duration-100 in-data-[state=closed]:-rotate-90 motion-reduce:transition-none" aria-hidden="true"><ChevronIcon /></span>
              {title}
            </CollapsibleTrigger>
          </h2>
          {accessory}
        </div>
        <CollapsibleContent>
          {isEmpty && empty ? <RailEmpty>{empty}</RailEmpty> : children}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

/** The one line an empty block says. */
export function RailEmpty({ children }: { children: ReactNode }) {
  return <p className="mx-2.5 mt-1 mb-2 text-[13px] text-muted-foreground">{children}</p>;
}

/**
 * Where it lives, who opened it and when, and what has accrued since — the
 * line GitHub puts under a title, in the same order the native clients use.
 */
export function issueMeta(issue: CrmIssue): string {
  const owners = issue.assignees?.length
    ? issue.assignees.map((one) => one.login)
    : [issue.assignee_login].filter(Boolean);
  const opened = issue.created_at ? new Date(issue.created_at) : null;
  return [
    `${issue.repo} #${issue.number}`,
    opened && !Number.isNaN(opened.valueOf())
      ? opened.toLocaleDateString(dateLocale, { day: 'numeric', month: 'short', year: 'numeric' })
      : null,
    owners.length ? `→ ${owners.join(', ')}` : null,
    issue.milestone,
    issue.issue_type,
    issue.sub_issues ? t('{completed}/{total} done', { completed: issue.sub_issues.completed, total: issue.sub_issues.total }) : null,
    issue.comments > 0 ? plural(issue.comments, { one: '{count} comment', other: '{count} comments' }) : null,
  ].filter(Boolean).join(' · ');
}

export function issueStateLabel(issue: Pick<CrmIssue, 'state' | 'state_reason'>): string {
  if (issue.state === 'open') return 'Open issue';
  return issue.state_reason === 'not_planned' ? 'Closed, not planned' : 'Closed issue';
}


function authorInitials(login: string): string {
  return login.slice(0, 2).toUpperCase();
}

/** The GitHub creator stays visible as an identity, not a second metadata sentence. */
export function IssueAuthorPill({ login, avatarSrc }: { login: string; avatarSrc: string | null }) {
  return (
    <Badge
      variant="outline"
      className="max-w-40 flex-none gap-[5px] overflow-hidden rounded-full bg-(--surface-sunken) py-0.5 pr-[7px] pl-[3px] text-[11px] leading-[1.15] font-normal text-foreground"
      aria-label={`GitHub user ${login}`}
      title={`GitHub user @${login}`}
    >
      <Avatar className="size-4 flex-none" aria-hidden="true">
        {avatarSrc && <AvatarImage src={avatarSrc} alt="" loading="lazy" />}
        <AvatarFallback className="bg-(--surface-raised) text-[7px] font-[650] tracking-[0.02em] text-muted-foreground">{authorInitials(login)}</AvatarFallback>
      </Avatar>
      <span className="truncate">{login}</span>
    </Badge>
  );
}

/** The metadata line, cut short so the creator's pill at the end stays in view. */
export function IssueSubtitle({ metadata, children }: { metadata: ReactNode; children?: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="min-w-0 truncate">{metadata}</span>
      {children}
    </span>
  );
}

/** "by", before the creator's pill. */
export const byClass = 'flex-none text-muted-foreground';

/** An issue as Work draws it: its state in the well, the body opens it. The
 * starred state and the avatar address are given; `IssueRow` in WorkRows
 * reads them from the shared favorites and the API. */
export function IssueRowView({ issue, metadata, active = false, starred = false, avatarSrc, onOpen, menu }: {
  issue: CrmIssue;
  metadata: ReactNode;
  active?: boolean;
  starred?: boolean;
  /** The creator's picture, from their GitHub avatar URL; omit to draw initials only. */
  avatarSrc?: (url: string) => string;
  onOpen: () => void;
  menu?: ComponentProps<typeof RailRow>['menu'];
}) {
  return (
    <RailRow
      leading={<GlyphMark shape="square"><IssueStateIcon open={issue.state === 'open'} notPlanned={issue.state_reason === 'not_planned'} size={14} /></GlyphMark>}
      title={issue.title}
      subtitle={(
        <IssueSubtitle metadata={metadata}>
          {issue.author && (
            <>
              <span className={byClass}>by</span>
              <IssueAuthorPill login={issue.author.login} avatarSrc={issue.author.avatar_url && avatarSrc ? avatarSrc(issue.author.avatar_url) : null} />
            </>
          )}
        </IssueSubtitle>
      )}
      active={active}
      ariaLabel={`${issue.title}, ${issueStateLabel(issue).toLowerCase()}`}
      onSelect={onOpen}
      starred={starred}
      menu={menu}
    />
  );
}
