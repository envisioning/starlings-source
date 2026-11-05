import { useEffect, useRef, useState } from 'react';
import type { DocsSubject } from '@starlings/contracts';
import { SegmentedFilter } from './SegmentedFilter';
import { Command, CommandInput, CommandItem, CommandList } from '@/ui/command';
import { Popover, PopoverAnchor, PopoverContent } from '@/ui/popover';
import { fetchSubjects, type CrmSubject, type SubjectKind } from './crm-work';
import { returnFocusIfFree } from './menu-focus';
import { SUBJECT_KIND_LABELS } from '@starlings/contracts/subject-kinds';
import { t } from './i18n';

const SUBJECT_KIND_LABEL = Object.fromEntries(
  Object.entries(SUBJECT_KIND_LABELS).map(([kind, label]) => [kind, t(label)]),
) as Record<SubjectKind, string>;

/**
 * A project or lead, picked by name — what a document is about.
 * The CRM relation picker the Mac uses, as a small popover: a kind toggle,
 * a query, the first page of matches. shadcn's Popover and Command
 *: ↑ ↓ and Enter pick, Escape or a click outside closes.
 *
 * The caller opens it next to its own button and removes it on `onClose`.
 * The popover hangs from a zero-size anchor where it is rendered, and gives
 * the keyboard back to whatever had it when it opened.
 */
export function SubjectPicker({ onPick, onClose, kinds = ['project', 'lead'], initialKind, allStatuses = false, align = 'start' }: {
  /** The CRM row is the second argument, for a caller that keeps the title. */
  onPick: (subject: DocsSubject, row: CrmSubject) => void;
  onClose: () => void;
  /** The tabs offered; a filing control opens all four, a thread adds two. */
  kinds?: SubjectKind[];
  initialKind?: SubjectKind;
  /** Every status, not only open: a meeting is filed on the event it was about, however long ago. */
  allStatuses?: boolean;
  /** Which edge of the anchor the popover lines up with. */
  align?: 'start' | 'end';
}) {
  const [kind, setKind] = useState<SubjectKind>(initialKind ?? kinds[0] ?? 'project');
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<CrmSubject[]>([]);
  const [error, setError] = useState('');
  /** What had the keyboard when the picker opened — usually the caller's button. */
  const opener = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);

  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void fetchSubjects(kind, query, allStatuses ? 'all' : undefined).then((page) => {
        if (cancelled) return;
        setMatches(page.subjects);
        setError('');
      }).catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : t('Couldn’t search.'));
      });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [kind, query, allStatuses]);

  return (
    <Popover open onOpenChange={(open) => { if (!open) onClose(); }}>
      <PopoverAnchor asChild>
        <span className="pointer-events-none absolute top-[calc(100%+2px)] left-0 size-0" aria-hidden="true" />
      </PopoverAnchor>
      <PopoverContent
        align={align}
        className="w-72 p-2"
        aria-label={t('Add a subject')}
        // Ours to close; the page's Escape (back to the list) must not fire too.
        onEscapeKeyDown={(event) => event.stopPropagation()}
        // The button that opened the picker toggles it; a press there is not "outside".
        onInteractOutside={(event) => { if (opener.current?.contains(event.target as Node)) event.preventDefault(); }}
        onCloseAutoFocus={(event) => returnFocusIfFree(event, opener.current)}
      >
        <SegmentedFilter
          label={t('Type')}
          className="mb-2"
          value={kind}
          onChange={setKind}
          options={kinds.map((option) => ({ value: option, label: SUBJECT_KIND_LABEL[option] }))}
        />
        <Command shouldFilter={false} loop className="bg-transparent">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={t('Search')}
            aria-label={t('Search: {kind}', { kind: SUBJECT_KIND_LABEL[kind] })}
            autoFocus
          />
          <CommandList className="max-h-60">
            {error && <p className="px-2 py-3 text-xs text-muted-foreground">{error}</p>}
            {!error && matches.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">No {kind} matches.</p>}
            {matches.slice(0, 12).map((subject) => (
              <CommandItem key={subject.id} value={subject.id} onSelect={() => onPick({ system: 'core', kind, subject_id: subject.id }, subject)}>
                <span className="flex min-w-0 flex-col">
                  <strong className="truncate font-medium">{subject.title}</strong>
                  {subject.subtitle && <small className="truncate text-xs text-muted-foreground">{subject.subtitle}</small>}
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
