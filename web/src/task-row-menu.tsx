import type { WorkTaskMenuContext } from '@starlings/contracts/work-actions';
import { DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '@/ui/dropdown-menu';
import { RowMenuItems, StarItem, issueFavoriteTarget, type RowMenuDoor } from './row-menu-items';
import { MenuIcon } from './menu-icons';
import { t } from './i18n';
import type { CrmIssue, CrmTeamMember, IssueStateChange } from './crm-work';

/** Assign to… on a row: who can hold it, who is signed in, and what choosing one does. */
export type RowAssign = {
  team: readonly CrmTeamMember[];
  /** The signed-in member's address: their row leads the list, as "Me". */
  me: string | null;
  onAssign: (member: CrmTeamMember) => void;
};

/**
 * Assign to ▸ one item per teammate, by name. On an issue only people
 * GitHub knows can be chosen; the rest stay listed and say why not.
 */
function AssignItem({ assign, needsGithub }: { assign: RowAssign; needsGithub: boolean }) {
  // You first, as "Me", then everyone else by name.
  const me = assign.me?.trim().toLowerCase() ?? '';
  const isMe = (member: CrmTeamMember) => me !== '' && (member.email ?? '').trim().toLowerCase() === me;
  // People before agents.
  const isAgent = (member: CrmTeamMember) => member.kind === 'agent';
  const team = [...assign.team].sort((a, b) => Number(isMe(b)) - Number(isMe(a)) || Number(isAgent(a)) - Number(isAgent(b)) || a.name.localeCompare(b.name));
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger><MenuIcon name="assign" />{t('Assign to')}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {team.map((member) => {
          const blocked = needsGithub && !member.github_login;
          return (
            <DropdownMenuItem key={member.id} disabled={blocked} onSelect={() => assign.onAssign(member)}>
              {blocked
                ? t('{name} (no GitHub username)', { name: isMe(member) ? t('Me') : member.name })
                : isMe(member) ? t('Me') : member.name}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** Where an Open item goes: a link, or an in-page handler. */
export type TaskMenuDoor = { href: string } | { onClick: () => void };

/**
 * A task row's menu items, in the groups of the shared registry
 * (`@starlings/contracts/work-actions`, the table the Mac and the phone draw),
 * through `RowMenuItems`. An action with no handler here drops out.
 * Home's glance card moves its door to the first group so opening its menu
 * cannot make a state change the first keyboard action.
 */
export function TaskMenuItems({ context, subjectTitle, door, coreDoor, favoriteRef, preferDoor = false, onAccept, onDecline, onDone, onCancel, onSeen, onFileGitHub, onHandOff, onDelete, assign }: {
  context: WorkTaskMenuContext;
  /** Null when the task has no subject: the door is Mine. */
  subjectTitle: string | null;
  door?: TaskMenuDoor;
  /** The task's subject in Core (`coreTaskDoor`). */
  coreDoor?: RowMenuDoor;
  /** The task id, when the row stars the task. */
  favoriteRef?: string;
  /** Put navigation first on a glance card's context menu. */
  preferDoor?: boolean;
  onAccept?: () => void;
  onDecline?: () => void;
  onDone?: () => void;
  onCancel?: () => void;
  onSeen?: () => void;
  /** Only for a project task that is not on GitHub yet. */
  onFileGitHub?: () => void;
  /** To an agent, with a brief. Only where the team has an agent. */
  onHandOff?: () => void;
  /** Delete…: the caller asks first. Only where the member can write the task. */
  onDelete?: () => void;
  /** Assign to… (UNOWNED's first group). */
  assign?: RowAssign;
}) {
  const hasSubject = subjectTitle !== null;
  const doorAction = hasSubject ? 'open-subject' : 'open-mine';
  const label = hasSubject ? t('Open {title}', { title: subjectTitle }) : t('Open in Mine');
  return (
    <RowMenuItems
      kind="task"
      context={context}
      preferDoor={preferDoor}
      facts={{ hasSubject, hasCore: !!coreDoor, canFileOnGitHub: !!onFileGitHub, isStarable: favoriteRef !== undefined, canAssign: (assign?.team.length ?? 0) > 0, canHandOff: !!onHandOff, canDelete: !!onDelete }}
      run={{
        accept: onAccept,
        decline: onDecline,
        complete: onDone,
        cancel: onCancel,
        'mark-seen': onSeen,
        'file-github': onFileGitHub,
        'hand-off': onHandOff,
        delete: onDelete,
        ...(door && 'onClick' in door ? { [doorAction]: door.onClick } : {}),
      }}
      doors={{
        ...(door && 'href' in door ? { [doorAction]: { href: door.href, label } } : {}),
        'open-core': coreDoor,
      }}
      labels={{ [doorAction]: label, delete: t('Delete…') }}
      render={{
        star: favoriteRef ? () => <StarItem target={{ kind: 'crm.task', target_ref: favoriteRef }} /> : undefined,
        assign: assign ? () => <AssignItem assign={assign} needsGithub={false} /> : undefined,
      }}
    />
  );
}

/**
 * An issue row's menu, in the registry's groups: close or reopen; Seen,
 * when the row is an assigned INBOX row; the issue's door, where the row has
 * one elsewhere; then the star. Home's glance card puts its door first so
 * the first keyboard action does not change issue state.
 */
export function IssueMenuItems({ issue, onChange, onSeen, onHandOff, door, coreDoor, preferDoor = false, assign }: {
  issue: Pick<CrmIssue, 'owner' | 'repo' | 'number' | 'state'>;
  onChange: (change: IssueStateChange) => void;
  onSeen?: () => void;
  /** To an agent, with a brief. Only where the team has an agent. */
  onHandOff?: () => void;
  door?: TaskMenuDoor;
  coreDoor?: RowMenuDoor;
  /** Put navigation first on a glance card's context menu. */
  preferDoor?: boolean;
  /** Assign to…: an UNOWNED row, whose menu leads with it. */
  assign?: RowAssign;
}) {
  const label = t('Open {title}', { title: `${issue.repo}#${issue.number}` });
  return (
    <RowMenuItems
      kind="issue"
      context={assign ? 'unowned' : 'assigned'}
      preferDoor={preferDoor}
      facts={{ isOpen: issue.state === 'open', hasCore: !!coreDoor, canMarkSeen: !!onSeen, canAssign: assign?.team.some((member) => member.github_login) ?? false, canHandOff: !!onHandOff }}
      run={{
        'close-issue': () => onChange('close'),
        'close-not-planned': () => onChange('close_not_planned'),
        'reopen-issue': () => onChange('reopen'),
        'mark-seen': onSeen,
        'hand-off': onHandOff,
        ...(door && 'onClick' in door ? { open: door.onClick } : {}),
      }}
      doors={{
        ...(door && 'href' in door ? { open: { href: door.href, label } } : {}),
        'open-core': coreDoor,
      }}
      labels={{ open: label }}
      render={{
        star: () => <StarItem target={issueFavoriteTarget(issue)} />,
        assign: assign ? () => <AssignItem assign={assign} needsGithub /> : undefined,
      }}
    />
  );
}
