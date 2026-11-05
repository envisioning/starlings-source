import type { UntriagedTouchSource } from './index';

/**
 * The word for each kind of CRM touch in the Sales inbox. The ids are
 * `UNTRIAGED_TOUCH_SOURCES` in `index.ts`; the web reads this table and the
 * generator writes the Swift `UntriagedTouch.Source.label`
 * (`Sources/Generated/SalesValuesRegistry.swift`).
 */
export const UNTRIAGED_TOUCH_SOURCE_LABELS: Record<UntriagedTouchSource, string> = {
  contact: 'Contact form',
  support_case: 'Support case',
  pricing_request: 'Pricing request',
  readiness_assessment: 'Readiness assessment',
};
