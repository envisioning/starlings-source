import { useCallback, useEffect, useState } from 'react';
import { SIGNALS_OUTREACH_STATUSES, type CrmContactFacets, type SignalsOutreachStatus } from '@starlings/contracts';
import { Input } from '@/ui/input';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { RailRow, RailRowsPlaceholder, RailSection } from './SurfaceShell';
import { ErrorNotice } from './ErrorNotice';
import { FilterButton } from './FilterButton';
import { MenuIcon } from './menu-icons';
import { useMenuTrigger } from './menu-focus';
import { railListClass } from './rail-list';
import { searchCrmOrganizations } from './crm-work';
import {
  DEFAULT_CONTACT_FILTER,
  contactDisplayName,
  isDefaultContactFilter,
  listContacts,
  readContactFilter,
  writeContactFilter,
  type ContactListFilter,
  type ContactListPage, outreachLabel } from './contacts';
import { dateLocale, t } from './i18n';

/** The fold key, as on the Mac and the iPhone. */
const CONTACTS_GROUP_KEY = 'work.contacts';

/** A country code as its name in the reader's language, else the code. */
function countryName(code: string): string {
  try {
    return new Intl.DisplayNames([dateLocale], { type: 'region' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** A language code as its name in the reader's language, else the code. */
function languageName(code: string): string {
  try {
    return new Intl.DisplayNames([dateLocale], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * The Contacts group on Work's Browse: every contact, searched by
 * name, address, title or organization, with Core's contact filters. The
 * search and the filters read the Worker; a row opens the contact page.
 */
export function ContactsBrowseGroup({ selectedContact, version, onOpenContact }: {
  selectedContact: string | null;
  /** Moves when a contact changes elsewhere on the page; the group reads again. */
  version: number;
  onOpenContact: (contactID: string) => void;
}) {
  const [filter, setFilter] = useState<ContactListFilter>(readContactFilter);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<ContactListPage | null>(null);
  const [facets, setFacets] = useState<CrmContactFacets | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setPage(null);
    setError('');
    // A search waits for a pause in typing; a filter reads at once.
    const timer = window.setTimeout(() => {
      void listContacts(query, filter)
        .then((found) => {
          if (!live) return;
          setPage(found);
          if (found.facets) setFacets(found.facets);
        })
        .catch((cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : t('Couldn’t load contacts.')); });
    }, query.trim() ? 250 : 0);
    return () => { live = false; window.clearTimeout(timer); };
  }, [query, filter, version]);

  const changeFilter = useCallback((next: ContactListFilter) => {
    setFilter(next);
    writeContactFilter(next);
  }, []);

  const custom = !isDefaultContactFilter(filter) || query.trim() !== '';
  const contacts = page?.contacts ?? [];
  return (
    <div className="mt-[18px]">
      <RailSection
        title={t('Contacts')}
        storageKey={CONTACTS_GROUP_KEY}
        forcedOpen={query.trim() !== ''}
        accessory={(
          <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Input
              type="search"
              value={query}
              placeholder={t('Search')}
              aria-label={t('Search Contacts')}
              className="h-7 w-36 text-xs"
              onChange={(event) => setQuery(event.target.value)}
            />
            <ContactFilterMenu filter={filter} facets={facets} onChange={changeFilter} />
            {page && <small>{contacts.length}{page.hasMore ? '+' : ''}</small>}
          </span>
        )}
      >
        {error && <ErrorNotice message={error} copyText={error} />}
        {!error && !page && <RailRowsPlaceholder count={3} label={t('Loading…')} />}
        {page && contacts.length === 0 && <p className="lede">{custom ? t('Nothing matches.') : t('No contacts yet.')}</p>}
        <ul className={railListClass} aria-label={t('Contacts')}>
          {contacts.map((contact) => (
            <RailRow
              key={contact.id}
              title={contactDisplayName(contact)}
              subtitle={[contact.title, contact.organization_name].filter(Boolean).join(' · ') || undefined}
              active={contact.id === selectedContact}
              onSelect={() => onOpenContact(contact.id)}
            />
          ))}
        </ul>
      </RailSection>
    </div>
  );
}

/**
 * The Contacts group's filters: organization, country, partner, existing
 * client, Signals status and language. Country and language offer the values
 * the store answers in `facets`.
 */
function ContactFilterMenu({ filter, facets, onChange }: {
  filter: ContactListFilter;
  facets: CrmContactFacets | null;
  onChange: (next: ContactListFilter) => void;
}) {
  const menu = useMenuTrigger();
  const dirty = !isDefaultContactFilter(filter);
  const choice = (label: string, value: string | undefined, options: readonly string[], name: (option: string) => string, set: (value: string | undefined) => void) => (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>{value ? `${label}: ${name(value)}` : label}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
        <DropdownMenuRadioGroup value={value ?? ''} onValueChange={(next) => set(next || undefined)}>
          <DropdownMenuRadioItem value="">{t('Any')}</DropdownMenuRadioItem>
          {options.map((option) => <DropdownMenuRadioItem key={option} value={option}>{name(option)}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
  const countries = [...(facets?.countries ?? [])].sort((a, b) => countryName(a).localeCompare(countryName(b), dateLocale));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <FilterButton ref={menu.trigger} dirty={dirty} label={t('Filter Contacts')} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={menu.onCloseAutoFocus}>
        <OrganizationChoice filter={filter} onChange={onChange} />
        {countries.length > 0 && choice(t('Country'), filter.country, countries, countryName, (country) => onChange({ ...filter, country }))}
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={filter.partner} onCheckedChange={(checked) => onChange({ ...filter, partner: checked === true })} onSelect={(event) => event.preventDefault()}>{t('Partner')}</DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={filter.existing_client} onCheckedChange={(checked) => onChange({ ...filter, existing_client: checked === true })} onSelect={(event) => event.preventDefault()}>{t('Existing client')}</DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {choice(t('Signals status'), filter.signals_outreach_status, SIGNALS_OUTREACH_STATUSES, outreachLabel, (status) => onChange({ ...filter, signals_outreach_status: status as SignalsOutreachStatus | undefined }))}
        {facets && facets.languages.length > 0 && choice(t('Language'), filter.preferred_language, facets.languages, languageName, (preferred_language) => onChange({ ...filter, preferred_language }))}
        {dirty && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange(DEFAULT_CONTACT_FILTER)}><MenuIcon name="reset" />{t('Reset')}</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The organization filter: a search inside the submenu, since a workspace has too many organizations to list. */
function OrganizationChoice({ filter, onChange }: {
  filter: ContactListFilter;
  onChange: (next: ContactListFilter) => void;
}) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      void searchCrmOrganizations(query)
        .then((found) => { if (live) setOptions(found.slice(0, 20).map(({ id, name }) => ({ id, name }))); })
        .catch(() => { if (live) setOptions([]); });
    }, query.trim() ? 250 : 0);
    return () => { live = false; window.clearTimeout(timer); };
  }, [query]);
  const label = t('Organization');
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>{filter.organization_id ? `${label}: ${filter.organization_name ?? t('Organization')}` : label}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-80 w-64 overflow-y-auto">
        <div className="p-1">
          <Input
            type="search"
            value={query}
            placeholder={t('Search organizations')}
            aria-label={t('Search organizations')}
            className="h-7 text-xs"
            // The menu reads letters as a jump to an item; the field keeps them.
            onKeyDown={(event) => event.stopPropagation()}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <DropdownMenuRadioGroup
          value={filter.organization_id ?? ''}
          onValueChange={(id) => {
            const picked = options.find((option) => option.id === id);
            const rest: ContactListFilter = { ...filter };
            delete rest.organization_id;
            delete rest.organization_name;
            onChange(picked ? { ...rest, organization_id: picked.id, organization_name: picked.name } : rest);
          }}
        >
          <DropdownMenuRadioItem value="">{t('Any')}</DropdownMenuRadioItem>
          {filter.organization_id && !options.some((option) => option.id === filter.organization_id) && (
            <DropdownMenuRadioItem value={filter.organization_id}>{filter.organization_name ?? filter.organization_id}</DropdownMenuRadioItem>
          )}
          {options.map((option) => <DropdownMenuRadioItem key={option.id} value={option.id}>{option.name}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
