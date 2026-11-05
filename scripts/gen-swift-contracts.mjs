#!/usr/bin/env node
// Swift from the wire schema: reads packages/contracts/schema/wire.json and
// writes packages/contracts/swift/Sources/StarlingsContracts/Wire.swift, one
// `Codable, Hashable, Sendable` struct or enum per `$defs` entry.
//
//   pnpm contracts:swift           # write
//   pnpm contracts:swift --check   # exit 1 when the file on disk is stale
//   pnpm contracts:test            # the emitter against small shapes (packages/contracts/scripts/gen-swift.test.mjs)
//
// Own emitter rather than quicktype: quicktype's Swift is not Sendable-clean
// under Swift 6 and it invents names that collide with the hand-written types
// this replaces. The mapping is deliberately small; a schema feature this
// script does not know throws, so the gap shows up at generation, not at
// decode time on a phone.
//
// JSON Schema      Swift
// object           struct, CodingKeys when a key is not already camelCase (device_id -> deviceID)
// string/enum      struct <Name>: RawRepresentable — an open enum with a static per value
//                  (a string const is a one-value one); unknown values decode, they do not fail.
//                  `x-closed` (closed: true in wire.ts) makes it a real enum instead.
// string           String
// integer          Int
// number           Double
// boolean          Bool (a `const: true` is still Bool; the Worker guarantees it)
// array            [T]
// $ref             the referenced def's name
// record           [String: T]
// anyOf of strings String
// anyOf of $refs    enum with a case per member, decoded by their shared string field; `.other` keeps a stranger
// not required     T?
// type: [T, null]  T?
// type: null       omitted from the struct
//
// A request body (`io: 'input'` in wire.ts, `x-io: input` here) is the same
// struct with its own Codable, because a write says three things where a read
// says two:
// required         T                 always sent
// required, null   T?                always sent; nil goes as null (clears)
// not required     T?                sent when set; nil is left out (keeps)
// not required,    Patch<T>          .omit leaves the field alone, .null clears
// null                               it, .value(x) sets it (see Patch.swift)
// const string     T = .value        the init defaults it; the caller does not name it
//
// A query string (`io: 'query'`, `x-io: query`) is a struct that is not
// Codable: `queryItems`, in the contract's order, a nil field left out, a
// number as its digits, a Bool as `true`/`false`, a set as its raw value,
// an array as one item per element.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** The `$defs` being emitted; a union reads its members' shapes from here. */
let defs = {};

// Swift API guidelines spell an acronym in one case: `deviceID`, `imageURL`,
// never `deviceId`. Only an initial segment stays lowercase (`id`, `url`).
const ACRONYMS = { id: 'ID', ids: 'IDs', url: 'URL', urls: 'URLs', uri: 'URI', uris: 'URIs' };
// Keys arrive in snake_case or already in camelCase (the lobby routes):
// both split into words, and a word that is an acronym is spelled as one
// (requestId -> requestID, avatar_url -> avatarURL).
export const segments = (s) =>
  s
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .filter(Boolean)
    // A word already in capitals (BR in pt-BR, URL in avatarURL) stays so.
    .map((seg) => (/^[A-Z0-9]{2,}$/.test(seg) ? seg : seg.toLowerCase()));
const upper = (seg) => ACRONYMS[seg] ?? seg.charAt(0).toUpperCase() + seg.slice(1);
const pascal = (s) => segments(s).map(upper).join('');
const camel = (s) => {
  const [head, ...rest] = segments(s);
  if (!head) return s;
  return head.toLowerCase() + rest.map(upper).join('');
};
const SWIFT_KEYWORDS = new Set(['default', 'in', 'is', 'as', 'for', 'if', 'else', 'return', 'type', 'self', 'where', 'case', 'enum', 'struct', 'class', 'let', 'var', 'func', 'import', 'operator', 'protocol', 'static', 'true', 'false', 'nil', 'init', 'super', 'throws', 'internal', 'public', 'private', 'fileprivate', 'open', 'extension', 'subscript', 'typealias', 'associatedtype', 'deinit', 'inout', 'rethrows', 'guard', 'defer', 'do', 'repeat', 'while', 'switch', 'break', 'continue', 'fallthrough', 'throw', 'try', 'catch', 'Any', 'Self']);
const ident = (s) => (SWIFT_KEYWORDS.has(s) ? `\`${s}\`` : s);
// A key a backtick would only make ugly: `self` is not a property name in any
// form, `internal` reads as an access level. The wire key stays; only the
// Swift spelling moves.
const FIELD_RENAMES = { self: 'isSelf', internal: 'isInternal' };
const fieldName = (key) => FIELD_RENAMES[key] ?? camel(key);

/** Nested declarations emitted while walking a property; flushed after the owner. */
let pending = [];

function swiftType(schema, hint) {
  if (schema.$ref) return schema.$ref.replace(/^#\/\$defs\//, '');
  let types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const nullable = types.includes('null') || (schema.anyOf?.some((s) => s.type === 'null') ?? false);
  if (schema.anyOf) {
    const rest = schema.anyOf.filter((s) => s.type !== 'null');
    // Two string formats (an instant or a day) are one String to a client.
    if (rest.length > 1 && rest.every((s) => s.type === 'string' && !s.enum && s.const === undefined)) {
      return 'String' + (nullable ? '?' : '');
    }
    if (rest.length !== 1) throw new Error(`${hint}: anyOf with ${rest.length} non-null members is not supported yet`);
    return swiftType(rest[0], hint) + (nullable ? '?' : '');
  }
  types = types.filter((t) => t !== 'null');
  if (types.length !== 1) throw new Error(`${hint}: expected one type, got ${JSON.stringify(schema.type)}`);
  const [type] = types;
  let out;
  switch (type) {
    case 'string':
      if (schema.enum || schema.const !== undefined) {
        const values = schema.enum ?? [schema.const];
        // A literal is a one-case enum: the compiler then knows the value. A set
        // whose members are not names (an emoji palette) stays a String.
        if (values.every((v) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(camel(v)))) {
          pending.push(emitEnum(hint, values));
          out = hint;
        } else out = 'String';
      } else out = 'String';
      break;
    case 'integer': out = 'Int'; break;
    case 'number': out = Number.isInteger(schema.const) ? 'Int' : 'Double'; break;
    case 'boolean': out = 'Bool'; break;
    case 'array': out = `[${swiftType(schema.items, hint + 'Item')}]`; break;
    case 'object':
      if (!schema.properties && schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        // z.record: keys are strings, values one shape.
        out = `[String: ${swiftType(schema.additionalProperties, hint + 'Value')}]`;
        break;
      }
      pending.push(emitStruct(hint, schema));
      out = hint;
      break;
    default: throw new Error(`${hint}: unsupported type ${type}`);
  }
  return out + (nullable ? '?' : '');
}

/**
 * An old name read as the value that replaced it. ADR 0006 renamed the
 * `partner` subject kind to `organization`; a snapshot cached on a device
 * before the rename still says `partner`. Applied only to an enum that names
 * the new value and not the old one.
 */
const READ_ALIASES = { partner: 'organization' };

/**
 * The same, for one enum only, where the old value is shared by enums that
 * take different new names: `envisioning` became `starlings` as
 * a calendar platform and `internal` as a subject group. The contract still
 * lists the old value for one release, so a TypeScript reader accepts a
 * cached answer; Swift gets no case for it and reads it as the new one.
 */
const ENUM_READ_ALIASES = {
  CalendarMeetingPlatform: { envisioning: 'starlings' },
  InboxRecentEntrySubjectGroup: { envisioning: 'internal' },
};

export function readAliases(name, values) {
  return [
    ...Object.entries(READ_ALIASES).filter(([alias, value]) => values.includes(value) && !values.includes(alias)),
    ...Object.entries(ENUM_READ_ALIASES[name] ?? {}).filter(([, value]) => values.includes(value)),
  ];
}

function emitEnum(name, listed, closed = false) {
  const caseName = (v) => ident(camel(v));
  const aliases = readAliases(name, listed);
  const values = listed.filter((v) => !(v in (ENUM_READ_ALIASES[name] ?? {})));
  if (closed) {
    // A set the client chooses from (`closed: true` in wire.ts): a real enum,
    // so a switch over it is exhaustive and a new member is a compile error
    // everywhere it matters.
    const cases = values.map((v) => (camel(v) === v ? `  case ${caseName(v)}` : `  case ${caseName(v)} = "${v}"`));
    if (aliases.length === 0) {
      return `public enum ${name}: String, Codable, Hashable, Sendable, CaseIterable {\n${cases.join('\n')}\n}\n`;
    }
    const reads = [
      ...values.map((v) => `    case "${v}": self = .${caseName(v)}`),
      ...aliases.map(([alias, value]) => `    case "${alias}": self = .${caseName(value)}`),
    ];
    return [
      `public enum ${name}: String, Codable, Hashable, Sendable, CaseIterable {`,
      ...cases,
      '',
      `  public init?(rawValue: String) {`,
      '    switch rawValue {',
      ...reads,
      '    default: return nil',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
  }
  // Otherwise an open enum, not a Swift `enum`: a value this build has never
  // heard of decodes as itself instead of failing the whole response. The
  // Worker ships from main continuously and a native build is always older
  // than it, so a new status or client name must not empty a lobby on a
  // phone. `switch` over one needs a `default`; that is the honest shape of
  // a wire value.
  const cases = values.map((v) => `  public static let ${caseName(v)} = ${name}(rawValue: "${v}")`);
  return [
    `public struct ${name}: RawRepresentable, Codable, Hashable, Sendable, CustomStringConvertible {`,
    '  public let rawValue: String',
    aliases.length === 0
      ? '  public init(rawValue: String) { self.rawValue = rawValue }'
      : `  public init(rawValue: String) { self.rawValue = ${name}.readAliases[rawValue] ?? rawValue }`,
    '  public var description: String { rawValue }',
    '',
    ...cases,
    '',
    '  /// Every value the contract names, in its order.',
    `  public static let known: [${name}] = [${values.map((v) => `.${caseName(v)}`).join(', ')}]`,
    ...(aliases.length === 0 ? [] : [
      '',
      '  /// An old name, read as the value that replaced it (ADR 0006).',
      `  static let readAliases: [String: String] = [${aliases.map(([alias, value]) => `"${alias}": "${value}"`).join(', ')}]`,
    ]),
    '}',
    '',
  ].join('\n');
}

/** True while walking a request body: nested structs inherit it. */
let inputMode = false;

function emitStruct(name, schema) {
  const required = new Set(schema.required ?? []);
  const props = Object.entries(schema.properties ?? {}).flatMap(([key, prop]) => {
    // A field that is always null carries nothing; the struct leaves it out
    // and Codable ignores the key.
    if (prop.type === 'null') return [];
    const inner = swiftType(prop, name + pascal(key));
    const nullable = inner.endsWith('?');
    const base = nullable ? inner.slice(0, -1) : inner;
    // Which of the four ways a request field travels (see the header).
    let mode;
    if (required.has(key)) mode = nullable ? 'null' : 'always';
    else mode = nullable && inputMode ? 'patch' : 'present';
    const type = mode === 'patch' ? `Patch<${base}>` : mode === 'always' ? base : `${base}?`;
    // A literal names itself: `kind: .team` is not the caller's to choose.
    const literal = prop.type === 'string' && prop.const !== undefined && base === name + pascal(key)
      ? `.${ident(camel(prop.const))}`
      : null;
    const fallback = literal ?? (mode === 'patch' ? '.omit' : type.endsWith('?') ? 'nil' : null);
    return [{ key, field: fieldName(key), type, base, mode, fallback, description: prop.description }];
  });
  const lines = [];
  if (schema.description) lines.push(`/// ${schema.description}`);
  lines.push(`public struct ${name}: Codable, Hashable, Sendable {`);
  for (const p of props) {
    if (p.description) lines.push(`  /// ${p.description}`);
    lines.push(`  public ${inputMode ? 'var' : 'let'} ${ident(p.field)}: ${p.type}`);
  }
  lines.push('');
  const params = props.map((p) => `${ident(p.field)}: ${p.type}${p.fallback ? ` = ${p.fallback}` : ''}`);
  lines.push(`  public init(${params.join(', ')}) {`);
  lines.push(...props.map((p) => `    self.${ident(p.field)} = ${ident(p.field)}`));
  lines.push('  }');
  if (inputMode || props.some((p) => p.field !== p.key)) {
    lines.push('');
    lines.push('  enum CodingKeys: String, CodingKey {');
    lines.push(...props.map((p) => (p.field === p.key ? `    case ${ident(p.field)}` : `    case ${ident(p.field)} = "${p.key}"`)));
    lines.push('  }');
  }
  if (inputMode) {
    // Synthesized Codable drops every nil, which cannot say "clear this".
    const decode = { always: 'decode', null: 'decodeIfPresent', present: 'decodeIfPresent', patch: 'decodePatch' };
    const encode = { always: 'encode', null: 'encode', present: 'encodeIfPresent', patch: 'encodePatch' };
    lines.push('');
    lines.push('  public init(from decoder: Decoder) throws {');
    lines.push('    let container = try decoder.container(keyedBy: CodingKeys.self)');
    lines.push(...props.map((p) => `    ${ident(p.field)} = try container.${decode[p.mode]}(${p.base}.self, forKey: .${ident(p.field)})`));
    lines.push('  }');
    lines.push('');
    lines.push('  public func encode(to encoder: Encoder) throws {');
    lines.push('    var container = encoder.container(keyedBy: CodingKeys.self)');
    lines.push(...props.map((p) => `    try container.${encode[p.mode]}(${ident(p.field)}, forKey: .${ident(p.field)})`));
    lines.push('  }');
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}

// A GET's query string. Not Codable: the one thing a client does with it is
// put it on a URL, and the Worker reads it back through the zod schema.
function emitQuery(name, schema) {
  const required = new Set(schema.required ?? []);
  const props = Object.entries(schema.properties ?? {}).map(([key, prop]) => {
    const inner = swiftType(prop, name + pascal(key));
    const base = inner.endsWith('?') ? inner.slice(0, -1) : inner;
    return { key, field: fieldName(key), base, required: required.has(key) && !inner.endsWith('?'), description: prop.description };
  });
  const value = (base, expr) => {
    if (base === 'String') return expr;
    if (base === 'Int' || base === 'Double') return `String(${expr})`;
    if (base === 'Bool') return `${expr} ? "true" : "false"`;
    if (base.startsWith('[')) throw new Error(`${name}: a query array must hold strings, numbers or a set, not ${base}`);
    // A set, open or closed: its raw value.
    return `${expr}.rawValue`;
  };
  const lines = [];
  if (schema.description) lines.push(`/// ${schema.description}`);
  lines.push(`public struct ${name}: Hashable, Sendable {`);
  for (const p of props) {
    if (p.description) lines.push(`  /// ${p.description}`);
    lines.push(`  public var ${ident(p.field)}: ${p.base}${p.required ? '' : '?'}`);
  }
  lines.push('');
  const params = props.map((p) => `${ident(p.field)}: ${p.base}${p.required ? '' : '? = nil'}`);
  lines.push(`  public init(${params.join(', ')}) {`);
  lines.push(...props.map((p) => `    self.${ident(p.field)} = ${ident(p.field)}`));
  lines.push('  }');
  lines.push('');
  lines.push("  /// The query, in the contract's order; a nil field is left out.");
  lines.push('  public var queryItems: [URLQueryItem] {');
  lines.push('    var items: [URLQueryItem] = []');
  for (const p of props) {
    const field = ident(p.field);
    if (p.base.startsWith('[')) {
      const item = p.base.slice(1, -1);
      const each = `for element in ${field} { items.append(URLQueryItem(name: "${p.key}", value: ${value(item, 'element')})) }`;
      lines.push(p.required ? `    ${each}` : `    if let ${field} { ${each} }`);
    } else {
      const append = `items.append(URLQueryItem(name: "${p.key}", value: ${value(p.base, field)}))`;
      lines.push(p.required ? `    ${append}` : `    if let ${field} { ${append} }`);
    }
  }
  lines.push('    return items');
  lines.push('  }');
  lines.push('}');
  return lines.join('\n') + '\n';
}

// A union of named objects that each carry one string field telling them
// apart (z.union / z.discriminatedUnion of registered shapes): a Swift enum
// with one case per member, decoded by that field. A value no member claims
// lands in `.other`, so a row this build has never seen is kept, not thrown
// on. Two members may claim the same value (an assigned task and an assigned
// issue both say `assigned`); they are tried in order.
function emitUnion(name, members) {
  const refs = members.map((m) => {
    if (!m.$ref) throw new Error(`${name}: every member of a union must be a registered shape`);
    return m.$ref.replace(/^#\/\$defs\//, '');
  });
  // The discriminator: a string field every member has as a literal, or
  // failing that as a set. A `kind: 'lead'` beats a `status` enum that
  // happens to come first.
  const literalKeys = (def, literal) =>
    Object.entries(def.properties ?? {})
      .filter(([, p]) => p.type === 'string' && (literal ? p.const !== undefined : p.const !== undefined || p.enum))
      .map(([k]) => k);
  const shared = (literal) =>
    literalKeys(defs[refs[0]], literal).find((k) => refs.every((r) => literalKeys(defs[r], literal).includes(k)));
  const key = shared(true) ?? shared(false);
  if (!key) {
    throw new Error(`${name}: union members must share one string discriminator`);
  }
  const valuesOf = (def) => {
    const p = def.properties[key];
    return p.enum ?? [p.const];
  };
  // Case names come from the member's name minus the words it shares with
  // the union's at either end (InboxTalkItem in InboxItem -> talk,
  // DocsPdfAnchor in DocsAnnotationAnchor -> pdf); they must not collide.
  const words = (n) => n.split(/(?<=[a-z0-9])(?=[A-Z])/);
  const own = words(name);
  const caseNameFor = (ref) => {
    let w = words(ref);
    let lead = 0;
    while (lead < own.length && lead < w.length - 1 && w[lead] === own[lead]) lead += 1;
    w = w.slice(lead);
    let trail = 0;
    while (trail < own.length && trail < w.length - 1 && w[w.length - 1 - trail] === own[own.length - 1 - trail]) trail += 1;
    w = w.slice(0, w.length - trail);
    return ident(camel(w.join('')));
  };
  const cases = refs.map((ref) => ({ ref, values: valuesOf(defs[ref]), caseName: caseNameFor(ref) }));
  const seen = new Set();
  for (const c of cases) {
    if (seen.has(c.caseName)) throw new Error(`${name}: two members would both be case ${c.caseName}`);
    seen.add(c.caseName);
  }
  const byValue = new Map();
  for (const c of cases) for (const v of c.values) byValue.set(v, [...(byValue.get(v) ?? []), c]);
  const decodeArms = [...byValue.entries()].map(([value, claimants]) => {
    if (claimants.length === 1) return `    case "${value}": self = .${claimants[0].caseName}(try ${claimants[0].ref}(from: decoder))`;
    // Several members claim this value: the first that decodes wins.
    const tries = claimants.map((c) => `      if let value = try? ${c.ref}(from: decoder) { self = .${c.caseName}(value); return }`);
    return `    case "${value}":\n${tries.join('\n')}\n      self = .other(${key}: ${key})`;
  });
  return [
    `public enum ${name}: Codable, Hashable, Sendable {`,
    ...cases.map((c) => `  case ${c.caseName}(${c.ref})`),
    `  /// A member this build does not know, kept by its \`${key}\`.`,
    `  case other(${key}: String)`,
    '',
    `  public var ${key}: String {`,
    '    switch self {',
    ...cases.map((c) => `    case .${c.caseName}(let value): value.${camel(key)}.rawValue`),
    `    case .other(let ${key}): ${key}`,
    '    }',
    '  }',
    '',
    `  private enum DiscriminatorKeys: String, CodingKey { case ${key} }`,
    '',
    '  public init(from decoder: Decoder) throws {',
    '    let container = try decoder.container(keyedBy: DiscriminatorKeys.self)',
    `    let ${key} = try container.decode(String.self, forKey: .${key})`,
    `    switch ${key} {`,
    ...decodeArms,
    `    default: self = .other(${key}: ${key})`,
    '    }',
    '  }',
    '',
    '  public func encode(to encoder: Encoder) throws {',
    '    switch self {',
    ...cases.map((c) => `    case .${c.caseName}(let value): try value.encode(to: encoder)`),
    `    case .other(let ${key}):`,
    '      var container = encoder.container(keyedBy: DiscriminatorKeys.self)',
    `      try container.encode(${key}, forKey: .${key})`,
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
}

/** One Swift declaration per `$defs` entry, in order, nested shapes after their owner. */
export function generateDeclarations($defs) {
  defs = $defs;
  const decls = [];
  for (const [name, schema] of Object.entries(defs)) {
    pending = [];
    inputMode = schema['x-io'] === 'input';
    if (schema['x-io'] === 'query') {
      const owner = emitQuery(name, schema);
      decls.push(owner, ...pending);
    } else if (schema.type === 'object') {
      const owner = emitStruct(name, schema);
      decls.push(owner, ...pending);
    } else if (schema.type === 'string' && schema.enum) {
      decls.push(emitEnum(name, schema.enum, schema['x-closed'] === true));
    } else if (schema.anyOf || schema.oneOf) {
      decls.push(emitUnion(name, schema.anyOf ?? schema.oneOf));
    } else {
      throw new Error(`${name}: top-level shape must be an object, a string enum or a union of registered shapes`);
    }
  }
  return decls;
}

const header = `// Generated by scripts/gen-swift-contracts.mjs from packages/contracts/schema/wire.json.
// Do not edit. Change the zod schema in packages/contracts/src and run pnpm contracts:gen.

import Foundation

`;

/** The whole file for a wire document. */
export function generateSwift(document) {
  return header + generateDeclarations(document.$defs).join('\n');
}

const root = resolve(import.meta.dirname, '..');
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const input = resolve(root, positional[0] ?? 'packages/contracts/schema/wire.json');
const output = resolve(root, positional[1] ?? 'packages/contracts/swift/Sources/StarlingsContracts/Wire.swift');
const text = import.meta.main ? generateSwift(JSON.parse(readFileSync(input, 'utf8'))) : '';

if (!import.meta.main) {
  // Imported by the test; nothing to write.
} else if (process.argv.includes('--check')) {
  // The gate: what is on disk must be what the schema says now.
  const current = existsSync(output) ? readFileSync(output, 'utf8') : '';
  if (current !== text) {
    console.error(`${output} is stale: run pnpm contracts:gen and commit the result`);
    process.exit(1);
  }
  console.log(`${output} is current`);
} else {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, text);
  console.log(`wrote ${Object.keys(defs).length} shapes to ${output}`);
}
