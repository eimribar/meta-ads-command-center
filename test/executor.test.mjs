import test from 'node:test';
import assert from 'node:assert/strict';
import { applyApproved, rejectCard, undo, ladder, setLadder } from '../src/optimizer/executor.mjs';
import { setBudget, setStatus, assertInScope } from '../src/meta-write.mjs';
import { withExecution } from '../src/context.mjs';
import { setup } from './helpers.mjs';
import { fakeAccount } from './account-fake.mjs';

const card = (extra) => ({ run_date: new Date().toISOString().slice(0, 10), disposition: 'proposed', applied: false, ...extra });
const PAUSE = card({ action_type: 'pause_ad', target_level: 'ad', target_id: '30', decision_key: 'pause:30', before: { status: 'ACTIVE' }, after: { status: 'PAUSED' } });
const SCALE = card({ action_type: 'scale_budget', target_level: 'adset', target_id: '20', decision_key: 'budget:20|up', disposition: 'escalated', before: { dailyBudget: 100 }, after: { dailyBudget: 120 } });

test('an approved pause is applied once, through the journal', async () => {
  const { db } = setup({}, { seed: { actions_log: [PAUSE] } });
  const acct = fakeAccount();
  const r = await applyApproved(1, { by: 'UOPERATOR', note: 'agreed' });
  assert.equal(r.ok, true);
  assert.deepEqual(acct.writes().map((w) => [w.path, w.params.status]), [['30', 'PAUSED']]);
  assert.equal(db.tables.actions_log[0].disposition, 'applied_by_human');
  assert.equal(db.tables.write_journal[0].state, 'applied');
  const twice = await applyApproved(1, { by: 'UOPERATOR' });
  assert.equal(twice.ok, false);
  assert.match(twice.reason, /already approved/);
  assert.equal(acct.writes().length, 1);
});

test('an approved budget raise applies when the live budget still matches the card', async () => {
  const { db } = setup({}, { seed: { actions_log: [SCALE] } });
  const acct = fakeAccount();
  const r = await applyApproved(1, { by: 'UOPERATOR' });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(acct.writes().map((w) => [w.path, w.params.daily_budget]), [['20', '12000']]);
  assert.equal(db.tables.timeline.find((t) => t.event === 'budget_changed').detail.to, 120);
});

test('the stale guard refuses a budget card the account moved away from', async () => {
  const { db } = setup({}, { seed: { actions_log: [SCALE] } });
  const acct = fakeAccount({ adsetBudget: 150 });
  const r = await applyApproved(1, { by: 'UOPERATOR' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /stale/);
  assert.equal(acct.writes().length, 0);
  assert.equal(db.tables.actions_log[0].close_reason, 'execution_needs_review');
  assert.equal(db.tables.actions_log[0].fail_key, 'stale_budget');
});

test('the daily ceiling binds approvals', async () => {
  setup({ MAX_DAILY_BUDGET: '110' }, { seed: { actions_log: [SCALE] } });
  const acct = fakeAccount();
  const r = await applyApproved(1, { by: 'UOPERATOR' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /ceiling/);
  assert.equal(acct.writes().length, 0);
});

test('budget changes need an operator and a ceiling, also as direct orders', async () => {
  setup();
  const acct = fakeAccount();
  await assert.rejects(() => withExecution({ actor: 'USOMEONE', kind: 'chat', key: 'k1' }, () => setBudget('adset', '20', 110)), /needs an operator/);
  await assert.rejects(() => withExecution({ actor: null, kind: 'scheduled', key: 'k2' }, () => setBudget('adset', '20', 110)), /needs an operator/);
  await assert.rejects(() => withExecution({ actor: 'UOPERATOR', kind: 'order', key: 'k3' }, () => setBudget('adset', '20', 900)), /ceiling/);
  setup({ MAX_DAILY_BUDGET: '' });
  fakeAccount();
  await assert.rejects(() => withExecution({ actor: 'UOPERATOR', kind: 'order', key: 'k4' }, () => setBudget('adset', '20', 110)), /MAX_DAILY_BUDGET is not set/);
  assert.equal(acct.writes().length, 0);
});

test('writes outside the ad account or the allowlist are refused', async () => {
  setup({ CAMPAIGN_ALLOWLIST: '99' });
  fakeAccount();
  await assert.rejects(() => assertInScope('ad', '30'), /outside CAMPAIGN_ALLOWLIST/);
  setup();
  fakeAccount({ extra: { handler: () => ({ account_id: '999', campaign_id: '5' }) } });
  await assert.rejects(() => assertInScope('ad', '777'), /not in this ad account/);
  await assert.rejects(() => assertInScope('ad', 'act_111'), /not a Meta object id/);
});

test('switching a campaign or ad set on needs an operator', async () => {
  setup();
  fakeAccount();
  await assert.rejects(() => withExecution({ actor: null, kind: 'scheduled', key: 'k' }, () => setStatus('adset', '20', 'ACTIVE')), /needs an operator/);
});

test('reject closes the card with the reason; undo reverses and demotes an automatic action', async () => {
  const auto = { ...PAUSE, disposition: 'auto_applied', applied: true, applied_by: 'optimizer' };
  const { db } = setup({}, { seed: { actions_log: [PAUSE, auto], autonomy_policy: [{ action_type: 'pause_ad', mode: 'auto' }] } });
  const acct = fakeAccount();
  const rj = await rejectCard(1, { by: 'UOPERATOR', note: 'new creative, give it time' });
  assert.equal(rj.ok, true);
  assert.equal(db.tables.actions_log[0].close_reason, 'human_reject');
  const u = await undo(2, { by: 'UOPERATOR' });
  assert.equal(u.ok, true);
  assert.equal(u.demoted, true);
  assert.deepEqual(acct.writes().map((w) => [w.path, w.params.status]), [['30', 'ACTIVE']]);
  assert.equal((await ladder()).find((l) => l.action_type === 'pause_ad').mode, 'propose');
  assert.equal((await undo(2, { by: 'UOPERATOR' })).ok, false);
  assert.equal((await undo(1, { by: 'UOPERATOR' })).ok, false);
});

test('the ladder: everything starts on propose; budget moves and re-activations never go auto', async () => {
  setup();
  assert.ok((await ladder()).every((l) => l.mode === 'propose'));
  assert.equal((await setLadder('pause_ad', 'auto', { by: 'U' })).ok, true);
  for (const t of ['scale_budget', 'descale_budget', 'unpause_ad']) assert.equal((await setLadder(t, 'auto', { by: 'U' })).ok, false);
  assert.equal((await setLadder('delete_everything', 'auto', { by: 'U' })).ok, false);
});
