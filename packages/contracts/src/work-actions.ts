/**
 * Canonical row-action intents, order, and client availability.
 *
 * This is rule input, not a wire shape. Labels, symbols, and execution stay
 * with each surface so localization and navigation do not enter the contract.
 * The Swift tables (`Sources/Generated/WorkActionsRegistry.swift`) and the table
 * keys of fixtures/work-actions.json are generated from it (`pnpm registries:gen`).
 */

export const WORK_ROW_KINDS = [
  'task',
  'issue',
  'inbox_talk',
  'inbox_sales',
  'inbox_comment',
  'inbox_card',
  'inbox_followup',
  'inbox_booking',
  'inbox_invitation',
  'inbox_forwarded',
  'inbox_interest',
  'inbox_commercial',
  'inbox_decision',
  'inbox_question',
  'quick_note',
  'subject',
  'goal',
  'doc',
  'doc_rail',
  'board_card',
  'message',
  'conversation',
  'person',
] as const;

export type WorkRowKind = (typeof WORK_ROW_KINDS)[number];

export const WORK_ACTION_CLIENTS = ['mac', 'ios', 'web'] as const;
export type WorkActionClient = (typeof WORK_ACTION_CLIENTS)[number];
export type WorkActionClientAvailability = Readonly<Record<WorkActionClient, boolean>>;

/** One stable id per intent. Search verbs that are also row actions use these ids. */
export const WORK_ROW_ACTIONS = [
  'accept',
  'decline',
  'complete',
  'cancel',
  'mark-seen',
  'file-github',
  'open-subject',
  'open-mine',
  'open-core',
  'close-issue',
  'close-not-planned',
  'reopen-issue',
  'open',
  'open-github',
  'copy-link',
  'star',
  'mark-read',
  'mute',
  'archive',
  'start-lead',
  'dismiss',
  'undo-dismiss',
  'copy-email',
  'open-document',
  'resolve',
  'open-calendar',
  'edit',
  'file-note',
  'move-workspace',
  'delete',
  'edit-details',
  'win-lead',
  'rename',
  'open-talk',
  'open-history',
  'open-tasks',
  'open-issues',
  'new-task',
  'new-issue',
  'new-document',
  'start-room',
  'link-repository',
  'keep-vault',
  'met',
  'drop',
  'reopen',
  'open-floating',
  'open-page',
  'copy-page-link',
  'file-document',
  'open-conversation',
  'move-stage',
  'hand-off',
  'react',
  'save-note',
  'copy',
  'reply',
  'decide',
  'make-card',
  'withdraw',
  'copy-forwarding-address',
  'message',
  'wave',
  'call',
  'join-room',
  'star-person',
  'star-thread',
  'notes-self',
  'set-status',
  'assign',
  'make-responsible',
  'rsvp',
] as const;

export type WorkRowActionID = (typeof WORK_ROW_ACTIONS)[number];

export const WORK_ROW_ACTION_DEFINITIONS = {
  accept: { destructive: false },
  decline: { destructive: true },
  complete: { destructive: false },
  cancel: { destructive: false },
  'mark-seen': { destructive: false },
  'file-github': { destructive: false },
  'open-subject': { destructive: false },
  'open-mine': { destructive: false },
  'open-core': { destructive: false },
  'close-issue': { destructive: false },
  'close-not-planned': { destructive: true },
  'reopen-issue': { destructive: false },
  open: { destructive: false },
  'open-github': { destructive: false },
  'copy-link': { destructive: false },
  star: { destructive: false },
  'mark-read': { destructive: false },
  mute: { destructive: false },
  archive: { destructive: true },
  'start-lead': { destructive: false },
  dismiss: { destructive: false },
  'undo-dismiss': { destructive: false },
  'copy-email': { destructive: false },
  'open-document': { destructive: false },
  resolve: { destructive: false },
  'open-calendar': { destructive: false },
  edit: { destructive: false },
  'file-note': { destructive: false },
  'move-workspace': { destructive: false },
  delete: { destructive: true },
  'edit-details': { destructive: false },
  'win-lead': { destructive: false },
  rename: { destructive: false },
  'open-talk': { destructive: false },
  'open-history': { destructive: false },
  'open-tasks': { destructive: false },
  'open-issues': { destructive: false },
  'new-task': { destructive: false },
  'new-issue': { destructive: false },
  'new-document': { destructive: false },
  'start-room': { destructive: false },
  'link-repository': { destructive: false },
  'keep-vault': { destructive: false },
  met: { destructive: false },
  drop: { destructive: false },
  reopen: { destructive: false },
  'open-floating': { destructive: false },
  'open-page': { destructive: false },
  'copy-page-link': { destructive: false },
  'file-document': { destructive: false },
  'open-conversation': { destructive: false },
  'move-stage': { destructive: false },
  'hand-off': { destructive: false },
  react: { destructive: false },
  'save-note': { destructive: false },
  copy: { destructive: false },
  reply: { destructive: false },
  decide: { destructive: false },
  'make-card': { destructive: false },
  withdraw: { destructive: true },
  'copy-forwarding-address': { destructive: false },
  message: { destructive: false },
  wave: { destructive: false },
  call: { destructive: false },
  'join-room': { destructive: false },
  'star-person': { destructive: false },
  'star-thread': { destructive: false },
  'notes-self': { destructive: false },
  'set-status': { destructive: false },
  // One item per teammate, drawn by each surface from Core's team (as
  // `decide` draws one per option): the row's holder, on an UNOWNED row.
  assign: { destructive: false },
  // A person row on a project or lead: they answer for it (docs/OWNERSHIP.md).
  'make-responsible': { destructive: false },
  // One item per answer in `CALENDAR_RSVP_ANSWERS` (Accept, Maybe, Decline),
  // drawn by each surface as `decide` draws one per option.
  rsvp: { destructive: false },
} as const satisfies Record<WorkRowActionID, { destructive: boolean }>;

const allClients = { mac: true, ios: true, web: true } as const;
const nativeClients = { mac: true, ios: true, web: false } as const;
const macOnly = { mac: true, ios: false, web: false } as const;
const webOnly = { mac: false, ios: false, web: true } as const;
const macAndWeb = { mac: true, ios: false, web: true } as const;

/**
 * Client support is recorded per kind because one intent can have a different
 * native implementation for another row kind. Missing entries are unavailable.
 */
export const WORK_ROW_ACTION_CLIENTS = {
  task: {
    accept: allClients,
    decline: allClients,
    complete: allClients,
    cancel: allClients,
    'mark-seen': allClients,
    'file-github': allClients,
    'open-subject': allClients,
    'open-mine': allClients,
    'open-core': allClients,
    star: allClients,
    assign: allClients,
    // To an agent, with the brief, from the subject's own task
    // rows as from its Board card.
    'hand-off': allClients,
    // Asks first; the Worker deletes from the store that holds the tasks group.
    delete: allClients,
  },
  issue: {
    'close-issue': allClients,
    'close-not-planned': allClients,
    'reopen-issue': allClients,
    open: macAndWeb,
    'open-github': macAndWeb,
    'copy-link': macAndWeb,
    'open-core': allClients,
    star: allClients,
    'mark-seen': allClients,
    // One row menu everywhere: an issue goes to an agent from its row too.
    'hand-off': allClients,
    assign: allClients,
  },
  inbox_talk: {
    'open-subject': allClients,
    'mark-read': allClients,
    mute: allClients,
    'open-core': allClients,
  },
  inbox_sales: {
    'start-lead': allClients,
    dismiss: allClients,
    'undo-dismiss': nativeClients,
    'copy-email': allClients,
  },
  inbox_comment: {
    'open-document': allClients,
    'open-subject': allClients,
    resolve: allClients,
    'open-core': allClients,
  },
  inbox_card: {
    open: allClients,
    'open-subject': allClients,
    'open-github': allClients,
  },
  inbox_followup: {
    open: allClients,
    dismiss: allClients,
  },
  inbox_booking: {
    'open-calendar': allClients,
    'copy-email': allClients,
    dismiss: allClients,
  },
  // A calendar invitation waiting on your answer.
  inbox_invitation: {
    rsvp: allClients,
    'open-calendar': allClients,
  },
  // An event read from mail forwarded to calendar@: `accept` adds it to the
  // calendar, `decline` discards it.
  inbox_forwarded: {
    accept: allClients,
    decline: allClients,
  },
  inbox_interest: {
    'copy-email': allClients,
    dismiss: allClients,
  },
  // An offer or license coming due: the subject is where it is dealt with.
  inbox_commercial: {
    'open-subject': allClients,
    dismiss: allClients,
    'undo-dismiss': nativeClients,
  },
  // A decision waiting on you: `decide` is one menu item per option,
  // drawn by each surface from the ask ("Answer: …"); `open` shows it whole.
  inbox_decision: {
    decide: allClients,
    open: allClients,
  },
  inbox_question: { open: allClients },
  // Move to ▸ another workspace this device is signed in to. A browser tab
  // holds one workspace, so only the native clients can offer it.
  quick_note: {
    edit: allClients,
    'file-note': allClients,
    'move-workspace': nativeClients,
    delete: allClients,
  },
  subject: {
    star: allClients,
    mute: allClients,
    open: allClients,
    'edit-details': allClients,
    // Win (ADR 0008): starts the project, moves open tasks, closes the lead.
    'win-lead': allClients,
    rename: nativeClients,
    'open-talk': allClients,
    'open-history': allClients,
    'open-tasks': allClients,
    'open-issues': allClients,
    'new-task': allClients,
    'new-issue': allClients,
    // Web is guest-first: it hosts nothing, so it starts no room.
    'start-room': nativeClients,
    // The web links through the Worker's project-repos route, as the native clients do.
    'link-repository': allClients,
    // The web's is a handoff to Mac and iPhone: it opens no vault.
    'keep-vault': allClients,
    'open-core': allClients,
  },
  goal: {
    met: allClients,
    drop: allClients,
    reopen: allClients,
  },
  doc: {
    open: allClients,
    star: allClients,
    'open-floating': macOnly,
    'open-page': allClients,
    'copy-page-link': allClients,
    'copy-link': allClients,
    'file-document': allClients,
    rename: allClients,
    archive: allClients,
  },
  doc_rail: {
    open: webOnly,
    'copy-link': webOnly,
    star: allClients,
  },
  board_card: {
    // The phone opens a card by its tap; its menu has no Open.
    open: macAndWeb,
    'open-github': macOnly,
    'open-subject': macOnly,
    'open-conversation': macOnly,
    'move-stage': allClients,
    'hand-off': allClients,
  },
  message: {
    react: allClients,
    'save-note': allClients,
    copy: allClients,
    reply: allClients,
    decide: allClients,
    // A card from a guest's line (docs/SUPPORT.md): the web first; Mac and
    // iPhone have no guest-thread screens yet.
    'make-card': webOnly,
    edit: allClients,
    withdraw: allClients,
  },
  conversation: {
    open: allClients,
    'mark-read': allClients,
    mute: allClients,
    'copy-forwarding-address': allClients,
    archive: allClients,
    'copy-link': webOnly,
    'open-core': allClients,
    star: allClients,
  },
  person: {
    message: webOnly,
    wave: allClients,
    call: allClients,
    'join-room': allClients,
    'copy-email': allClients,
    'star-person': allClients,
    'star-thread': allClients,
    'open-core': allClients,
    'notes-self': allClients,
    'set-status': allClients,
    'make-responsible': allClients,
  },
} as const satisfies Record<
  WorkRowKind,
  Partial<Record<WorkRowActionID, WorkActionClientAvailability>>
>;

type ActionGroups = Readonly<Record<string, readonly (readonly WorkRowActionID[])[]>>;

// Docs multi-select stays separate per #504; these groups describe one row.
export const WORK_ROW_MENU_GROUPS = {
  task: {
    inbox_proposed: [
      ['accept', 'decline'],
      ['open-subject'],
      ['open-core'],
      ['star'],
    ],
    subject_proposed: [
      ['accept', 'decline'],
      ['open-core'],
      ['star'],
    ],
    subject_open: [
      ['complete', 'cancel'],
      ['hand-off'],
      ['file-github'],
      ['open-core'],
      ['star'],
      ['delete'],
    ],
    mine: [
      ['complete', 'cancel'],
      ['hand-off'],
      ['open-subject', 'open-mine'],
      ['file-github'],
      ['open-core'],
      ['star'],
      ['delete'],
    ],
    assigned: [
      ['complete', 'cancel'],
      ['mark-seen'],
      ['hand-off'],
      ['open-subject', 'open-mine'],
      ['file-github'],
      ['open-core'],
      ['star'],
    ],
    // Overview's UNOWNED (docs/BOARD.md §Unowned): who holds it comes first.
    unowned: [
      ['assign'],
      ['complete', 'cancel'],
      ['hand-off'],
      ['open-subject', 'open-mine'],
      ['file-github'],
      ['open-core'],
      ['star'],
    ],
  },
  issue: {
    row: [
      ['open'],
      ['close-issue', 'close-not-planned', 'reopen-issue'],
      ['hand-off'],
      ['open-github'],
      ['copy-link'],
      ['open-core'],
      ['star'],
    ],
    assigned: [
      ['close-issue', 'close-not-planned', 'reopen-issue'],
      ['mark-seen'],
      ['hand-off'],
      ['open'],
      ['open-core'],
      ['star'],
    ],
    unowned: [
      ['assign'],
      ['open'],
      ['close-issue', 'close-not-planned', 'reopen-issue'],
      ['hand-off'],
      ['open-github', 'copy-link'],
      ['open-core'],
      ['star'],
    ],
  },
  inbox_talk: {
    row: [
      ['open-subject'],
      ['mark-read', 'mute'],
      ['open-core'],
    ],
  },
  inbox_sales: {
    row: [
      ['start-lead'],
      ['dismiss', 'undo-dismiss', 'copy-email'],
    ],
  },
  inbox_comment: {
    row: [
      ['open-document', 'open-subject'],
      ['resolve'],
      ['open-core'],
    ],
  },
  inbox_card: {
    row: [
      ['open'],
      ['open-subject', 'open-github'],
    ],
  },
  inbox_followup: {
    row: [
      ['open'],
      ['dismiss'],
    ],
  },
  inbox_booking: {
    row: [
      ['open-calendar', 'copy-email'],
      ['dismiss'],
    ],
  },
  inbox_invitation: {
    row: [
      ['rsvp'],
      ['open-calendar'],
    ],
  },
  inbox_forwarded: {
    row: [
      ['accept', 'decline'],
    ],
  },
  inbox_interest: {
    row: [
      ['copy-email'],
      ['dismiss'],
    ],
  },
  inbox_commercial: {
    row: [
      ['open-subject'],
      ['dismiss', 'undo-dismiss'],
    ],
  },
  inbox_decision: {
    row: [
      ['decide'],
      ['open'],
    ],
  },
  inbox_question: { row: [['open']] },
  quick_note: {
    home: [
      ['edit', 'file-note', 'move-workspace'],
      ['delete'],
    ],
    inbox: [
      ['file-note'],
      ['delete'],
    ],
  },
  subject: {
    row: [
      ['star', 'mute'],
      ['open', 'edit-details', 'rename', 'win-lead'],
      ['open-tasks', 'open-issues', 'new-task', 'new-issue'],
      ['start-room', 'link-repository', 'keep-vault', 'open-core'],
    ],
    organization: [
      ['star', 'mute'],
      ['open', 'open-talk', 'open-history', 'start-room'],
      ['open-tasks', 'new-task'],
      ['open-core'],
    ],
  },
  goal: {
    row: [
      ['met', 'drop', 'reopen'],
    ],
  },
  doc: {
    row: [
      ['open', 'star'],
      ['open-floating'],
      ['open-page', 'copy-page-link', 'copy-link'],
      ['file-document'],
      ['rename'],
      ['archive'],
    ],
  },
  doc_rail: {
    folder: [
      ['open', 'copy-link'],
      ['star'],
    ],
    address: [
      ['open', 'copy-link'],
    ],
  },
  board_card: {
    row: [
      ['open'],
      ['open-github', 'open-subject', 'open-conversation'],
      ['move-stage'],
      ['hand-off'],
    ],
  },
  message: {
    row: [
      ['react'],
      ['copy', 'reply', 'decide', 'make-card'],
      ['save-note', 'edit', 'withdraw'],
    ],
  },
  conversation: {
    row: [
      ['mark-read', 'mute'],
      ['copy-forwarding-address'],
      ['archive'],
      ['star'],
    ],
    // Home's MESSAGES card: a person's conversation or a subject's Talk.
    home: [
      ['open'],
      ['mark-read', 'mute'],
      ['archive'],
      ['copy-link', 'open-core'],
      ['star'],
    ],
  },
  person: {
    // Message leads on web; filtering it out leaves the Mac's Wave,
    // Call/Join room, person star, and thread star order intact.
    peer: [
      ['message', 'wave', 'call', 'join-room'],
      ['make-responsible'],
      ['copy-email'],
      ['star-person', 'star-thread'],
    ],
    agent: [
      ['message'],
      ['copy-email'],
      ['star-person'],
    ],
    self: [
      ['notes-self', 'set-status'],
      ['make-responsible'],
      ['star-person'],
    ],
    attendee: [
      ['open-core', 'copy-email'],
    ],
  },
} as const satisfies Record<WorkRowKind, ActionGroups>;

export type WorkRowMenuContext<K extends WorkRowKind = WorkRowKind> =
  K extends WorkRowKind ? keyof (typeof WORK_ROW_MENU_GROUPS)[K] & string : never;

export type WorkRowActionFacts = Readonly<Record<string, boolean | undefined>>;

function fact(facts: WorkRowActionFacts, name: string): boolean {
  return facts[name] === true;
}

function actionMatchesFacts(
  kind: WorkRowKind,
  action: WorkRowActionID,
  facts: WorkRowActionFacts,
): boolean {
  switch (kind) {
    case 'task':
      if (action === 'open-subject') return fact(facts, 'hasSubject');
      if (action === 'open-mine') return facts.hasSubject === false;
      if (action === 'open-core') return fact(facts, 'hasCore');
      if (action === 'file-github') return fact(facts, 'canFileOnGitHub');
      if (action === 'star') return fact(facts, 'isStarable');
      if (action === 'assign') return fact(facts, 'canAssign');
      if (action === 'hand-off') return fact(facts, 'canHandOff');
      if (action === 'delete') return fact(facts, 'canDelete');
      return true;
    case 'issue':
      if (action === 'close-issue' || action === 'close-not-planned') return fact(facts, 'isOpen');
      if (action === 'reopen-issue') return facts.isOpen === false;
      if (action === 'open-github' || action === 'copy-link') return fact(facts, 'hasRepo');
      if (action === 'open-core') return fact(facts, 'hasCore');
      if (action === 'mark-seen') return fact(facts, 'canMarkSeen');
      if (action === 'assign') return fact(facts, 'canAssign');
      if (action === 'hand-off') return fact(facts, 'canHandOff') && fact(facts, 'isOpen');
      return true;
    case 'inbox_talk':
      if (action === 'open-subject') return fact(facts, 'hasSubject');
      if (action === 'mark-read') return fact(facts, 'hasUnread');
      if (action === 'open-core') return fact(facts, 'hasCore');
      return true;
    case 'inbox_sales':
      if (action === 'dismiss') return facts.isDismissed === false;
      if (action === 'undo-dismiss') return fact(facts, 'isDismissed');
      if (action === 'copy-email') return fact(facts, 'hasEmail');
      return true;
    case 'inbox_comment':
      if (action === 'open-subject') return fact(facts, 'hasSubject');
      if (action === 'open-core') return fact(facts, 'hasCore');
      return true;
    case 'inbox_card':
      if (action === 'open-github') return fact(facts, 'isIssue');
      return true;
    case 'inbox_followup':
      return true;
    case 'inbox_booking':
      if (action === 'open-calendar') return fact(facts, 'hasEvent');
      if (action === 'copy-email') return fact(facts, 'hasEmail');
      return true;
    case 'inbox_interest':
      if (action === 'copy-email') return fact(facts, 'hasEmail');
      return true;
    case 'inbox_commercial':
      if (action === 'dismiss') return facts.isDismissed !== true;
      if (action === 'undo-dismiss') return fact(facts, 'isDismissed');
      return true;
    case 'inbox_invitation':
    case 'inbox_forwarded':
      return true;
    case 'inbox_question':
    case 'inbox_decision':
      return true;
    case 'quick_note':
      // File… stays after the first filing: a note can be filed again.
      if (action === 'edit') return fact(facts, 'isEditable');
      if (action === 'move-workspace') return fact(facts, 'hasOtherWorkspace');
      return true;
    case 'subject':
      if (action === 'open-talk' || action === 'open-history') return fact(facts, 'isPartner');
      if (action === 'edit-details' || action === 'rename') return !fact(facts, 'isPartner') && !fact(facts, 'isEvent');
      if (action === 'win-lead') return fact(facts, 'isOpenLead');
      if (action === 'open-issues') return fact(facts, 'isProject') && fact(facts, 'hasRepo');
      if (action === 'new-issue') return fact(facts, 'isProject') && fact(facts, 'hasRepo');
      if (action === 'start-room') return !fact(facts, 'isEvent');
      if (action === 'link-repository') return fact(facts, 'isProject') && !fact(facts, 'hasRepo');
      if (action === 'keep-vault') return fact(facts, 'isProject') && !fact(facts, 'hasVault');
      if (action === 'open-core') return fact(facts, 'hasCore');
      return true;
    case 'goal':
      if (action === 'met' || action === 'drop') return fact(facts, 'isOpen');
      if (action === 'reopen') return facts.isOpen === false;
      return true;
    case 'doc':
      if (action === 'open-page' || action === 'copy-page-link') return fact(facts, 'isSavedLink');
      if (action === 'copy-link') return facts.isSavedLink === false;
      if (action === 'file-document' || action === 'rename' || action === 'archive') return fact(facts, 'isEditable');
      return true;
    case 'doc_rail':
      if (action === 'star') return fact(facts, 'isFolder');
      return true;
    case 'board_card':
      if (action === 'open-github') return fact(facts, 'hasRepo');
      if (action === 'open-subject') return fact(facts, 'hasSubject');
      if (action === 'open-conversation') return fact(facts, 'hasConversation');
      if (action === 'move-stage') return fact(facts, 'canMoveStage');
      if (action === 'hand-off') return fact(facts, 'hasAgents');
      return true;
    case 'message':
      if (fact(facts, 'isPartial')) return false;
      if (action === 'react') return facts.isWithdrawn === false;
      if (action === 'save-note') return fact(facts, 'isMine') && facts.isWithdrawn === false && facts.isEvent === false && fact(facts, 'hasText');
      if (action === 'copy') return fact(facts, 'hasText');
      if (action === 'reply') return fact(facts, 'isReplyable');
      if (action === 'decide') return fact(facts, 'canDecide');
      if (action === 'make-card') return fact(facts, 'canMakeCard');
      if (action === 'edit' || action === 'withdraw') {
        return fact(facts, 'isMine') && facts.isWithdrawn === false && facts.isEvent === false;
      }
      return true;
    case 'conversation':
      if (action === 'mark-read') return fact(facts, 'hasUnread');
      if (action === 'copy-forwarding-address') return fact(facts, 'hasInboundAddress');
      // The Worker archives only a direct conversation; a channel says so.
      if (action === 'archive') return facts.isDirect !== false;
      if (action === 'open-core') return fact(facts, 'hasCore');
      return true;
    case 'person':
      if (action === 'wave') return fact(facts, 'canWave');
      if (action === 'call') return fact(facts, 'canCall');
      if (action === 'join-room') return fact(facts, 'canJoinRoom');
      if (action === 'copy-email') return fact(facts, 'hasEmail');
      if (action === 'star-thread') return fact(facts, 'hasThread');
      if (action === 'star-person') return fact(facts, 'hasFavorite');
      if (action === 'open-core') return fact(facts, 'hasCore');
      if (action === 'make-responsible') return fact(facts, 'canMakeResponsible');
      return true;
  }
}

/** Resolve one row kind and context for a client, preserving only useful groups. */
export function rowMenuGroups<K extends WorkRowKind>(
  kind: K,
  context: WorkRowMenuContext<K>,
  client: WorkActionClient,
  facts: WorkRowActionFacts = {},
): WorkRowActionID[][] {
  const groups = (WORK_ROW_MENU_GROUPS[kind] as ActionGroups)[context] ?? [];
  const clients = WORK_ROW_ACTION_CLIENTS[kind] as Partial<
    Record<WorkRowActionID, WorkActionClientAvailability>
  >;
  return groups
    .map((group) => group.filter((action) =>
      clients[action]?.[client] === true && actionMatchesFacts(kind, action, facts)))
    .filter((group) => group.length > 0)
    .map((group) => [...group]);
}

/** Existing task callers stay on the shared resolver until their views move. */
export const WORK_TASK_ACTIONS = [
  'accept',
  'decline',
  'complete',
  'cancel',
  'mark-seen',
  'file-github',
  'open-subject',
  'open-mine',
  'open-core',
  'star',
  'assign',
] as const satisfies readonly WorkRowActionID[];

export type WorkTaskActionID = (typeof WORK_TASK_ACTIONS)[number];
export const WORK_TASK_MENU_CONTEXTS = [
  'inbox_proposed',
  'subject_proposed',
  'subject_open',
  'mine',
  'assigned',
  'unowned',
] as const;
export type WorkTaskMenuContext = (typeof WORK_TASK_MENU_CONTEXTS)[number];
export const WORK_TASK_MENU_GROUPS = WORK_ROW_MENU_GROUPS.task;
export const WORK_TASK_MENU_REGISTRY = {
  actions: WORK_TASK_ACTIONS,
  contexts: WORK_TASK_MENU_CONTEXTS,
  groups: WORK_TASK_MENU_GROUPS,
} as const;

export interface WorkTaskMenuOptions {
  hasSubject: boolean;
  hasCore: boolean;
  canFileOnGitHub: boolean;
  isStarable?: boolean;
}

export function workTaskMenuGroups(
  context: WorkTaskMenuContext,
  options: WorkTaskMenuOptions,
  client: WorkActionClient = 'web',
): WorkTaskActionID[][] {
  return rowMenuGroups('task', context, client, {
    hasSubject: options.hasSubject,
    hasCore: options.hasCore,
    canFileOnGitHub: options.canFileOnGitHub,
    isStarable: options.isStarable,
  }) as WorkTaskActionID[][];
}
