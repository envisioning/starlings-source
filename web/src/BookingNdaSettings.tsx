import { useEffect, useState } from 'react';
import type { BookingNdaAdminResponse } from '@starlings/contracts/booking-settings';
import { Button } from '@/ui/button';
import { apiFetch } from './api';
import { searchDocs } from './docs';
import { ErrorNotice } from './ErrorNotice';
import { SearchablePicker } from './SearchablePicker';
import { SectionCard } from './SectionCard';
import type { SearchablePickerOption } from './searchable-picker';
import { t } from './i18n';

/**
 * Admin › People: the NDA a guest can ask to meet under on a booking page
 * (docs/CORE_FOLD_PLAN.md §Phase 3d). It is a document in Docs; a guest who
 * asks for it gets a Docs signature request on it. Saves on change. Only an
 * admin may change it; anyone else reads it. Hidden on a workspace with no Docs.
 */
export function BookingNdaSettings({ canEdit }: { canEdit: boolean }) {
  const [setting, setSetting] = useState<BookingNdaAdminResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<BookingNdaAdminResponse>('/admin/booking-nda', { fallbackError: t('Couldn’t load the booking NDA.'), noStore: true, signal: controller.signal })
      .then(setSetting)
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, []);

  async function save(documentId: string | null) {
    setSaving(true);
    setError(null);
    try {
      setSetting(await apiFetch<BookingNdaAdminResponse>('/admin/booking-nda', {
        method: 'PUT',
        body: { document_id: documentId },
        fallbackError: t('Couldn’t save the booking NDA.'),
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  if (setting && !setting.docs) return null;

  const current: SearchablePickerOption[] = setting?.document_id
    ? [{ id: setting.document_id, title: setting.document_title ?? t('A document you cannot open') }]
    : [];

  return (
    <SectionCard id="admin-booking-nda" title={t('Booking NDA')}>
      <SearchablePicker
        label={t('Document')}
        placeholder={t('None')}
        options={current}
        value={setting?.document_id ?? ''}
        disabled={!canEdit || saving || !setting}
        emptyMessage={t('No documents found.')}
        onSearch={async (query) => (await searchDocs(query)).map((hit) => ({ id: hit.id, title: hit.title, subtitle: hit.path }))}
        onChange={(id) => { void save(id || null); }}
        className="max-w-80"
      />
      {setting?.document_id && canEdit && (
        <div>
          <Button type="button" variant="secondary" disabled={saving} onClick={() => { void save(null); }}>
            {t('Remove')}
          </Button>
        </div>
      )}
      {error && <ErrorNotice message={error} inline className="text-sm" />}
    </SectionCard>
  );
}
