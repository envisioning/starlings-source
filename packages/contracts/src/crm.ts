// Core's shapes as Meet serves them. Core (CRM + CMS) owns these rows; Meet
// is the practical front end, so the wire it answers with is written here
// once and generated into Swift. Grows as the CRM routes move over.
import { z } from 'zod';
import { SUBJECT_KIND_ALIASES } from './subject-kinds';

/**
 * ADR 0006 renamed the `partner` subject kind to `organization`. Apps built
 * before the rename still send `partner`; every kind a request carries reads
 * it as `organization`. The JSON schema, and so the Swift contract, names
 * only the current kinds.
 */
export function readKindAlias(value: unknown): unknown {
  return typeof value === 'string' && Object.hasOwn(SUBJECT_KIND_ALIASES, value) ? SUBJECT_KIND_ALIASES[value] : value;
}

export function acceptingKindAliases<T extends z.ZodType>(schema: T) {
  return z.preprocess(readKindAlias, schema);
}

export const crmWorkItemKindSchema = z.enum(['task', 'milestone']);
export type CrmWorkItemKind = z.infer<typeof crmWorkItemKindSchema>;

/** A task or milestone with a date, as the calendar draws it beside events. */
export const crmWorkItemSchema = z.object({
  id: z.string(),
  kind: crmWorkItemKindSchema,
  assignee_id: z.string().nullable(),
  assignee_name: z.string().nullable(),
  assignee_email: z.string().nullable(),
  /** Set by the Worker, which knows the owner; Core has no idea who is asking. */
  mine: z.boolean().optional(),
  title: z.string(),
  notes: z.string().nullable(),
  status: z.string(),
  due_at: z.string().nullable(),
  priority: z.string().nullable(),
  responsible_party: z.string(),
  project_id: z.string().nullable(),
  project_title: z.string().nullable(),
  lead_id: z.string().nullable(),
  /** A task on an event (docs/EVENTS.md); absent from a Core that predates it. */
  event_id: z.string().nullable().optional(),
  event_title: z.string().nullable().optional(),
  /** A task on a partner (PARTNERS (HQ Docs)); absent until Core's `meet-work-items` carries it. */
  organization_id: z.string().nullable().optional(),
  organization_title: z.string().nullable().optional(),
  milestone_id: z.string().nullable(),
  updated_at: z.string().nullable(),
});
export type CrmWorkItem = z.infer<typeof crmWorkItemSchema>;

/** `GET /api/calendar/work-items`. Core unreachable answers empty and says so. */
export const calendarWorkItemsResponseSchema = z.object({
  items: z.array(crmWorkItemSchema),
  degraded: z.boolean().optional(),
});
export type CalendarWorkItemsResponse = z.infer<typeof calendarWorkItemsResponseSchema>;

// ---------------------------------------------------------------------------
// Subjects: leads, projects, partners, events.
// ---------------------------------------------------------------------------

/**
 * `partner` is an organization with `is_partner = true`, the organization
 * uuid as the id — read-only through Meet, edited as an organization in
 * Core (PARTNERS (HQ Docs)). `event` is a CMS `events` row, the CMS
 * uuid as the id — read-only through Meet, edited under Website in Core
 * (docs/EVENTS.md). Clients that predate either must treat an
 * unknown kind as not openable rather than as a project.
 */
export const crmSubjectKindSchema = acceptingKindAliases(z.enum(['lead', 'project', 'organization', 'event']));
export type CrmSubjectKind = z.infer<typeof crmSubjectKindSchema>;

/** GET /api/crm/subjects?kind=lead|project&q= */
export const crmSubjectSchema = z.object({
  /** Open tasks on this subject, so a list says where things stand. */
  open_tasks: z.number().int().optional(),
  /** How many of those are past their date. */
  overdue_tasks: z.number().int().optional(),
  /** Whether a repository is linked. Projects only. */
  has_repo: z.boolean().optional(),
  /**
   * The one agent that works on this project, by the address the roster knows
   * it by — `null` when it has none, and absent on a lead. Core owns this edge
   * (`projects.agent_email`, unique and nullable).
   */
  agent_email: z.string().nullable().optional(),
  /**
   * Who answers for this project or lead, chosen by a person (,
   * docs/OWNERSHIP.md). Null: nobody chose; clients show `responsibleOf`'s
   * suggestion. Absent on an event, a partner, and from an older Core. A name,
   * never a permission.
   */
  responsible_email: z.string().nullable().optional(),
  /** Who chose the responsible person, and when (ISO). */
  responsible_set_by: z.string().nullable().optional(),
  responsible_set_at: z.string().nullable().optional(),
  /** The related organization's logo, when Core's enrichment pipeline has one — a curated logo URL, not a favicon. */
  organization_logo_url: z.string().nullable().optional(),
  /**
   * The organization this subject hangs off ( decision 1).
   * Existing Core rows may still have no organization; new lead and project
   * requests require one. Absent on a row from a Core that predates the edge.
   */
  organization_id: z.string().nullable().optional(),
  organization_name: z.string().nullable().optional(),
  /** Projects only: the workspace's own work, as Core's `projects.is_internal`. */
  internal: z.boolean().optional(),
  id: z.string(),
  kind: crmSubjectKindSchema,
  title: z.string(),
  subtitle: z.string().nullable(),
  /** Partners only: how much work hangs off the relationship. */
  related_projects: z.number().int().optional(),
  related_leads: z.number().int().optional(),
  /** Events only: the one date, `YYYY-MM-DD`, or null on an undated draft. */
  event_date: z.string().nullable().optional(),
  /** Events only: whether the website lists it. Plays no part in Work. */
  published: z.boolean().optional(),
  /** A project's or lead's status, Core's word. Absent on a partner, an event, or an older Worker. */
  status: z.string().nullable().optional(),
  /** When something last moved on this subject, ISO ( slice 3c). Null when nothing is known. */
  last_activity_at: z.string().nullable().optional(),
  /**
   * The id the request named, when that record was merged into this one
   *. A client replaces the id it holds with `id`. Absent when the
   * request named this record.
   */
  merged_from: z.string().optional(),
});
export type CrmSubject = z.infer<typeof crmSubjectSchema>;

/** A project or lead that hangs off a partner or an event, enough to open it. */
export const crmRelatedRowSchema = z.object({ id: z.string(), title: z.string().nullable(), status: z.string().nullable() });
export type CrmRelatedRow = z.infer<typeof crmRelatedRowSchema>;
export const crmRelatedContactSchema = z.object({ id: z.string(), name: z.string().nullable(), email: z.string().nullable(), title: z.string().nullable() });
export type CrmRelatedContact = z.infer<typeof crmRelatedContactSchema>;

export const crmSubjectRelatedSchema = z.object({
  projects: z.array(crmRelatedRowSchema),
  leads: z.array(crmRelatedRowSchema),
  contacts: z.array(crmRelatedContactSchema),
});
export type CrmSubjectRelated = z.infer<typeof crmSubjectRelatedSchema>;

/**
 * The columns Core keeps on an organization beyond its name, read on the
 * organization's detail. D1 keeps each one since migration 0130,
 * so the `subjects` copy loses none. Absent from a store that does not send
 * them. `url` (Core's `website`), `industry` and `notes` are on the detail.
 */
export const crmOrganizationProfileShape = {
  legal_name: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  postcode: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  vat_id: z.string().nullable().optional(),
  tax_id: z.string().nullable().optional(),
  size: z.string().nullable().optional(),
  /** The member who owns the relationship, by person id. */
  owner_id: z.string().nullable().optional(),
  founded: z.string().nullable().optional(),
  hq_location: z.string().nullable().optional(),
  company_type: z.string().nullable().optional(),
  linkedin_url: z.string().nullable().optional(),
  /** Core's own logo column. `organization_logo_url` is the one a client shows. */
  logo_url: z.string().nullable().optional(),
  logo_image_url: z.string().nullable().optional(),
  profile_image_url: z.string().nullable().optional(),
  /** The billing entity Core's offers name. */
  entity: z.string().nullable().optional(),
  domain: z.string().nullable().optional(),
  is_agency: z.boolean().optional(),
  is_existing_client: z.boolean().optional(),
  is_partner: z.boolean().optional(),
};

/**
 * What an organization is to the workspace, read from its records (ADR 0006
 * decision 2), never stored as a kind: a client has an open project, an
 * active license or Core's existing-client mark; a partner has a
 * partnership; a prospect has an open lead. One firm can be all three.
 */
export const ORGANIZATION_RELATIONSHIPS = ['client', 'partner', 'prospect'] as const;
export type OrganizationRelationship = (typeof ORGANIZATION_RELATIONSHIPS)[number];

export const crmSubjectDetailSchema = crmSubjectSchema.extend({
  status: z.string(),
  updated_at: z.string().nullable(),
  description: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  contact_id: z.string().nullable().optional(),
  lead_id: z.string().nullable().optional(),
  license_id: z.string().nullable().optional(),
  contact_ids: z.array(z.string()).optional(),
  evid: z.string().nullable().optional(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  characteristics: z.record(z.string(), z.boolean()).nullable().optional(),
  specs: z.string().nullable().optional(),
  technical: z.string().nullable().optional(),
  research: z.string().nullable().optional(),
  design: z.string().nullable().optional(),
  contract: z.string().nullable().optional(),
  analytics: z.string().nullable().optional(),
  authentication: z.string().nullable().optional(),
  /** Partners only. */
  industry: z.string().nullable().optional(),
  /** Organizations only. */
  ...crmOrganizationProfileShape,
  /** Events only (docs/EVENTS.md). Where and when, from the CMS row. */
  start_at: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  place: z.string().nullable().optional(),
  image_url: z.string().nullable().optional(),
  /** Free text in the CMS, not an organization. Display only. */
  host: z.string().nullable().optional(),
  partner: z.string().nullable().optional(),
  partner_url: z.string().nullable().optional(),
  related: crmSubjectRelatedSchema.optional(),
  /** Organizations only: in this order, the ones that hold. Absent from an older Worker. */
  relationships: z.array(z.enum(ORGANIZATION_RELATIONSHIPS)).optional(),
});
export type CrmSubjectDetail = z.infer<typeof crmSubjectDetailSchema>;

export const crmSubjectDetailResponseSchema = z.object({
  subject: crmSubjectDetailSchema,
});
export type CrmSubjectDetailResponse = z.infer<typeof crmSubjectDetailResponseSchema>;
export type CrmSubjectMutationResponse = CrmSubjectDetailResponse;

/**
 * The values an organization list can be filtered by: every
 * industry and every country the workspace's organizations carry, sorted.
 * Not narrowed by the filters, so a choice never removes the other choices.
 */
export const crmOrganizationFacetsSchema = z.object({
  industries: z.array(z.string()),
  countries: z.array(z.string()),
});
export type CrmOrganizationFacets = z.infer<typeof crmOrganizationFacetsSchema>;

export const crmSubjectsResponseSchema = z.object({
  subjects: z.array(crmSubjectSchema),
  /** More exist than were returned — the answer past this is to search. */
  has_more: z.boolean(),
  /** `kind=organization` only. Absent from a store that does not send them yet. */
  facets: crmOrganizationFacetsSchema.optional(),
});
export type CrmSubjectsResponse = z.infer<typeof crmSubjectsResponseSchema>;

/**
 * One number per Core status, plus `all` and `open` (`open` is Core's own
 * definition — Active and Paused for a project, every lead for a lead). A
 * status with no rows is absent: read absent as zero once the answer arrived.
 */
export const crmSubjectStatusCountsSchema = z.record(z.string(), z.number().int());
export type CrmSubjectStatusCounts = z.infer<typeof crmSubjectStatusCountsSchema>;

export const crmSubjectCountsResponseSchema = z.object({
  counts: crmSubjectStatusCountsSchema,
  /** The workspace's own projects. */
  internal: crmSubjectStatusCountsSchema.optional(),
  client: crmSubjectStatusCountsSchema.optional(),
});
export type CrmSubjectCountsResponse = z.infer<typeof crmSubjectCountsResponseSchema>;

// ---------------------------------------------------------------------------
// Interactions, repositories, the team.
// ---------------------------------------------------------------------------

export const crmInteractionContactSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
});
export type CrmInteractionContact = z.infer<typeof crmInteractionContactSchema>;

export const crmInteractionTypeSchema = z.enum(['note', 'email', 'call', 'meeting', 'web']);
export type CrmInteractionType = z.infer<typeof crmInteractionTypeSchema>;

/** A compact interaction projection for the Work subject pane. */
export const crmInteractionSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: crmInteractionTypeSchema,
  occurred_at: z.string().nullable(),
  created_at: z.string().nullable(),
  summary_preview: z.string().nullable(),
  /** The whole summary, Markdown, for a reader. The preview is one line of it. */
  summary_markdown: z.string().nullable(),
  transcript_preview: z.string().nullable(),
  duration_minutes: z.number().int().nullable(),
  project_id: z.string().nullable(),
  lead_id: z.string().nullable(),
  organization_id: z.string().nullable(),
  source: z.string().nullable(),
  channel: z.string().nullable(),
  status: z.string().nullable(),
  url: z.string().nullable(),
  contacts: z.array(crmInteractionContactSchema),
  /** Core's free text on the row: a note's body, an email's excerpt. Absent where the store has none. */
  description: z.string().nullable().optional(),
  /** Core's tags on the row. Absent when it has none. */
  tags: z.array(z.string()).optional(),
  /** A Signals account the interaction is about. */
  signals_account_id: z.string().nullable().optional(),
  /** On a project's History: the row is the lead's it was won from (ADR 0008). Absent elsewhere. */
  from_lead: z.boolean().optional(),
});
export type CrmInteraction = z.infer<typeof crmInteractionSchema>;

/** The row returned by the Worker, including the optional source event edge. */
export const crmInteractionRowSchema = crmInteractionSchema.extend({
  event_id: z.string().nullable().optional(),
});
export type CrmInteractionRow = z.infer<typeof crmInteractionRowSchema>;

/** The kinds a member logs by hand on a subject's History. Email and web rows come from connectors. */
export const CRM_INTERACTION_MANUAL_TYPES = ['call', 'meeting', 'note'] as const;
export type CrmInteractionManualType = (typeof CRM_INTERACTION_MANUAL_TYPES)[number];

const interactionLink = z.uuid().nullable();
const interactionUrl = z.string().trim().max(2_000).url().refine((value) => /^https?:\/\//iu.test(value), 'url must be http or https').nullable();

/**
 * `POST /api/crm/interactions`: a call, meeting or note logged
 * by hand. It is filed on an organization, a lead or a project, and names
 * the contacts who were there. Core's agent route writes it while the
 * `interactions` group is on Core, D1 after.
 */
export const crmInteractionCreateSchema = z.object({
  type: z.enum(CRM_INTERACTION_MANUAL_TYPES),
  title: z.string().trim().min(1).max(200),
  occurred_at: z.iso.datetime({ offset: true }),
  summary_markdown: z.string().trim().max(10_000).nullable().optional(),
  url: interactionUrl.optional(),
  organization_id: interactionLink.optional(),
  lead_id: interactionLink.optional(),
  project_id: interactionLink.optional(),
  contact_ids: z.array(z.uuid()).max(50).default([]),
}).refine((value) => Boolean(value.organization_id || value.lead_id || value.project_id), {
  message: 'File the interaction on an organization, a lead or a project.',
});
export type CrmInteractionCreate = z.infer<typeof crmInteractionCreateSchema>;

/**
 * `PATCH /api/crm/interactions/:id`: only the fields sent
 * change. `contact_ids` replaces the list. The type of an email or web row
 * stays what it is unless the edit names another.
 */
export const crmInteractionUpdateSchema = z.object({
  type: crmInteractionTypeSchema.optional(),
  title: z.string().trim().min(1).max(200).optional(),
  occurred_at: z.iso.datetime({ offset: true }).optional(),
  summary_markdown: z.string().trim().max(10_000).nullable().optional(),
  url: interactionUrl.optional(),
  organization_id: interactionLink.optional(),
  lead_id: interactionLink.optional(),
  project_id: interactionLink.optional(),
  contact_ids: z.array(z.uuid()).max(50).optional(),
});
export type CrmInteractionUpdate = z.infer<typeof crmInteractionUpdateSchema>;

/** `POST` and `PATCH /api/crm/interactions`: the row as History draws it. */
export const crmInteractionResponseSchema = z.object({ interaction: crmInteractionSchema });
export type CrmInteractionResponse = z.infer<typeof crmInteractionResponseSchema>;

/** `DELETE /api/crm/interactions/:id`. Its contact and subject links go with it. */
export const crmInteractionDeleteResponseSchema = z.object({
  id: z.string(),
  deleted: z.literal(true),
});
export type CrmInteractionDeleteResponse = z.infer<typeof crmInteractionDeleteResponseSchema>;

// ---------------------------------------------------------------------------
// Contacts: the people outside the workspace (docs/RELATIONSHIPS.md slice 2,
//). A contact is a workspace record on every store, not a subject:
// it has no channel and no grant of its own, and it is seen through its
// organization.
// ---------------------------------------------------------------------------

/** One contact, as a list and a picker draw it. Core calls the title `company_role`; the wire calls it `title`. */
export const crmContactSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  title: z.string().nullable(),
  organization_id: z.string().nullable(),
  organization_name: z.string().nullable(),
  /** The primary address, the one Core holds as `email`. */
  email: z.string().nullable(),
  /** Every address, the primary first. */
  emails: z.array(z.string()),
});
export type CrmContact = z.infer<typeof crmContactSchema>;

/**
 * The values a contact list can be filtered by: country codes
 * (ISO 3166 alpha-2) and preferred languages. D1 answers the values its
 * contacts carry, sorted; Core answers its own option lists. Not narrowed by
 * the filters, so a choice never removes the other choices.
 */
export const crmContactFacetsSchema = z.object({
  countries: z.array(z.string()),
  languages: z.array(z.string()),
});
export type CrmContactFacets = z.infer<typeof crmContactFacetsSchema>;

/** `GET /api/crm/contacts`, in name order. */
export const crmContactsResponseSchema = z.object({
  contacts: z.array(crmContactSchema),
  /** More match than were returned: the answer is a narrower query. */
  has_more: z.boolean(),
  /** With `facets=true` only. Absent from a store that does not send them yet. */
  facets: crmContactFacetsSchema.optional(),
});
export type CrmContactsResponse = z.infer<typeof crmContactsResponseSchema>;

// ---------------------------------------------------------------------------
// Offers and licences: read on a lead and an organization, behind
// the `offers` and `licenses` work modules. Core holds them until the
// commercial group moves to D1, and the same shapes answer from D1
// after that. Writing an offer is.
// ---------------------------------------------------------------------------

/** One offer, as a subject's Offers group draws it. */
export const crmOfferSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  /** Core's offer status, as Core spells it (draft, sent, accepted, rejected, expired). */
  status: z.string().nullable(),
  total_amount: z.number().nullable(),
  currency: z.string().nullable(),
  valid_until: z.string().nullable(),
  is_accepted: z.boolean().nullable(),
  created_at: z.string().nullable(),
  lead_id: z.string().nullable(),
  organization_id: z.string().nullable(),
  /** Edits the buyer does not see until Send update. D1 answers it; Core and an older Worker do not. */
  has_unsent_changes: z.boolean().optional(),
  /** On a workspace-wide list only: the status a reader sees, and the subject's name. */
  shown_status: z.string().optional(),
  organization_name: z.string().nullable().optional(),
  lead_title: z.string().nullable().optional(),
});
export type CrmOffer = z.infer<typeof crmOfferSchema>;

/** One licence, as a subject's Licences group draws it. */
export const crmLicenseUsageSchema = z.object({
  snapshot_at: z.string(),
  window_starts_at: z.string().nullable(),
  window_ends_at: z.string().nullable(),
  projects_count: z.number().int().nullable(),
  sessions_created_30d: z.number().int().nullable(),
  last_session_created_at: z.string().nullable(),
  workflow_runs_succeeded_30d: z.number().int().nullable(),
  last_successful_workflow_run_at: z.string().nullable(),
  results_first_viewed_at: z.string().nullable(),
});
export type CrmLicenseUsage = z.infer<typeof crmLicenseUsageSchema>;

export const crmLicenseSchema = z.object({
  id: z.string(),
  product: z.string().nullable(),
  plan_type: z.string().nullable(),
  seats: z.number().int().nullable(),
  amount_eur: z.number().nullable(),
  start_date: z.string().nullable(),
  /** A date (YYYY-MM-DD). */
  renewal_date: z.string().nullable(),
  is_active: z.boolean(),
  offer_id: z.string().nullable(),
  lead_id: z.string().nullable(),
  organization_id: z.string().nullable(),
  payment_type: z.string().nullable().optional(),
  billing_interval: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  /** The Signals organization whose usage and billing facts land here. */
  signals_org_id: z.string().nullable().optional(),
  /** The latest subscription status Signals reported. */
  billing_status: z.string().nullable().optional(),
  /** Null until Signals reports a snapshot. Unknown is null, never zero. */
  usage: crmLicenseUsageSchema.nullable().optional(),
  /** On a workspace-wide list only: the subject's name. */
  organization_name: z.string().nullable().optional(),
  lead_title: z.string().nullable().optional(),
});
export type CrmLicense = z.infer<typeof crmLicenseSchema>;

/**
 * `GET /api/crm/subjects/:kind/:id/commercial`, for a lead or an
 * organization. Newest first. A list is null when its work module is off,
 * so a client hides the group rather than drawing it empty.
 */
export const crmSubjectCommercialResponseSchema = z.object({
  offers: z.array(crmOfferSchema).nullable(),
  licenses: z.array(crmLicenseSchema).nullable(),
});
export type CrmSubjectCommercialResponse = z.infer<typeof crmSubjectCommercialResponseSchema>;

/** A member who was on a call with the contact, and on how many. */
export const crmContactMemberSchema = z.object({
  email: z.string(),
  name: z.string().nullable(),
  calls: z.number().int(),
});
export type CrmContactMember = z.infer<typeof crmContactMemberSchema>;

/**
 * The columns Core keeps on a contact beyond its name, title and addresses,
 * read on the contact page. D1 keeps each one since migration
 * 0130. Absent from a store that does not send them.
 */
export const crmContactProfileShape = {
  notes: z.string().nullable().optional(),
  linkedin_url: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  headline: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  connection_count: z.string().nullable().optional(),
  /** ISO 3166 alpha-2. */
  country: z.string().nullable().optional(),
  corporate_email: z.string().nullable().optional(),
  profile_image_url: z.string().nullable().optional(),
  /** Named flags, as Core's `characteristics`. */
  characteristics: z.record(z.string(), z.boolean()).nullable().optional(),
  preferred_language: z.string().optional(),
  signals_outreach_status: z.string().nullable().optional(),
  /** ISO. */
  signals_notified_at: z.string().nullable().optional(),
  birthday_month: z.number().int().nullable().optional(),
  birthday_day: z.number().int().nullable().optional(),
  birthday_year: z.number().int().nullable().optional(),
  /** The profile kinds, one flag each, as Core keeps them. */
  futurist: z.boolean().optional(),
  corporate: z.boolean().optional(),
  academic: z.boolean().optional(),
  independent: z.boolean().optional(),
  government: z.boolean().optional(),
  ngo: z.boolean().optional(),
  media: z.boolean().optional(),
  intelligence: z.boolean().optional(),
};

/** Core's contact languages (`CONTACT_LANGUAGE_VALUES`), in its order. */
export const CONTACT_LANGUAGES = ['en', 'pt'] as const;

/**
 * `GET /api/crm/contact-options`: what the contact editor
 * offers. `characteristics` are the names a contact's `characteristics`
 * map takes: `contact_characteristics_config` on either store, and on D1
 * also any other name a contact carries. `languages` are Core's languages and any other a
 * contact carries, Core's first.
 */
export const crmContactOptionsResponseSchema = z.object({
  characteristics: z.array(z.string()),
  languages: z.array(z.string()),
});
export type CrmContactOptionsResponse = z.infer<typeof crmContactOptionsResponseSchema>;

/** The contact page: the contact, the work they are on, the calls they were in and who met them. */
export const crmContactDetailSchema = crmContactSchema.extend({
  ...crmContactProfileShape,
  /** The id the request named, when that contact was merged into this one. A client replaces the id it holds with `id`. */
  merged_from: z.string().optional(),
  projects: z.array(crmRelatedRowSchema),
  leads: z.array(crmRelatedRowSchema),
  /** The calls they were in, newest first. */
  interactions: z.array(crmInteractionSchema),
  /** Members who were on those calls, most calls first. */
  met_by: z.array(crmContactMemberSchema),
});
export type CrmContactDetail = z.infer<typeof crmContactDetailSchema>;

/** `GET`, `POST` and `PATCH` on one contact answer the page. */
export const crmContactResponseSchema = z.object({
  contact: crmContactDetailSchema,
});
export type CrmContactResponse = z.infer<typeof crmContactResponseSchema>;

export const recentFeedEntrySchema = z.object({
  subject: z.object({
    kind: crmSubjectKindSchema,
    id: z.string(),
    title: z.string(),
  }),
  /** Quiet event metadata uses the same display envelope; it is not a Core interaction. */
  interaction: crmInteractionRowSchema.extend({ type: z.enum(['call', 'email', 'meeting', 'note', 'web', 'event']) }),
});
export type RecentFeedEntry = z.infer<typeof recentFeedEntrySchema>;

/** GET /api/crm/feed — interactions and quiet events across visible open subjects. */
export const recentFeedResponseSchema = z.object({
  entries: z.array(recentFeedEntrySchema),
  partial: z.array(z.string()),
});
export type RecentFeedResponse = z.infer<typeof recentFeedResponseSchema>;

/** GET /api/crm/interactions?project_id=|lead_id= */
export const crmInteractionsResponseSchema = z.object({
  interactions: z.array(crmInteractionSchema),
});
export type CrmInteractionsResponse = z.infer<typeof crmInteractionsResponseSchema>;

/** A repository linked to a project. Core owns the link and the GitHub App. */
export const crmGithubRepoSchema = z.object({
  id: z.string(),
  owner: z.string(),
  repo: z.string(),
  label: z.string().nullable(),
  milestone: z.string().nullable(),
  is_primary: z.boolean(),
});
export type CrmGithubRepo = z.infer<typeof crmGithubRepoSchema>;

export const crmGithubReposResponseSchema = z.object({
  repos: z.array(crmGithubRepoSchema),
});
export type CrmGithubReposResponse = z.infer<typeof crmGithubReposResponseSchema>;

export const crmProjectRepoResponseSchema = z.object({
  repo: crmGithubRepoSchema,
});
export type CrmProjectRepoResponse = z.infer<typeof crmProjectRepoResponseSchema>;

export const crmTeamMemberSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  /** Who they are on GitHub, so an issue can be assigned to them; absent until they say. */
  github_login: z.string().nullable().optional(),
  /**
   * A person, or an enrolled agent that can hold work. Absent
   * from Core and from an older Worker: a person.
   */
  kind: z.enum(['person', 'agent']).optional(),
});
export type CrmTeamMember = z.infer<typeof crmTeamMemberSchema>;

/** GET /api/crm/team */
export const crmTeamResponseSchema = z.object({
  members: z.array(crmTeamMemberSchema),
});
export type CrmTeamResponse = z.infer<typeof crmTeamResponseSchema>;

export const crmGithubLoginResponseSchema = z.object({
  github_login: z.string().nullable(),
});
export type CrmGithubLoginResponse = z.infer<typeof crmGithubLoginResponseSchema>;

// ---------------------------------------------------------------------------
// GitHub issues on a project's linked repositories. Read only, and never
// mirrored into a task: an issue stays GitHub's row.
// ---------------------------------------------------------------------------

export const crmIssueStateSchema = z.enum(['open', 'closed']);
export type CrmIssueState = z.infer<typeof crmIssueStateSchema>;

export const crmIssueLabelSchema = z.object({
  name: z.string(),
  color: z.string().nullable(),
  description: z.string().nullable(),
});
export type CrmIssueLabel = z.infer<typeof crmIssueLabelSchema>;

export const crmIssueUserSchema = z.object({
  login: z.string(),
  avatar_url: z.string().nullable(),
});
export type CrmIssueUser = z.infer<typeof crmIssueUserSchema>;

export const crmIssueMilestoneSchema = z.object({
  title: z.string(),
  number: z.number().int().nullable(),
  state: crmIssueStateSchema.nullable(),
  due_on: z.string().nullable(),
});
export type CrmIssueMilestone = z.infer<typeof crmIssueMilestoneSchema>;

export const crmIssueSubIssuesSchema = z.object({
  total: z.number().int(),
  completed: z.number().int(),
  percent_completed: z.number(),
});
export type CrmIssueSubIssues = z.infer<typeof crmIssueSubIssuesSchema>;

export const crmIssueSchema = z.object({
  /** `owner/repo#number`, stable and readable. */
  id: z.string(),
  number: z.number().int(),
  owner: z.string(),
  repo: z.string(),
  title: z.string(),
  state: crmIssueStateSchema,
  url: z.string(),
  /** Label names; the colours arrive beside them in `label_details`. */
  labels: z.array(z.string()),
  label_details: z.array(crmIssueLabelSchema).optional(),
  assignee_login: z.string().nullable(),
  assignees: z.array(crmIssueUserSchema).optional(),
  author: crmIssueUserSchema.nullable().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable(),
  closed_at: z.string().nullable().optional(),
  state_reason: z.string().nullable().optional(),
  issue_type: z.string().nullable().optional(),
  milestone: z.string().nullable(),
  milestone_detail: crmIssueMilestoneSchema.nullable().optional(),
  comments: z.number().int(),
  reactions: z.record(z.string(), z.number().int()).nullable().optional(),
  sub_issues: crmIssueSubIssuesSchema.nullable().optional(),
});
export type CrmIssue = z.infer<typeof crmIssueSchema>;

export const crmIssueCommentSchema = z.object({
  id: z.number().int(),
  author: z.string(),
  author_avatar_url: z.string().nullable().optional(),
  body: z.string(),
  created_at: z.string(),
  updated_at: z.string().nullable().optional(),
  url: z.string(),
  reactions: z.record(z.string(), z.number().int()).nullable().optional(),
});
export type CrmIssueComment = z.infer<typeof crmIssueCommentSchema>;

export const crmIssueEventSchema = z.object({
  id: z.string(),
  kind: z.string(),
  actor: z.string().nullable(),
  created_at: z.string().nullable(),
  label: crmIssueLabelSchema.nullable(),
  subject: z.string().nullable(),
  url: z.string().nullable(),
  state_reason: z.string().nullable(),
});
export type CrmIssueEvent = z.infer<typeof crmIssueEventSchema>;

export const crmSubIssueSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: crmIssueStateSchema,
  url: z.string(),
});
export type CrmSubIssue = z.infer<typeof crmSubIssueSchema>;

export const crmIssueDetailSchema = crmIssueSchema.extend({
  body: z.string(),
  comments_list: z.array(crmIssueCommentSchema),
  timeline: z.array(crmIssueEventSchema).optional(),
  sub_issue_list: z.array(crmSubIssueSchema).optional(),
});
export type CrmIssueDetail = z.infer<typeof crmIssueDetailSchema>;

export const crmIssueDetailResponseSchema = z.object({
  issue: crmIssueDetailSchema,
});
export type CrmIssueDetailResponse = z.infer<typeof crmIssueDetailResponseSchema>;

/** POST and PATCH /api/crm/issue answer the row as GitHub now has it. */
export const crmIssueResponseSchema = z.object({
  issue: crmIssueSchema,
});
export type CrmIssueResponse = z.infer<typeof crmIssueResponseSchema>;

export const crmIssueFacetsResponseSchema = z.object({
  labels: z.array(crmIssueLabelSchema),
  milestones: z.array(crmIssueMilestoneSchema),
  assignees: z.array(crmIssueUserSchema),
});
export type CrmIssueFacetsResponse = z.infer<typeof crmIssueFacetsResponseSchema>;

export const crmIssuesResponseSchema = z.object({
  issues: z.array(crmIssueSchema),
  /** False when the project has no repository; the list is then empty and not an error. */
  linked: z.boolean(),
  has_more: z.boolean().optional(),
});
export type CrmIssuesResponse = z.infer<typeof crmIssuesResponseSchema>;

// ---------------------------------------------------------------------------
// Tasks, mine, the board.
// ---------------------------------------------------------------------------

export const crmTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string().nullable(),
  status: z.string(),
  responsible_party: z.string(),
  assignee_id: z.string().nullable(),
  assignee_name: z.string().nullable(),
  assignee_email: z.string().nullable(),
  due_date: z.string().nullable(),
  /** Core's priority word, passed through; absent on a row that never had one. */
  priority: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  project_id: z.string().nullable(),
  lead_id: z.string().nullable(),
  event_id: z.string().nullable().optional(),
  /**
   * A partner's own task: its CRM organization, with no project,
   * lead, event or meeting. Core also sets it as context on a task that
   * hangs off something else, so it names a partner only when the other
   * four are empty.
   */
  organization_id: z.string().nullable().optional(),
  meeting_id: z.string().nullable().optional(),
  /**
   * A Signals account's task. Core also echoes the account's
   * organization on it, so a task with this id is never a partner's.
   */
  signals_account_id: z.string().nullable().optional(),
  /** The contact the task is about, as Core keeps it: context, not a place. */
  contact_id: z.string().nullable().optional(),
  updated_at: z.string().nullable(),
  github_owner: z.string().nullable().optional(),
  github_repo: z.string().nullable().optional(),
  github_issue_number: z.number().int().nullable().optional(),
  /** Whether the assignee is a person or an agent. Absent: a person. */
  assignee_kind: z.enum(['person', 'agent']).nullable().optional(),
  /** The goal this task serves. Absent from a Core that predates goals. */
  goal_id: z.string().nullable().optional(),
});
export type CrmTask = z.infer<typeof crmTaskSchema>;

export const crmTasksResponseSchema = z.object({
  tasks: z.array(crmTaskSchema),
});
export type CrmTasksResponse = z.infer<typeof crmTasksResponseSchema>;

/** POST and PATCH on a task answer the row as Core now has it. */
export const crmTaskResponseSchema = z.object({
  task: crmTaskSchema,
});
export type CrmTaskResponse = z.infer<typeof crmTaskResponseSchema>;

/**
 * `DELETE /api/crm/tasks/:id`. The task goes from the store that
 * holds the `tasks` group. Nothing else is deleted with it.
 */
export const crmTaskDeleteResponseSchema = z.object({
  id: z.string(),
  deleted: z.literal(true),
});
export type CrmTaskDeleteResponse = z.infer<typeof crmTaskDeleteResponseSchema>;

/**
 * `GET /api/crm/subjects/organization/:id/project-tasks`: the
 * organization's open tasks, one group per project, for its Tasks pane
 * grouped By project. Projects in the order the organization lists them; a
 * project with no open task is left out. `partial` is true when a project's
 * tasks could not be read.
 */
export const crmOrganizationProjectTasksResponseSchema = z.object({
  projects: z.array(z.object({
    id: z.string(),
    title: z.string().nullable(),
    status: z.string().nullable(),
    tasks: z.array(crmTaskSchema),
  })),
  partial: z.boolean(),
});
export type CrmOrganizationProjectTasksResponse = z.infer<typeof crmOrganizationProjectTasksResponseSchema>;

export const crmMyTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string().nullable(),
  status: z.string(),
  responsible_party: z.string(),
  due_date: z.string().nullable(),
  priority: z.string().nullable(),
  project_id: z.string().nullable(),
  lead_id: z.string().nullable(),
  event_id: z.string().nullable().optional(),
  /** A partner's own task; see `crmTaskSchema.organization_id`. */
  organization_id: z.string().nullable().optional(),
  meeting_id: z.string().nullable().optional(),
  /** A Signals account's task; see `crmTaskSchema.signals_account_id`. */
  signals_account_id: z.string().nullable().optional(),
  /** See `crmTaskSchema.contact_id`. */
  contact_id: z.string().nullable().optional(),
  subject_title: z.string().nullable(),
  github_owner: z.string().nullable(),
  github_repo: z.string().nullable(),
  github_issue_number: z.number().int().nullable(),
  updated_at: z.string().nullable(),
});
export type CrmMyTask = z.infer<typeof crmMyTaskSchema>;

/** GET /api/crm/mine */
export const crmMyWorkResponseSchema = z.object({
  tasks: z.array(crmMyTaskSchema),
  issues: z.array(crmIssueSchema),
  /** Whether the member's GitHub login is known, so issues could be matched at all. */
  matched: z.boolean(),
  github_login: z.string().nullable(),
});
export type CrmMyWorkResponse = z.infer<typeof crmMyWorkResponseSchema>;

/** One of the signed-in member's own items finished in the last board window. */
export const crmRecentlyClosedKindSchema = z.enum(['task', 'issue']);
export type CrmRecentlyClosedKind = z.infer<typeof crmRecentlyClosedKindSchema>;

export const crmRecentlyClosedItemSchema = z.object({
  kind: crmRecentlyClosedKindSchema,
  id: z.string(),
  title: z.string(),
  subject_title: z.string().nullable(),
  /** The linked project lets a Reopen write evict the project's issue cache. */
  project_id: z.string().nullable(),
  updated_at: z.string().nullable(),
  /** Present only for an issue, so the shared reopen action has its reference. */
  issue: crmIssueSchema.nullable(),
});
export type CrmRecentlyClosedItem = z.infer<typeof crmRecentlyClosedItemSchema>;

/** GET /api/crm/recently-closed — already ordered newest first by WorkItems. */
export const crmRecentlyClosedWorkResponseSchema = z.object({
  items: z.array(crmRecentlyClosedItemSchema),
  partial: z.array(z.string()),
});
export type CrmRecentlyClosedWorkResponse = z.infer<typeof crmRecentlyClosedWorkResponseSchema>;

/**
 * GET /api/crm/unowned — open work nobody on our side holds, across every
 * subject (docs/BOARD.md §Unowned). Mine's own shapes, so each client plans
 * and draws the rows the way it draws Mine; the Worker has already applied
 * the shared rule (`planUnowned`), and no client filters them again.
 */
/** The subject an UNOWNED row is on, for the menu that shows or hides each one. */
export const crmUnownedSubjectSchema = z.object({
  kind: crmSubjectKindSchema,
  id: z.string(),
  title: z.string(),
});
export type CrmUnownedSubject = z.infer<typeof crmUnownedSubjectSchema>;

/**
 * Why a subject's work could not be read: Core or GitHub said
 * 429, refused the credentials, did not answer in time, or failed otherwise.
 */
export const crmReadFailureCauseSchema = z.enum(['rate_limited', 'auth', 'timeout', 'upstream']);
export type CrmReadFailureCause = z.infer<typeof crmReadFailureCauseSchema>;

/** One subject (or source) whose read failed, and why. `status` is the HTTP code when one came back. */
export const crmReadFailureSchema = z.object({
  subject: z.string(),
  cause: crmReadFailureCauseSchema,
  status: z.number().int().optional(),
});
export type CrmReadFailure = z.infer<typeof crmReadFailureSchema>;

export const crmUnownedWorkResponseSchema = z.object({
  tasks: z.array(crmMyTaskSchema),
  issues: z.array(crmIssueSchema),
  /**
   * The project each issue was read for, by issue id: a task names its own
   * subject, an issue does not. Absent from a Worker before 2026-10-01.
   */
  issue_subjects: z.record(z.string(), crmUnownedSubjectSchema).optional(),
  /**
   * Subjects whose work could not be read, by title — the board's own
   * `partial`. Failures only since: a subject that only hit the
   * row cap is in `truncated`, and is not an error.
   */
  partial: z.array(z.string()),
  /** Subjects that answered but hit the row cap: the list shows their first rows. Quiet, not an error. */
  truncated: z.array(z.string()).optional(),
  /** The failures in `partial`, each with its cause, for the red notice and its Retry. */
  failed: z.array(crmReadFailureSchema).optional(),
});
export type CrmUnownedWorkResponse = z.infer<typeof crmUnownedWorkResponseSchema>;

export const cardTraceKindSchema = z.enum(['task', 'issue']);

/** The last message that moved a card, so the board can say why it sits where it does. */
export const cardTraceSchema = z.object({
  ref_kind: cardTraceKindSchema,
  ref_id: z.string(),
  thread_id: z.string(),
  message_id: z.string(),
  text: z.string(),
  at: z.number().int(),
});
export type CardTrace = z.infer<typeof cardTraceSchema>;

/**
 * GET /api/crm/board — every open card on every subject, and this week's
 * finished ones, in one read. The client deals them into columns with
 * `WorkItems.board`; nothing here is staged.
 */
export const crmBoardResponseSchema = z.object({
  subjects: z.array(crmSubjectSchema),
  tasks: z.array(crmTaskSchema),
  issues: z.array(crmIssueSchema),
  traces: z.array(cardTraceSchema),
  /** Which project each issue was read for, by issue id — a repository can serve several projects. */
  issue_projects: z.record(z.string(), z.string()),
  /** Subjects whose work could not be read, by title. Failures only since; a cap hit is `truncated`. */
  partial: z.array(z.string()),
  /** Subjects that hit the row cap: their first rows are on the board. Quiet, not an error. */
  truncated: z.array(z.string()).optional(),
  /** The failures in `partial`, each with its cause. */
  failed: z.array(crmReadFailureSchema).optional(),
  finished_since: z.string(),
});
export type CrmBoardResponse = z.infer<typeof crmBoardResponseSchema>;

export const taskCandidateResponsibleSchema = z.enum(['team', 'client', 'unassigned']);

export const taskCandidateSchema = z.object({
  title: z.string(),
  quote: z.string(),
  responsible: taskCandidateResponsibleSchema,
  confidence: z.number(),
});
export type TaskCandidate = z.infer<typeof taskCandidateSchema>;

export const taskCandidatesResponseSchema = z.object({
  candidates: z.array(taskCandidateSchema),
  engine: z.enum(['ai', 'off']),
});
export type TaskCandidatesResponse = z.infer<typeof taskCandidatesResponseSchema>;
