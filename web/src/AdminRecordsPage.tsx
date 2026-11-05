import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type {
  Characteristic,
  CharacteristicKind,
  ContactSourceDefinition,
  SubjectSettingsResponse,
  SubjectSettingsWrite,
} from '@starlings/contracts/subject-settings';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Input } from '@/ui/input';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { PlaceholderRows } from '@/ui/placeholder-rows';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { CommercialRecords } from './AdminRecordsCommercial';
import { AdminHeader } from './AdminNav';
import { apiFetch } from './api';
import { useDocumentTitle } from './document-title';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';
import { useOwnerSession } from './owner-session';
import { Note, PAGE, SectionCard, TableFrame } from './SectionCard';
import { SignInGate } from './SignInGate';
import { AppShell, MemberLoadingShell } from './SiteChrome';

/**
 * Admin › Records: the settings the subjects group carries. The
 * characteristics a lead or contact can have, and where a contact came from.
 * Core holds them until the subjects group moves; the page then says so and
 * edits nothing. Below them, the commercial group's settings,
 * shown once that group answers from D1.
 */
export function AdminRecordsPage() {
  const session = useOwnerSession();
  useDocumentTitle(t('Records'), t('Admin'));
  if (session.kind === 'loading') return <MemberLoadingShell />;
  if (session.kind === 'visitor') return <SignInGate title={t('Admin')} />;
  return (
    <AppShell variant="wide" member="home" memberNavCurrent={null}>
      <div className={PAGE}>
        <AdminHeader section="records" />
        <div className="grid gap-4">
          <RecordsSettings />
          <CommercialRecords />
        </div>
      </div>
    </AppShell>
  );
}

type Write = (change: SubjectSettingsWrite) => Promise<void>;

const CATEGORIES: ContactSourceDefinition['category'][] = ['manual', 'website', 'import', 'integration', 'inbound', 'legacy'];

function RecordsSettings() {
  const [data, setData] = useState<SubjectSettingsResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    apiFetch<SubjectSettingsResponse>('/admin/records', { fallbackError: t('Couldn’t load these settings.'), noStore: true })
      .then((body) => { if (!cancelled) setData(body); })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : t('Couldn’t load these settings.')); });
    return () => { cancelled = true; };
  }, []);

  const write = useCallback<Write>(async (change) => {
    setData(await apiFetch<SubjectSettingsResponse>('/admin/records', {
      method: 'POST',
      body: change,
      fallbackError: t('Couldn’t save the change.'),
      noStore: true,
    }));
  }, []);

  if (error) return <ErrorNotice message={error} />;
  if (!data) return <PlaceholderRows count={5} label={t('Opening…')} />;
  if (!data.editable) return <Note>{t('These settings can’t change here yet.')}</Note>;

  return (
    <div className="grid gap-4">
      <CharacteristicsCard id="records-lead" title={t('Lead characteristics')} kind="lead" rows={data.lead_characteristics} write={write} />
      <CharacteristicsCard id="records-contact" title={t('Contact characteristics')} kind="contact" rows={data.contact_characteristics} write={write} />
      <SourcesCard rows={data.contact_sources} write={write} />
    </div>
  );
}

/** One row's save: busy while it runs, and its own error under the table. */
function useSave() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t save the change.'));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}

function RowActions({ busy, dirty, onSave, onDelete }: { busy: boolean; dirty: boolean; onSave: () => void; onDelete?: () => void }) {
  return (
    <div className="flex justify-end gap-1.5">
      <Button type="button" size="sm" variant="secondary" disabled={busy || !dirty} onClick={onSave}>{t('Save')}</Button>
      {onDelete && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onDelete}>{t('Delete')}</Button>}
    </div>
  );
}

function EditTable({ head, children, error }: { head: string[]; children: ReactNode; error: string }) {
  return (
    <>
      <TableFrame>
        <Table>
          <TableHeader>
            <TableRow>
              {head.map((label) => <TableHead key={label} scope="col">{label}</TableHead>)}
              <TableHead scope="col"><span className="sr-only">{t('Actions')}</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>{children}</TableBody>
        </Table>
      </TableFrame>
      {error && <ErrorNotice message={error} />}
    </>
  );
}

// ── Characteristics ─────────────────────────────────────────────────────────

function CharacteristicsCard({ id, title, kind, rows, write }: { id: string; title: string; kind: CharacteristicKind; rows: Characteristic[]; write: Write }) {
  const save = useSave();
  return (
    <SectionCard id={id} title={title}>
      <EditTable head={[t('Name')]} error={save.error}>
        {rows.map((row) => <CharacteristicRow key={row.id} kind={kind} row={row} write={write} save={save} />)}
        <CharacteristicRow kind={kind} write={write} save={save} />
      </EditTable>
    </SectionCard>
  );
}

function CharacteristicRow({ kind, row, write, save }: { kind: CharacteristicKind; row?: Characteristic; write: Write; save: ReturnType<typeof useSave> }) {
  const [name, setName] = useState(row?.name ?? '');
  const dirty = name.trim() !== '' && name.trim() !== (row?.name ?? '');
  const onSave = () => void save.run(async () => {
    await write({ op: 'characteristic.save', kind, ...(row ? { id: row.id } : {}), name: name.trim() });
    if (!row) setName('');
  });
  return (
    <TableRow>
      <TableCell>
        <Input value={name} placeholder={row ? undefined : t('new_characteristic')} aria-label={t('Name')} onChange={(event) => setName(event.target.value)} />
      </TableCell>
      <TableCell>
        <RowActions busy={save.busy} dirty={dirty} onSave={onSave}
          {...(row ? { onDelete: () => void save.run(() => write({ op: 'characteristic.delete', kind, id: row.id })) } : {})} />
      </TableCell>
    </TableRow>
  );
}

// ── Contact sources ─────────────────────────────────────────────────────────

const NEW_SOURCE: ContactSourceDefinition = {
  key: '', label: '', category: 'manual', description: null, is_active: true,
  manual_selectable: true, import_selectable: false, is_system: false, sort_order: 100,
};

function SourcesCard({ rows, write }: { rows: ContactSourceDefinition[]; write: Write }) {
  const save = useSave();
  return (
    <SectionCard id="records-sources" title={t('Contact sources')}>
      <EditTable head={[t('Label'), t('Key'), t('Category'), t('Active'), t('Pick by hand'), t('Pick on import'), t('Order')]} error={save.error}>
        {rows.map((row) => <SourceRow key={row.key} row={row} write={write} save={save} />)}
        <SourceRow row={NEW_SOURCE} added write={write} save={save} />
      </EditTable>
    </SectionCard>
  );
}

function SourceRow({ row, added = false, write, save }: { row: ContactSourceDefinition; added?: boolean; write: Write; save: ReturnType<typeof useSave> }) {
  const [draft, setDraft] = useState(row);
  const set = <K extends keyof ContactSourceDefinition>(key: K, value: ContactSourceDefinition[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const dirty = draft.label.trim() !== '' && draft.key.trim() !== '' && JSON.stringify(draft) !== JSON.stringify(row);
  const onSave = () => void save.run(async () => {
    await write({
      op: 'source.save',
      key: draft.key.trim(),
      label: draft.label.trim(),
      category: draft.category,
      description: draft.description,
      is_active: draft.is_active,
      manual_selectable: draft.manual_selectable,
      import_selectable: draft.import_selectable,
      sort_order: draft.sort_order,
    });
    if (added) setDraft(NEW_SOURCE);
  });
  return (
    <TableRow>
      <TableCell><Input value={draft.label} aria-label={t('Label')} placeholder={added ? t('New source') : undefined} onChange={(event) => set('label', event.target.value)} /></TableCell>
      <TableCell>
        {added
          ? <Input value={draft.key} aria-label={t('Key')} placeholder="new_source" onChange={(event) => set('key', event.target.value)} />
          : <code className="text-[13px]">{row.key}</code>}
      </TableCell>
      <TableCell>
        <NativeSelect value={draft.category} aria-label={t('Category')} disabled={row.is_system} onChange={(event) => set('category', event.target.value as ContactSourceDefinition['category'])}>
          {CATEGORIES.map((category) => <NativeSelectOption key={category} value={category}>{category}</NativeSelectOption>)}
        </NativeSelect>
      </TableCell>
      <TableCell><Checkbox aria-label={t('Active')} checked={draft.is_active} onCheckedChange={(checked) => set('is_active', checked === true)} /></TableCell>
      <TableCell><Checkbox aria-label={t('Pick by hand')} checked={draft.manual_selectable} onCheckedChange={(checked) => set('manual_selectable', checked === true)} /></TableCell>
      <TableCell><Checkbox aria-label={t('Pick on import')} checked={draft.import_selectable} onCheckedChange={(checked) => set('import_selectable', checked === true)} /></TableCell>
      <TableCell>
        <Input className="w-20" type="number" inputMode="numeric" value={String(draft.sort_order)} aria-label={t('Order')}
          onChange={(event) => set('sort_order', Number.parseInt(event.target.value, 10) || 0)} />
      </TableCell>
      <TableCell><RowActions busy={save.busy} dirty={dirty} onSave={onSave} /></TableCell>
    </TableRow>
  );
}
