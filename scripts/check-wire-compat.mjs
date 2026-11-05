#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const schemaRelativePath = 'packages/contracts/schema/wire.json';
const schemaPath = resolve(repoRoot, schemaRelativePath);
const breaksPath = resolve(repoRoot, 'packages/contracts/wire-breaks.json');

function expandRefs(schema, defs, stack = []) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  if (typeof schema.$ref === 'string' && schema.$ref.startsWith('#/$defs/')) {
    const name = decodeURIComponent(schema.$ref.slice('#/$defs/'.length).replace(/~1/g, '/').replace(/~0/g, '~'));
    if (!Object.hasOwn(defs, name) || stack.includes(name)) return { ...schema };
    return expandRefs(defs[name], defs, [...stack, name]);
  }

  const expanded = { ...schema };
  if (schema.properties && typeof schema.properties === 'object') {
    expanded.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, value]) => [name, expandRefs(value, defs, stack)]),
    );
  }
  if (schema.items) expanded.items = expandRefs(schema.items, defs, stack);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    expanded.additionalProperties = expandRefs(schema.additionalProperties, defs, stack);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(schema[key])) expanded[key] = schema[key].map((value) => expandRefs(value, defs, stack));
  }
  return expanded;
}

function variants(schema) {
  if (Array.isArray(schema?.anyOf)) return schema.anyOf;
  if (Array.isArray(schema?.oneOf)) return schema.oneOf;
  return null;
}

function isNullSchema(schema) {
  if (schema?.type === 'null' || (Array.isArray(schema?.type) && schema.type.includes('null'))) return true;
  const children = variants(schema);
  return Boolean(children?.length && children.every(isNullSchema));
}

function isNullable(schema) {
  if (isNullSchema(schema)) return true;
  const children = variants(schema);
  if (children?.some(isNullSchema)) return true;
  const type = schema?.type;
  return Array.isArray(type) && type.includes('null');
}

function withoutNull(schema) {
  const keys = ['anyOf', 'oneOf'];
  for (const key of keys) {
    if (!Array.isArray(schema?.[key])) continue;
    const children = schema[key].filter((child) => !isNullSchema(child));
    if (children.length === schema[key].length) continue;
    if (children.length === 1) return children[0];
    return { ...schema, [key]: children };
  }
  if (Array.isArray(schema?.type) && schema.type.includes('null')) {
    const types = schema.type.filter((type) => type !== 'null');
    return { ...schema, type: types.length === 1 ? types[0] : types };
  }
  return schema;
}

function pathName(path) {
  return path.length ? path.join('.') : '$value';
}

function addIssue(issues, type, path, kind, message) {
  const issue = { type, field: pathName(path), kind, message };
  if (!issues.some((existing) => existing.type === issue.type && existing.field === issue.field && existing.kind === issue.kind)) {
    issues.push(issue);
  }
}

function normalizedTypes(schema) {
  if (typeof schema?.type === 'string') return [schema.type];
  if (Array.isArray(schema?.type)) return schema.type;
  return null;
}

function typeAcceptsOldType(oldType, newType) {
  if (oldType === newType) return true;
  return oldType === 'integer' && newType === 'number';
}

function lowerBound(schema) {
  const candidates = [];
  if (typeof schema?.minimum === 'number') candidates.push({ value: schema.minimum, exclusive: false });
  if (typeof schema?.exclusiveMinimum === 'number') candidates.push({ value: schema.exclusiveMinimum, exclusive: true });
  return candidates.reduce((best, current) => !best || current.value > best.value ||
    (current.value === best.value && current.exclusive), null);
}

function upperBound(schema) {
  const candidates = [];
  if (typeof schema?.maximum === 'number') candidates.push({ value: schema.maximum, exclusive: false });
  if (typeof schema?.exclusiveMaximum === 'number') candidates.push({ value: schema.exclusiveMaximum, exclusive: true });
  return candidates.reduce((best, current) => !best || current.value < best.value ||
    (current.value === best.value && current.exclusive), null);
}

function narrowerLower(oldSchema, newSchema) {
  const oldBound = lowerBound(oldSchema);
  const newBound = lowerBound(newSchema);
  return Boolean(newBound && (!oldBound || newBound.value > oldBound.value ||
    (newBound.value === oldBound.value && newBound.exclusive && !oldBound.exclusive)));
}

function narrowerUpper(oldSchema, newSchema) {
  const oldBound = upperBound(oldSchema);
  const newBound = upperBound(newSchema);
  return Boolean(newBound && (!oldBound || newBound.value < oldBound.value ||
    (newBound.value === oldBound.value && newBound.exclusive && !oldBound.exclusive)));
}

function compareSchema(oldSchema, newSchema, type, path, issues, seen = new Set()) {
  if (!oldSchema || !newSchema || typeof oldSchema !== 'object' || typeof newSchema !== 'object') return;
  const pair = JSON.stringify([path, oldSchema, newSchema]);
  if (seen.has(pair)) return;
  seen.add(pair);

  const wasNullable = isNullable(oldSchema);
  const isNowNullable = isNullable(newSchema);
  if (wasNullable && !isNowNullable) {
    addIssue(issues, type, path, 'type-narrowed', 'The field is no longer nullable.');
  }

  let oldShape = oldSchema;
  if (wasNullable && !isNowNullable) oldShape = withoutNull(oldSchema);

  const oldVariants = variants(oldShape);
  const newVariants = variants(newSchema);
  if (oldVariants || newVariants) {
    const previousMembers = oldVariants ?? [oldShape];
    const currentMembers = newVariants ?? [newSchema];
    for (const previousMember of previousMembers) {
      if (isNullSchema(previousMember) && wasNullable && !isNowNullable) continue;
      let compatible = false;
      for (const currentMember of currentMembers) {
        const candidateIssues = [];
        compareSchema(previousMember, currentMember, type, path, candidateIssues, new Set());
        if (candidateIssues.length === 0) {
          compatible = true;
          break;
        }
      }
      if (!compatible) {
        addIssue(issues, type, path, 'type-narrowed', 'A previously accepted schema variant is no longer accepted.');
      }
    }
    return;
  }

  const oldTypes = normalizedTypes(oldShape);
  const newTypes = normalizedTypes(newSchema);
  if (oldTypes && newTypes) {
    for (const oldType of oldTypes) {
      if (!newTypes.some((newType) => typeAcceptsOldType(oldType, newType))) {
        addIssue(issues, type, path, 'type-narrowed', 'The field type no longer accepts all previously valid values.');
        break;
      }
    }
  } else if (!oldTypes && newTypes && !oldShape.enum && !Object.hasOwn(oldShape, 'const')) {
    addIssue(issues, type, path, 'type-narrowed', 'The field now has a narrower type.');
  }

  if (oldTypes?.includes('string') && !oldShape.enum && !Object.hasOwn(oldShape, 'const') &&
      (Array.isArray(newSchema.enum) || Object.hasOwn(newSchema, 'const'))) {
    addIssue(issues, type, path, 'type-narrowed', 'A general string is now restricted to a fixed value set.');
  }

  if (oldShape['x-closed'] === true && Array.isArray(oldShape.enum) && Array.isArray(newSchema.enum)) {
    const lost = oldShape.enum.filter((value) => !newSchema.enum.includes(value));
    if (lost.length) {
      addIssue(issues, type, path, 'closed-enum-member-removed', 'A closed enum no longer includes: ' + lost.join(', ') + '.');
    }
  }

  if (Object.hasOwn(oldShape, 'const') && !Object.hasOwn(newSchema, 'const') &&
      Array.isArray(newSchema.enum) && !newSchema.enum.includes(oldShape.const)) {
    addIssue(issues, type, path, 'type-narrowed', 'The field no longer accepts its previous constant value.');
  } else if (Object.hasOwn(oldShape, 'const') && Object.hasOwn(newSchema, 'const') &&
      oldShape.const !== newSchema.const) {
    addIssue(issues, type, path, 'type-narrowed', 'The field constant value changed.');
  }

  const oldProperties = oldShape.properties ?? {};
  const newProperties = newSchema.properties ?? {};
  for (const property of Object.keys(oldProperties)) {
    if (!Object.hasOwn(newProperties, property)) {
      addIssue(issues, type, [...path, property], 'removed-field', 'The field was removed from the current wire shape.');
    }
  }

  const oldRequired = new Set(oldShape.required ?? []);
  for (const property of newSchema.required ?? []) {
    if (!oldRequired.has(property)) {
      addIssue(issues, type, [...path, property], 'optional-made-required', 'The field is now required where it was previously optional.');
    }
  }

  if (oldShape.additionalProperties !== false && newSchema.additionalProperties === false) {
    addIssue(issues, type, [...path, '$additionalProperties'], 'type-narrowed', 'The object no longer accepts additional properties.');
  }

  for (const property of Object.keys(oldProperties)) {
    if (Object.hasOwn(newProperties, property)) {
      compareSchema(oldProperties[property], newProperties[property], type, [...path, property], issues, seen);
    }
  }

  if (oldShape.items && newSchema.items) {
    compareSchema(oldShape.items, newSchema.items, type, [...path, '[]'], issues, seen);
  }

  for (const [key, minimum, current] of [
    ['minLength', Number(oldShape.minLength ?? 0), Number(newSchema.minLength ?? 0)],
    ['minItems', Number(oldShape.minItems ?? 0), Number(newSchema.minItems ?? 0)],
    ['minProperties', Number(oldShape.minProperties ?? 0), Number(newSchema.minProperties ?? 0)],
  ]) {
    if (current > minimum) addIssue(issues, type, path, 'type-narrowed', 'The field now requires a larger ' + key + '.');
  }
  for (const [key, maximum, current] of [
    ['maxLength', Number(oldShape.maxLength ?? Infinity), Number(newSchema.maxLength ?? Infinity)],
    ['maxItems', Number(oldShape.maxItems ?? Infinity), Number(newSchema.maxItems ?? Infinity)],
    ['maxProperties', Number(oldShape.maxProperties ?? Infinity), Number(newSchema.maxProperties ?? Infinity)],
  ]) {
    if (current < maximum) addIssue(issues, type, path, 'type-narrowed', 'The field now allows a smaller ' + key + '.');
  }
  if (narrowerLower(oldShape, newSchema) || narrowerUpper(oldShape, newSchema)) {
    addIssue(issues, type, path, 'type-narrowed', 'The numeric range is narrower.');
  }
  if (newSchema.pattern && newSchema.pattern !== oldShape.pattern) {
    addIssue(issues, type, path, 'type-narrowed', 'The field now has a narrower or changed pattern constraint.');
  }
  if (newSchema.format && newSchema.format !== oldShape.format) {
    addIssue(issues, type, path, 'type-narrowed', 'The field now has a narrower or changed format constraint.');
  }
}

/** True when `before` in `previous` and `after` in `current` read and write the same JSON. */
function sameWireType(previous, before, current, after) {
  const oldDefinition = previous.$defs[before];
  const newDefinition = current.$defs[after];
  if (oldDefinition['x-io'] !== newDefinition['x-io']) return false;
  const oldSchema = expandRefs(oldDefinition, previous.$defs);
  const newSchema = expandRefs(newDefinition, current.$defs);
  const forward = [];
  const backward = [];
  compareSchema(oldSchema, newSchema, after, [], forward);
  compareSchema(newSchema, oldSchema, before, [], backward);
  return forward.length === 0 && backward.length === 0;
}

export function compareWireDocuments(previous, current) {
  if (!previous?.$defs || !current?.$defs) {
    throw new Error('Both wire documents must contain a $defs object.');
  }
  const issues = [];
  const added = Object.keys(current.$defs).filter((type) => !Object.hasOwn(previous.$defs, type));
  for (const type of Object.keys(previous.$defs).sort()) {
    if (!Object.hasOwn(current.$defs, type)) {
      // A type name is never on the wire: a type renamed with the same
      // shape and direction breaks no client (Meet* to Starlings*).
      if (added.some((candidate) => sameWireType(previous, type, current, candidate))) continue;
      addIssue(issues, type, ['$type'], 'removed-type', 'The wire type was removed.');
      continue;
    }
    const oldDefinition = previous.$defs[type];
    const newDefinition = current.$defs[type];
    if (oldDefinition['x-io'] !== newDefinition['x-io']) {
      addIssue(issues, type, ['$type'], 'changed-io', 'The wire direction changed.');
    }
    compareSchema(
      expandRefs(oldDefinition, previous.$defs),
      expandRefs(newDefinition, current.$defs),
      type,
      [],
      issues,
    );
  }
  return issues;
}

/** True when `shipsIn` names a version at or before `tag` (`v7.2.10`). A waiver with no version never counts as spent. */
export function wireBreakShipped(shipsIn, tag) {
  const parts = (text) => /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(String(text ?? ''))?.slice(1).map(Number) ?? null;
  const wanted = parts(shipsIn);
  const newest = parts(tag);
  if (!wanted || !newest) return false;
  for (let index = 0; index < 3; index += 1) {
    if (wanted[index] !== newest[index]) return wanted[index] < newest[index];
  }
  return true;
}

export function applyWireBreakWaivers(issues, waivers, newestTag = null) {
  if (!Array.isArray(waivers)) {
    return { remaining: issues, problems: ['wire-breaks.json must contain an array.'], applied: [] };
  }
  const problems = [];
  const seen = new Set();
  const used = new Set();
  for (const waiver of waivers) {
    if (!waiver || typeof waiver.type !== 'string' || !waiver.type.trim() ||
        typeof waiver.field !== 'string' || !waiver.field.trim() ||
        typeof waiver.reason !== 'string' || !waiver.reason.trim() ||
        typeof waiver.ships_in !== 'string' || !waiver.ships_in.trim()) {
      problems.push('Every wire break entry needs non-empty type, field, reason, and ships_in strings.');
      continue;
    }
    // The release that carries a break makes its entry spent. It waives nothing more
    // and refuses nobody, so a release never turns every branch red.
    if (wireBreakShipped(waiver.ships_in, newestTag)) continue;
    const key = waiver.type + '\u0000' + waiver.field;
    if (seen.has(key)) {
      problems.push('Duplicate wire break entry for ' + waiver.type + '.' + waiver.field + '.');
      continue;
    }
    seen.add(key);
    if (issues.some((issue) => issue.type === waiver.type && issue.field === waiver.field)) {
      used.add(key);
    } else {
      problems.push('Stale wire break entry for ' + waiver.type + '.' + waiver.field + '.');
    }
  }
  const remaining = issues.filter((issue) => !seen.has(issue.type + '\u0000' + issue.field));
  const applied = waivers.filter((waiver) => waiver && used.has(waiver.type + '\u0000' + waiver.field));
  return { remaining, problems, applied };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

function localReleaseTags() {
  return git(['tag', '--list', 'v*', '--sort=-version:refname']).split(/\r?\n/).filter(Boolean);
}

/**
 * Cloudflare Workers Builds clones `main` shallow and without tags, so the
 * newest release is not in the checkout. Fetch that one tag from origin, one
 * commit deep. A fetch that fails fails the check: this gate must not pass
 * because it could not see the release it compares against.
 */
function fetchNewestReleaseTag() {
  const newest = git(['ls-remote', '--tags', '--refs', '--sort=-version:refname', 'origin', 'v*'])
    .split(/\r?\n/).filter(Boolean)[0]?.split('\t')[1]?.replace('refs/tags/', '');
  if (!newest) return [];
  git(['fetch', '--quiet', '--depth=1', '--no-tags', 'origin', `+refs/tags/${newest}:refs/tags/${newest}`]);
  console.log('Fetched ' + newest + ' from origin (the checkout had no release tags).');
  return [newest];
}

async function main() {
  const tags = localReleaseTags();
  if (!tags.length) tags.push(...fetchNewestReleaseTag());
  if (!tags.length) throw new Error('No v* release tag was found, locally or on origin.');
  const newestTag = tags[0];
  const previousText = git(['show', newestTag + ':' + schemaRelativePath]);
  const previous = JSON.parse(previousText);
  const current = await readJson(schemaPath);
  const waivers = await readJson(breaksPath);
  const result = applyWireBreakWaivers(compareWireDocuments(previous, current), waivers, newestTag);

  if (result.problems.length || result.remaining.length) {
    console.error('Wire compatibility check failed against ' + newestTag + '.');
    for (const problem of result.problems) console.error('  ' + problem);
    for (const issue of result.remaining) {
      console.error('  ' + issue.type + '.' + issue.field + ': ' + issue.message);
    }
    process.exitCode = 1;
    return;
  }

  console.log('Wire compatibility passed against ' + newestTag + ' (' +
    Object.keys(current.$defs).length + ' registered shapes).');
  for (const waiver of result.applied) {
    console.log('  documented break: ' + waiver.type + '.' + waiver.field +
      ' ships in ' + waiver.ships_in + ' (' + waiver.reason + ')');
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
