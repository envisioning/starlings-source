import { useEffect, useState } from 'react';
import type { AdminPerson } from '@starlings/contracts';
import type { VisitorHomeAdminResponse, VisitorHomeUpdate } from '@starlings/contracts/visitor-home';
import { Checkbox } from '@/ui/checkbox';
import { Label } from '@/ui/label';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { apiFetch } from './api';
import { ErrorNotice } from './ErrorNotice';
import { SectionCard } from './SectionCard';
import { t } from './i18n';

const NOBODY = '';

/**
 * Admin › People: what a signed-out visitor sees at the workspace root
 * (packages/contracts/src/visitor-home.ts). Each control saves on change, as
 * a role does. Only an admin may change it; anyone else reads it.
 */
export function VisitorHomeSettings({ people, canEdit }: { people: AdminPerson[]; canEdit: boolean }) {
  const [setting, setSetting] = useState<VisitorHomeUpdate | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<VisitorHomeAdminResponse>('/admin/visitor-home', { fallbackError: t('Couldn’t load the visitor home.'), noStore: true, signal: controller.signal })
      .then((home) => setSetting({ join: home.join, booking_email: home.booking_email }))
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, []);

  // The root offers a booking page only for a member who has one.
  const bookable = people
    .filter((person) => person.kind === 'human' && !person.revoked && person.room_slug)
    .sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email));

  async function save(next: VisitorHomeUpdate) {
    const previous = setting;
    setSetting(next);
    setSaving(true);
    setError(null);
    try {
      const home = await apiFetch<VisitorHomeAdminResponse>('/admin/visitor-home', {
        method: 'PUT',
        body: next,
        fallbackError: t('Couldn’t save the visitor home.'),
      });
      setSetting({ join: home.join, booking_email: home.booking_email });
    } catch (cause) {
      setSetting(previous);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  const disabled = !canEdit || saving || !setting;

  return (
    <SectionCard id="admin-visitor-home" title={t('Visitor home')}>
      <Label className="flex cursor-pointer items-center gap-3 font-normal leading-normal">
        <Checkbox
          checked={setting?.join ?? false}
          disabled={disabled}
          onCheckedChange={(value) => { if (setting) void save({ ...setting, join: value === true }); }}
        />
        {t('Room code field')}
      </Label>
      <Label className="grid max-w-80 gap-1.5 font-normal leading-normal">
        {t('Booking page')}
        <NativeSelect
          value={setting?.booking_email ?? NOBODY}
          disabled={disabled}
          onChange={(event) => { if (setting) void save({ ...setting, booking_email: event.target.value || null }); }}
        >
          <NativeSelectOption value={NOBODY}>{t('None')}</NativeSelectOption>
          {bookable.map((person) => (
            <NativeSelectOption key={person.email} value={person.email.toLowerCase()}>
              {person.name ?? person.email}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Label>
      {error && <ErrorNotice message={error} inline className="text-sm" />}
    </SectionCard>
  );
}
