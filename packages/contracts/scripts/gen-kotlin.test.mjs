// The Kotlin emitter against small shapes: one zod schema per rule in the
// header of gen-kotlin-contracts.mjs, through the same two passes wire.json
// takes, asserted on the Kotlin text. `pnpm contracts:test`. Catches an
// emitter regression without a Gradle build; `pnpm contracts:check` only
// says the committed output is stale. Mirrors gen-swift.test.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { generateDeclarations } from '../../../scripts/gen-kotlin-contracts.mjs';
import { buildWireDocument } from './emit-schema.ts';

/** Kotlin for a registry, keyed by declaration name. */
function kotlin(schemas) {
  const decls = generateDeclarations(buildWireDocument(schemas).$defs);
  return Object.fromEntries(decls.map((d) => [d.match(/^(?:data class|class|enum class|value class|sealed interface) (\w+)/m)[1], d]));
}

test('a response object is a data class with Kotlin casing and SerialName', () => {
  const { Row } = kotlin({
    Row: z.object({ device_id: z.string(), avatar_url: z.string().nullable(), requestId: z.string().optional(), count: z.number().int(), score: z.number(), self: z.boolean() }),
  });
  assert.match(Row, /^@Serializable\ndata class Row\(/);
  assert.match(Row, /@SerialName\("device_id"\) val deviceId: String,\n/);
  assert.match(Row, /@SerialName\("avatar_url"\) val avatarUrl: String\? = null,\n/);
  assert.match(Row, /  val requestId: String\? = null,\n/, 'already camelCase: no SerialName');
  assert.match(Row, /val count: Long,\n/, 'a wire integer reaches 2^53');
  assert.match(Row, /val score: Double,\n/);
  assert.match(Row, /@SerialName\("self"\) val isSelf: Boolean,\n/);
  assert.doesNotMatch(Row, /EncodeDefault/, 'a response sends nothing it was not given');
});

test('a string set is an open value class unless closed', () => {
  const { Status, Surface } = kotlin({
    Status: z.enum(['waiting', 'admitted', 'not_planned']),
    Surface: { schema: z.enum(['mac', 'ios']), closed: true },
  });
  assert.match(Status, /@Serializable\n@JvmInline\nvalue class Status\(val value: String\)/);
  assert.match(Status, /val NOT_PLANNED = Status\("not_planned"\)/);
  assert.match(Status, /val known: List<Status> = listOf\(WAITING, ADMITTED, NOT_PLANNED\)/);
  assert.match(Surface, /@Serializable\nenum class Surface\(val value: String\)/);
  assert.match(Surface, /@SerialName\("mac"\) MAC\("mac"\),/);
});

test('an old name reads as the value that replaced it', () => {
  const { Kind } = kotlin({ Kind: z.enum(['lead', 'organization']) });
  assert.match(Kind, /@Serializable\(with = Kind\.Serializer::class\)/);
  assert.match(Kind, /val readAliases: Map<String, String> = mapOf\("partner" to "organization"\)/);
});

test('a union of registered shapes is a sealed interface by the literal every member has, with Other', () => {
  const talk = z.object({ kind: z.literal('talk'), status: z.enum(['open', 'done']), id: z.string() });
  const task = z.object({ kind: z.literal('task'), status: z.enum(['open']), id: z.string() });
  const { InboxItem, InboxTalkItem } = kotlin({ InboxTalkItem: talk, InboxTaskItem: task, InboxItem: z.union([talk, task]) });
  assert.match(InboxTalkItem, /^\) : InboxItem$/m, 'a member implements the union');
  assert.match(InboxTalkItem, /@EncodeDefault val kind: InboxTalkItemKind = InboxTalkItemKind\.TALK,/, 'the literal is always sent, so a member round-trips');
  assert.match(InboxItem, /@Serializable\(with = InboxItemSerializer::class\)\nsealed interface InboxItem \{/);
  assert.match(InboxItem, /data class Other\(val raw: JsonObject\) : InboxItem/);
  assert.match(InboxItem, /"talk" -> json\.decodeFromJsonElement\(InboxTalkItem\.serializer\(\), element\)/);
  assert.match(InboxItem, /WireUnionSerializer<InboxItem>\("work\.starlings\.contracts\.InboxItem", "kind"\)/, '`kind` is the literal every member has; `status` is a set');
  assert.match(InboxItem, /val InboxItem\.kind: String/);
});

test('two members that claim one value are tried in order', () => {
  const a = z.object({ kind: z.literal('assigned'), task_id: z.string() });
  const b = z.object({ kind: z.literal('assigned'), issue_id: z.string() });
  const { Item } = kotlin({ ItemA: a, ItemB: b, Item: z.union([a, b]) });
  assert.match(Item, /"assigned" -> firstOf\(json, element, ItemA\.serializer\(\), ItemB\.serializer\(\)\) \?: Item\.Other\(element\)/);
});

test('a request body says omit, null and value apart', () => {
  const { Update, UpdateRef } = kotlin({
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
  assert.match(Update, /  val title: String,\n/);
  assert.match(Update, /@EncodeDefault val owner: String\? = null,\n/, 'a required nullable is always sent; null goes as null');
  assert.match(Update, /  val note: String\? = null,\n/, 'not required: left out when null');
  assert.match(Update, /val due: Patch<String> = Patch\.Omit,\n/);
  assert.match(Update, /  val text: String\? = null,\n/, 'a defaulted field is optional on the way in');
  assert.match(Update, /@EncodeDefault val kind: UpdateKind = UpdateKind\.TASK,/, 'a literal names itself');
  assert.match(UpdateRef, /val id: Patch<String> = Patch\.Omit/, 'a nested request shape is a request shape');
});

test('a record, a nullable ref and a null-only field', () => {
  const sub = z.object({ id: z.string() });
  const { Prefs } = kotlin({
    Sub: sub,
    Prefs: z.object({ subjects: z.record(z.string(), sub), primary: sub.nullable(), legacy: z.null(), flags: z.record(z.string(), z.boolean()).optional() }),
  });
  assert.match(Prefs, /val subjects: Map<String, Sub>,\n/);
  assert.match(Prefs, /val primary: Sub\? = null,\n/);
  assert.match(Prefs, /val flags: Map<String, Boolean>\? = null,\n/);
  assert.doesNotMatch(Prefs, /legacy/, 'a field that is always null is left out');
});

test('a query string is items in order, read after coercion, a defaulted field optional', () => {
  const { PageQuery } = kotlin({
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
  assert.match(PageQuery, /^data class PageQuery\(/);
  assert.doesNotMatch(PageQuery, /@Serializable/);
  assert.match(PageQuery, /  val q: String,\n/);
  assert.match(PageQuery, /val limit: Long\? = null,\n/);
  assert.match(PageQuery, /val done: Boolean\? = null,\n/);
  assert.match(PageQuery, /items\.add\("q" to q\)/);
  assert.match(PageQuery, /limit\?\.let \{ items\.add\("limit" to it\.toString\(\)\) \}/);
  assert.match(PageQuery, /done\?\.let \{ items\.add\("done" to it\.toString\(\)\) \}/);
  assert.match(PageQuery, /sort\?\.let \{ items\.add\("sort" to it\.value\) \}/);
  assert.match(PageQuery, /tags\?\.let \{ for \(element in it\) items\.add\("tags" to element\) \}/);
  assert.ok(PageQuery.indexOf('"q" to') < PageQuery.indexOf('"limit" to'), "the contract's order");
});

test('a shape the emitter does not know fails at generation, not on a phone', () => {
  assert.throws(() => kotlin({ Mixed: z.object({ value: z.union([z.string(), z.number()]) }) }), /anyOf with 2 non-null members/);
  assert.throws(() => kotlin({ Bare: z.string() }), /top-level shape must be/);
  assert.throws(() => kotlin({ Twice: z.object({ device_id: z.string(), deviceId: z.string() }) }), /both deviceId/);
  assert.throws(() => kotlin({ Kw: z.object({ in: z.string() }) }), /Kotlin keyword/);
});
