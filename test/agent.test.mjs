import test from 'node:test';
import assert from 'node:assert/strict';
import { ask } from '../src/agent.mjs';
import { setup, fakeClaude, toolUse, text, fakeSlack, fakeApp, fakeGraph } from './helpers.mjs';
import { setRuntime } from '../src/runtime.mjs';
import { registerApprovals } from '../src/slack/approvals.mjs';
import { fakeAccount } from './account-fake.mjs';

// Order the agent, then tap the card it posts.
async function orderAndConfirm({ words, call, tapper = 'UOPERATOR', key = 'chat:test:1' }) {
  const slack = fakeSlack();
  setRuntime({ slack });
  const requests = fakeClaude([toolUse('o1', 'execute_order', call), text('The card is up.')]);
  const out = await ask([{ role: 'user', content: words }], { actor: 'UOPERATOR', key, thread: { channel: 'CTEST', thread_ts: '1' } });
  const card = slack.calls.find((c) => c.name === 'chat.postMessage' && c.args.blocks?.some((b) => b.type === 'actions'));
  const app = fakeApp();
  registerApprovals(app);
  const button = (id) => card.args.blocks.find((b) => b.type === 'actions').elements.find((e) => e.action_id === id);
  const tap = (id, user = tapper) => app.actions[id]({ ack: async () => {}, body: { type: 'block_actions', user: { id: user }, channel: { id: 'CTEST' }, message: { ts: card ? '1001' : null } }, action: button(id), client: slack });
  return { slack, requests, out, card, tap };
}

test('an order posts a card naming the change, and nothing changes until an operator taps Confirm', async () => {
  setup();
  const acct = fakeAccount();
  const { requests, out, card, tap, slack } = await orderAndConfirm({ words: 'pause the loser ad', call: { op: 'set_status', level: 'ad', target_id: '30', status: 'PAUSED' } });
  assert.ok(card, 'a card was posted');
  assert.match(JSON.stringify(card.args.blocks), /Pause ad \*Loser\*/);
  assert.equal(acct.writes().length, 0, 'the message alone changes nothing');
  assert.match(out.text, /_Actions this turn: posted a card to confirm: Pause ad Loser/);
  // the live facts ride in the user turn, the system prompt stays stable
  const first = requests[0].messages[0].content;
  assert.match(first[0].text, /Target cost per test rides: \$150/);
  assert.match(first[0].text, /is an operator/);
  assert.equal(first[1].text, 'From <@UOPERATOR> (an operator): pause the loser ad');
  assert.match(requests[0].system[1].text, /The brain is empty/);
  await tap('order_confirm');
  assert.deepEqual(acct.writes().map((w) => [w.path, w.params.status]), [['30', 'PAUSED']]);
  assert.match(JSON.stringify(slack.calls.at(-1).args.blocks), /Paused\. Meta now shows it paused/);
  await tap('order_confirm');
  assert.equal(acct.writes().length, 1, 'a second tap does nothing');
  assert.match(slack.calls.at(-1).args.text, /Already done/);
});

test('an order above the ceiling is refused when it is confirmed, and the card says so', async () => {
  setup({ MAX_DAILY_BUDGET: '150' });
  const acct = fakeAccount();
  const { tap, slack } = await orderAndConfirm({ words: 'set broad to 400 a day', call: { op: 'set_budget', level: 'adset', target_id: '20', daily_budget: 400 }, key: 'chat:test:2' });
  await tap('order_confirm');
  assert.equal(acct.writes().length, 0);
  assert.match(JSON.stringify(slack.calls.at(-1).args.blocks), /Not done: REFUSED: .*daily ceiling/);
});

test('a confirmed order is read back from Meta and kept with the operator\'s words', async () => {
  const { db } = setup({ ADMIN_SLACK_USER_IDS: 'UOPERATOR,UOPERATOR2' });
  fakeAccount();
  const { tap, slack } = await orderAndConfirm({ words: 'set broad to 140 a day', call: { op: 'set_budget', level: 'adset', target_id: '20', daily_budget: 140 }, key: 'chat:test:3', tapper: 'UOPERATOR2' });
  await tap('order_confirm');
  assert.match(JSON.stringify(slack.calls.at(-1).args.blocks), /Meta now shows \$140/);
  const order = db.tables.timeline.find((t) => t.event === 'order');
  assert.equal(order.detail.words, 'set broad to 140 a day');
  assert.equal(order.detail.filed_by, 'UOPERATOR');
  assert.equal(order.detail.by, 'UOPERATOR2', 'carried out as the operator who tapped');
  assert.deepEqual(order.detail.result, { before: 100, after: 140 });
});

test('a cancelled or expired order never runs', async () => {
  const { db } = setup();
  const acct = fakeAccount();
  let o = await orderAndConfirm({ words: 'pause the loser', call: { op: 'set_status', level: 'ad', target_id: '30', status: 'PAUSED' }, key: 'chat:test:4' });
  await o.tap('order_cancel');
  await o.tap('order_confirm');
  assert.equal(acct.writes().length, 0);
  assert.match(o.slack.calls.at(-1).args.text, /Already cancelled/);
  o = await orderAndConfirm({ words: 'pause the loser', call: { op: 'set_status', level: 'ad', target_id: '30', status: 'PAUSED' }, key: 'chat:test:5' });
  const row = db.tables.state.filter((r) => r.key.startsWith('order/')).at(-1);
  row.value = { ...row.value, at: new Date(Date.now() - 25 * 3600_000).toISOString() };
  await o.tap('order_confirm');
  assert.equal(acct.writes().length, 0);
  assert.match(JSON.stringify(o.slack.calls.at(-1)), /Expired/);
});

test('only an operator\'s own message can file an order', async () => {
  setup();
  setRuntime({ slack: fakeSlack() });
  const { fileOrder } = await import('../src/orders.mjs');
  const { withExecution } = await import('../src/context.mjs');
  const r = await withExecution({ actor: 'USOMEONE', key: 'k' }, () => fileOrder('set_status', { level: 'ad', target_id: '30', status: 'PAUSED' }));
  assert.equal(r.ok, false);
  assert.match(r.refused, /operator/);
});

test('a comment reply is a card with the exact text, escaped, and goes out only on Confirm', async () => {
  const { db } = setup();
  const sent = [];
  fakeGraph(({ method, path, params }) => {
    if (method === 'GET' && path === 'me/accounts') return { data: [{ id: '999', access_token: 'page-token' }] };
    if (method === 'GET' && path === '777') return { message: 'Is it <!channel> cheaper online?', from: { name: 'Dana' } };
    if (method === 'GET' && path === '999') return { access_token: 'page-token' };
    if (method === 'POST' && path === '777/comments') { sent.push(params.message); return { id: 'r1' }; }
    return { error: { code: 100, message: `no ${method} ${path}` } };
  });
  const slack = fakeSlack();
  setRuntime({ slack });
  fakeClaude([toolUse('c1', 'comment_action', { platform: 'facebook', comment_id: '777', action: 'reply', message: 'Same price everywhere.' }), text('Card is up.')]);
  await ask([{ role: 'user', content: 'reply to Dana: same price everywhere' }], { actor: 'UOPERATOR', key: 'chat:test:6', thread: { channel: 'CTEST', thread_ts: '1' } });
  assert.equal(sent.length, 0);
  const card = slack.calls.find((c) => c.name === 'chat.postMessage' && c.args.blocks?.some((b) => b.type === 'actions'));
  const shown = JSON.stringify(card.args.blocks);
  assert.match(shown, /Same price everywhere\./);
  assert.match(shown, /&lt;!channel&gt;/, 'the comment cannot ping the channel from the card');
  const app = fakeApp();
  registerApprovals(app);
  const confirm = card.args.blocks.find((b) => b.type === 'actions').elements.find((e) => e.action_id === 'order_confirm');
  await app.actions.order_confirm({ ack: async () => {}, body: { user: { id: 'UOPERATOR' }, channel: { id: 'CTEST' }, message: { ts: '1001' } }, action: confirm, client: slack });
  assert.deepEqual(sent, ['Same price everywhere.']);
  assert.ok(db.tables.moderation_log.some((m) => m.action === 'reply' && m.source === 'order:UOPERATOR'));
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

