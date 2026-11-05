import type { DecisionAsk } from '@starlings/contracts/decision-asks';
import { DropdownMenuItem } from '@/ui/dropdown-menu';
import { MenuIcon } from './menu-icons';
import { t } from './i18n';

/**
 * The registry's `decide` on a decision row: one item per option, the
 * recommendation said so, for Work's INBOX menu and Home's WORK card.
 */
export function DecisionAnswerItems({ ask, onAnswer }: { ask: DecisionAsk; onAnswer: (option: string) => void }) {
  return <>
    {ask.options.map((option) => (
      <DropdownMenuItem key={option.key} onSelect={() => onAnswer(option.key)}>
        <MenuIcon name="decide" />
        {option.key === ask.recommendation
          ? t('Answer: {label} (recommended)', { label: option.label })
          : t('Answer: {label}', { label: option.label })}
      </DropdownMenuItem>
    ))}
  </>;
}
