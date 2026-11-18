import test from 'node:test';
import assert from 'node:assert/strict';
import { isOperator, toolsForActor, operatorOnlyMiddleware, READ_ONLY_TOOLS } from '../src/auth.mjs';
import { buildReceiptFooter, withEffects, reportEffect, reportBlocked } from '../src/context.mjs';
import { allTools } from '../src/tools.mjs';
import { setup } from './helpers.mjs';

test('operators come from ADMIN_SLACK_USER_IDS only', () => {
  setup({ ADMIN_SLACK_USER_IDS: 'UA,UB' });
  assert.equal(isOperator('UA'), true);
  assert.equal(isOperator('UC'), false);
  assert.equal(isOperator(null), false);
});

test('non-operators get only the read tools', () => {
  setup();
  const all = allTools();
  const writes = all.filter((t) => !READ_ONLY_TOOLS.has(t.name) && !t.type).map((t) => t.name);
  assert.ok(writes.includes('execute_order') && writes.includes('file_proposal') && writes.includes('comment_action'));
  const guest = toolsForActor(all, 'USOMEONE').map((t) => t.name);
  for (const w of writes) assert.ok(!guest.includes(w), `${w} leaked to a non-operator`);
  assert.ok(guest.includes('account_overview'));
  assert.equal(toolsForActor(all, 'UOPERATOR').length, all.length);
});

test('buttons from non-operators are acknowledged and dropped', async () => {
  setup();
  const mw = operatorOnlyMiddleware();
  let acked = 0, passed = 0, ephemeral = 0;
  const client = { chat: { postEphemeral: async () => { ephemeral++; } } };
  await mw({ body: { type: 'block_actions', user: { id: 'USOMEONE' }, channel: { id: 'C1' } }, ack: async () => { acked++; }, next: async () => { passed++; }, client });
  assert.deepEqual([acked, passed, ephemeral], [1, 0, 1]);
  await mw({ body: { type: 'view_submission', user: { id: 'UOPERATOR' } }, ack: async () => {}, next: async () => { passed++; }, client });
  await mw({ body: { type: 'event_callback' }, next: async () => { passed++; } });
  assert.equal(passed, 2);
});

test('the receipt footer comes from what the tools did', async () => {
  assert.equal(buildReceiptFooter([]), '_No account changes this turn (read only)._');
  const list = [];
  await withEffects(list, async () => {
    reportEffect('execute_order', ['30'], 'paused ad Ad A');
    reportBlocked('execute_order', 'REFUSED: above the ceiling');
  });
  const f = buildReceiptFooter(list);
  assert.match(f, /Actions this turn: paused ad Ad A/);
  assert.match(f, /Not done: execute_order \(REFUSED: above the ceiling\)/);
});
