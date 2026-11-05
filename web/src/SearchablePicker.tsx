import { useEffect, useId, useMemo, useState, Fragment } from 'react';
import { Check, ChevronDown, Plus, Star } from 'lucide-react';
import { Button } from '@/ui/button';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { cn } from '@/lib/utils';
import { Field, FieldLabel } from '@/ui/field';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';
import { searchablePickerMatches, type SearchablePickerOption } from './searchable-picker';

/** Native-looking web combobox for the shared long-list option contract. */
export function SearchablePicker({
  label,
  placeholder,
  options,
  value,
  onChange,
  emptyMessage,
  disabled = false,
  onSearch,
  onCreate,
  className,
}: {
  label: string;
  placeholder: string;
  options: SearchablePickerOption[];
  value: string;
  onChange: (value: string) => void;
  emptyMessage: string;
  disabled?: boolean;
  onSearch?: (query: string) => Promise<SearchablePickerOption[]>;
  onCreate?: (name: string) => Promise<SearchablePickerOption>;
  className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [remoteOptions, setRemoteOptions] = useState<SearchablePickerOption[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const selected = options.find((option) => option.id === value);

  const visible = useMemo(() => {
    const source = query.trim() ? remoteOptions ?? options : options;
    return source.filter((option) => searchablePickerMatches(option, query));
  }, [options, query, remoteOptions]);

  useEffect(() => {
    const cleaned = query.trim();
    if (!open || !cleaned || !onSearch) {
      setRemoteOptions(null);
      setSearching(false);
      setSearchError('');
      return;
    }
    let active = true;
    setSearching(true);
    setSearchError('');
    const timer = window.setTimeout(() => {
      void onSearch(cleaned)
        .then((results) => { if (active) setRemoteOptions(results); })
        .catch((error: unknown) => {
          if (!active) return;
          setRemoteOptions([]);
          setSearchError(error instanceof Error ? error.message : emptyMessage);
        })
        .finally(() => { if (active) setSearching(false); });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [onSearch, open, query]);

  useEffect(() => setCreateError(''), [query]);

  function close(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      setQuery('');
      setRemoteOptions(null);
      setSearching(false);
    }
  }

  function choose(option: SearchablePickerOption) {
    onChange(option.id);
    close(false);
  }

  async function createFromQuery() {
    const name = query.trim();
    if (!onCreate || name.length < 2 || creating || searching || searchError) return;
    setCreating(true);
    setCreateError('');
    try {
      const created = await onCreate(name);
      onChange(created.id);
      close(false);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : emptyMessage);
    } finally {
      setCreating(false);
    }
  }

  const foldedQuery = fold(query.trim());
  const hasExactMatch = foldedQuery.length > 0 && visible.some((option) => fold(option.title) === foldedQuery);
  const canCreate = Boolean(onCreate && foldedQuery.length >= 2 && !searching && !searchError && !hasExactMatch);

  return (
    <Field className={cn('gap-1', className)}>
      <FieldLabel htmlFor={id} className="text-xs font-normal text-muted-foreground">{label}</FieldLabel>
      <Popover open={open} onOpenChange={close}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-label={`${label}, ${selected ? displayTitle(selected) : placeholder}`}
            className="w-full justify-between font-normal"
            disabled={disabled}
          >
            <span className="flex min-w-0 items-center gap-2">
              {selected?.color && <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: selected.color }} aria-hidden />}
              <span className="truncate">{selected ? displayTitle(selected) : placeholder}</span>
            </span>
            <ChevronDown className="ml-2 size-4 shrink-0 text-muted-foreground" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
          <Command shouldFilter={false} loop>
            <CommandInput
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder={t('Search')}
              aria-label={t('Search')}
            />
            <CommandList>
              {visible.map((option, index) => (
                <Fragment key={option.id}>
                  {option.group && option.group !== visible[index - 1]?.group && (
                    <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground" role="presentation">{option.group}</div>
                  )}
                  <CommandItem
                    value={option.id}
                    onSelect={() => choose(option)}
                    className="gap-2"
                  >
                    <span className="min-w-0 flex-1 truncate">{displayTitle(option)}</span>
                    {option.isStarred && <Star className="size-3.5 fill-current text-(--accent-mark)" aria-label={t('Starred')} />}
                    {option.color && <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: option.color }} aria-hidden />}
                    {option.id === value && <Check className="size-4 text-(--accent-mark)" aria-hidden />}
                  </CommandItem>
                </Fragment>
              ))}
              {canCreate && (
                <CommandItem value={`create-${foldedQuery}`} onSelect={() => void createFromQuery()} disabled={creating} className="gap-2">
                  <Plus className="size-4 shrink-0" aria-hidden />
                  <span className="font-medium">{t('Create organization')}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{query.trim()}</span>
                </CommandItem>
              )}
              {!searching && !searchError && <CommandEmpty>{emptyMessage}</CommandEmpty>}
              {searching && <div className="px-2 py-3 text-center text-sm text-muted-foreground">{t('Searching…')}</div>}
              {searchError && <ErrorNotice message={searchError} inline className="p-2 text-sm" />}
              {createError && <ErrorNotice message={createError} inline className="p-2 text-sm" />}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </Field>
  );
}

function displayTitle(option: SearchablePickerOption): string {
  return option.context ? `${option.context} · ${option.title}` : option.title;
}

function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase();
}
