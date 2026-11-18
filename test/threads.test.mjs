// Thread replies: which messages the agent answers without a new mention.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMessage, threadIsOurs, threadCache } from '../src/slack/routing.mjs';

const ME = { botUserId: 'UBOT', botId: 'BBOT' };

const reply = (extra) => ({ channel_type: 'channel', channel: 'C1', user: 'UDANA', ts: '2.0', thread_ts: '1.0', text: 'and last week?', ...extra });

test('a thread reply with no mention is a candidate; mentions, bots and top level messages are not', () => {
  assert.equal(classifyMessage(reply(), ME), 'thread');
  assert.equal(classifyMessage(reply({ channel_type: 'group' }), ME), 'thread');
  assert.equal(classifyMessage(reply({ text: '<@UBOT> and last week?' }), ME), 'ignore');      // app_mention handles it
  assert.equal(classifyMessage(reply({ text: '<@UROB> can you check?' }), ME), 'ignore');      // for someone else
  assert.equal(classifyMessage(reply({ thread_ts: undefined }), ME), 'ignore');               // not in a thread
  assert.equal(classifyMessage(reply({ bot_id: 'BOTHER' }), ME), 'ignore');
  assert.equal(classifyMessage(reply({ user: 'UBOT' }), ME), 'ignore');
  assert.equal(classifyMessage(reply({ subtype: 'message_changed' }), ME), 'ignore');
  assert.equal(classifyMessage(reply({ subtype: 'thread_broadcast' }), ME), 'thread');
  assert.equal(classifyMessage({ channel_type: 'im', user: 'UDANA', ts: '1', text: 'hi' }, ME), 'dm');
});

test('a thread is the app\'s when it started it, was mentioned in it or answered in it', () => {
  assert.equal(threadIsOurs([{ user: 'UBOT', bot_id: 'BBOT', text: 'Desk' }, { user: 'UDANA', text: 'ok' }], ME), true);
  assert.equal(threadIsOurs([{ user: 'UDANA', text: '<@UBOT> how are we doing?' }], ME), true);
  assert.equal(threadIsOurs([{ user: 'UDANA', text: 'lunch?' }, { user: 'UBOT', text: 'answer' }], ME), true);
  assert.equal(threadIsOurs([{ user: 'UDANA', text: 'lunch?' }, { user: 'UROB', text: 'sure' }], ME), false);
  const c = threadCache({ ttlMs: 60_000 });
  assert.equal(c.get('C1:1.0'), undefined);
  c.set('C1:1.0', false); assert.equal(c.get('C1:1.0'), false);
  c.set('C1:1.0', true); assert.equal(c.get('C1:1.0'), true);
});
