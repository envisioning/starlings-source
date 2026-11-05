import { useEffect, useState } from 'react';
import type { AuditEvent } from '@keep/contracts';
import { api } from './api';
import { Fine, PageHeader } from './parts';
import { ActivityTable } from './Vault';

/** Everything, newest first. An audit log nobody reads is not a control. */
export function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  useEffect(() => {
    api.audit().then((result) => setEvents(result.events));
  }, []);
  return (
    <div className="max-w-[1100px]">
      <PageHeader title="Activity" />
      {events === null ? <Fine>Loading…</Fine> : <ActivityTable events={events} />}
    </div>
  );
}
