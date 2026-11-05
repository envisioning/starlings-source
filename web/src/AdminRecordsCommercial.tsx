import { useEffect, useState } from 'react';
import type { CommercialSettingsResponse, CommercialSettingsTable, CommercialSettingsWrite } from '@starlings/contracts/commercial-settings';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Input } from '@/ui/input';
import { PlaceholderRows } from '@/ui/placeholder-rows';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { Textarea } from '@/ui/textarea';
import { apiFetch } from './api';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';
import { RailSection } from './SurfaceShell';
import { TableFrame } from './SectionCard';

/**
 * Admin › Records, the commercial group's settings. Each table is
 * a list of columns: one row form draws them all. Nothing shows while another
 * store holds the group. The catalog is a page in Work, not here.
 */
type FieldKind = 'text' | 'long' | 'url' | 'date' | 'number' | 'flag';
interface Column { key: string; label: string; kind: FieldKind; required?: boolean }

const TERM_COLUMNS: Column[] = [
  { key: 'title', label: 'Title', kind: 'text', required: true },
  { key: 'description', label: 'Text', kind: 'long', required: true },
  { key: 'is_active', label: 'Active', kind: 'flag' },
  { key: 'is_default', label: 'Default', kind: 'flag' },
];

const TABLES: ReadonlyArray<{ table: CommercialSettingsTable; title: string; columns: Column[]; deletes: boolean }> = [
  { table: 'settings_payment_terms', title: 'Payment terms', columns: TERM_COLUMNS, deletes: true },
  {
    table: 'currency_settings',
    title: 'Currencies',
    deletes: false,
    columns: [
      { key: 'currency_code', label: 'Code', kind: 'text', required: true },
      { key: 'symbol', label: 'Symbol', kind: 'text', required: true },
      { key: 'surcharge_percentage', label: 'Surcharge, %', kind: 'number', required: true },
      { key: 'is_enabled', label: 'On', kind: 'flag' },
    ],
  },
  {
    table: 'corporate_entities',
    title: 'Corporate entities',
    deletes: true,
    columns: [
      { key: 'name', label: 'Name', kind: 'text', required: true },
      { key: 'legal_name', label: 'Legal name', kind: 'text' },
      { key: 'address', label: 'Address', kind: 'text' },
      { key: 'postcode', label: 'Postcode', kind: 'text' },
      { key: 'city', label: 'City', kind: 'text' },
      { key: 'country', label: 'Country', kind: 'text' },
      { key: 'vat_id', label: 'VAT ID', kind: 'text' },
      { key: 'tax_id', label: 'Tax ID', kind: 'text' },
      { key: 'logo_url', label: 'Logo URL', kind: 'text' },
      { key: 'billing_iban', label: 'IBAN', kind: 'text' },
      { key: 'signatory_name', label: 'Signatory', kind: 'text' },
      { key: 'signatory_title', label: 'Signatory title', kind: 'text' },
      { key: 'is_default', label: 'Default', kind: 'flag' },
    ],
  },
  { table: 'settings_delivery_conditions', title: 'Delivery conditions', columns: TERM_COLUMNS, deletes: true },
  {
    table: 'settings_offer_links',
    title: 'Offer links',
    deletes: true,
    columns: [
      { key: 'title', label: 'Title', kind: 'text', required: true },
      { key: 'url', label: 'URL', kind: 'url', required: true },
      { key: 'icon', label: 'Icon', kind: 'text' },
      { key: 'is_active', label: 'Active', kind: 'flag' },
      { key: 'is_default', label: 'Default', kind: 'flag' },
    ],
  },
  {
    table: 'policies',
    title: 'Policies',
    deletes: true,
    columns: [
      { key: 'title', label: 'Title', kind: 'text', required: true },
      { key: 'description', label: 'Text', kind: 'long' },
      { key: 'effective_date', label: 'Effective', kind: 'date' },
      { key: 'url', label: 'URL', kind: 'url' },
    ],
  },
];

type Values = Record<string, string | boolean>;

function valuesOf(columns: Column[], row: Record<string, unknown> | null): Values {
  return Object.fromEntries(columns.map((column) => {
    const value = row?.[column.key];
    if (column.kind === 'flag') return [column.key, row ? value === true : column.key !== 'is_default'];
    return [column.key, value === null || value === undefined ? '' : String(value)];
  }));
}

function wireOf(columns: Column[], values: Values): Record<string, unknown> {
  return Object.fromEntries(columns.map((column) => {
    const value = values[column.key];
    if (column.kind === 'flag') return [column.key, value === true];
    const text = String(value ?? '').trim();
    if (column.kind === 'number') return [column.key, Number(text) || 0];
    return [column.key, text === '' && !column.required ? null : text];
  }));
}

export function CommercialRecords() {
  const [data, setData] = useState<CommercialSettingsResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const fallbackError = t('Couldn’t load these settings.');
    apiFetch<CommercialSettingsResponse>('/admin/records/commercial', { fallbackError, noStore: true })
      .then((body) => { if (!cancelled) setData(body); })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : fallbackError); });
    return () => { cancelled = true; };
  }, []);

  const write = async (change: CommercialSettingsWrite) => {
    setData(await apiFetch<CommercialSettingsResponse>('/admin/records/commercial', {
      method: 'POST',
      body: change,
      fallbackError: t('Couldn’t save the change.'),
      noStore: true,
    }));
  };

  if (error) return <ErrorNotice message={error} />;
  if (!data) return <PlaceholderRows count={3} label={t('Opening…')} />;
  if (!data.editable) return null;
  return (
    <div>
      {TABLES.map(({ table, title, columns, deletes }) => (
        <RailSection key={table} title={t(title)} storageKey={`admin.records.${table}`}>
          <SettingsTable table={table} columns={columns} deletes={deletes} rows={data[table] as Array<Record<string, unknown>>} write={write} />
        </RailSection>
      ))}
    </div>
  );
}

function SettingsTable({ table, columns, deletes, rows, write }: {
  table: CommercialSettingsTable;
  columns: Column[];
  deletes: boolean;
  rows: Array<Record<string, unknown>>;
  write: (change: CommercialSettingsWrite) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (action: () => Promise<void>) => {
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
  };
  return (
    <>
      <TableFrame>
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((column) => <TableHead key={column.key} scope="col">{t(column.label)}</TableHead>)}
              <TableHead scope="col"><span className="sr-only">{t('Actions')}</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => <SettingsRow key={String(row.id)} table={table} columns={columns} row={row} deletes={deletes} busy={busy} run={run} write={write} />)}
            <SettingsRow key="new" table={table} columns={columns} row={null} deletes={false} busy={busy} run={run} write={write} />
          </TableBody>
        </Table>
      </TableFrame>
      {error && <ErrorNotice message={error} />}
    </>
  );
}

function SettingsRow({ table, columns, row, deletes, busy, run, write }: {
  table: CommercialSettingsTable;
  columns: Column[];
  row: Record<string, unknown> | null;
  deletes: boolean;
  busy: boolean;
  run: (action: () => Promise<void>) => Promise<boolean>;
  write: (change: CommercialSettingsWrite) => Promise<void>;
}) {
  const initial = valuesOf(columns, row);
  const [values, setValues] = useState(initial);
  const set = (key: string, value: string | boolean) => setValues((current) => ({ ...current, [key]: value }));
  const dirty = columns.some((column) => values[column.key] !== initial[column.key]);
  const complete = columns.every((column) => !column.required || String(values[column.key] ?? '').trim() !== '');
  const save = () => void run(async () => {
    await write({ op: 'save', table, ...(row ? { id: String(row.id) } : {}), values: wireOf(columns, values) } as CommercialSettingsWrite);
    if (!row) setValues(valuesOf(columns, null));
  });
  return (
    <TableRow>
      {columns.map((column) => (
        <TableCell key={column.key} className={column.kind === 'long' ? 'min-w-[260px]' : undefined}>
          {column.kind === 'flag' && <Checkbox checked={values[column.key] === true} aria-label={t(column.label)} disabled={busy} onCheckedChange={(checked) => set(column.key, checked === true)} />}
          {column.kind === 'long' && <Textarea rows={2} value={String(values[column.key])} aria-label={t(column.label)} disabled={busy} onChange={(event) => set(column.key, event.target.value)} />}
          {column.kind !== 'flag' && column.kind !== 'long' && (
            <Input
              className="min-w-24"
              type={column.kind === 'number' ? 'number' : column.kind === 'date' ? 'date' : column.kind === 'url' ? 'url' : 'text'}
              value={String(values[column.key])}
              aria-label={t(column.label)}
              disabled={busy}
              onChange={(event) => set(column.key, event.target.value)}
            />
          )}
        </TableCell>
      ))}
      <TableCell>
        <div className="flex justify-end gap-1.5">
          <Button type="button" size="sm" variant="secondary" disabled={busy || !dirty || !complete} onClick={save}>{row ? t('Save') : t('Add')}</Button>
          {deletes && row && (
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => write({ op: 'delete', table: table as never, id: String(row.id) }))}>{t('Delete')}</Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}
