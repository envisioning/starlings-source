import { useEffect, useState } from 'react';
import type { PeerWorkspace, PeerWorkspaceTokenResponse } from '@starlings/contracts/subject-access';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { confirmDataLoss } from './ConfirmDataLoss';
import { ErrorNotice } from './ErrorNotice';
import { plural, t } from './i18n';
import { Note, SectionCard } from './SectionCard';
import { listPeerOrganizations, newPeerToken, revokePeerOrganization } from './subject-access-api';

/**
 * Admin's list of peer organizations (docs/ACCESS.md slice 5): the companies
 * whose Claude reaches the subjects shared with them. A member sees the list;
 * an admin revokes one, which closes every subject it holds at once, or
 * issues it a new token, shown once.
 */
export function PeerOrganizations({ canEdit }: { canEdit: boolean }) {
  const [peers, setPeers] = useState<PeerWorkspace[] | null>(null);
  const [error, setError] = useState('');
  const [issued, setIssued] = useState<PeerWorkspaceTokenResponse | null>(null);

  useEffect(() => {
    listPeerOrganizations().then(setPeers, (cause: unknown) => setError(cause instanceof Error ? cause.message : t('Couldn’t load organizations.')));
  }, []);

  const replace = (peer: PeerWorkspace) => setPeers((rows) => rows?.map((row) => (row.organization_id === peer.organization_id ? peer : row)) ?? rows);

  const revoke = async (peer: PeerWorkspace) => {
    if (!await confirmDataLoss({
      title: t('Revoke {name}?', { name: peer.name }),
      body: t('Its token stops at once and it reaches none of its subjects. A new token brings it back.'),
      action: t('Revoke'),
    })) return;
    try {
      replace(await revokePeerOrganization(peer.organization_id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t revoke the organization.'));
    }
  };

  const issue = async (peer: PeerWorkspace) => {
    try {
      const answer = await newPeerToken(peer.organization_id);
      replace(answer.peer);
      setIssued(answer);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t issue a new token.'));
    }
  };

  return (
    <SectionCard id="admin-peer-organizations" title={t('Organizations')}>
      {error && <ErrorNotice message={error} />}
      {peers?.length === 0 && <Note>{t('Nothing is shared with an organization.')}</Note>}
      <ul className="flex flex-col gap-2">
        {peers?.map((peer) => (
          <li key={peer.organization_id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate">{peer.name}</span>
            <span className="text-muted-foreground">
              {peer.revoked_at ? t('Revoked') : plural(peer.subjects, { one: '{count} subject', other: '{count} subjects' })}
            </span>
            {canEdit && (
              <>
                <Button type="button" size="sm" variant="outline" onClick={() => { void issue(peer); }}>{t('New token')}</Button>
                {!peer.revoked_at && <Button type="button" size="sm" variant="ghost" onClick={() => { void revoke(peer); }}>{t('Revoke')}</Button>}
              </>
            )}
          </li>
        ))}
      </ul>
      {issued && (
        <div className="flex flex-col gap-1">
          <Input readOnly aria-label={t('Organization token')} value={issued.peer_token} onFocus={(event) => event.currentTarget.select()} />
          <Note>{t('Shown once. {name} uses it at {url}.', { name: issued.peer.name, url: issued.peer_mcp_url })}</Note>
        </div>
      )}
    </SectionCard>
  );
}
