import { describe, expect, it } from 'vitest';
import { workspaceDescriptorSchema } from '@starlings/contracts/workspace-descriptor';
import { calendarEventsResponseSchema } from '@starlings/contracts/calendar';
import { crmBoardResponseSchema, crmMyWorkResponseSchema, crmSubjectDetailResponseSchema, crmSubjectsResponseSchema } from '@starlings/contracts/crm';
import {
  decisionAsksResponseSchema,
  favoritesResponseSchema,
  inboxResponseSchema,
  meetingCategoryResponseSchema,
  ownerRoomResponseSchema,
  peersResponseSchema,
  searchResponseSchema,
  threadMessagesResponseSchema,
  threadsResponseSchema,
} from '@starlings/contracts';

/*
 * What the Worker really answers (meet#593). The web's side of the pin:
 * `web/src/api.ts` casts a response (`response.json() as T`), so nothing at
 * run time tells the page a field moved. Every file in
 * `fixtures/responses/` is the body the Worker's own route test recorded for
 * one read, and each is parsed here with the contract the page types it by.
 * The Worker suite holds the file to what the route answers
 * (`services/control-plane/test/response-fixtures.test.ts`); the Mac and iOS
 * suites decode the same files (`Tests/ResponseFixtureTests.swift`).
 *
 * Rename a field in a Worker response and the Worker's check fails first;
 * re-record (`node scripts/record-response-fixtures.mjs --write`) and this
 * one fails until the contract and the page follow.
 */

const files = import.meta.glob('../../fixtures/responses/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;
const recorded = new Map(Object.entries(files).map(([file, body]) => [file.replace(/^.*\//u, '').replace(/\.json$/u, ''), body]));

/** The contract each recorded read is parsed with: the route's response schema. */
/** The slice of a zod schema this test uses: the web does not depend on zod itself. */
interface Contract {
  safeParse(value: unknown): { success: true } | { success: false; error: { issues: unknown[] } };
}

const contracts: Record<string, Contract> = {
  'owner-room': ownerRoomResponseSchema,
  'crm-subjects': crmSubjectsResponseSchema,
  'crm-subject-project': crmSubjectDetailResponseSchema,
  'crm-mine': crmMyWorkResponseSchema,
  'crm-board': crmBoardResponseSchema,
  threads: threadsResponseSchema,
  'thread-messages': threadMessagesResponseSchema,
  peers: peersResponseSchema,
  'calendar-upcoming': calendarEventsResponseSchema,
  'crm-inbox': inboxResponseSchema,
  search: searchResponseSchema,
  favorites: favoritesResponseSchema,
  'crm-starred': searchResponseSchema,
  'decision-asks': decisionAsksResponseSchema,
  'meeting-category': meetingCategoryResponseSchema,
  'workspace-descriptor': workspaceDescriptorSchema,
};

describe('recorded Worker responses', () => {
  it('names a contract for every file and a file for every contract', () => {
    expect([...recorded.keys()].sort()).toEqual(Object.keys(contracts).sort());
  });

  for (const [name, schema] of Object.entries(contracts)) {
    it(`${name} parses with its contract`, () => {
      const parsed = schema.safeParse(recorded.get(name));
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2)).toBe(true);
    });
  }
});
