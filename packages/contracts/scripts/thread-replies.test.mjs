import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  threadMessageSchema,
  threadMessageSendSchema,
} from '../src/index.ts';
import { wireSchemas } from '../src/wire.ts';

const legacyMessage = {
  id: 'message-1',
  thread_id: 'thread-1',
  sent_at: 1_760_000_000_000,
  sender_email: 'ada@example.com',
  sender_name: 'Ada',
  text: 'Hello',
  is_mine: false,
  type: 'text',
};

test('thread reply fields share the registered response and input contracts', () => {
  assert.equal(wireSchemas.ThreadMessageWire, threadMessageSchema);
  assert.deepEqual(wireSchemas.ThreadSendRequest, { schema: threadMessageSendSchema, io: 'input' });
});

test('older messages without a reply parent remain valid', () => {
  const parsed = threadMessageSchema.parse(legacyMessage);
  assert.equal(parsed.reply_to_message_id, undefined);
});

test('message replies accept null or a parent id and reject malformed values', () => {
  assert.equal(threadMessageSchema.parse({ ...legacyMessage, reply_to_message_id: null }).reply_to_message_id, null);
  assert.equal(threadMessageSchema.parse({ ...legacyMessage, reply_to_message_id: 'parent-1' }).reply_to_message_id, 'parent-1');
  assert.equal(threadMessageSchema.safeParse({ ...legacyMessage, reply_to_message_id: 42 }).success, false);
});

test('send requests may omit, clear, or set the reply parent', () => {
  assert.equal(threadMessageSendSchema.parse({ text: 'Hello' }).reply_to_message_id, undefined);
  assert.equal(threadMessageSendSchema.parse({ text: 'Hello', reply_to_message_id: null }).reply_to_message_id, null);
  assert.equal(threadMessageSendSchema.parse({ text: 'Hello', reply_to_message_id: 'parent-1' }).reply_to_message_id, 'parent-1');
  assert.equal(threadMessageSendSchema.safeParse({ text: 'Hello', reply_to_message_id: 42 }).success, false);
});
