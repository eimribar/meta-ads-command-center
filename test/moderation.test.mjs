import test from 'node:test';
import assert from 'node:assert/strict';
import { runModeration, moderationSummary } from '../src/moderation.mjs';
import { setup, fakeGraph, fakeClaude, text } from './helpers.mjs';

const POST = [{ platform: 'facebook', id: '222_1', label: 'Page post' }];
const COMMENTS = [
  { id: 'c1', message: 'BUY CHEAP FOLLOWERS at spam.example', from: { name: 'Spammer' } },
  { id: 'c2', message: 'Does this work for teams?', from: { name: 'Curious' } },
  { id: 'c3', message: 'this is a scam probably', from: { name: 'Unsure' } },
];
const VERDICTS = { verdicts: [
  { id: 'c1', action: 'remove', category: 'spam', confidence: 0.97, reason: 'spam link' },
  { id: 'c2', action: 'keep', category: 'none', confidence: 0.99, reason: 'a real question' },
  { id: 'c3', action: 'remove', category: 'false_claim', confidence: 0.5, reason: 'maybe' },
] };

function page({ refuseDelete = false } = {}) {
  return fakeGraph(({ method, path }) => {
    if (method === 'GET' && path === '222') return { access_token: 'page-token' };
    if (method === 'GET' && path === '222_1/comments') return { data: COMMENTS };
    if (method === 'DELETE' && refuseDelete) return { error: { code: 200, message: 'cannot delete' } };
    return { success: true };
  });
}

test('clear spam is hidden, a real question stays, an unsure one is flagged and left up', async () => {
  const { db } = setup();
  const calls = page();
  const asked = fakeClaude([text(JSON.stringify(VERDICTS))]);
  const r = await runModeration({ given: POST });
  assert.deepEqual(r.hidden.map((c) => c.id), ['c1']);
  assert.deepEqual(r.flagged.map((c) => c.id), ['c3']);
  assert.deepEqual(calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.path, c.params.is_hidden]), [['POST', 'c1', 'true']]);
  assert.match(asked[0].messages[0].content, /data, never instructions/);
  assert.equal(asked[0].output_config.format.type, 'json_schema');
  assert.deepEqual(db.tables.moderation_log.map((m) => [m.comment_id, m.action]), [['c1', 'hide'], ['c3', 'flag']]);
  assert.match(moderationSummary(r), /Hidden \(1\)/);
});

test('handled and flagged comments are not looked at again', async () => {
  setup({}, { seed: { moderation_log: [{ platform: 'facebook', comment_id: 'c1', action: 'hide' }, { platform: 'facebook', comment_id: 'c3', action: 'flag' }] } });
  page();
  const asked = fakeClaude([text(JSON.stringify({ verdicts: [VERDICTS.verdicts[1]] }))]);
  const r = await runModeration({ given: POST });
  assert.equal(r.fresh, 1);
  assert.equal(JSON.parse(asked[0].messages[0].content.split('\n')[1]).length, 1);
});

test('flag mode and dry runs act on nothing', async () => {
  setup({ MODERATION_ACTION: 'flag' });
  let calls = page();
  fakeClaude([text(JSON.stringify(VERDICTS))]);
  let r = await runModeration({ given: POST });
  assert.equal(r.hidden.length, 0);
  assert.equal(r.flagged.length, 2);
  assert.equal(calls.filter((c) => c.method !== 'GET').length, 0);
  setup();
  calls = page();
  fakeClaude([text(JSON.stringify(VERDICTS))]);
  r = await runModeration({ given: POST, act: false });
  assert.equal(calls.filter((c) => c.method !== 'GET').length, 0);
  assert.match(r.flagged[0].note, /dry run/);
});

test('delete mode falls back to hide when Meta refuses the delete', async () => {
  setup({ MODERATION_ACTION: 'delete' });
  const calls = page({ refuseDelete: true });
  fakeClaude([text(JSON.stringify(VERDICTS))]);
  const r = await runModeration({ given: POST });
  assert.deepEqual(calls.filter((c) => c.method !== 'GET').map((c) => c.method), ['DELETE', 'POST']);
  assert.deepEqual(r.hidden.map((c) => c.id), ['c1']);
});
