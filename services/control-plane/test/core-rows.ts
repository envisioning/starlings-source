// Whole rows as Core and Docs send them, for tests that stub either. The
// Worker parses every upstream answer with the wire schemas (meet#335), so a
// stub row must carry each field the schema requires. A test names only the
// fields it cares about.
//
// The Core rows are Core's own: they are taken from `fixtures/core/`, the
// bodies Core's route tests record (meet#606), not typed here, so a default
// can only be a value Core sends. The Docs rows are written out below.
import interactions from '../../../fixtures/core/meet-crm-interactions.get.json';
import issueDetail from '../../../fixtures/core/meet-github-issues-detail.get.json';
import projectDetail from '../../../fixtures/core/meet-crm-subjects-project-id.get.json';
import tasks from '../../../fixtures/core/meet-crm-tasks.get.json';

/** The defaults, with each field the test names in its own type. */
function row<Defaults extends object, Fields extends object>(defaults: Defaults, fields: Fields): Omit<Defaults, keyof Fields> & Fields {
  return { ...defaults, ...fields };
}

/** A `meet-crm-tasks` row (`crmTaskSchema`): the one Core sends with every optional column empty. */
const TASK = tasks.tasks[1]!;

export function coreTask<Fields extends object>(fields: Fields = {} as Fields) {
  return row(TASK, fields);
}

/** A `meet-crm-interactions` row (`crmInteractionSchema`). */
const INTERACTION = interactions.interactions[0]!;

export function coreInteraction<Fields extends object>(fields: Fields = {} as Fields) {
  return row(INTERACTION, fields);
}

/** A `meet-crm-subjects` row as the id lookup answers it (`crmSubjectDetailSchema`): a project. */
const SUBJECT_DETAIL = projectDetail.subject;

export function coreSubjectDetail<Fields extends object>(fields: Fields = {} as Fields) {
  return row(SUBJECT_DETAIL, fields);
}

/** A Docs document row (`docsDocumentSummarySchema`). */
const DOCUMENT = {
  id: 'doc-1',
  path: '/work/note',
  slug: 'note',
  title: 'Note',
  kind: 'markdown',
  folder_id: null,
  visibility: 'internal',
  status: 'active',
  source_system: 'native',
  source_kind: null,
  source_url: null,
  editable: true,
  version: 1,
  byte_size: 0,
  content_hash: '0'.repeat(64),
  tags: [],
  category: null,
  transcript: false,
  subjects: [],
  created_at: '2026-09-22T09:00:00.000Z',
  updated_at: '2026-09-22T09:00:00.000Z',
  updated_by: null,
};

export function docsDocument<Fields extends object>(fields: Fields = {} as Fields) {
  return row(DOCUMENT, fields);
}

/** A Docs document with its body (`docsDocumentDetailSchema`). */
const DOCUMENT_DETAIL = { ...DOCUMENT, body_md: '', links: [], backlinks: [], open_annotations: 0 };

export function docsDocumentDetail<Fields extends object>(fields: Fields = {} as Fields) {
  return row(DOCUMENT_DETAIL, fields);
}

/** A `meet-github-issues` detail row (`crmIssueDetailSchema`). */
const ISSUE_DETAIL = issueDetail.issue;

export function coreIssueDetail<Fields extends object>(fields: Fields = {} as Fields) {
  return row(ISSUE_DETAIL, fields);
}
