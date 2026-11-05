import type { ComponentProps } from 'react';
import type { PullItem } from '@starlings/contracts';
import { PullIcon } from './action-icons';
import { GlyphMark } from './SubjectMark';
import { byClass, IssueAuthorPill, IssueRowView, IssueSubtitle, issueMeta, issueStateLabel, RailRow, TaskRowView } from './rail-row';
import { t } from './i18n';
import { apiBase } from './config';
import { isFavorite, useFavorites } from './favorites';

export const TASK_ROW_EXIT_MS = 160;

/** The Work rows that are not a subject, built on the rail's one row shape
 * so Mine, a subject's Tasks and Issues panes, and Overview read alike —
 * the Mac's `WorkMyTaskRowView` / `WorkIssueRowView` on `WorkListRowView`. */

/** A task: click the body to open; show a completion well when the caller owns that action. */
export function TaskRow({ favoriteTargetRef, ...row }: Omit<ComponentProps<typeof TaskRowView>, 'starred'> & {
  favoriteTargetRef?: string;
}) {
  const { rows: favorites } = useFavorites();
  return <TaskRowView {...row} starred={Boolean(favoriteTargetRef) && isFavorite(favorites, { kind: 'crm.task', target_ref: favoriteTargetRef! })} />;
}

export { issueMeta, issueStateLabel };

function githubAvatarSrc(url: string): string {
  return `${apiBase}/crm/avatar?url=${encodeURIComponent(url)}&size=32`;
}

/** An issue: its state in the well, the body opens it. */
export function IssueRow({ issue, ...row }: Omit<ComponentProps<typeof IssueRowView>, 'starred' | 'avatarSrc'>) {
  const { rows: favorites } = useFavorites();
  return (
    <IssueRowView
      {...row}
      issue={issue}
      avatarSrc={githubAvatarSrc}
      starred={isFavorite(favorites, { kind: 'github.issue', target_ref: `${issue.owner.toLowerCase()}/${issue.repo.toLowerCase()}#${issue.number}` })}
    />
  );
}

const PULL_STATE_LABEL: Record<PullItem['state'], string> = {
  open: t('Open'),
  draft: t('Draft'),
  merged: t('Merged'),
  closed: t('Closed'),
};
const PULL_REVIEW_LABEL: Record<PullItem['review'], string | null> = {
  none: null,
  requested: t('review requested'),
  changes_requested: t('changes requested'),
  approved: t('approved'),
};
const PULL_CHECK_LABEL: Record<PullItem['checks'], string | null> = {
  none: null,
  pending: t('checks running'),
  success: t('checks green'),
  failure: t('checks red'),
};

/**
 * A pull request on a mapped repository. Opens on github.com: a
 * pull is read here and reviewed there. The subtitle carries the state, the
 * review verdict and the CI colour, which is what a standup wants to know.
 */
export function PullRow({ pull }: { pull: PullItem }) {
  const facts = [
    `${pull.owner}/${pull.repo} #${pull.number}`,
    PULL_STATE_LABEL[pull.state],
    PULL_REVIEW_LABEL[pull.review],
    pull.state === 'open' || pull.state === 'draft' ? PULL_CHECK_LABEL[pull.checks] : null,
    pull.closes.length ? t('closes {issues}', { issues: pull.closes.map((number) => `#${number}`).join(', ') }) : null,
  ].filter(Boolean);
  return (
    <RailRow
      leading={<GlyphMark shape="square"><PullIcon size={14} /></GlyphMark>}
      title={pull.title}
      subtitle={(
        <IssueSubtitle metadata={facts.join(' · ')}>
          {pull.author_login && (
            <>
              <span className={byClass}>by</span>
              <IssueAuthorPill login={pull.author_login} avatarSrc={null} />
            </>
          )}
        </IssueSubtitle>
      )}
      muted={pull.state === 'merged' || pull.state === 'closed'}
      onSelect={() => window.open(pull.url, '_blank', 'noopener,noreferrer')}
    />
  );
}
