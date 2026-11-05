import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

async function ownerHeaders() {
  const email = `quick-note-${crypto.randomUUID()}@example.com`;
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Quick Note test', email }),
  }));
  const session = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${session.access_token}` };
}

describe('Quick Notes', () => {
  it('captures an unfiled note and reads it back in owner order', async () => {
    const headers = await ownerHeaders();
    const createdResponse = await exports.default.fetch(new Request('http://local/api/quick-notes', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        body: 'Ask Core about the partner handoff.',
        source: 'work',
      }),
    }));

    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json<{ note: { id: string; body: string; source: string; state: string; context: null } }>();
    expect(created.note).toMatchObject({
      body: 'Ask Core about the partner handoff.',
      source: 'work',
      state: 'open',
      context: null,
    });

    const listResponse = await exports.default.fetch(new Request('http://local/api/quick-notes', { headers }));
    expect(listResponse.status).toBe(200);
    const listed = await listResponse.json<{ notes: Array<{ id: string; body: string }> }>();
    expect(listed.notes.find((note) => note.id === created.note.id)).toMatchObject({
      id: created.note.id,
      body: 'Ask Core about the partner handoff.',
    });
  });

  // meet#1093: a phone saves first and sends later, maybe twice.
  it('takes the id the client minted, and a repeat send returns that note instead of a second', async () => {
    const headers = await ownerHeaders();
    const id = crypto.randomUUID();
    const written = Date.now() - 60 * 60 * 1000;
    const send = () => exports.default.fetch(new Request('http://local/api/quick-notes', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Written on the train.', source: 'home', id, captured_at: written }),
    }));

    const first = await send();
    expect(first.status).toBe(201);
    const made = await first.json<{ note: { id: string; created_at: string } }>();
    expect(made.note.id).toBe(id);
    expect(made.note.created_at).toBe(new Date(written).toISOString());

    const again = await send();
    expect(again.status).toBe(200);
    expect((await again.json<{ note: { id: string } }>()).note.id).toBe(id);

    const listed = await (await exports.default.fetch(new Request('http://local/api/quick-notes', { headers })))
      .json<{ notes: Array<{ id: string }> }>();
    expect(listed.notes.filter((note) => note.id === id)).toHaveLength(1);
  });

  it('keeps a capture time inside the window and never in the future', async () => {
    const headers = await ownerHeaders();
    const send = async (captured_at: number) => {
      const response = await exports.default.fetch(new Request('http://local/api/quick-notes', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'Clock check.', id: crypto.randomUUID(), captured_at }),
      }));
      return Date.parse((await response.json<{ note: { created_at: string } }>()).note.created_at);
    };
    const before = Date.now();
    expect(await send(before + 24 * 60 * 60 * 1000)).toBeLessThanOrEqual(Date.now());
    expect(await send(1)).toBeGreaterThanOrEqual(before - 30 * 24 * 60 * 60 * 1000);
  });

  it('rejects an empty capture before it reaches the note store', async () => {
    const response = await exports.default.fetch(new Request('http://local/api/quick-notes', {
      method: 'POST',
      headers: { ...(await ownerHeaders()), 'content-type': 'application/json' },
      body: JSON.stringify({ body: '   ' }),
    }));
    expect(response.status).toBe(400);
  });

  it('marks a note as promoted and can delete it from the inbox', async () => {
    const headers = await ownerHeaders();
    const createdResponse = await exports.default.fetch(new Request('http://local/api/quick-notes', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'File this after the call.', source: 'work' }),
    }));
    const created = await createdResponse.json<{ note: { id: string } }>();

    const promotedResponse = await exports.default.fetch(new Request(
      `http://local/api/quick-notes/${created.note.id}/promote`,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'task', id: crypto.randomUUID() }),
      },
    ));
    expect(promotedResponse.status).toBe(200);
    expect(await promotedResponse.json<{ note: { state: string; promotion: { kind: string } } }>()).toMatchObject({
      note: { state: 'promoted', promotion: { kind: 'task' } },
    });

    const deletedResponse = await exports.default.fetch(new Request(
      `http://local/api/quick-notes/${created.note.id}`,
      { method: 'DELETE', headers },
    ));
    expect(deletedResponse.status).toBe(200);
    expect(await deletedResponse.json<{ ok: true }>()).toEqual({ ok: true });

    const missingResponse = await exports.default.fetch(new Request(
      `http://local/api/quick-notes/${created.note.id}`,
      { method: 'DELETE', headers },
    ));
    expect(missingResponse.status).toBe(404);
  });

  it('rewrites a note body, capitalises its first letter, and keeps the rest', async () => {
    const headers = await ownerHeaders();
    const created = await (await exports.default.fetch(new Request('http://local/api/quick-notes', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'call the partner back' }),
    }))).json<{ note: { id: string; body: string; created_at: string } }>();
    expect(created.note.body).toBe('Call the partner back');

    const updatedResponse = await exports.default.fetch(new Request(
      `http://local/api/quick-notes/${created.note.id}`,
      {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ body: '  call the partner back tomorrow  ' }),
      },
    ));
    expect(updatedResponse.status).toBe(200);
    expect(await updatedResponse.json<{ note: { body: string; state: string; created_at: string } }>()).toMatchObject({
      note: { body: 'Call the partner back tomorrow', state: 'open', created_at: created.note.created_at },
    });

    const emptyResponse = await exports.default.fetch(new Request(
      `http://local/api/quick-notes/${created.note.id}`,
      {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ body: ' ' }),
      },
    ));
    expect(emptyResponse.status).toBe(400);
  });

  it('accepts every destination and a non-uuid id like a GitHub issue', async () => {
    const headers = await ownerHeaders();
    const cases: Array<[string, string]> = [
      ['issue', 'envisioning/starlings#134'],
      ['message', crypto.randomUUID()],
      ['doc', crypto.randomUUID()],
      ['retained_note', crypto.randomUUID()],
    ];
    for (const [kind, id] of cases) {
      const created = await (await exports.default.fetch(new Request('http://local/api/quick-notes', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ body: `File as ${kind}.`, source: 'work' }),
      }))).json<{ note: { id: string } }>();
      const promoted = await exports.default.fetch(new Request(
        `http://local/api/quick-notes/${created.note.id}/promote`,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ kind, id }),
        },
      ));
      expect(promoted.status, kind).toBe(200);
      expect(await promoted.json<{ note: { promotion: { kind: string; id: string } } }>()).toMatchObject({
        note: { promotion: { kind, id } },
      });
    }

    const rejected = await exports.default.fetch(new Request('http://local/api/quick-notes', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Nowhere.', source: 'work' }),
    }));
    const note = await rejected.json<{ note: { id: string } }>();
    const unknown = await exports.default.fetch(new Request(
      `http://local/api/quick-notes/${note.note.id}/promote`,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'email', id: crypto.randomUUID() }),
      },
    ));
    expect(unknown.status).toBe(400);
  });

  it('requires an owner session', async () => {
    const response = await exports.default.fetch(new Request('http://local/api/quick-notes'));
    expect(response.status).toBe(401);
  });
});
