import { t } from '@shared/i18n';
import { MeetingSim } from './sim/MeetingSim';

/** The named people and agent make the live call the homepage's first showcase. */
export function CallsShowcase() {
  return <section className="my-12 scroll-mt-24" aria-labelledby="calls-demo-title">
    <h2 id="calls-demo-title">{t('Agents on a call')}</h2>
    <p className="mb-6 max-w-[680px] text-muted-foreground">{t('See the live transcript, an agent at work, and the notes and tasks the call leaves on its project.')}</p>
    <MeetingSim />
  </section>;
}
