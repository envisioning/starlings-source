import { useState } from 'react';
import { ArrowDownIcon, ArrowUpIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/ui/dialog';
import { Input } from '@/ui/input';
import { confirmDataLoss } from './ConfirmDataLoss';
import {
  createDocsCategory,
  deleteDocsCategory,
  orderDocsCategories,
  updateDocsCategory,
  useDocsCategories,
  type DocsCategoryRow,
} from './docs';
import { ErrorNotice } from './ErrorNotice';
import { plural, t } from './i18n';
import { Tip } from './Tip';

/**
 * The workspace's categories, edited in place (envisioning/docs migration
 * 0008): add, rename, move up or down, delete. They are data on Docs, so the
 * same list Docs' own sidebar edits. A rename keeps the id, so every
 * address and filter that names it still works. Deleting one leaves its
 * documents uncategorized; the confirm says how many.
 */
export function DocsCategoriesDialog({ onClose, onChanged }: {
  onClose: () => void;
  /** The list changed: the rail reads its counts again. */
  onChanged: () => void;
}) {
  const categories = useDocsCategories();
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function run(act: () => Promise<unknown>, fallback: string) {
    setBusy(true);
    setError('');
    try {
      await act();
      onChanged();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallback);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const label = adding.trim();
    if (!label || busy) return;
    if (await run(() => createDocsCategory(label), t('Couldn’t add the category.'))) setAdding('');
  }

  function rename(category: DocsCategoryRow, label: string) {
    const next = label.trim();
    if (!next || next === category.label) return;
    void run(() => updateDocsCategory(category.id, { label: next }), t('Couldn’t rename the category.'));
  }

  function move(index: number, by: -1 | 1) {
    const ids = categories.map((category) => category.id);
    const [moved] = ids.splice(index, 1);
    if (!moved) return;
    ids.splice(index + by, 0, moved);
    void run(() => orderDocsCategories(ids), t('Couldn’t move the category.'));
  }

  async function remove(category: DocsCategoryRow) {
    if (!await confirmDataLoss({
      title: t('Delete “{title}”?', { title: category.label }),
      body: `${category.count > 0
        ? plural(category.count, { one: '{count} document becomes uncategorized.', other: '{count} documents become uncategorized.' })
        : t('No document is in it.')} ${t('This can’t be undone.')}`,
      action: t('Delete'),
    })) return;
    void run(() => deleteDocsCategory(category.id), t('Couldn’t delete the category.'));
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="gap-3 p-4 sm:max-w-md"
        aria-describedby={undefined}
        // Ours to close; the page's Escape (back to the list) must not fire too.
        onEscapeKeyDown={(event) => event.stopPropagation()}
      >
        <DialogTitle>{t('Categories')}</DialogTitle>
        {error && <ErrorNotice message={error} />}
        {categories.length === 0
          ? <p className="m-0 text-sm text-muted-foreground">{t('No categories yet.')}</p>
          : (
            <ul className="m-0 flex max-h-80 list-none flex-col gap-1.5 overflow-y-auto p-0" aria-label={t('Categories')}>
              {categories.map((category, index) => (
                <li key={category.id} className="flex items-center gap-1">
                  <Input
                    // Keyed by label so a rename from elsewhere replaces the field's text.
                    key={category.label}
                    type="text"
                    defaultValue={category.label}
                    maxLength={80}
                    aria-label={t('Name of {category}', { category: category.label })}
                    className="h-8 min-w-0 flex-1"
                    disabled={busy}
                    onBlur={(event) => rename(category, event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                    }}
                  />
                  <small className="w-8 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{category.count > 0 ? category.count : ''}</small>
                  <Tip label={t('Move up')}>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={t('Move {title} up', { title: category.label })} disabled={busy || index === 0} onClick={() => move(index, -1)}>
                      <ArrowUpIcon aria-hidden="true" />
                    </Button>
                  </Tip>
                  <Tip label={t('Move down')}>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={t('Move {title} down', { title: category.label })} disabled={busy || index === categories.length - 1} onClick={() => move(index, 1)}>
                      <ArrowDownIcon aria-hidden="true" />
                    </Button>
                  </Tip>
                  <Tip label={t('Delete')}>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={t('Delete {category}', { category: category.label })} disabled={busy} onClick={() => void remove(category)}>
                      <Trash2Icon aria-hidden="true" />
                    </Button>
                  </Tip>
                </li>
              ))}
            </ul>
          )}
        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void add(); }}>
          <Input
            type="text"
            value={adding}
            placeholder={t('New category')}
            aria-label={t('New category')}
            maxLength={80}
            className="h-8 min-w-0 flex-1"
            onChange={(event) => setAdding(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={busy || !adding.trim()}>{t('Add')}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
