import { useEffect, useState } from 'react';
import type { ThreadHandoff } from '@starlings/contracts';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/ui/dialog';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { ErrorNotice } from './ErrorNotice';
import { handOffCard, type HandOffCard } from './crm-work';
import { fetchPeers, isAgent, peerDisplayName, type Peer } from './team-presence';
import { t } from './i18n';

/**
 * Hand off: a card goes to an agent with what done looks like and
 * what comes back. Both are required. The Mac's `HandOffSheet`. The message
 * carries the card as its ref and the brief as `handoff`; its text repeats
 * both for the person reading the conversation later.
 */
export function HandOffDialog({ card, onHandedOff, onClose }: {
  card: HandOffCard;
  onHandedOff: (agent: Peer) => void;
  onClose: () => void;
}) {
  const [agents, setAgents] = useState<Peer[] | null>(null);
  const [agentEmail, setAgentEmail] = useState('');
  const [doneWhen, setDoneWhen] = useState('');
  const [deliverable, setDeliverable] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchPeers()
      .then((response) => {
        if (cancelled) return;
        const found = (response.peers ?? []).filter(isAgent);
        setAgents(found);
        setAgentEmail((current) => current || found[0]?.email || '');
      })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : t('Couldn’t load your team.')); });
    return () => { cancelled = true; };
  }, []);

  const agent = agents?.find((one) => one.email === agentEmail) ?? null;
  const brief: ThreadHandoff = { done_when: doneWhen.trim(), deliverable: deliverable.trim() };
  const ready = !!agent && brief.done_when.length > 0 && brief.deliverable.length > 0 && !busy;
  const title = card.issue ? card.issue.title : card.task?.title ?? '';

  async function handOff() {
    if (!ready || !agent) return;
    setBusy(true);
    try {
      await handOffCard(card, agent.email, brief);
      onHandedOff(agent);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t hand that off.'));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="gap-3 p-4 sm:max-w-md" aria-describedby={undefined} onEscapeKeyDown={(event) => event.stopPropagation()}>
        <DialogTitle>{t('Hand off')}</DialogTitle>
        <p className="m-0 text-[13px] text-muted-foreground">{title}</p>
        {agents && agents.length === 0 && <p className="m-0 text-[13px]">{t('No agents on your team yet.')}</p>}
        {agents && agents.length > 0 && (
          <div className="grid gap-1.5">
            <Label htmlFor="handoff-agent">{t('Agent')}</Label>
            <NativeSelect id="handoff-agent" value={agentEmail} disabled={busy} onChange={(event) => setAgentEmail(event.target.value)}>
              {agents.map((one) => <NativeSelectOption key={one.email} value={one.email}>{peerDisplayName(one)}</NativeSelectOption>)}
            </NativeSelect>
          </div>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor="handoff-done">{t('Done when')}</Label>
          <Input id="handoff-done" value={doneWhen} disabled={busy} autoFocus maxLength={1000}
            placeholder={t('What is true when this is finished')} onChange={(event) => setDoneWhen(event.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="handoff-deliverable">{t('Deliverable')}</Label>
          <Input id="handoff-deliverable" value={deliverable} disabled={busy} maxLength={500}
            placeholder={t('A pull request, a document, a message')} onChange={(event) => setDeliverable(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void handOff(); }} />
        </div>
        {error && <ErrorNotice message={error} copyText={error} />}
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>{t('Cancel')}</Button>
          <Button type="button" onClick={() => void handOff()} disabled={!ready}>{t('Hand off')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
