import {
  catalogServiceResponseSchema,
  offerCreateSchema,
  offerDecisionSchema,
  offerDuplicateSchema,
  offerLineCreateSchema,
  offerLinePatchSchema,
  offerPatchSchema,
  organizationDiscountSchema,
  serviceCreateSchema,
  servicePatchSchema,
  type CatalogResponse,
  type CatalogServiceResponse,
  type OfferDecisionResponse,
  type OfferOptionsResponse,
  type OfferResponse,
  type OfferSendResponse,
  type OfferVersionResponse,
  type OrganizationDiscountResponse,
} from '@starlings/contracts/offers';
import {
  licenseCreateSchema,
  licensePatchSchema,
  licensesQuerySchema,
  offersQuerySchema,
  signalsAccountMapRequestSchema,
  type LicenseResponse,
  type LicensesResponse,
  type OffersResponse,
  type SignalsAccountMapResponse,
} from '@starlings/contracts/licenses';
import { recordAdminAction } from '../admin-audit';
import { assertTrustedMutation, json, readBoundedJSON } from '../http';
import { createLicense, endLicense, listLicenses, listOffers, mapSignalsAccounts, patchLicense, readLicense } from '../licenses-d1';
import {
  addOfferLine,
  createOffer,
  createService,
  duplicateOffer,
  listCatalog,
  patchOffer,
  patchOfferLine,
  patchService,
  readOffer,
  readOfferOptions,
  readOfferVersion,
  readOrganizationDiscount,
  recordOfferDecision,
  removeOfferLine,
  sendOffer,
  sendOfferUpdate,
  setOrganizationDiscount,
} from '../offers-d1';
import { defineRoute, PARAMS, type Route } from '../route-types';
import { subjectAccessFor } from '../subject-access';

const crmWork = { kind: 'capability', capability: 'crmWork' } as const;
const offerId = { id: PARAMS.uuid };
const lineParams = { id: PARAMS.uuid, lineId: PARAMS.uuid };

/**
 * A member's offers and catalog (docs/WORK.md §Offers). On a Core
 * workspace, while Core holds the commercial group, each one refuses with 409
 * before it reads or writes (`assertOffersHere`).
 */
export const offersRoutes: readonly Route[] = [
  defineRoute({
    method: 'GET',
    path: '/api/crm/offer-options',
    gate: crmWork,
    handler: async ({ env }) => json(await readOfferOptions(env) satisfies OfferOptionsResponse),
  }),
  defineRoute({
    method: 'GET',
    path: '/api/crm/offers',
    gate: crmWork,
    handler: async ({ url, env, owner }) => {
      const query = offersQuerySchema.parse(Object.fromEntries(url.searchParams));
      return json(await listOffers(env, owner.email, await subjectAccessFor(env, owner), query) satisfies OffersResponse);
    },
  }),
  defineRoute({
    method: 'POST',
    path: '/api/crm/offers',
    gate: crmWork,
    handler: async ({ request, env, owner }) => {
      assertTrustedMutation(request, env);
      const body = offerCreateSchema.parse(await readBoundedJSON(request));
      return json(await createOffer(env, await subjectAccessFor(env, owner), owner.email, body) satisfies OfferResponse, 201);
    },
  }),
  defineRoute({
    method: 'GET',
    path: '/api/crm/offers/:id',
    params: offerId,
    gate: crmWork,
    handler: async ({ env, owner, params }) => json(await readOffer(env, await subjectAccessFor(env, owner), params.id!) satisfies OfferResponse),
  }),
  defineRoute({
    method: 'PATCH',
    path: '/api/crm/offers/:id',
    params: offerId,
    gate: crmWork,
    handler: async ({ request, env, owner, params }) => {
      assertTrustedMutation(request, env);
      const body = offerPatchSchema.parse(await readBoundedJSON(request));
      return json(await patchOffer(env, await subjectAccessFor(env, owner), owner.email, params.id!, body) satisfies OfferResponse);
    },
  }),
  defineRoute({
    method: 'GET',
    path: '/api/crm/offers/:id/versions/:version',
    params: { id: PARAMS.uuid, version: { re: '[1-9][0-9]{0,5}', sample: '1' } },
    gate: crmWork,
    handler: async ({ env, owner, params }) => json(await readOfferVersion(env, await subjectAccessFor(env, owner), params.id!, Number(params.version)) satisfies OfferVersionResponse),
  }),
  defineRoute({
    method: 'POST',
    path: '/api/crm/offers/:id/lines',
    params: offerId,
    gate: crmWork,
    handler: async ({ request, env, owner, params }) => {
      assertTrustedMutation(request, env);
      const body = offerLineCreateSchema.parse(await readBoundedJSON(request));
      return json(await addOfferLine(env, await subjectAccessFor(env, owner), owner.email, params.id!, body) satisfies OfferResponse, 201);
    },
  }),
  defineRoute({
    method: 'PATCH',
    path: '/api/crm/offers/:id/lines/:lineId',
    params: lineParams,
    gate: crmWork,
    handler: async ({ request, env, owner, params }) => {
      assertTrustedMutation(request, env);
      const body = offerLinePatchSchema.parse(await readBoundedJSON(request));
      return json(await patchOfferLine(env, await subjectAccessFor(env, owner), owner.email, params.id!, params.lineId!, body) satisfies OfferResponse);
    },
  }),
  defineRoute({
    method: 'DELETE',
    path: '/api/crm/offers/:id/lines/:lineId',
    params: lineParams,
    gate: crmWork,
    handler: async ({ request, env, owner, params }) => {
      assertTrustedMutation(request, env);
      return json(await removeOfferLine(env, await subjectAccessFor(env, owner), owner.email, params.id!, params.lineId!) satisfies OfferResponse);
    },
  }),
  defineRoute({
    method: 'POST',
    path: '/api/crm/offers/:id/send',
    params: offerId,
    gate: crmWork,
    handler: async ({ request, env, owner, params }) => {
      assertTrustedMutation(request, env);
      return json(await sendOffer(env, await subjectAccessFor(env, owner), owner.email, params.id!) satisfies OfferSendResponse);
    },
  }),
  defineRoute({
    method: 'POST',
    path: '/api/crm/offers/:id/send-update',
    params: offerId,
    gate: crmWork,
    handler: async ({ request, env, owner, params }) => {
      assertTrustedMutation(request, env);
      return json(await sendOfferUpdate(env, await subjectAccessFor(env, owner), owner.email, params.id!) satisfies OfferSendResponse);
    },
  }),
  defineRoute({
    method: 'POST',
    path: '/api/crm/offers/:id/duplicate',
    params: offerId,
    gate: crmWork,
    handler: async ({ request, env, owner, params }) => {
      assertTrustedMutation(request, env);
      const body = offerDuplicateSchema.parse(await readBoundedJSON(request));
      return json(await duplicateOffer(env, await subjectAccessFor(env, owner), owner.email, params.id!, body) satisfies OfferResponse, 201);
    },
  }),
  defineRoute({
    method: 'POST',
    path: '/api/crm/offers/:id/decision',
    params: offerId,
    gate: crmWork,
    handler: async ({ request, env, owner, params }) => {
      assertTrustedMutation(request, env);
      const body = offerDecisionSchema.parse(await readBoundedJSON(request));
      return json(await recordOfferDecision(env, await subjectAccessFor(env, owner), owner.email, params.id!, body) satisfies OfferDecisionResponse);
    },
  }),
  defineRoute({
    method: 'GET',
    path: '/api/crm/organizations/:id/default-discount',
    params: offerId,
    gate: crmWork,
    handler: async ({ env, owner, params }) => json(await readOrganizationDiscount(env, await subjectAccessFor(env, owner), params.id!) satisfies OrganizationDiscountResponse),
  }),
  defineRoute({
    method: 'PATCH',
    path: '/api/crm/organizations/:id/default-discount',
    params: offerId,
    gate: crmWork,
    handler: async ({ request, env, owner, params }) => {
      assertTrustedMutation(request, env);
      const body = organizationDiscountSchema.parse(await readBoundedJSON(request));
      return json(await setOrganizationDiscount(env, await subjectAccessFor(env, owner), owner.email, params.id!, body) satisfies OrganizationDiscountResponse);
    },
  }),

  // The service catalog: a commercial page in Work (decided by MZ, 2026-11-04).
  defineRoute({
    method: 'GET',
    path: '/api/crm/services',
    gate: crmWork,
    handler: async ({ env }) => json(await listCatalog(env) satisfies CatalogResponse),
  }),
  defineRoute({
    method: 'POST',
    path: '/api/crm/services',
    gate: crmWork,
    handler: async ({ request, env, owner }) => {
      assertTrustedMutation(request, env);
      const body = serviceCreateSchema.parse(await readBoundedJSON(request));
      return json(catalogServiceResponseSchema.parse({ service: await createService(env, owner.email, body) }) satisfies CatalogServiceResponse, 201);
    },
  }),
  defineRoute({
    method: 'PATCH',
    path: '/api/crm/services/:id',
    params: offerId,
    gate: crmWork,
    handler: async ({ request, env, owner, params }) => {
      assertTrustedMutation(request, env);
      const body = servicePatchSchema.parse(await readBoundedJSON(request));
      return json(catalogServiceResponseSchema.parse({ service: await patchService(env, owner.email, params.id!, body) }) satisfies CatalogServiceResponse);
    },
  }),

  // Licences: web, Mac and agents edit, iPhone and Android read (decided by MZ, 2026-11-05).
  defineRoute({
    method: 'GET',
    path: '/api/crm/licenses',
    gate: crmWork,
    handler: async ({ url, env, owner }) => {
      const query = licensesQuerySchema.parse(Object.fromEntries(url.searchParams));
      return json(await listLicenses(env, owner.email, await subjectAccessFor(env, owner), query) satisfies LicensesResponse);
    },
  }),
  defineRoute({
    method: 'POST',
    path: '/api/crm/licenses',
    gate: crmWork,
    handler: async ({ request, env, owner }) => {
      assertTrustedMutation(request, env);
      const body = licenseCreateSchema.parse(await readBoundedJSON(request));
      return json(await createLicense(env, await subjectAccessFor(env, owner), owner.email, body) satisfies LicenseResponse, 201);
    },
  }),
  defineRoute({
    method: 'GET',
    path: '/api/crm/licenses/:id',
    params: offerId,
    gate: crmWork,
    handler: async ({ env, owner, params }) => json(await readLicense(env, await subjectAccessFor(env, owner), params.id!) satisfies LicenseResponse),
  }),
  defineRoute({
    method: 'PATCH',
    path: '/api/crm/licenses/:id',
    params: offerId,
    gate: crmWork,
    handler: async ({ request, env, owner, params }) => {
      assertTrustedMutation(request, env);
      const body = licensePatchSchema.parse(await readBoundedJSON(request));
      return json(await patchLicense(env, await subjectAccessFor(env, owner), owner.email, params.id!, body) satisfies LicenseResponse);
    },
  }),
  defineRoute({
    method: 'POST',
    path: '/api/crm/licenses/:id/end',
    params: offerId,
    gate: crmWork,
    handler: async ({ request, env, owner, params }) => {
      assertTrustedMutation(request, env);
      return json(await endLicense(env, await subjectAccessFor(env, owner), owner.email, params.id!) satisfies LicenseResponse);
    },
  }),

  // Core's `signals_accounts` rows onto licences and leads. A dry run unless the body says apply.
  defineRoute({
    method: 'POST',
    path: '/api/admin/signals-accounts/map',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = signalsAccountMapRequestSchema.parse(await readBoundedJSON(request));
      const result = await mapSignalsAccounts(env, owner.email, body);
      if (result.applied) await recordAdminAction(env, owner, 'signals_accounts.map', null, JSON.stringify(result.counts));
      return json(result satisfies SignalsAccountMapResponse);
    },
  }),
];
