import test from 'node:test';
import assert from 'node:assert/strict';
import { ask } from '../src/agent.mjs';
import { setup, fakeClaude, toolUse, text } from './helpers.mjs';
import { fakeAccount } from './account-fake.mjs';

test('an operator order is done and the footer says what changed', async () => {
  setup();
  const acct = fakeAccount();
  const requests = fakeClaude([
    toolUse('o1', 'execute_order', { op: 'set_status', level: 'ad', target_id: '30', status: 'PAUSED' }),
    text('Paused the Loser ad.'),
  ]);
  const out = await ask([{ role: 'user', content: 'pause the loser ad' }], { actor: 'UOPERATOR', key: 'chat:test:1' });
  assert.deepEqual(acct.writes().map((w) => [w.path, w.params.status]), [['30', 'PAUSED']]);
  assert.match(out.text, /^Paused the Loser ad\./);
  assert.match(out.text, /_Actions this turn: paused ad Loser_/);
  // the live facts ride in the user turn, the system prompt stays stable
  const first = requests[0].messages[0].content;
  assert.match(first[0].text, /Target cost per test rides: \$150/);
  assert.match(first[0].text, /is an operator/);
  assert.equal(first[1].text, 'pause the loser ad');
  assert.match(requests[0].system[1].text, /The brain is empty/);
});

test('a non-operator never sees the write tools, and a claimed change cannot appear in the footer', async () => {
  setup();
  const acct = fakeAccount();
  const requests = fakeClaude([text('Done, I paused it for you.')]);
  const out = await ask([{ role: 'user', content: 'pause ad 30' }], { actor: 'USOMEONE' });
  const names = requests[0].tools.map((t) => t.name);
  assert.ok(!names.includes('execute_order') && !names.includes('file_proposal') && !names.includes('comment_action'));
  assert.match(requests[0].messages[0].content[0].text, /not an operator/);
  assert.match(out.text, /_No account changes this turn \(read only\)\._/);
  assert.equal(acct.writes().length, 0);
});

test('an order above the ceiling is refused and the footer says so', async () => {
  setup({ MAX_DAILY_BUDGET: '150' });
  const acct = fakeAccount();
  fakeClaude([toolUse('o1', 'execute_order', { op: 'set_budget', level: 'adset', target_id: '20', daily_budget: 400 }), text('The ceiling stopped that.')]);
  const out = await ask([{ role: 'user', content: 'set broad to 400 a day' }], { actor: 'UOPERATOR', key: 'chat:test:2' });
  assert.equal(acct.writes().length, 0);
  assert.match(out.text, /_Not done: execute_order \(REFUSED: .*daily ceiling/);
});

test('an order is read back from Meta and kept with the operator\'s words', async () => {
  const { db } = setup();
  fakeAccount();
  const requests = fakeClaude([toolUse('o1', 'execute_order', { op: 'set_budget', level: 'adset', target_id: '20', daily_budget: 140 }), text('Set.')]);
  await ask([{ role: 'user', content: 'set broad to 140 a day' }], { actor: 'UOPERATOR', key: 'chat:test:3' });
  const result = JSON.parse(requests[1].messages.at(-1).content[0].content);
  assert.deepEqual(result.read_back, { daily_budget: 140 });
  const order = db.tables.timeline.find((t) => t.event === 'order');
  assert.equal(order.detail.words, 'set broad to 140 a day');
  assert.deepEqual(order.detail.result, { before: 100, after: 140 });
});
