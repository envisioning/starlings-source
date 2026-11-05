#!/usr/bin/env node
// Kotlin from the wire schema: reads packages/contracts/schema/wire.json and
// writes android/app/src/main/java/work/starlings/contracts/Wire.kt, one
// kotlinx.serialization class per `$defs` entry. The Android counterpart of
// scripts/gen-swift-contracts.mjs: the same schema features, the same names
// where Kotlin style allows, and the same rule that a schema feature this
// script does not know throws at generation, not at decode time on a phone.
//
//   pnpm contracts:kotlin           # write
//   pnpm contracts:kotlin --check   # exit 1 when the file on disk is stale
//   pnpm contracts:test             # the emitter against small shapes (packages/contracts/scripts/gen-kotlin.test.mjs)
//
// JSON Schema      Kotlin
// object           @Serializable data class; @SerialName when the Kotlin name is not the key
//                  (device_id -> deviceId: Kotlin spells an acronym as a word)
// string/enum      @JvmInline value class X(val value: String) — an open enum with a
//                  companion constant per value; unknown values decode, they do not fail.
//                  `x-closed` makes it a real `enum class` with @SerialName per entry.
// string           String
// integer          Long (wire integers reach 2^53)
// number           Double (Long for an integer const)
// boolean          Boolean
// array            List<T>
// $ref             the referenced def's name
// record           Map<String, T>
// anyOf of strings String
// anyOf of $refs   sealed interface the members implement, decoded by their shared string
//                  field; `Other` keeps a stranger as its raw JsonObject
// not required     T? = null
// type: [T, null]  T? = null
// type: null       omitted from the class (WireJson ignores unknown keys)
//
// A request body (`x-io: input`) says three things where a read says two.
// WireJson encodes with `encodeDefaults = false` and `explicitNulls = true`:
// required         T                          always sent
// required, null   @EncodeDefault T? = null   always sent; null goes as null (clears)
// not required     T? = null                  sent when set; null is left out (keeps)
// not required,    Patch<T> = Patch.Omit      Omit leaves the field alone, Null clears
// null                                        it, Value(x) sets it
// const string     @EncodeDefault T = T.X     the caller does not name it; always sent
//
// A query string (`x-io: query`) is a data class that is not @Serializable:
// `queryItems()`, in the contract's order, a null field left out, a number
// as its digits, a Boolean as `true`/`false`, a set as its value, an array
// as one item per element.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readAliases, segments } from './gen-swift-contracts.mjs';

/** The `$defs` being emitted; a union reads its members' shapes from here. */
let defs = {};
/** Member def name -> the unions it belongs to, for its supertypes. */
let unionsOf = new Map();
/** Every top-level name emitted, so a collision fails here and not in kotlinc. */
let declared = new Set();

const word = (seg) => seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase();
const pascal = (s) => segments(s).map(word).join('');
const camel = (s) => {
  const [head, ...rest] = segments(s);
  if (!head) return s;
  return head.toLowerCase() + rest.map(word).join('');
};
/** A constant: an open enum's companion value or a closed enum's entry. */
const constName = (v) => segments(v).map((s) => s.toUpperCase()).join('_');
// The same test the Swift emitter makes, so a set is a type on both clients or on neither.
const swiftCamel = (s) => {
  const [head, ...rest] = segments(s);
  if (!head) return s;
  return head.toLowerCase() + rest.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join('');
};
const isNameSet = (values) => values.every((v) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(swiftCamel(v)));

const KOTLIN_KEYWORDS = new Set(['as', 'break', 'class', 'continue', 'do', 'else', 'false', 'for', 'fun', 'if', 'in', 'interface', 'is', 'null', 'object', 'package', 'return', 'super', 'this', 'throw', 'true', 'try', 'typealias', 'typeof', 'val', 'var', 'when', 'while']);
// The Swift spellings, so both clients name the field alike. A Kotlin
// keyword with no entry here throws: add one rather than a backtick.
const FIELD_RENAMES = { self: 'isSelf', internal: 'isInternal' };
const fieldName = (key) => {
  const name = FIELD_RENAMES[key] ?? camel(key);
  if (KOTLIN_KEYWORDS.has(name)) throw new Error(`${key}: a Kotlin keyword; add it to FIELD_RENAMES`);
  return name;
};
// Names the generated file itself uses unqualified.
const RESERVED = new Set(['String', 'Long', 'Double', 'Boolean', 'List', 'Map', 'Pair', 'Any', 'Nothing', 'Unit', 'Int', 'Patch', 'PatchSerializer', 'WireJson', 'WireUnionSerializer', 'WireOpenEnumSerializer', 'WireClosedEnumSerializer', 'JsonObject', 'JsonElement', 'Json', 'Serializable', 'SerialName', 'EncodeDefault', 'JvmInline']);

function declare(name) {
  if (RESERVED.has(name)) throw new Error(`${name}: the name of a type the generated file uses`);
  if (declared.has(name)) throw new Error(`${name}: declared twice (a nested shape's name collides with another)`);
  declared.add(name);
}

/** A Kotlin string literal. */
const str = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/\n/g, '\\n')}"`;
/** A KDoc line; a description must not close the comment. */
const doc = (indent, text) => `${indent}/** ${text.replace(/\*\//g, '*&#47;').replace(/\s*\n\s*/g, ' ')} */`;

/** Nested declarations emitted while walking a property; flushed after the owner. */
let pending = [];

function kotlinType(schema, hint) {
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
    const inner = kotlinType(rest[0], hint);
    return inner + (nullable && !inner.endsWith('?') ? '?' : '');
  }
  types = types.filter((t) => t !== 'null');
  if (types.length !== 1) throw new Error(`${hint}: expected one type, got ${JSON.stringify(schema.type)}`);
  const [type] = types;
  let out;
  switch (type) {
    case 'string':
      if (schema.enum || schema.const !== undefined) {
        const values = schema.enum ?? [schema.const];
        // A literal is a one-value set. A set whose members are not names (an
        // emoji palette) stays a String.
        if (isNameSet(values)) {
          pending.push(emitEnum(hint, values));
          out = hint;
        } else out = 'String';
      } else out = 'String';
      break;
    case 'integer': out = 'Long'; break;
    case 'number': out = Number.isInteger(schema.const) ? 'Long' : 'Double'; break;
    case 'boolean': out = 'Boolean'; break;
    case 'array': out = `List<${kotlinType(schema.items, hint + 'Item')}>`; break;
    case 'object':
      if (!schema.properties && schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        // z.record: keys are strings, values one shape.
        out = `Map<String, ${kotlinType(schema.additionalProperties, hint + 'Value')}>`;
        break;
      }
      pending.push(emitStruct(hint, schema));
      out = hint;
      break;
    default: throw new Error(`${hint}: unsupported type ${type}`);
  }
  return out + (nullable ? '?' : '');
}

function uniqueConstants(name, values) {
  const seen = new Map();
  for (const v of values) {
    const c = constName(v);
    if (seen.has(c)) throw new Error(`${name}: ${JSON.stringify(seen.get(c))} and ${JSON.stringify(v)} are both ${c}`);
    seen.set(c, v);
  }
}

function emitEnum(name, listed, closed = false) {
  declare(name);
  const aliases = readAliases(name, listed);
  const dropped = new Set(aliases.map(([alias]) => alias));
  const values = listed.filter((v) => !dropped.has(v));
  uniqueConstants(name, values);
  const aliasMap = `mapOf(${aliases.map(([a, v]) => `${str(a)} to ${str(v)}`).join(', ')})`;
  if (closed) {
    // A set the client chooses from: a real enum, so a `when` over it is
    // exhaustive and a new member is a compile error everywhere it matters.
    const lines = [];
    if (aliases.length === 0) lines.push('@Serializable');
    else lines.push(`@Serializable(with = ${name}.Serializer::class)`);
    lines.push(`enum class ${name}(val value: String) {`);
    lines.push(values.map((v) => `  @SerialName(${str(v)}) ${constName(v)}(${str(v)})`).join(',\n') + ';');
    lines.push('', '  override fun toString(): String = value');
    if (aliases.length > 0) {
      lines.push('');
      lines.push('  /** Reads an old name as the value that replaced it (ADR 0006). */');
      lines.push(`  object Serializer : WireClosedEnumSerializer<${name}>(${str(`work.starlings.contracts.${name}`)}, ${name}.entries, ${aliasMap}, { it.value })`);
    }
    lines.push('}', '');
    return lines.join('\n');
  }
  // Otherwise an open enum: a value this build has never heard of decodes
  // as itself instead of failing the whole response. The Worker ships from
  // main continuously and a native build is always older than it. A `when`
  // over one needs an `else`; that is the honest shape of a wire value.
  const lines = [];
  if (aliases.length === 0) lines.push('@Serializable');
  else lines.push(`@Serializable(with = ${name}.Serializer::class)`);
  lines.push('@JvmInline');
  lines.push(`value class ${name}(val value: String) {`);
  lines.push('  override fun toString(): String = value', '');
  lines.push('  companion object {');
  lines.push(...values.map((v) => `    val ${constName(v)} = ${name}(${str(v)})`));
  lines.push('');
  lines.push("    /** Every value the contract names, in its order. */");
  lines.push(`    val known: List<${name}> = listOf(${values.map(constName).join(', ')})`);
  if (aliases.length > 0) {
    lines.push('');
    lines.push('    /** An old name, read as the value that replaced it (ADR 0006). */');
    lines.push(`    val readAliases: Map<String, String> = ${aliasMap}`);
    lines.push('');
    lines.push(`    fun of(raw: String): ${name} = ${name}(readAliases[raw] ?: raw)`);
  }
  lines.push('  }');
  if (aliases.length > 0) {
    lines.push('');
    lines.push(`  object Serializer : WireOpenEnumSerializer<${name}>(${str(`work.starlings.contracts.${name}`)}, { ${name}.of(it) }, { it.value })`);
  }
  lines.push('}', '');
  return lines.join('\n');
}

/** True while walking a request body: nested classes inherit it. */
let inputMode = false;

function emitStruct(name, schema) {
  declare(name);
  const required = new Set(schema.required ?? []);
  const props = Object.entries(schema.properties ?? {}).flatMap(([key, prop]) => {
    // A field that is always null carries nothing; the class leaves it out.
    if (prop.type === 'null') return [];
    const inner = kotlinType(prop, name + pascal(key));
    const nullable = inner.endsWith('?');
    const base = nullable ? inner.slice(0, -1) : inner;
    // Which of the four ways a request field travels (see the header).
    let mode;
    if (required.has(key)) mode = nullable ? 'null' : 'always';
    else mode = nullable && inputMode ? 'patch' : 'present';
    const type = mode === 'patch' ? `Patch<${base}>` : mode === 'always' ? base : `${base}?`;
    // A literal names itself: `kind = UpdateKind.TASK` is not the caller's to choose.
    const literal = prop.type === 'string' && prop.const !== undefined && base === name + pascal(key)
      ? `${base}.${constName(prop.const)}`
      : null;
    const fallback = literal ?? (mode === 'patch' ? 'Patch.Omit' : type.endsWith('?') ? 'null' : null);
    // A default the encoder drops unless told: the literal, and a null a write must send.
    const encodeDefault = literal !== null || (inputMode && mode === 'null');
    return [{ key, field: fieldName(key), type, base, fallback, encodeDefault, description: prop.description }];
  });
  const fields = new Map();
  for (const p of props) {
    if (fields.has(p.field)) throw new Error(`${name}: ${fields.get(p.field)} and ${p.key} are both ${p.field}`);
    fields.set(p.field, p.key);
  }
  const lines = [];
  if (schema.description) lines.push(doc('', schema.description));
  lines.push('@Serializable');
  const supertypes = unionsOf.get(name) ?? [];
  const head = `data class ${name}(`;
  const tail = supertypes.length ? `) : ${supertypes.join(', ')}` : ')';
  if (props.length === 0) {
    // A data class needs a property; an empty object is a plain class.
    lines.push(`class ${name}${supertypes.length ? ` : ${supertypes.join(', ')}` : ''} {`);
    lines.push('  override fun equals(other: Any?): Boolean = other is ' + name);
    lines.push(`  override fun hashCode(): Int = ${str(name)}.hashCode()`);
    lines.push(`  override fun toString(): String = ${str(name + '()')}`);
    lines.push('}');
    return lines.join('\n') + '\n';
  }
  lines.push(head);
  for (const p of props) {
    if (p.description) lines.push(doc('  ', p.description));
    const annotations = [p.encodeDefault ? '@EncodeDefault ' : '', p.field !== p.key ? `@SerialName(${str(p.key)}) ` : ''].join('');
    lines.push(`  ${annotations}val ${p.field}: ${p.type}${p.fallback ? ` = ${p.fallback}` : ''},`);
  }
  lines.push(tail);
  return lines.join('\n') + '\n';
}

// A GET's query string. Not @Serializable: the one thing a client does with
// it is put it on a URL, and the Worker reads it back through the zod schema.
function emitQuery(name, schema) {
  declare(name);
  const required = new Set(schema.required ?? []);
  const props = Object.entries(schema.properties ?? {}).map(([key, prop]) => {
    const inner = kotlinType(prop, name + pascal(key));
    const base = inner.endsWith('?') ? inner.slice(0, -1) : inner;
    return { key, field: fieldName(key), base, required: required.has(key) && !inner.endsWith('?'), description: prop.description };
  });
  const value = (base, expr) => {
    if (base === 'String') return expr;
    if (base === 'Long' || base === 'Double' || base === 'Boolean') return `${expr}.toString()`;
    if (base.startsWith('List<')) throw new Error(`${name}: a query array must hold strings, numbers or a set, not ${base}`);
    // A set, open or closed: its value.
    return `${expr}.value`;
  };
  const lines = [];
  if (schema.description) lines.push(doc('', schema.description));
  lines.push(`data class ${name}(`);
  for (const p of props) {
    if (p.description) lines.push(doc('  ', p.description));
    lines.push(`  val ${p.field}: ${p.base}${p.required ? '' : '? = null'},`);
  }
  lines.push(') {');
  lines.push("  /** The query, in the contract's order; a null field is left out. */");
  lines.push('  fun queryItems(): List<Pair<String, String>> {');
  lines.push('    val items = mutableListOf<Pair<String, String>>()');
  for (const p of props) {
    if (p.base.startsWith('List<')) {
      const item = p.base.slice(5, -1);
      if (item.endsWith('?')) throw new Error(`${name}.${p.key}: a query array of nullable items`);
      const each = `for (element in ${p.field}) items.add(${str(p.key)} to ${value(item, 'element')})`;
      lines.push(p.required ? `    ${each}` : `    ${p.field}?.let { for (element in it) items.add(${str(p.key)} to ${value(item, 'element')}) }`);
    } else {
      lines.push(p.required
        ? `    items.add(${str(p.key)} to ${value(p.base, p.field)})`
        : `    ${p.field}?.let { items.add(${str(p.key)} to ${value(p.base, 'it')}) }`);
    }
  }
  lines.push('    return items');
  lines.push('  }');
  lines.push('}');
  return lines.join('\n') + '\n';
}

const memberRefs = (name, members) =>
  members.map((m) => {
    if (!m.$ref) throw new Error(`${name}: every member of a union must be a registered shape`);
    return m.$ref.replace(/^#\/\$defs\//, '');
  });

// A union of named objects that each carry one string field telling them
// apart: a sealed interface the members implement, decoded by that field.
// A value no member claims lands in `Other`, which keeps the raw object, so
// a row this build has never seen is kept, not thrown on. Two members may
// claim the same value; they are tried in order.
function emitUnion(name, members) {
  declare(name);
  const refs = memberRefs(name, members);
  // The discriminator: a string field every member has as a literal, or
  // failing that as a set (the Swift emitter's rule).
  const literalKeys = (def, literal) =>
    Object.entries(def.properties ?? {})
      .filter(([, p]) => p.type === 'string' && (literal ? p.const !== undefined : p.const !== undefined || p.enum))
      .map(([k]) => k);
  const shared = (literal) =>
    literalKeys(defs[refs[0]], literal).find((k) => refs.every((r) => literalKeys(defs[r], literal).includes(k)));
  const key = shared(true) ?? shared(false);
  if (!key) throw new Error(`${name}: union members must share one string discriminator`);
  for (const r of refs) {
    if (!(defs[r].required ?? []).includes(key)) throw new Error(`${name}: ${r}.${key} must be required to tell members apart`);
  }
  const field = fieldName(key);
  const valuesOf = (def) => {
    const p = def.properties[key];
    return p.enum ?? [p.const];
  };
  // How a member's field reads as a String: a set is a type unless its values are not names.
  const read = (def) => (isNameSet(valuesOf(def)) ? `${field}.value` : field);
  const byValue = new Map();
  for (const ref of refs) for (const v of valuesOf(defs[ref])) byValue.set(v, [...(byValue.get(v) ?? []), ref]);
  const decodeArms = [...byValue.entries()].map(([value, claimants]) => {
    if (claimants.length === 1) return `      ${str(value)} -> json.decodeFromJsonElement(${claimants[0]}.serializer(), element)`;
    // Several members claim this value: the first that decodes wins.
    return `      ${str(value)} -> firstOf(json, element, ${claimants.map((c) => `${c}.serializer()`).join(', ')}) ?: ${name}.Other(element)`;
  });
  const serializer = `${name}Serializer`;
  declare(serializer);
  return [
    `@Serializable(with = ${serializer}::class)`,
    `sealed interface ${name} {`,
    `  /** A member this build does not know, kept whole; its \`${key}\` is in [raw]. */`,
    `  data class Other(val raw: JsonObject) : ${name}`,
    '}',
    '',
    `/** The \`${key}\` that tells the members of [${name}] apart. */`,
    `val ${name}.${field}: String`,
    '  get() = when (this) {',
    ...refs.map((r) => `    is ${r} -> ${read(defs[r])}`),
    `    is ${name}.Other -> raw.getValue(${str(key)}).jsonPrimitive.content`,
    '  }',
    '',
    `object ${serializer} : WireUnionSerializer<${name}>(${str(`work.starlings.contracts.${name}`)}, ${str(key)}) {`,
    `  override fun decode(json: Json, discriminator: String, element: JsonObject): ${name} =`,
    '    when (discriminator) {',
    ...decodeArms,
    `      else -> ${name}.Other(element)`,
    '    }',
    '',
    `  override fun encode(json: Json, value: ${name}): JsonElement =`,
    '    when (value) {',
    ...refs.map((r) => `      is ${r} -> json.encodeToJsonElement(${r}.serializer(), value)`),
    `      is ${name}.Other -> value.raw`,
    '    }',
    '}',
    '',
  ].join('\n');
}

/** One Kotlin declaration per `$defs` entry, in order, nested shapes after their owner. */
export function generateDeclarations($defs) {
  defs = $defs;
  declared = new Set();
  unionsOf = new Map();
  for (const [name, schema] of Object.entries(defs)) {
    if (!(schema.anyOf || schema.oneOf) || schema.type) continue;
    for (const ref of memberRefs(name, schema.anyOf ?? schema.oneOf)) {
      if (!defs[ref] || defs[ref].type !== 'object' || defs[ref]['x-io'] === 'query') throw new Error(`${name}: member ${ref} is not a registered object`);
      unionsOf.set(ref, [...(unionsOf.get(ref) ?? []), name]);
    }
  }
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

const header = `// Generated by scripts/gen-kotlin-contracts.mjs from packages/contracts/schema/wire.json.
// Do not edit. Change the zod schema in packages/contracts/src and run pnpm contracts:gen.
@file:OptIn(ExperimentalSerializationApi::class)

package work.starlings.contracts

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.descriptors.nullable
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive

/**
 * The Json every type in this file expects. Decode and encode with it.
 *
 * - \`ignoreUnknownKeys\`: the Worker adds fields before a build knows them.
 * - \`encodeDefaults = false\`: a request field at its default is left out,
 *   so \`null\` on a not-required field and [Patch.Omit] keep what the Worker has.
 * - \`explicitNulls = true\`: a field the generator marks \`@EncodeDefault\`
 *   (a required nullable, a literal) is always sent, \`null\` included.
 */
val WireJson: Json = Json {
  ignoreUnknownKeys = true
  encodeDefaults = false
  explicitNulls = true
}

/**
 * A request field with three states, where a nullable has two:
 * \`.nullable().optional()\` on a zod input schema. [Omit] leaves the key out
 * (the Worker keeps what it has), [Null] sends \`null\` (clears it), [Value]
 * sets it. Needs [WireJson]: \`encodeDefaults = false\` is what leaves [Omit] out.
 */
@Serializable(with = PatchSerializer::class)
sealed class Patch<out T> {
  data object Omit : Patch<Nothing>()
  data object Null : Patch<Nothing>()
  data class Value<out T>(val value: T) : Patch<T>()

  /** The value when one is set; null for both [Omit] and [Null]. */
  val valueOrNull: T? get() = (this as? Value<T>)?.value

  companion object {
    /** Send what is there, or clear it: the whole-editor write. */
    fun <T> of(value: T?): Patch<T> = if (value == null) Null else Value(value)

    /** Send what is there, or say nothing: the partial write. */
    fun <T> ifSome(value: T?): Patch<T> = if (value == null) Omit else Value(value)
  }
}

class PatchSerializer<T>(private val valueSerializer: KSerializer<T>) : KSerializer<Patch<T>> {
  override val descriptor: SerialDescriptor = valueSerializer.descriptor.nullable

  override fun serialize(encoder: Encoder, value: Patch<T>) {
    when (value) {
      Patch.Omit -> throw SerializationException("Patch.Omit is left out only with encodeDefaults = false: encode with WireJson")
      Patch.Null -> encoder.encodeNull()
      is Patch.Value -> encoder.encodeSerializableValue(valueSerializer, value.value)
    }
  }

  override fun deserialize(decoder: Decoder): Patch<T> =
    if (decoder.decodeNotNullMark()) Patch.Value(decoder.decodeSerializableValue(valueSerializer))
    else { decoder.decodeNull(); Patch.Null }
}

/** An open enum with read aliases: an old name decodes as the value that replaced it. */
open class WireOpenEnumSerializer<T>(
  serialName: String,
  private val wrap: (String) -> T,
  private val unwrap: (T) -> String,
) : KSerializer<T> {
  override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor(serialName, PrimitiveKind.STRING)
  override fun serialize(encoder: Encoder, value: T) = encoder.encodeString(unwrap(value))
  override fun deserialize(decoder: Decoder): T = wrap(decoder.decodeString())
}

/** A closed enum with read aliases. A value it does not name fails, as a closed set should. */
open class WireClosedEnumSerializer<T : Enum<T>>(
  serialName: String,
  private val values: List<T>,
  private val aliases: Map<String, String>,
  private val unwrap: (T) -> String,
) : KSerializer<T> {
  override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor(serialName, PrimitiveKind.STRING)
  override fun serialize(encoder: Encoder, value: T) = encoder.encodeString(unwrap(value))
  override fun deserialize(decoder: Decoder): T {
    val raw = decoder.decodeString()
    val wanted = aliases[raw] ?: raw
    return values.firstOrNull { unwrap(it) == wanted }
      ?: throw SerializationException("\${descriptor.serialName} has no value \\"\$raw\\"")
  }
}

/**
 * A union of registered shapes, told apart by one string field. JSON only:
 * the member is chosen from the decoded object, and a stranger is kept whole.
 */
abstract class WireUnionSerializer<T : Any>(serialName: String, private val key: String) : KSerializer<T> {
  override val descriptor: SerialDescriptor = buildClassSerialDescriptor(serialName)

  protected abstract fun decode(json: Json, discriminator: String, element: JsonObject): T
  protected abstract fun encode(json: Json, value: T): JsonElement

  /** The first member that decodes, for a value several members claim. */
  protected fun firstOf(json: Json, element: JsonObject, vararg members: KSerializer<out T>): T? {
    for (member in members) {
      try { return json.decodeFromJsonElement(member, element) } catch (_: SerializationException) {} catch (_: IllegalArgumentException) {}
    }
    return null
  }

  override fun deserialize(decoder: Decoder): T {
    val input = decoder as? JsonDecoder ?: throw SerializationException("\${descriptor.serialName} decodes from JSON only")
    val element = input.decodeJsonElement() as? JsonObject
      ?: throw SerializationException("\${descriptor.serialName} is not an object")
    val discriminator = (element[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
      ?: throw SerializationException("\${descriptor.serialName} has no string \\"\$key\\"")
    return decode(input.json, discriminator, element)
  }

  override fun serialize(encoder: Encoder, value: T) {
    val output = encoder as? JsonEncoder ?: throw SerializationException("\${descriptor.serialName} encodes to JSON only")
    output.encodeJsonElement(encode(output.json, value))
  }
}

`;

/** The whole file for a wire document. */
export function generateKotlin(document) {
  return header + generateDeclarations(document.$defs).join('\n');
}

const root = resolve(import.meta.dirname, '..');
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const input = resolve(root, positional[0] ?? 'packages/contracts/schema/wire.json');
const output = resolve(root, positional[1] ?? 'android/app/src/main/java/work/starlings/contracts/Wire.kt');
const text = import.meta.main ? generateKotlin(JSON.parse(readFileSync(input, 'utf8'))) : '';

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
