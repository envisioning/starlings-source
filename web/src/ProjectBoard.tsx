import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { PlaceholderRows } from '@/ui/placeholder-rows';
import { cn } from '@/lib/utils';
import { BoardColumn, boardCardDrag } from './BoardColumn';
import { ErrorNotice } from './ErrorNotice';
import { readFailureLine, truncatedLine } from './read-gaps';
import { FilterButton } from './FilterButton';
import { HandOffDialog } from './HandOffDialog';
import { toast } from './Toast';
import { IssueStateIcon, MoreActionsIcon } from './action-icons';
import {
  boardCards,
  cardPassesTaskFilter,
  DEFAULT_WORK_TASK_FILTER,
  deleteTask,
  fetchBoard,
  isFinished,
  moveCard,
  passesHolderFilter,
  planBoard,
  WORK_HOLDER_CHOICES,
  WORK_STAGE_TITLES,
  WORK_STAGES,
  type BoardCard,
  type CardTrace,
  type CrmBoardResponse,
  type CrmIssue,
  type CrmSubject,
  type CrmTask,
  type WorkStage,
  type WorkTaskFilter,
} from './crm-work';
import { confirmDataLoss } from './ConfirmDataLoss';
import { isTaskFilterDirty, TaskFilterGroups } from './task-filter-menu';
import { formatDay } from './meeting-time';
import { useMenuTrigger } from './menu-focus';
import { MenuIcon } from './menu-icons';
import { peerDisplayName, type Peer } from './team-presence';
import { t } from './i18n';

/** The board reads itself again at this cadence while it is up, as the Mac's does. */
const REFRESH_MS = 30_000;

/** The head of a stage's column (`WORK_STAGE_TITLES`, the same table every client reads). */
function stageTitle(stage: WorkStage): string {
  return t(WORK_STAGE_TITLES.find((row) => row.value === stage)!.title);
}

/**
 * One project's board (docs/BOARD.md): its tasks and
 * issues in the six stages of the shared `planBoard`, the Mac's
 * `WorkCardBoardView` scoped to the project. One read
 * (`GET /api/crm/board?project_id=`), again every 30 seconds while the page
 * is visible. Drag a card between columns to move it, or use its menu: Move
 * to, Hand off and Delete. The holder, Due and Side filters and the hidden
 * columns narrow what is drawn, never what is stored.
 */
export function ProjectBoard({ project, agents, hiddenStages, onHiddenStagesChange, onOpenTask, onOpenIssue, onOpenTrace }: {
  project: CrmSubject;
  /** The roster's agents, for Hand off and the holder filter. */
  agents: readonly Peer[];
  /** The columns this person hides, on every project (`board_hidden_stages`). */
  hiddenStages: readonly WorkStage[];
  onHiddenStagesChange: (next: WorkStage[]) => void;
  onOpenTask: (task: CrmTask) => void;
  onOpenIssue: (issue: CrmIssue) => void;
  /** The card's last line: open the project's Talk at that message. */
  onOpenTrace: (trace: CardTrace) => void;
}) {
  const [response, setResponse] = useState<CrmBoardResponse | null>(null);
  const [error, setError] = useState('');
  const [finishedOpen, setFinishedOpen] = useState(false);
  const [holder, setHolder] = useState('anyone');
  // Due and Side: per session, as the holder filter is.
  const [taskFilter, setTaskFilter] = useState<WorkTaskFilter>(DEFAULT_WORK_TASK_FILTER);
  // A card in flight: drawn in its new column before the Worker answers,
  // and put back if it does not.
  const [moved, setMoved] = useState<Map<string, WorkStage>>(() => new Map());
  /** The card whose Hand off is open: agent, done when, deliverable. */
  const [handingOff, setHandingOff] = useState<BoardCard | null>(null);

  const load = useCallback(async () => {
    try {
      setResponse(await fetchBoard(project.id));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t load the board.'));
    }
  }, [project.id]);

  useEffect(() => {
    void load();
    // An agent's move mid-run has to show without a reload. A hidden tab
    // does not ask; it asks again when it is shown.
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, REFRESH_MS);
    const shown = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', shown);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', shown); };
  }, [load]);

  const cards = useMemo(() => (response ? boardCards(response) : []), [response]);
  const shownCards = useMemo(
    () => cards.filter((card) => passesHolderFilter(card, holder, card.subject?.agent_email ?? project.agent_email) && cardPassesTaskFilter(card, taskFilter)),
    [cards, holder, taskFilter, project.agent_email],
  );

  const board = useMemo(() => {
    const since = response ? Date.parse(response.finished_since) : Number.NaN;
    const planned = planBoard(shownCards, Date.now(), undefined, Number.isNaN(since) ? null : since);
    if (moved.size === 0) return planned;
    const columns = Object.fromEntries(WORK_STAGES.map((stage) => [stage, [] as BoardCard[]])) as Record<WorkStage, BoardCard[]>;
    for (const stage of WORK_STAGES) {
      for (const card of planned.columns[stage]) columns[moved.get(card.id) ?? stage].push(card);
    }
    return { columns, stageOf: planned.stageOf };
  }, [shownCards, response, moved]);

  async function move(id: string, stage: WorkStage) {
    const card = cards.find((one) => one.id === id);
    if (!card || board.stageOf[card.id] === stage) return;
    setMoved((current) => new Map(current).set(card.id, stage));
    try {
      await moveCard(card, stage);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t move that card.'));
    } finally {
      setMoved((current) => { const next = new Map(current); next.delete(card.id); return next; });
    }
  }

  /** Delete…: asks first; the card leaves the board on success. */
  async function remove(task: CrmTask) {
    if (!await confirmDataLoss({
      title: t('Delete “{title}”?', { title: task.title }),
      body: t('This can’t be undone.'),
      action: t('Delete'),
    })) return;
    try {
      await deleteTask(task.id);
      setResponse((current) => current ? { ...current, tasks: current.tasks.filter((row) => row.id !== task.id) } : current);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t delete that task.'));
    }
  }

  if (!response && !error) return <PlaceholderRows count={4} />;

  const hidden = new Set(hiddenStages);
  // Every column this view would draw before the person hid any.
  const offered = WORK_STAGES.filter((stage) => finishedOpen || !isFinished(stage));
  const stages = offered.filter((stage) => !hidden.has(stage));
  const hiddenCount = offered.filter((stage) => hidden.has(stage)).reduce((sum, stage) => sum + board.columns[stage].length, 0);
  const finishedCount = board.columns.done.length + board.columns.dropped.length;

  return (
    <section className="grid min-w-0 gap-3" aria-label={t('Board')}>
      {response && readFailureLine(response) && (
        <ErrorNotice
          role="status"
          message={readFailureLine(response)}
          action={<Button type="button" variant="outline" size="xs" onClick={() => void load()}>{t('Retry')}</Button>}
        />
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 text-[13px] text-muted-foreground">
          {[
            // A cap hit is quiet copy; a failure is the red notice below.
            response ? truncatedLine(response) : null,
            hiddenCount > 0 ? t('{count} cards in hidden columns', { count: hiddenCount }) : null,
          ].filter(Boolean).join(' · ')}
        </p>
        <div className="flex items-center gap-1">
          <Button type="button" size="sm" variant="ghost" aria-pressed={finishedOpen} onClick={() => setFinishedOpen((open) => !open)}>
            {finishedOpen ? t('Hide finished') : t('Finished ({count})', { count: finishedCount })}
          </Button>
          <BoardViewMenu
            holder={holder}
            taskFilter={taskFilter}
            agents={agents}
            hidden={hidden}
            onHolderChange={setHolder}
            onTaskFilterChange={setTaskFilter}
            onToggleStage={(stage) => onHiddenStagesChange(WORK_STAGES.filter((one) => (one === stage ? !hidden.has(one) : hidden.has(one))))}
          />
        </div>
      </div>
      {error && <ErrorNotice message={error} copyText={error} action={<Button type="button" variant="outline" size="xs" onClick={() => void load()}>{t('Retry')}</Button>} />}
      {/* Columns share the width; below ~1000px they keep 190px each and the row scrolls. */}
      <div className="min-w-0 overflow-x-auto pb-2">
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.max(stages.length, 1)}, minmax(190px, 1fr))` }}>
          {stages.map((stage) => (
            <BoardColumn key={stage} title={stageTitle(stage)} count={board.columns[stage].length} onDropCard={(id) => { void move(id, stage); }}>
              {board.columns[stage].map((card) => (
                <CardFace
                  key={card.id}
                  card={card}
                  stage={stage}
                  canHandOff={agents.length > 0}
                  moving={moved.has(card.id)}
                  onOpen={() => { if (card.issue) onOpenIssue(card.issue); else if (card.task) onOpenTask(card.task); }}
                  onMove={(target) => { void move(card.id, target); }}
                  onHandOff={() => setHandingOff(card)}
                  onDelete={card.task ? () => { void remove(card.task!); } : undefined}
                  onOpenTrace={onOpenTrace}
                />
              ))}
            </BoardColumn>
          ))}
        </div>
      </div>
      {handingOff && (
        <HandOffDialog
          card={handingOff}
          onClose={() => setHandingOff(null)}
          onHandedOff={(agent) => {
            setHandingOff(null);
            toast(t('Handed off to {name}', { name: peerDisplayName(agent) }), 'neutral');
          }}
        />
      )}
    </section>
  );
}

/**
 * The board's view menu: who holds the cards shown (`WORK_HOLDER_CHOICES`,
 * then one row per agent), and which columns this person hides. A choice
 * keeps the menu open, so several columns can be turned off in a row.
 */
function BoardViewMenu({ holder, taskFilter, agents, hidden, onHolderChange, onTaskFilterChange, onToggleStage }: {
  holder: string;
  taskFilter: WorkTaskFilter;
  agents: readonly Peer[];
  hidden: ReadonlySet<WorkStage>;
  onHolderChange: (next: string) => void;
  onTaskFilterChange: (next: WorkTaskFilter) => void;
  onToggleStage: (stage: WorkStage) => void;
}) {
  const menu = useMenuTrigger();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <FilterButton ref={menu.trigger} dirty={holder !== 'anyone' || isTaskFilterDirty(taskFilter) || hidden.size > 0} label={t('Filter the board')} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={menu.onCloseAutoFocus}>
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t('Held by')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={holder} onValueChange={onHolderChange}>
          {WORK_HOLDER_CHOICES.map((choice) => (
            <DropdownMenuRadioItem key={choice.value} value={choice.value}>{t(choice.title)}</DropdownMenuRadioItem>
          ))}
          {agents.map((agent) => (
            <DropdownMenuRadioItem key={agent.email} value={`agent:${agent.email}`}>{peerDisplayName(agent)}</DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <TaskFilterGroups filter={taskFilter} onChange={onTaskFilterChange} />
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t('Columns')}</DropdownMenuLabel>
        {WORK_STAGES.map((stage) => (
          <DropdownMenuCheckboxItem
            key={stage}
            checked={!hidden.has(stage)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() => onToggleStage(stage)}
          >
            {stageTitle(stage)}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The card face (BOARD.md rule 13): title, source, who holds it, the due
 * date when late, and the last event line, which opens the project's Talk
 * there. The `…` holds Move to (every stage, hidden ones too) and Hand off.
 */
function CardFace({ card, stage, canHandOff, moving, onOpen, onMove, onHandOff, onDelete, onOpenTrace }: {
  card: BoardCard;
  stage: WorkStage;
  /** The roster has an agent, and the card is still open. */
  canHandOff: boolean;
  moving: boolean;
  onOpen: () => void;
  onMove: (stage: WorkStage) => void;
  /** Opens Hand off: the agent, what done looks like, what comes back. */
  onHandOff: () => void;
  /** A task card's Delete…; an issue card has none. */
  onDelete?: () => void;
  onOpenTrace: (trace: CardTrace) => void;
}) {
  const menu = useMenuTrigger();
  const title = card.issue ? card.issue.title : card.task?.title ?? '';
  const due = card.task?.due_date ? new Date(card.task.due_date) : null;
  const late = due !== null && !Number.isNaN(due.valueOf()) && !card.done && due.valueOf() < Date.now();
  const source = card.issue
    ? `${card.issue.repo} #${card.issue.number}`
    : card.githubRef ? t('Task · {ref}', { ref: card.githubRef }) : t('Task');
  const holderName = card.issue ? card.issue.assignee_login : card.task?.assignee_name;
  return (
    <div
      {...boardCardDrag(card.id)}
      className={cn(
        'group relative grid min-w-0 gap-1 rounded-md border border-transparent bg-(--surface-raised) hover-lift hover-edge',
        (card.done || moving) && 'opacity-60',
      )}
    >
      {/* shadcn: the card body is the target; the menu and the trace sit beside it */}
      {/* hover: the card around it lifts */}
      <button type="button" onClick={onOpen} className="grid min-w-0 gap-1 p-3 pr-9 pb-1 text-left text-inherit">
        <span className="flex min-w-0 items-baseline justify-between gap-2">
          <span className="line-clamp-2 text-[14px] font-[560] text-foreground">{title}</span>
          {due && card.task?.due_date && (
            <span className={cn('flex-none text-xs text-muted-foreground', late && 'font-bold text-foreground')}>{formatDay(card.task.due_date)}</span>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {card.issue && <IssueStateIcon open={card.issue.state === 'open'} notPlanned={card.issue.state_reason === 'not_planned'} size={12} />}
          <span className="truncate">{[source, holderName].filter(Boolean).join(' · ')}</span>
        </span>
      </button>
      {card.trace
        ? (
          // shadcn: a line of text that is a link into Talk, not a control with a box
          <button
            type="button"
            onClick={() => onOpenTrace(card.trace!)}
            className="truncate px-3 pb-3 text-left text-xs text-muted-foreground underline-offset-3 hover:text-foreground hover:underline"
          >
            {card.trace.text}
          </button>
        )
        : <span className="pb-2" />}
      <div className="absolute top-1.5 right-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button ref={menu.trigger} type="button" variant="ghost" size="icon-sm" aria-label={t('Card actions')} className="size-[26px] text-muted-foreground hover:text-foreground">
              <MoreActionsIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onCloseAutoFocus={menu.onCloseAutoFocus}>
            <DropdownMenuItem onSelect={onOpen}><MenuIcon name="open" />{t('Open')}</DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><MenuIcon name="move" />{t('Move to')}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {WORK_STAGES.filter((target) => target !== stage).map((target) => (
                  <DropdownMenuItem key={target} onSelect={() => onMove(target)}>{stageTitle(target)}</DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {canHandOff && !card.done && (
              <DropdownMenuItem onSelect={onHandOff}><MenuIcon name="assign" />{t('Hand off…')}</DropdownMenuItem>
            )}
            {onDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={onDelete}><MenuIcon name="delete" />{t('Delete…')}</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
