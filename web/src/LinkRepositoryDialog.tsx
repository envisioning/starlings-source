import { useEffect, useState } from 'react';
import { Button } from '@/ui/button';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/ui/command';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/ui/dialog';
import type { CrmGithubRepo } from '@starlings/contracts';
import { ErrorNotice } from './ErrorNotice';
import { linkProjectRepo, searchGithubRepos, type CrmSubject } from './crm-work';
import { t } from './i18n';

/**
 * Link a GitHub repository to a project (the Mac's "Add repository" sheet). Search what Meet's
 * GitHub App can see, choose one, link it. A project with a repository gets its Issues pane.
 */
export function LinkRepositoryDialog({ project, onLinked, onClose }: {
  project: CrmSubject;
  onLinked: (repo: CrmGithubRepo) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [repos, setRepos] = useState<CrmGithubRepo[] | null>(null);
  const [chosen, setChosen] = useState<CrmGithubRepo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Debounced: this is a search against GitHub, not a typeahead cache.
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchGithubRepos(query)
        .then((found) => { if (!cancelled) { setRepos(found); setError(''); } })
        .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : t('Couldn’t load repositories.')); });
    }, query ? 250 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query]);

  async function link() {
    if (!chosen || busy) return;
    setBusy(true);
    try {
      const linked = await linkProjectRepo(project.id, chosen);
      onLinked(linked);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t link that repository.'));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="gap-3 p-4 sm:max-w-md" aria-describedby={undefined} onEscapeKeyDown={(event) => event.stopPropagation()}>
        <DialogTitle>{t('Link a repository to {project}', { project: project.title })}</DialogTitle>
        <Command shouldFilter={false} loop className="rounded-lg border bg-transparent">
          <CommandInput placeholder={t('Search repositories')} aria-label={t('Search repositories')} value={query} onValueChange={setQuery} autoFocus />
          <CommandList className="max-h-72">
            {repos !== null && <CommandEmpty>{t('No repository matches.')}</CommandEmpty>}
            {(repos ?? []).map((repo) => (
              <CommandItem key={repo.id} value={repo.id} onSelect={() => setChosen(repo)} aria-selected={chosen?.id === repo.id}>
                <span className="min-w-0 flex-1 truncate">{repo.label?.trim() || `${repo.owner}/${repo.repo}`}</span>
                {chosen?.id === repo.id && <span className="text-xs text-muted-foreground">{t('Chosen')}</span>}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
        {error && <ErrorNotice message={error} copyText={error} />}
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>{t('Cancel')}</Button>
          <Button type="button" onClick={() => void link()} disabled={!chosen || busy}>{t('Link')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
