import { removeOwnAvatar, storeOwnAvatar } from '../avatars';
import { type AvatarResponse, ISSUE_IMAGE_MAX_BYTES, type IssueImageResponse } from '../contracts';
import { readHomePreferences, writeHomePreferences } from '../home-preferences';
import { assertTrustedMutation, json, readBoundedBytes, readBoundedJSON } from '../http';
import { serveIssueImage, storeIssueImage } from '../issue-images';
import { readLanguagePreference, writeLanguagePreference } from '../language-preference';
import { type HomePreferencesResponse, homePreferencesUpdateSchema } from '@starlings/contracts/home-layout';
import { type LanguagePreferenceResponse, languagePreferenceUpdateSchema } from '@starlings/contracts/language';
import { defineRoute, type Route } from '../route-types';
import { readSetup, writeSetupSkip } from '../setup';
import { type SetupResponse, setupSkipUpdateSchema } from '@starlings/contracts/setup';

export const profileRoutes: readonly Route[] = [
  // The setup checklist (docs/ONBOARDING.md): the viewer's steps, each done
  // when the thing exists. Every role with a profile reads its own; a step
  // the viewer has no capability for is left out.
  defineRoute({
    method: 'GET',
    path: '/api/setup',
    gate: { kind: 'capability', capability: 'ownProfile' },
    handler: async ({ env, owner }) => {
      return json(await readSetup(env, { sub: owner.sub, email: owner.email, role: owner.role }) satisfies SetupResponse);
    },
  }),

  // Skip: one person clears a step from their own card, or brings it back.
  // The answer is their checklist after the change.
  defineRoute({
    method: 'PUT',
    path: '/api/setup/skip',
    gate: { kind: 'capability', capability: 'ownProfile' },
    handler: async ({ request, env, owner }) => {
      assertTrustedMutation(request, env);
      const body = setupSkipUpdateSchema.parse(await readBoundedJSON(request));
      const viewer = { sub: owner.sub, email: owner.email, role: owner.role };
      if (!(await writeSetupSkip(env, viewer, body.step, body.skipped))) {
        return json({ error: 'That isn’t one of your setup steps.' }, 404);
      }
      return json(await readSetup(env, viewer) satisfies SetupResponse);
    },
  }),

  // What Home is made of, per person (fixtures/home-layout.json). One's own
  // screen, so the same capability as one's own picture: a community session
  // has a Home too, even if most modules have nothing to draw for it.
  defineRoute({
    method: 'GET',
    path: '/api/home/preferences',
    gate: { kind: 'capability', capability: 'ownProfile' },
    handler: async ({ env, owner }) => {
      return json(await readHomePreferences(env, owner.sub) satisfies HomePreferencesResponse);
    },
  }),

  defineRoute({
    method: 'PUT',
    path: '/api/home/preferences',
    gate: { kind: 'capability', capability: 'ownProfile' },
    handler: async ({ request, env, owner }) => {
      assertTrustedMutation(request, env);
      const body = homePreferencesUpdateSchema.parse(await readBoundedJSON(request));
      return json(await writeHomePreferences(env, owner.sub, body.modules) satisfies HomePreferencesResponse);
    },
  }),

  // The language the interface is drawn in, per person. One's
  // own screen, so the same capability as one's own picture. `null` clears
  // the choice and the client follows its device again.
  defineRoute({
    method: 'GET',
    path: '/api/profile/language',
    gate: { kind: 'capability', capability: 'ownProfile' },
    handler: async ({ env, owner }) => {
      return json(await readLanguagePreference(env, owner.sub) satisfies LanguagePreferenceResponse);
    },
  }),

  defineRoute({
    method: 'PUT',
    path: '/api/profile/language',
    gate: { kind: 'capability', capability: 'ownProfile' },
    handler: async ({ request, env, owner }) => {
      assertTrustedMutation(request, env);
      const body = languagePreferenceUpdateSchema.parse(await readBoundedJSON(request));
      return json(await writeLanguagePreference(env, owner.sub, body.language) satisfies LanguagePreferenceResponse);
    },
  }),

  // Your own picture, and only ever your own: there is no email parameter here
  // to get wrong. PUT takes raw image bytes as the body — clients square and
  // downscale first, so nothing here has to decode an image to resize it.
  defineRoute({
    method: ['PUT', 'POST'],
    path: '/api/profile/avatar',
    gate: { kind: 'capability', capability: 'ownProfile', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      return json(await storeOwnAvatar(request, env, owner) satisfies AvatarResponse);
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/api/profile/avatar',
    gate: { kind: 'capability', capability: 'ownProfile', origin: 'trusted' },
    handler: async ({ env, owner }) => {
      return json(await removeOwnAvatar(env, owner) satisfies AvatarResponse);
    },
  }),

  // A picture for a GitHub issue. Upload is member-only; reading is not, and
  // cannot be — github.com renders an issue body with no Meet session in hand,
  // so an authenticated URL would be a broken image on the page the picture
  // exists for. See `issue-images.ts`.
  defineRoute({
    method: ['POST', 'PUT'],
    path: '/api/issue-images',
    gate: { kind: 'capability', capability: 'issueImages', origin: 'trusted' },
    handler: async ({ request, env, url }) => {
    const bytes = await readBoundedBytes(request, ISSUE_IMAGE_MAX_BYTES);
    return json(await storeIssueImage(env, bytes, url.origin) satisfies IssueImageResponse, 201);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/issue-images/:id',
    params: { id: { re: '[0-9a-f]{32}', sample: '00000000000000000000000000000001' } },
    gate: { kind: 'public', reason: "github.com renders an issue body with no Meet session; the address is a 32-hex id nobody can guess" },
    handler: async ({ env, params }) => serveIssueImage(env, params.id!),
  }),
];
