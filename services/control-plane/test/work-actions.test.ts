import { describe, expect, it } from 'vitest';
import {
  WORK_ACTION_CLIENTS,
  WORK_ROW_ACTION_CLIENTS,
  WORK_ROW_ACTION_DEFINITIONS,
  WORK_ROW_ACTIONS,
  WORK_ROW_KINDS,
  WORK_ROW_MENU_GROUPS,
  rowMenuGroups,
  workTaskMenuGroups,
  type WorkActionClient,
  type WorkRowActionFacts,
  type WorkRowActionID,
  type WorkRowKind,
} from '@starlings/contracts/work-actions';
import { CORE_SUBJECT_COLLECTIONS, coreContactURL, coreSubjectURL } from '@starlings/contracts/deployment';
import fixture from '../../../fixtures/work-actions.json';

interface FixtureTable {
  version: number;
  actions: Record<string, { destructive: boolean }>;
  clients: Record<string, Record<string, Record<WorkActionClient, boolean>>>;
  contexts: Record<string, Record<string, string[][]>>;
  core: {
    subjects: Array<{ kind: keyof typeof CORE_SUBJECT_COLLECTIONS; id: string; collection: string; url: string }>;
    contacts: Array<{ raw: string; url: string | null }>;
  };
}

interface FactCase {
  kind: WorkRowKind;
  context: string;
  client: WorkActionClient;
  facts: WorkRowActionFacts;
  expected: WorkRowActionID[][];
}

const table = fixture as FixtureTable;
const resolve = rowMenuGroups as (
  kind: WorkRowKind,
  context: string,
  client: WorkActionClient,
  facts?: WorkRowActionFacts,
) => WorkRowActionID[][];

const factCases: readonly FactCase[] = [
  {
    kind: 'task',
    context: 'mine',
    client: 'mac',
    facts: { hasSubject: false, hasCore: false, canFileOnGitHub: false },
    expected: [['complete', 'cancel'], ['open-mine']],
  },
  {
    kind: 'issue',
    context: 'row',
    client: 'mac',
    facts: { isOpen: true, hasRepo: true, hasCore: true },
    expected: [['open'], ['close-issue', 'close-not-planned'], ['open-github'], ['copy-link'], ['open-core'], ['star']],
  },
  {
    kind: 'task',
    context: 'mine',
    client: 'web',
    facts: { hasSubject: true, hasCore: true, canFileOnGitHub: true, isStarable: true },
    expected: [['complete', 'cancel'], ['open-subject'], ['file-github'], ['open-core'], ['star']],
  },
  {
    kind: 'issue',
    context: 'assigned',
    client: 'mac',
    facts: { isOpen: true, canMarkSeen: true },
    expected: [['close-issue', 'close-not-planned'], ['mark-seen'], ['open'], ['star']],
  },
  {
    kind: 'inbox_talk',
    context: 'row',
    client: 'mac',
    facts: { hasSubject: false, hasUnread: true, hasCore: false },
    expected: [['mark-read', 'mute']],
  },
  {
    kind: 'inbox_sales',
    context: 'row',
    client: 'web',
    facts: { isDismissed: false, hasEmail: true },
    expected: [['start-lead'], ['dismiss', 'copy-email']],
  },
  {
    kind: 'inbox_comment',
    context: 'row',
    client: 'web',
    facts: { hasSubject: false, hasCore: false },
    expected: [['open-document'], ['resolve']],
  },
  {
    kind: 'inbox_booking',
    context: 'row',
    client: 'web',
    facts: { hasEvent: false, hasEmail: true },
    expected: [['copy-email'], ['dismiss']],
  },
  {
    kind: 'inbox_interest',
    context: 'row',
    client: 'web',
    facts: { hasEmail: true },
    expected: [['copy-email'], ['dismiss']],
  },
  {
    kind: 'inbox_decision',
    context: 'row',
    client: 'ios',
    facts: {},
    expected: [['decide'], ['open']],
  },
  {
    kind: 'quick_note',
    context: 'inbox',
    client: 'mac',
    facts: { isEditable: false, isOpen: true },
    expected: [['file-note'], ['delete']],
  },
  {
    kind: 'subject',
    context: 'row',
    client: 'web',
    facts: {
      isProject: true,
      isPartner: false,
      isEvent: false,
      hasRepo: false,
      hasVault: false,
      hasCore: false,
    },
    // Keep vault on the web is the handoff to Mac and iPhone (meet#233). A project with no repository
    // can link one from the web too.
    expected: [['star', 'mute'], ['open', 'edit-details'], ['open-tasks', 'new-task'], ['link-repository', 'keep-vault']],
  },
  {
    kind: 'subject',
    context: 'organization',
    client: 'mac',
    facts: { isPartner: true, isEvent: false, hasCore: true },
    expected: [['star', 'mute'], ['open', 'open-talk', 'open-history', 'start-room'], ['open-tasks', 'new-task'], ['open-core']],
  },
  {
    kind: 'subject',
    context: 'row',
    client: 'web',
    facts: { isProject: true, isPartner: false, isEvent: false, hasRepo: false, hasVault: false, hasCore: true },
    expected: [['star', 'mute'], ['open', 'edit-details'], ['open-tasks', 'new-task'], ['link-repository', 'keep-vault', 'open-core']],
  },
  {
    kind: 'goal',
    context: 'row',
    client: 'web',
    facts: { isOpen: false },
    expected: [['reopen']],
  },
  {
    kind: 'doc',
    context: 'row',
    client: 'web',
    facts: { isSavedLink: true, isEditable: false },
    expected: [['open', 'star'], ['open-page', 'copy-page-link']],
  },
  {
    kind: 'doc_rail',
    context: 'folder',
    client: 'web',
    facts: { isFolder: true },
    expected: [['open', 'copy-link'], ['star']],
  },
  {
    kind: 'board_card',
    context: 'row',
    client: 'mac',
    facts: {
      hasRepo: false,
      hasSubject: false,
      hasConversation: false,
      canMoveStage: false,
      hasAgents: false,
    },
    expected: [['open']],
  },
  {
    kind: 'message',
    context: 'row',
    client: 'web',
    facts: {
      isMine: false,
      isWithdrawn: false,
      isPartial: false,
      hasText: true,
      isReplyable: true,
      canDecide: true,
      isEvent: false,
    },
    expected: [['react'], ['copy', 'reply', 'decide']],
  },
  {
    kind: 'message',
    context: 'row',
    client: 'ios',
    facts: {
      isMine: true,
      isWithdrawn: false,
      isPartial: false,
      hasText: true,
      isReplyable: false,
      canDecide: false,
      isEvent: false,
    },
    expected: [['react'], ['copy'], ['save-note', 'edit', 'withdraw']],
  },
  {
    kind: 'message',
    context: 'row',
    client: 'web',
    facts: {
      isMine: true,
      isWithdrawn: false,
      isPartial: true,
      hasText: true,
      isReplyable: true,
      canDecide: true,
      isEvent: false,
    },
    expected: [],
  },
  {
    kind: 'conversation',
    context: 'row',
    client: 'mac',
    facts: { hasUnread: false, hasInboundAddress: false },
    expected: [['mute'], ['archive'], ['star']],
  },
  {
    kind: 'conversation',
    context: 'row',
    client: 'web',
    facts: { hasUnread: true, hasInboundAddress: true },
    expected: [['mark-read', 'mute'], ['copy-forwarding-address'], ['archive'], ['star']],
  },
  {
    kind: 'person',
    context: 'peer',
    client: 'web',
    facts: { canWave: true, canCall: false, hasEmail: true, hasThread: false, hasFavorite: true },
    expected: [['message', 'wave'], ['copy-email'], ['star-person']],
  },
  {
    kind: 'person',
    context: 'peer',
    client: 'web',
    facts: { canWave: false, canCall: false, canJoinRoom: true, hasEmail: true, hasThread: false, hasFavorite: true },
    expected: [['message', 'join-room'], ['copy-email'], ['star-person']],
  },
];

describe('work action registry', () => {
  it('matches the version 2 fixture across every row kind and context', () => {
    expect(table.version).toBe(2);
    expect(Object.keys(table.actions)).toEqual([...WORK_ROW_ACTIONS]);
    expect(table.actions).toEqual(WORK_ROW_ACTION_DEFINITIONS);
    expect(Object.keys(table.clients)).toEqual([...WORK_ROW_KINDS]);
    expect(table.clients).toEqual(WORK_ROW_ACTION_CLIENTS);
    expect(Object.keys(table.contexts)).toEqual([...WORK_ROW_KINDS]);
    expect(table.contexts).toEqual(WORK_ROW_MENU_GROUPS);

    for (const kind of WORK_ROW_KINDS) {
      const contextGroups = table.contexts[kind]!;
      const clients = table.clients[kind]!;
      const referencedActions = [...new Set<string>(Object.values(contextGroups).flat(2))].sort();
      expect(Object.keys(clients).sort(), kind).toEqual(referencedActions);
      for (const groups of Object.values(contextGroups)) {
        for (const action of groups.flat()) {
          expect(table.actions[action], kind + '.' + action).toBeDefined();
        }
      }
    }
  });

  it('applies client availability for every row kind', () => {
    for (const kind of WORK_ROW_KINDS) {
      const contexts = table.contexts[kind]!;
      const clients = table.clients[kind]!;
      for (const [context, groups] of Object.entries(contexts)) {
        const ids = groups.flat();
        for (const client of WORK_ACTION_CLIENTS) {
          const actual = resolve(kind, context, client, {
            hasSubject: true,
            hasCore: true,
            canFileOnGitHub: true,
            canMarkSeen: true,
            hasUnread: true,
            isDismissed: false,
            hasEmail: true,
            hasEvent: true,
            isEditable: true,
            isOpen: true,
            isProject: true,
            isPartner: false,
            isEvent: false,
            hasRepo: true,
            hasVault: false,
            isSavedLink: true,
            isFolder: true,
            hasConversation: true,
            canMoveStage: true,
            hasAgents: true,
            isMine: false,
            isWithdrawn: false,
            hasText: true,
            isReplyable: true,
            canDecide: true,
            hasInboundAddress: true,
            canWave: true,
            canCall: true,
            hasThread: true,
          });
          const visible = new Set<string>(actual.flat());
          for (const id of ids) {
            const availability = clients[id];
            expect(availability, kind + '.' + context + '.' + id).toBeDefined();
            if (!availability) continue;
            if (!availability[client]) {
              expect(visible.has(id), kind + '.' + context + '.' + client + '.' + id).toBe(false);
            }
          }
          for (const id of visible) {
            expect(clients[id]?.[client], kind + '.' + context + '.' + client + '.' + id).toBe(true);
          }
        }
      }
    }
  });

  for (const testCase of factCases) {
    it('filters ' + testCase.kind + ' actions using row facts', () => {
      expect(resolve(testCase.kind, testCase.context, testCase.client, testCase.facts))
        .toEqual(testCase.expected);
    });
  }

  it('keeps task callers on the generic resolver', () => {
    const mine = workTaskMenuGroups('mine', {
      hasSubject: false,
      hasCore: false,
      canFileOnGitHub: false,
    });
    expect(mine).toEqual([['complete', 'cancel'], ['open-mine']]);

    const assigned = workTaskMenuGroups('assigned', {
      hasSubject: true,
      hasCore: false,
      canFileOnGitHub: false,
    });
    expect(assigned).toEqual([['complete', 'cancel'], ['mark-seen'], ['open-subject']]);
  });

  it('keeps Core subject and contact URLs pinned with the row-action fixture', () => {
    for (const subject of table.core.subjects) {
      expect(CORE_SUBJECT_COLLECTIONS[subject.kind]).toBe(subject.collection);
      expect(coreSubjectURL(subject.kind, subject.id)).toBe(subject.url);
    }
    for (const contact of table.core.contacts) {
      expect(coreContactURL(contact.raw)).toBe(contact.url);
    }
  });
});
