import type { CrmSubjectDetail } from './crm-work';
import { t } from './i18n';

/**
 * A CMS event's own facts: image, host, partner, link, description, and
 * whether the website shows it. Work's event page and the Calendar's event
 * dialog read the same record (the Work event subject is the CMS event,
 * docs/EVENTS.md), so they draw it once, here.
 */
export function EventAbout({ detail, title }: { detail: CrmSubjectDetail; title: string }) {
  const host = detail.host?.trim() ?? '';
  const partner = detail.partner?.trim() ?? '';
  const link = detail.url?.trim() ?? '';
  const imageURL = detail.image_url?.trim() ?? '';
  const description = detail.description?.trim() ?? '';
  return (
    <>
      {imageURL && <img className="mt-1 mb-2.5 block max-h-[220px] w-auto max-w-[min(100%,360px)] rounded-[10px] border object-contain" src={imageURL} alt={title} loading="lazy" decoding="async" />}
      {host && <p>{t('Hosted by {host}', { host })}</p>}
      {partner && <p>{detail.partner_url ? <a href={detail.partner_url} target="_blank" rel="noreferrer">{partner}</a> : partner}</p>}
      {link && <p><a href={link} target="_blank" rel="noreferrer">{link}</a></p>}
      {description && <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{description}</p>}
      {detail.published === false && <p className="text-muted-foreground">{t('Not on the website yet.')}</p>}
    </>
  );
}

/** Whether `EventAbout` has anything to draw. */
export function hasEventAbout(detail: CrmSubjectDetail): boolean {
  return Boolean(detail.image_url?.trim() || detail.host?.trim() || detail.partner?.trim() || detail.url?.trim() || detail.description?.trim() || detail.published === false);
}
