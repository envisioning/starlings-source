/**
 * The frontmatter grammar every `docs/**\/*.md` carries, with no Node
 * imports so the web build (`web/vite.config.ts`, the /help site) and the
 * scripts read one parser. `docs-frontmatter.mjs` adds the filesystem.
 */
export const DOC_KINDS = ['intent', 'contract', 'reference', 'howto'];

/**
 * The surfaces a person can be on (docs/SURFACES.md), by id. Each has one
 * `docs/help/surfaces/<id>.md` with `surface: <id>` in its frontmatter;
 * `check-docs.mjs` fails when one is missing or doubled. In-app help keys on
 * these ids (docs/DOCUMENTATION.md, decision 6).
 */
export const SURFACE_IDS = [
  'home', 'calendar', 'work', 'team', 'docs', 'settings', 'admin', 'search',
  'meeting', 'room-entry', 'schedule', 'prejoin', 'waiting-room', 'ended',
];
export const DOC_STATUSES = ['active', 'proposed', 'done', 'superseded'];

export const KIND_LABEL = {
  contract: 'Contracts',
  reference: 'Reference',
  howto: 'How-to and runbooks',
  intent: 'Intent',
};

export const STATUS_MEANING = {
  active: 'current; an instruction or a plan in progress',
  proposed: 'a study or proposal; no build started',
  done: 'the plan landed; its decisions hold; not an instruction',
  superseded: 'replaced or stale; read for history only',
};

function parseValue(raw) {
  const text = raw.trim();
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((item) => item.trim());
  }
  if (text.startsWith('"') && text.endsWith('"')) return JSON.parse(text);
  return text;
}

/**
 * The frontmatter of one file: `{ fields, body, errors }`. `fields` is null
 * when the file has no frontmatter block at all.
 */
export function readFrontmatter(text) {
  if (!text.startsWith('---\n')) return { fields: null, body: text, errors: ['no frontmatter'] };
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return { fields: null, body: text, errors: ['frontmatter never closes'] };
  const fields = {};
  const errors = [];
  for (const line of text.slice(4, end).split('\n')) {
    if (line.trim() === '') continue;
    const match = /^([a-z_]+):\s*(.*)$/u.exec(line);
    if (!match) {
      errors.push(`cannot read line: ${line}`);
      continue;
    }
    try {
      fields[match[1]] = parseValue(match[2]);
    } catch {
      errors.push(`cannot read value of ${match[1]}`);
    }
  }
  return { fields, body: text.slice(end + 5), errors };
}

/** Field-level checks that need no filesystem: shape, enums, the date. */
export function validateFields(fields) {
  const errors = [];
  if (!DOC_KINDS.includes(fields.kind)) errors.push(`kind must be one of ${DOC_KINDS.join(', ')}`);
  if (!DOC_STATUSES.includes(fields.status)) errors.push(`status must be one of ${DOC_STATUSES.join(', ')}`);
  if (typeof fields.verified !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(fields.verified)) errors.push('verified must be YYYY-MM-DD');
  if (typeof fields.summary !== 'string' || fields.summary.trim() === '') errors.push('summary is required');
  for (const key of ['capabilities', 'owns']) {
    if (fields[key] !== undefined && !Array.isArray(fields[key])) errors.push(`${key} must be a list`);
  }
  if (fields.surface !== undefined) {
    if (fields.kind !== 'reference') errors.push('surface belongs on a reference page');
    if (!SURFACE_IDS.includes(fields.surface)) errors.push(`surface must be one of ${SURFACE_IDS.join(', ')}`);
  }
  const known = new Set(['kind', 'status', 'verified', 'summary', 'capabilities', 'owns', 'surface']);
  for (const key of Object.keys(fields)) if (!known.has(key)) errors.push(`unknown field ${key}`);
  return errors;
}
