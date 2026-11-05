import { attentionFromOpenQuestion, type AttentionRequest } from '@starlings/contracts/attention';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ThreadCreateInput, ThreadKind, ThreadMessage, ThreadMessageRef, ThreadSummary } from '@starlings/contracts';
import { apiFetch } from './api';
import { ThreadPane } from './ThreadPane';

vi.mock('./api', () => ({
  apiFetch: vi.fn(),
  apiUpload: vi.fn(),
  apiObjectURL: vi.fn(async () => null),
}));
vi.mock('./owner-session', () => ({ useOwnerSession: () => ({ kind: 'owner', owner: { email: 'ada@example.com' } }) }));
vi.mock('./search-doors', () => ({ storeRecent: vi.fn() }));

const apiFetchMock = vi.mocked(apiFetch);
const subjectAddress: ThreadCreateInput = {
  kind: 'project',
  subject_id: '00000000-0000-4000-8000-000000000001',
};

function thread(kind: ThreadKind = 'project'): ThreadSummary {
  return {
    id: 'subject-thread', kind, parent_id: 'subject-id', audience: 'everyone',
    title: 'Project Talk', peer_email: null, peer_name: null, peers: [],
    last_message_at: null, last_message_preview: null, last_sender_email: null,
    unread: false, last_read_at: 0, has_mention: false, muted_until: null, archived_at: null,
  };
}

function message(id: string, text: string, overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id, thread_id: 'subject-thread', sent_at: Date.now() - 2_000,
    sender_email: 'ada@example.com', sender_name: 'Ada Lovelace', text,
    is_mine: false, type: 'text', ...overrides,
  };
}

function questionMessage(mode: 'single' | 'multiple' = 'single'): ThreadMessage {
  return message('agent-question', 'Which direction should I take?', {
    sender_email: 'agent-vocab@example.com', sender_name: 'Vocab',
    question: { mode, options: [
      { id: 'concise', label: 'Keep it concise' },
      { id: 'examples', label: 'Include examples' },
    ] },
  });
}

function setup(messages: ThreadMessage[], options: {
  request?: AttentionRequest;
  kind?: ThreadKind;
  olderCursor?: string | null;
  olderMessages?: ThreadMessage[];
  send?: () => unknown;
  onOpenRef?: (ref: ThreadMessageRef) => void;
} = {}) {
  const summary = thread(options.kind);
  const olderCursor = options.olderCursor ?? null;
  apiFetchMock.mockImplementation((async (path: string, request: { method?: string; body?: unknown } = {}) => {
    if (path.startsWith('/attention?')) return { requests: options.request ? [options.request] : [] };
    if (path.includes('/attention/') && request.method === 'POST') return { accepted: false, request: { ...options.request, state: 'dismissed', revision: 1 } };
    if (path === '/threads') return { thread: summary };
    if (path.includes('/messages?before=')) {
      return { thread: summary, messages: options.olderMessages ?? [], older_cursor: null };
    }
    if (path.endsWith('/messages') && request.method === 'POST') {
      if (options.send) return options.send();
      return { message: message('sent-reply', 'My reply', { is_mine: true, reply_to_message_id: 'parent' }) };
    }
    if (path === '/quick-notes' && request.method === 'POST') {
      return { note: { id: 'quick-note-1', body: 'My note', source: 'work', context: null, state: 'open', promotion: null, created_at: '', updated_at: '' } };
    }
    if (path.endsWith('/reactions') && request.method === 'POST') {
      return { message_id: 'mine', reactions: [] };
    }
    if (path.includes('/questions/') && request.method === 'POST') {
      const questionID = path.split('/questions/')[1]!.split('/')[0]!;
      const body = request.body as { option_ids: string[] };
      const labelsByID: Record<string, string> = { concise: 'Keep it concise', examples: 'Include examples' };
      const labels = body.option_ids.map((id) => labelsByID[id] ?? id);
      return { accepted: true, message: message('answer-1', labels.join(', '), {
        is_mine: true, reply_to_message_id: questionID,
        question_answer: { question_message_id: questionID, option_ids: body.option_ids, option_labels: labels },
      }) };
    }
    if (path.includes('/messages/') && request.method === 'PATCH') return {};
    if (path.endsWith('/messages')) return { thread: summary, messages, older_cursor: olderCursor };
    return {};
  }) as typeof apiFetch);
  return render(<ThreadPane address={subjectAddress} title="Talk" onOpenRef={options.onOpenRef} />);
}

async function openMessageMenu(text: string) {
  const row = screen.getByText(text).closest<HTMLElement>('li[data-message]');
  if (!row) throw new Error(`No message row for ${text}`);
  const bubble = row.querySelector<HTMLElement>('[data-bubble]');
  if (!bubble) throw new Error(`No message bubble for ${text}`);
  fireEvent.contextMenu(bubble);
  return screen.findByRole('menu');
}

beforeEach(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  apiFetchMock.mockReset();
});

afterEach(() => {
  delete (HTMLElement.prototype as unknown as { scrollIntoView?: (options?: ScrollIntoViewOptions) => void }).scrollIntoView;
});

describe('subject Talk replies', () => {
  it('shows canonical dismissal without a reply or active choices', async () => {
    const source = questionMessage();
    const request = { ...attentionFromOpenQuestion(source, source.question!, 'ada@example.com'), state: 'dismissed' as const, revision: 1 };
    setup([source], { request });
    expect(await screen.findByText('Dismissed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Keep it concise' })).toBeNull();
  });
  it('shows the assigned recipient instead of choices for another reader', async () => {
    const source = questionMessage();
    setup([source], { request: attentionFromOpenQuestion(source, source.question!, 'grace@example.com') });
    expect(await screen.findByText('Waiting on grace@example.com')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Keep it concise' })).toBeNull();
  });
  it('submits the canonical request and adopts a dismissal that won elsewhere', async () => {
    const source = questionMessage();
    const request = attentionFromOpenQuestion(source, source.question!, 'ada@example.com');
    setup([source], { request });
    await screen.findByText('Which direction should I take?');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Keep it concise' }).closest('fieldset') as HTMLFieldSetElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Keep it concise' }));
    expect(await screen.findByText('Dismissed')).toBeTruthy();
    expect(apiFetchMock.mock.calls.some(([path]) => path === `/attention/${encodeURIComponent(request.id)}/resolve`)).toBe(true);
    expect(apiFetchMock.mock.calls.some(([path]) => path.includes('/questions/'))).toBe(false);
  });

  it('submits a single selection immediately without a submit button', async () => {
    setup([questionMessage()]);
    await screen.findByText('Which direction should I take?');
    expect(screen.getByText('Asked by Vocab')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Submit answer' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Keep it concise' }));

    await waitFor(() => {
      const call = apiFetchMock.mock.calls.find(([path]) => path.endsWith('/questions/agent-question/answer'));
      expect(call?.[1]?.body).toEqual({ option_ids: ['concise'] });
    });
    expect(await screen.findByText('Answered by Ada Lovelace')).toBeTruthy();
  });

  it('submits multiple selections together', async () => {
    setup([questionMessage('multiple')]);
    await screen.findByText('Which direction should I take?');
    fireEvent.click(screen.getByRole('button', { name: 'Keep it concise' }));
    fireEvent.click(screen.getByRole('button', { name: 'Include examples' }));
    expect(screen.getByRole('button', { name: 'Keep it concise' }).getAttribute('aria-pressed')).toBe('true');
    expect(apiFetchMock.mock.calls.some(([path]) => path.endsWith('/questions/agent-question/answer'))).toBe(false);
    const submit = screen.getByRole('button', { name: 'Submit answer' });
    expect(submit.getAttribute('data-variant')).toBe('default');
    expect(submit.getAttribute('data-size')).toBe('lg');
    fireEvent.click(submit);

    await waitFor(() => {
      const call = apiFetchMock.mock.calls.find(([path]) => path.endsWith('/questions/agent-question/answer'));
      expect(call?.[1]?.body).toEqual({ option_ids: ['concise', 'examples'] });
    });
  });

  it('keeps a selected reply through sending and includes its parent id', async () => {
    setup([message('parent', 'The project should use the shorter wording.')]);
    await screen.findByText('The project should use the shorter wording.');

    fireEvent.click(within(await openMessageMenu('The project should use the shorter wording.')).getByRole('menuitem', { name: 'Reply' }));
    expect(screen.getByText('Replying to Ada Lovelace')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Agreed.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      const call = apiFetchMock.mock.calls.find(([path, request]) => path === '/threads/subject-thread/messages' && request?.method === 'POST');
      expect(call?.[1]?.body).toEqual(expect.objectContaining({
        text: 'Agreed.', mentions: [], attachments: [], reply_to_message_id: 'parent',
      }));
    });
    await waitFor(() => expect(screen.queryByText('Replying to Ada Lovelace')).toBeNull());
  });

  it('cancels reply context without discarding the draft', async () => {
    setup([message('parent', 'Parent message')]);
    await screen.findByText('Parent message');
    fireEvent.click(within(await openMessageMenu('Parent message')).getByRole('menuitem', { name: 'Reply' }));
    const composer = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(composer, { target: { value: 'Keep this draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel reply' }));

    expect((composer as HTMLTextAreaElement).value).toBe('Keep this draft');
    expect(screen.queryByText('Replying to Ada Lovelace')).toBeNull();
  });

  it('keeps reply context and text available for retry after a send failure', async () => {
    let attempts = 0;
    setup([message('parent', 'Parent message')], {
      send: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('offline');
        return { message: message('sent-reply', 'Retry succeeded', { is_mine: true, reply_to_message_id: 'parent' }) };
      },
    });
    await screen.findByText('Parent message');
    fireEvent.click(within(await openMessageMenu('Parent message')).getByRole('menuitem', { name: 'Reply' }));
    const composer = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(composer, { target: { value: 'Try again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('offline');

    expect((composer as HTMLTextAreaElement).value).toBe('Try again');
    expect(screen.getByText('Replying to Ada Lovelace')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(attempts).toBe(2));
    await waitFor(() => expect(screen.queryByText('Replying to Ada Lovelace')).toBeNull());
    const sends = apiFetchMock.mock.calls.filter(([path, request]) => path === '/threads/subject-thread/messages' && request?.method === 'POST');
    expect(sends).toHaveLength(2);
    expect(sends.every(([, request]) => (request?.body as { reply_to_message_id?: string }).reply_to_message_id === 'parent')).toBe(true);
  });

  it('edits a reply without changing its parent relationship', async () => {
    const parent = message('parent', 'Parent message');
    const reply = message('my-reply', 'My earlier reply', { is_mine: true, reply_to_message_id: 'parent' });
    setup([parent, reply]);
    await screen.findByText('My earlier reply');

    fireEvent.click(within(await openMessageMenu('My earlier reply')).getByRole('menuitem', { name: 'Edit' }));
    expect(screen.getByText('Replying to Ada Lovelace')).toBeTruthy();
    // The menu gives focus to the composer once it closes, so typing lands there.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Edit message' })));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit message' }), { target: { value: 'Edited reply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const call = apiFetchMock.mock.calls.find(([path, request]) => path.endsWith('/messages/my-reply') && request?.method === 'PATCH');
      expect(call?.[1]?.body).toEqual({ text: 'Edited reply' });
    });
  });

  it('loads an older page and scrolls to the parent from a reply preview', async () => {
    const child = message('child', 'Following up', { reply_to_message_id: 'parent' });
    setup([child], { olderCursor: 'older-1', olderMessages: [message('parent', 'Earlier decision')] });
    await screen.findByText('Following up');
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });

    fireEvent.click(screen.getByRole('button', { name: 'Jump to earlier message' }));

    await screen.findAllByText('Earlier decision');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' }));
    expect(apiFetchMock.mock.calls.some(([path]) => path === '/threads/subject-thread/messages?before=older-1')).toBe(true);
  });

  it('redacts withdrawn parent text and attachments in the preview', async () => {
    const withdrawn = message('parent', 'Secret text from before withdrawal', {
      deleted_at: Date.now(), attachments: [{ id: 'file-1', name: 'private.pdf', content_type: 'application/pdf', bytes: 4 }],
    });
    const child = message('child', 'A reply remains', { reply_to_message_id: 'parent', is_mine: true });
    setup([withdrawn, child]);
    await screen.findByText('A reply remains');

    const previews = screen.getAllByRole('button', { name: "Jump to Ada Lovelace’s message" });
    expect(previews.some(preview => preview.textContent?.includes('Message withdrawn'))).toBe(true);
    expect(previews.every(preview => !preview.textContent?.includes('private.pdf'))).toBe(true);
    expect(screen.queryByText('Secret text from before withdrawal')).toBeNull();
    expect(screen.queryByText(/private\.pdf/u)).toBeNull();
  });

  it('shows only a generic label for a parent with an attachment', async () => {
    const parent = message('parent', '', {
      attachments: [{ id: 'file-1', name: 'private.pdf', content_type: 'application/pdf', bytes: 4 }],
    });
    const child = message('child', 'A reply remains', { reply_to_message_id: 'parent' });
    setup([parent, child]);
    await screen.findByText('A reply remains');

    const preview = screen.getByRole('button', { name: "Jump to Ada Lovelace’s message" });
    expect(preview.textContent).toContain('Attachment');
    expect(preview.textContent).not.toContain('private.pdf');
  });

  it('does not show reply controls in the Everyone channel', async () => {
    setup([message('message', 'Company channel line')], { kind: 'team' });
    await screen.findByText('Company channel line');
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
    await openMessageMenu('Company channel line');
    expect(screen.queryByRole('menuitem', { name: 'Reply' })).toBeNull();
  });

  it.each(['project', 'lead', 'organization', 'event'] as const)(
    'offers replies in %s Talk', async (kind) => {
      setup([message('message', 'Subject Talk line')], { kind });
      await screen.findByText('Subject Talk line');
      expect(screen.queryByRole('menuitem', { name: 'Reply' })).toBeNull();
      expect(within(await openMessageMenu('Subject Talk line')).getByRole('menuitem', { name: 'Reply' })).toBeTruthy();
    },
  );

  it('opens the same compact menu from the message context menu', async () => {
    setup([message('parent', 'Use the approved wording.')]);
    await screen.findByText('Use the approved wording.');
    const row = screen.getByText('Use the approved wording.').closest<HTMLElement>('li[data-message]');
    const bubble = row?.querySelector<HTMLElement>('[data-bubble]');
    expect(bubble).toBeTruthy();

    fireEvent.contextMenu(bubble!);

    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Reply' })).toBeTruthy();
    // Reactions head the menu, as on the Mac.
    expect(within(menu).getAllByRole('menuitem', { name: /^React with / }).length).toBeGreaterThan(0);
    expect(within(menu).getByRole('menuitem', { name: 'Copy' })).toBeTruthy();

    fireEvent.keyDown(within(menu).getByRole('menuitem', { name: 'Reply' }), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(bubble));

    fireEvent.keyDown(bubble!, { key: 'F10', shiftKey: true });
    await screen.findByRole('menu');
  });

  it('lets you react to and save a copy of your own message', async () => {
    setup([message('mine', 'My note', { is_mine: true })]);
    await screen.findByText('My note');

    const menu = within(await openMessageMenu('My note'));
    fireEvent.click(menu.getByRole('menuitem', { name: 'React with Thumbs up' }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith(
      '/threads/subject-thread/messages/mine/reactions',
      expect.objectContaining({ method: 'POST', body: { emoji: '👍' } }),
    ));

    const secondMenu = within(await openMessageMenu('My note'));
    fireEvent.click(secondMenu.getByRole('menuitem', { name: 'Save as Quick Note' }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith(
      '/quick-notes',
      // A client id and the capture time ride along, so a retry is the same note (meet#1093).
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({ body: 'My note', source: 'work', context: null, id: expect.any(String), captured_at: expect.any(Number) }),
      }),
    ));
  });

});

describe('ref chips under an event line', () => {
  it('draws a chip that opens something as a named link, and a meeting chip as a label', async () => {
    const onOpenRef = vi.fn();
    setup([message('event-1', 'Rosa via claude.ai filed #710 · Chips look clickable', {
      type: 'event', sender_email: 'meet@org.example', sender_name: 'Meet',
      refs: [{ kind: 'issue', id: 'envisioning/starlings#710' }, { kind: 'meeting', id: 'meeting-1' }],
    })], { onOpenRef });
    const chip = await screen.findByRole('button', { name: 'Open issue #710' });
    expect(chip.textContent).toBe('#710');
    expect(chip.getAttribute('title')).toBe('Open issue #710');
    fireEvent.click(chip);
    expect(onOpenRef).toHaveBeenCalledWith({ kind: 'issue', id: 'envisioning/starlings#710' });
    // A meeting has no door from a channel: a label, not a button that does nothing.
    expect(screen.getByText('Meeting').closest('button')).toBeNull();
  });
});

describe('conversation head', () => {
  function mockThread() {
    const summary = thread();
    apiFetchMock.mockImplementation((async (path: string) => {
      if (path === '/threads') return { thread: summary };
      if (path.endsWith('/messages')) return { thread: summary, messages: [], older_cursor: null };
      return {};
    }) as typeof apiFetch);
  }

  it('makes the title a button that opens the person when wired (meet#483)', async () => {
    mockThread();
    const onOpenPerson = vi.fn();
    render(<ThreadPane address={subjectAddress} title="Talk" fill onOpenPerson={onOpenPerson} />);

    const heading = await screen.findByRole('heading', { level: 2, name: 'Project Talk' });
    fireEvent.click(within(heading).getByRole('button', { name: 'About Project Talk' }));
    expect(onOpenPerson).toHaveBeenCalledTimes(1);
  });

  it('keeps the title plain text when nothing is wired', async () => {
    mockThread();
    render(<ThreadPane address={subjectAddress} title="Talk" fill />);

    const heading = await screen.findByRole('heading', { level: 2, name: 'Project Talk' });
    expect(within(heading).queryByRole('button')).toBeNull();
  });
});
