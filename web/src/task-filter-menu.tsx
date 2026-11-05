import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { FilterButton } from './FilterButton';
import { useMenuTrigger } from './menu-focus';
import { MenuIcon } from './menu-icons';
import {
  DEFAULT_WORK_TASK_FILTER,
  sideChoiceTitle,
  WORK_DUE_CHOICES,
  WORK_SIDE_CHOICES,
  type WorkTaskFilter,
} from './crm-work';
import { t } from './i18n';

/** The filter differs from `DEFAULT_WORK_TASK_FILTER`. */
export function isTaskFilterDirty(filter: WorkTaskFilter): boolean {
  return filter.due !== DEFAULT_WORK_TASK_FILTER.due || filter.side !== DEFAULT_WORK_TASK_FILTER.side;
}

/**
 * The Due and Side groups inside a filter menu, beside the
 * holder filter. The words are the contract's (`WORK_DUE_CHOICES`,
 * `WORK_SIDE_CHOICES`); the team side reads as the workspace's name.
 */
export function TaskFilterGroups({ filter, onChange }: { filter: WorkTaskFilter; onChange: (next: WorkTaskFilter) => void }) {
  return (
    <>
      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t('Due')}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={filter.due} onValueChange={(value) => onChange({ ...filter, due: value as WorkTaskFilter['due'] })}>
        {WORK_DUE_CHOICES.map((choice) => (
          <DropdownMenuRadioItem key={choice.value} value={choice.value}>{t(choice.title)}</DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t('Side')}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={filter.side} onValueChange={(value) => onChange({ ...filter, side: value as WorkTaskFilter['side'] })}>
        {WORK_SIDE_CHOICES.map((choice) => (
          <DropdownMenuRadioItem key={choice.value} value={choice.value}>{sideChoiceTitle(choice)}</DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  );
}

/** A subject's Tasks list filter: Due and Side, then Reset while either is set. */
export function TaskFilterMenu({ filter, onChange }: { filter: WorkTaskFilter; onChange: (next: WorkTaskFilter) => void }) {
  const menu = useMenuTrigger();
  const dirty = isTaskFilterDirty(filter);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <FilterButton ref={menu.trigger} dirty={dirty} label={t('Filter tasks')} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={menu.onCloseAutoFocus}>
        <TaskFilterGroups filter={filter} onChange={onChange} />
        {dirty && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange(DEFAULT_WORK_TASK_FILTER)}><MenuIcon name="reset" />{t('Reset')}</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
