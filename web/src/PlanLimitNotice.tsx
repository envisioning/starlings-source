import { PLAN_ERROR_CODES, PLAN_UPGRADE_URL, PLAN_WORDS } from '@starlings/contracts/workspace-plans';
import { cn } from '@/lib/utils';
import { Alert } from '@/ui/alert';
import { Button } from '@/ui/button';
import { t } from './i18n';
import { useViewerIsAdmin, type PlanErrorCode } from './workspace-plan';

/**
 * The prompt at a plan limit: one line from `PLAN_WORDS`. An admin
 * gets Upgrade, which opens the pricing page; anybody else is told to ask one.
 */
export function PlanLimitNotice({ code, className }: { code: PlanErrorCode; className?: string }) {
  const isAdmin = useViewerIsAdmin();
  const words = code === PLAN_ERROR_CODES.projectLimit ? PLAN_WORDS.projectLimit : PLAN_WORDS.projectFrozen;
  return (
    <Alert role="status" className={cn('flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-3 py-2.5 text-[13px] leading-normal', className)}>
      <span className="min-w-0 flex-[1_1_auto]">
        {t(words)}
        {isAdmin === false && <> {t(PLAN_WORDS.askAdmin)}</>}
      </span>
      {isAdmin && (
        <Button asChild size="xs" variant="outline">
          <a href={PLAN_UPGRADE_URL} target="_blank" rel="noopener">{t(PLAN_WORDS.upgrade)}</a>
        </Button>
      )}
    </Alert>
  );
}
