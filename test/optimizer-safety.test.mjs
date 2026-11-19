// The optimizer's safety rails: one run at a time, one open card per move, apply-time checks,
// moves a person reversed, unknown outcomes, and runs that must not write.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, fakeGraph, fakeClaude, toolUse, text } from './helpers.mjs';
import { fakeAccount } from './account-fake.mjs';
import { runOptimizer, fileProposals, processProposal } from '../src/optimizer/optimizer.mjs';
import { applyApproved, rejectCard, undo, setLadder } from '../src/optimizer/executor.mjs';
import { checkSuppression } from '../src/optimizer/decisions.mjs';
import { costPosterior } from '../src/optimizer/stats.mjs';
import { setState, withLease } from '../src/jobs.mjs';
import { daysAgo, today } from '../src/clock.mjs';

const LADDER = ['pause_ad', 'unpause_ad', 'scale_budget', 'descale_budget'].map((t) => ({ action_type: t, mode: 'propose' }));
const proposals = (actions) => fakeClaude([() => toolUse('p1', 'propose_actions', { summary: 's', actions }), text('done')]);

// A hand-built context: ad set 20 with two losing ads, 30 and 34, both live.
function ctxTwoLosers() {
  const loser = { spend: 600, results: 0, cost: null, days: 5 };
  return {
    live: {
      campaigns: { 10: { name: 'Prospecting', effective: 'ACTIVE', configured: 'ACTIVE', daily_budget: null } },
      adsets: { 20: { name: 'Broad', effective: 'ACTIVE', configured: 'ACTIVE', daily_budget: 100, campaign_id: '10' } },
      ads: { 30: { name: 'A', effective: 'ACTIVE', configured: 'ACTIVE', adset_id: '20', campaign_id: '10' }, 34: { name: 'B', effective: 'ACTIVE', configured: 'ACTIVE', adset_id: '20', campaign_id: '10' } },
    },
    stats: { ad: { 30: loser, 34: loser }, adset: {}, campaign: {} },
    ledger: new Map(), baseline: 100, window: {},
  };
}
// Meta for that context: both ads read as in scope; `others` is what the ad set's ads edge shows.
function metaForTwo({ active = ['30', '34'] } = {}) {
  const posts = [];
  fakeGraph(({ method, path, params }) => {
    if (method === 'GET' && path === '20/ads') return { data: ['30', '34'].map((id) => ({ id, effective_status: active.includes(id) ? 'ACTIVE' : 'PAUSED' })) };
    if (method === 'GET' && /^3\d$/.test(path)) return { account_id: '111', campaign_id: '10' };
    if (method === 'POST') { posts.push([path, params.status]); return { success: true }; }
    return { error: { code: 100, message: `no ${method} ${path}` } };
  });
  return posts;
}

test('on auto, the second pause in an ad set is judged after the first: it would leave too few, so it waits', async () => {
  setup({}, { seed: { autonomy_policy: LADDER.map((l) => (l.action_type === 'pause_ad' ? { ...l, mode: 'auto' } : l)) } });
  const posts = metaForTwo();
  const ctx = ctxTwoLosers();
  const a = await processProposal({ action_type: 'pause_ad', target_id: '30', reason: 'loser' }, ctx, { cadence: 'daily' });
  const b = await processProposal({ action_type: 'pause_ad', target_id: '34', reason: 'loser' }, ctx, { cadence: 'daily' });
  assert.equal(a.row.disposition, 'auto_applied');
  assert.equal(b.row.disposition, 'escalated');
  assert.deepEqual(posts, [['30', 'PAUSED']]);
});

test('an automatic pause reads the ad set again first and never takes it below its floor', async () => {
  setup({}, { seed: { autonomy_policy: LADDER.map((l) => (l.action_type === 'pause_ad' ? { ...l, mode: 'auto' } : l)) } });
  const posts = metaForTwo({ active: ['30'] });   // 34 was paused in Ads Manager since the numbers were read
  const r = await processProposal({ action_type: 'pause_ad', target_id: '30', reason: 'loser' }, ctxTwoLosers(), { cadence: 'daily' });
  assert.equal(r.row.disposition, 'escalated');
  assert.match(r.row.explain, /pausing would leave 0 active ads/);
  assert.equal(posts.length, 0);
});

test('one open card per move, even when two runs race', async () => {
  const { db } = setup({}, { seed: { autonomy_policy: LADDER, actions_log: [{ run_date: today(), action_type: 'pause_ad', target_id: '30', decision_key: 'pause:30', disposition: 'proposed', applied: false }] } });
  metaForTwo();
  // this run's ledger was read before the other run filed its card
  const r = await processProposal({ action_type: 'pause_ad', target_id: '30', reason: 'loser' }, ctxTwoLosers(), { cadence: 'check' });
  assert.equal(r.blocked, 'already_open');
  assert.equal(r.action_id, 1);
  assert.equal(db.tables.actions_log.length, 1);
  await assert.rejects(() => db.insert('actions_log', [{ run_date: today(), action_type: 'pause_ad', target_id: '30', decision_key: 'pause:30', disposition: 'escalated' }]), (e) => e.code === '23505');
});

test('one optimizer run at a time; a lease left by a stopped run is taken over', async () => {
  const { db } = setup({}, { seed: { autonomy_policy: LADDER } });
  fakeAccount();
  await setState('lease/optimizer', { at: new Date().toISOString(), id: 'other' });
  let r = await runOptimizer();
  assert.equal(r.busy, true);
  assert.match(r.summary, /Another optimizer run is in progress/);
  assert.equal((await fileProposals([{ action_type: 'pause_ad', target_id: '30', reason: 'x' }]))[0].blocked, 'busy');
  db.tables.state.find((s) => s.key === 'lease/optimizer').value.at = new Date(Date.now() - 31 * 60_000).toISOString();
  proposals([]);
  r = await runOptimizer();
  assert.equal(r.busy, undefined);
  assert.ok(!db.tables.state.some((s) => s.key === 'lease/optimizer'), 'released at the end');
  assert.deepEqual(await withLease('x', async () => 7), 7);
});

test('proposals from chat respect the off switch and the freeze, and never apply on their own', async () => {
  setup({ OPTIMIZER_ENABLED: 'false' });
  assert.equal((await fileProposals([{ action_type: 'pause_ad', target_id: '30', reason: 'x' }]))[0].blocked, 'off');
  setup({}, { seed: { autonomy_policy: LADDER } });
  await setState('optimizer/freeze', { on: true, by: 'UOPERATOR' });
  assert.equal((await fileProposals([{ action_type: 'pause_ad', target_id: '30', reason: 'x' }]))[0].blocked, 'frozen');
  setup({}, { seed: { autonomy_policy: LADDER } });
  await setLadder('pause_ad', 'auto', { by: 'UOPERATOR' });
  const acct = fakeAccount();
  const [r] = await fileProposals([{ action_type: 'pause_ad', target_id: '30', reason: 'no test rides' }]);
  assert.equal(r.row.disposition, 'proposed');
  assert.equal(acct.writes().length, 0);
  setup({ TARGET_COST_PER_RESULT: '50' }, { seed: { autonomy_policy: LADDER } });
  fakeAccount({ tracking: false });
  assert.equal((await fileProposals([{ action_type: 'pause_ad', target_id: '30', reason: 'x' }]))[0].blocked, 'frozen', 'broken tracking freezes chat proposals too');
});

test('a safety check that cannot run freezes the run', async () => {
  const { db } = setup({}, { seed: { autonomy_policy: LADDER } });
  fakeAccount();
  const select = db.select.bind(db);
  db.select = async (table, opts) => { if (table === 'performance_daily' && opts?.where?.level === 'campaign') throw new Error('disk full'); return select(table, opts); };
  proposals([]);
  const r = await runOptimizer();
  assert.equal(r.frozen, true);
  assert.match(r.freezeReasons.join(' '), /the safety check could not run: disk full/);
});

test('a move a person undid, or turned back by hand, is asked again only of a person', () => {
  const live = { ads: { 30: { effective: 'ACTIVE' } }, adsets: {}, campaigns: {} };
  const row = (extra) => new Map([['pause:30', { id: 4, decision_key: 'pause:30', applied_at: '2026-11-10', ...extra }]]);
  let s = checkSuppression('pause:30', row({ standing: 'undone', undone_by: 'UOPERATOR', undone_at: '2026-11-11' }), live);
  assert.equal(s.suppressed, false);
  assert.equal(s.escalate, true);
  s = checkSuppression('pause:30', row({ standing: 'committed' }), live);
  assert.equal(s.escalate, true, 'someone turned the paused ad back on');
  s = checkSuppression('pause:30', row({ standing: 'unknown', journal_id: 9 }), live);
  assert.equal(s.suppressed, true);
  assert.match(s.why, /journal clear 9/);
});

test('an approval re-checks the account-wide growth cap with the raises applied since', async () => {
  const day7 = daysAgo(7);
  const { db } = setup({}, { seed: {
    performance_daily: [{ date: day7, level: 'campaign', entity_id: '10', status: 'ACTIVE', daily_budget: null }, { date: day7, level: 'adset', entity_id: '20', campaign_id: '10', status: 'ACTIVE', daily_budget: 100 }],
    actions_log: [{ run_date: today(), action_type: 'scale_budget', target_level: 'adset', target_id: '20', decision_key: 'budget:20|up', disposition: 'escalated', applied: false, before: { dailyBudget: 120 }, after: { dailyBudget: 144 } }],
  } });
  const acct = fakeAccount({ adsetBudget: 120 });   // a raise from 100 to 120 already landed this week
  const r = await applyApproved(1, { by: 'UOPERATOR' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /past 1\.3x its level a week ago/);
  assert.equal(acct.writes().length, 0);
  assert.equal(db.tables.actions_log[0].disposition, 'skipped');
});

test('approve and reject never both act on one card', async () => {
  const card = { run_date: today(), action_type: 'pause_ad', target_level: 'ad', target_id: '30', decision_key: 'pause:30', disposition: 'proposed', applied: false };
  let { db } = setup({}, { seed: { actions_log: [card] } });
  let acct = fakeAccount();
  assert.equal((await rejectCard(1, { by: 'UOPERATOR' })).ok, true);
  const late = await applyApproved(1, { by: 'UOPERATOR' });
  assert.equal(late.decided, true);
  assert.equal(acct.writes().length, 0);
  ({ db } = setup({}, { seed: { actions_log: [card], job_runs: [{ name: 'approval', slot: '1', status: 'running', started_at: new Date().toISOString() }] } }));
  acct = fakeAccount();
  const r = await rejectCard(1, { by: 'UOPERATOR' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /already being handled/);
  assert.equal(db.tables.actions_log[0].disposition, 'proposed');
});

test('an approval with no clear answer from Meta is recorded as unknown, and counts once it is cleared', async () => {
  const { db } = setup({}, { seed: { actions_log: [{ run_date: today(), action_type: 'pause_ad', target_level: 'ad', target_id: '30', decision_key: 'pause:30', disposition: 'proposed', applied: false }] } });
  fakeGraph(({ method, path }) => {
    if (method === 'GET' && path === '30') return { account_id: '111', campaign_id: '10' };
    if (method === 'POST') return { http: { status: 504, body: 'timeout' } };
    return { error: { code: 100, message: 'no' } };
  });
  const r = await applyApproved(1, { by: 'UOPERATOR' });
  assert.equal(r.unknown, true);
  assert.match(r.reason, /journal clear 1/);
  assert.equal(db.tables.actions_log[0].disposition, 'unknown');
  assert.equal(db.tables.actions_log[0].journal_id, 1);
  assert.match((await undo(1, { by: 'UOPERATOR' })).reason, /unknown outcome/);
  const { clearWrite } = await import('../src/write-journal.mjs');
  await clearWrite(1, 'UOPERATOR');
  assert.equal(db.tables.actions_log[0].disposition, 'applied_by_human');
});

test('undo never overwrites a newer budget, and a failed undo can be tried again', async () => {
  const applied = (after) => ({ run_date: today(), action_type: 'scale_budget', target_level: 'adset', target_id: '20', decision_key: 'budget:20|up', disposition: 'applied_by_human', applied: true, before: { dailyBudget: 100 }, after: { dailyBudget: after } });
  setup({}, { seed: { actions_log: [applied(120)] } });
  let acct = fakeAccount({ adsetBudget: 150 });   // someone set 150 by hand after the raise to 120
  const r = await undo(1, { by: 'UOPERATOR' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /changed again since #1/);
  assert.equal(acct.writes().length, 0);
  setup({}, { seed: { actions_log: [applied(120)] } });
  let fail = true;
  acct = fakeAccount({ adsetBudget: 120, extra: { handler: () => ({}) } });
  const { setRuntime, rt } = await import('../src/runtime.mjs');
  const real = rt.fetch;
  setRuntime({ fetch: async (url, opts) => (opts?.method === 'POST' && fail ? { ok: false, status: 400, headers: { get: () => null }, json: async () => ({ error: { code: 100, message: 'Invalid parameter' } }) } : real(url, opts)) });
  await assert.rejects(() => undo(1, { by: 'UOPERATOR' }), /Invalid parameter/);
  fail = false;
  const again = await undo(1, { by: 'UOPERATOR' });
  assert.equal(again.ok, true, again.reason);
  assert.deepEqual(acct.writes().map((w) => w.params.daily_budget), ['10000']);
});

test('a dry run reads fresh numbers and stores nothing', async () => {
  const { db } = setup({}, { seed: { autonomy_policy: LADDER } });
  fakeAccount();
  proposals([{ action_type: 'pause_ad', target_id: '30', reason: 'loser' }]);
  const r = await runOptimizer({ dryRun: true });
  assert.equal(r.actions.length, 1, JSON.stringify(r.freezeReasons || r.blocked));
  assert.equal((db.tables.performance_daily || []).length, 0);
  assert.equal((db.tables.actions_log || []).length, 0);
});

test('a prior worth 0 results is honoured, not replaced by the default', () => {
  const zero = costPosterior({ spend: 100, results: 2, priorCost: 50, priorResults: 0 });
  assert.ok(zero.alpha < 2.1, JSON.stringify(zero));
  assert.equal(costPosterior({ spend: 100, results: 2, priorCost: 50 }).alpha, 5, 'the default stays 3');
});
