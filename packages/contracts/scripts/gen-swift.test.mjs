// The Swift emitter against small shapes: one zod schema per rule in the
// header of gen-swift-contracts.mjs, through the same two passes wire.json
// takes, asserted on the Swift text. `pnpm contracts:test`. Lives here, next
// to the schema emitter, because zod resolves from this package. Catches an
// emitter regression without an Xcode build; `pnpm contracts:check` only
// says the committed output is stale.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { generateDeclarations } from '../../../scripts/gen-swift-contracts.mjs';
import { buildWireDocument } from './emit-schema.ts';
import { workspaceDefaultsSchema, workspaceDefaultsUpdateSchema, workspaceDefaultsAdminResponseSchema } from '../src/workspace-defaults.ts';

/** Swift for a registry, keyed by declaration name. */
function swift(schemas) {
  const decls = generateDeclarations(buildWireDocument(schemas).$defs);
  return Object.fromEntries(decls.map((d) => [d.match(/^public (?:struct|enum) (\w+)/m)[1], d]));
}

test('workspace defaults responses require resolved fields while updates may omit them', () => {
  const result = swift({
    WorkspaceDefaults: workspaceDefaultsSchema,
    WorkspaceDefaultsUpdate: { schema: workspaceDefaultsUpdateSchema, io: 'input' },
    WorkspaceDefaultsAdminResponse: workspaceDefaultsAdminResponseSchema,
  });
  assert.match(result.WorkspaceDefaultsAdminResponse, /public let defaults: WorkspaceDefaults\n/);
  assert.match(result.WorkspaceDefaults, /public let contactEmail: String\n/);
  assert.match(result.WorkspaceDefaultsUpdate, /public var contactEmail: String\?\n/);
});

test('a response object is a synthesized Codable struct with acronym casing and CodingKeys', () => {
  const { Row } = swift({
    Row: z.object({ device_id: z.string(), avatar_url: z.string().nullable(), requestId: z.string().optional(), count: z.number().int(), score: z.number(), self: z.boolean() }),
  });
  assert.match(Row, /public let deviceID: String\n/);
  assert.match(Row, /public let avatarURL: String\?\n/);
  assert.match(Row, /public let requestID: String\?\n/);
  assert.match(Row, /public let count: Int\n/);
  assert.match(Row, /public let score: Double\n/);
  assert.match(Row, /public let isSelf: Bool\n/);
  assert.match(Row, /case deviceID = "device_id"/);
  assert.match(Row, /case isSelf = "self"/);
  assert.doesNotMatch(Row, /init\(from decoder/, 'a response decodes with synthesized Codable');
});

test('a string set is an open enum unless closed', () => {
  const { Status, Surface } = swift({
    Status: z.enum(['waiting', 'admitted', 'not_planned']),
    Surface: { schema: z.enum(['mac', 'ios']), closed: true },
  });
  assert.match(Status, /public struct Status: RawRepresentable, Codable/);
  assert.match(Status, /public static let notPlanned = Status\(rawValue: "not_planned"\)/);
  assert.match(Status, /public static let known: \[Status\] = \[\.waiting, \.admitted, \.notPlanned\]/);
  assert.match(Surface, /public enum Surface: String, Codable, Hashable, Sendable, CaseIterable/);
  assert.match(Surface, /^  case mac$/m);
});

test('a union of registered shapes is an enum by the literal every member has, with .other', () => {
  const talk = z.object({ kind: z.literal('talk'), status: z.enum(['open', 'done']), id: z.string() });
  const task = z.object({ kind: z.literal('task'), status: z.enum(['open']), id: z.string() });
  const { InboxItem } = swift({ InboxTalkItem: talk, InboxTaskItem: task, InboxItem: z.union([talk, task]) });
  assert.match(InboxItem, /case talk\(InboxTalkItem\)/);
  assert.match(InboxItem, /case task\(InboxTaskItem\)/);
  assert.match(InboxItem, /case other\(kind: String\)/);
  assert.match(InboxItem, /case "talk": self = \.talk\(try InboxTalkItem\(from: decoder\)\)/);
  assert.doesNotMatch(InboxItem, /DiscriminatorKeys \{ case status/, '`kind` is the literal every member has; `status` is a set');
});

test('a request body says omit, null and value apart', () => {
  const { Update, UpdateRef } = swift({
    Update: {
      schema: z.object({
        title: z.string(),
        owner: z.string().nullable(),
        note: z.string().optional(),
        due: z.string().nullable().optional(),
        kind: z.literal('task'),
        text: z.string().default(''),
        ref: z.object({ id: z.string().nullable().optional() }).optional(),
      }),
      io: 'input',
    },
  });
  assert.match(Update, /public var title: String\n/);
  assert.match(Update, /public var owner: String\?\n/);
  assert.match(Update, /public var note: String\?\n/);
  assert.match(Update, /public var due: Patch<String>\n/);
  assert.match(Update, /public var text: String\?\n/, 'a defaulted field is optional on the way in');
  assert.match(Update, /kind: UpdateKind = \.task/, 'a literal names itself');
  assert.match(Update, /due: Patch<String> = \.omit/);
  assert.match(Update, /try container\.encode\(title, forKey: \.title\)/);
  assert.match(Update, /try container\.encode\(owner, forKey: \.owner\)/, 'a required nullable is always sent; nil goes as null');
  assert.match(Update, /try container\.encodeIfPresent\(note, forKey: \.note\)/);
  assert.match(Update, /try container\.encodePatch\(due, forKey: \.due\)/);
  assert.match(Update, /due = try container\.decodePatch\(String\.self, forKey: \.due\)/);
  assert.match(UpdateRef, /public var id: Patch<String>/, 'a nested request shape is a request shape');
});

test('a record, a nullable ref and a null-only field', () => {
  const sub = z.object({ id: z.string() });
  const { Prefs } = swift({
    Sub: sub,
    Prefs: z.object({ subjects: z.record(z.string(), sub), primary: sub.nullable(), legacy: z.null(), flags: z.record(z.string(), z.boolean()).optional() }),
  });
  assert.match(Prefs, /public let subjects: \[String: Sub\]\n/);
  assert.match(Prefs, /public let primary: Sub\?\n/);
  assert.match(Prefs, /public let flags: \[String: Bool\]\?\n/);
  assert.doesNotMatch(Prefs, /legacy/, 'a field that is always null is left out');
});

test('a query string is items in order, read after coercion, a defaulted field optional', () => {
  const { PageQuery } = swift({
    PageQuery: {
      schema: z.object({
        q: z.string(),
        limit: z.coerce.number().int().default(50),
        done: z.stringbool().optional(),
        sort: z.enum(['created', 'updated']).optional(),
        tags: z.array(z.string()).optional(),
      }),
      io: 'query',
    },
  });
  assert.match(PageQuery, /public struct PageQuery: Hashable, Sendable \{/);
  assert.doesNotMatch(PageQuery, /Codable/);
  assert.match(PageQuery, /public var q: String\n/);
  assert.match(PageQuery, /public var limit: Int\?\n/, 'coerced on the way in, a number to the client; defaulted, so optional');
  assert.match(PageQuery, /public var done: Bool\?\n/, 'a stringbool is a Bool to the client');
  assert.match(PageQuery, /items\.append\(URLQueryItem\(name: "q", value: q\)\)/);
  assert.match(PageQuery, /if let limit \{ items\.append\(URLQueryItem\(name: "limit", value: String\(limit\)\)\) \}/);
  assert.match(PageQuery, /if let done \{ items\.append\(URLQueryItem\(name: "done", value: done \? "true" : "false"\)\) \}/);
  assert.match(PageQuery, /value: sort\.rawValue/);
  assert.match(PageQuery, /for element in tags \{ items\.append\(URLQueryItem\(name: "tags", value: element\)\) \}/);
});

test('a shape the emitter does not know fails at generation, not on a phone', () => {
  assert.throws(() => swift({ Mixed: z.object({ value: z.union([z.string(), z.number()]) }) }), /anyOf with 2 non-null members/);
  assert.throws(() => swift({ Bare: z.string() }), /top-level shape must be/);
});
