import { quickNoteCreateSchema, quickNotePromoteSchema, quickNoteUpdateSchema } from '../contracts';
import { json, readBoundedJSON } from '../http';
import { defineRoute, type Route } from '../route-types';
import { quickNotesStub } from '../do-jurisdiction';

export const notesRoutes: readonly Route[] = [
  // Quick Notes are the unfiled capture layer from. They live in an
  // owner-scoped Durable Object because a note is private work-in-progress,
  // not a Core task yet: task creation still requires exactly one subject.
  // "Only you": an agent acting as the owner is refused.
  defineRoute({
    method: 'GET',
    path: '/api/quick-notes',
    gate: { kind: 'capability', capability: 'crmWork', agents: 'refuse' },
    handler: async ({ env, owner }) => {
      const notes = await quickNotesStub(env, owner.sub);
      return notes.fetch('https://quick-notes/notes');
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/quick-notes',
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted', agents: 'refuse' },
    handler: async ({ request, env, owner }) => {
      const notes = await quickNotesStub(env, owner.sub);
      const body = quickNoteCreateSchema.parse(await readBoundedJSON(request));
      return notes.fetch(new Request('https://quick-notes/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }));
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/api/quick-notes/:id',
    params: { id: { re: '[0-9a-fA-F-]{36}', sample: '00000000-0000-4000-8000-000000000001' } },
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted', agents: 'refuse' },
    handler: async ({ env, owner, params }) => {
      const notes = await quickNotesStub(env, owner.sub);
      return notes.fetch(new Request(`https://quick-notes/notes/${params.id!}`, { method: 'DELETE' }));
    },
  }),

  defineRoute({
    method: 'PATCH',
    path: '/api/quick-notes/:id',
    params: { id: { re: '[0-9a-fA-F-]{36}', sample: '00000000-0000-4000-8000-000000000001' } },
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted', agents: 'refuse' },
    handler: async ({ request, env, owner, params }) => {
      const notes = await quickNotesStub(env, owner.sub);
      const body = quickNoteUpdateSchema.parse(await readBoundedJSON(request));
      return notes.fetch(new Request(`https://quick-notes/notes/${params.id!}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }));
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/quick-notes/:id/promote',
    params: { id: { re: '[0-9a-fA-F-]{36}', sample: '00000000-0000-4000-8000-000000000001' } },
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted', agents: 'refuse' },
    handler: async ({ request, env, owner, params }) => {
      const notes = await quickNotesStub(env, owner.sub);
      const body = quickNotePromoteSchema.parse(await readBoundedJSON(request));
      return notes.fetch(new Request(`https://quick-notes/notes/${params.id!}/promote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }));
    },
  }),
];
