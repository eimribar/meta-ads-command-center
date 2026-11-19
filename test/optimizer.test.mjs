import test from 'node:test';
import assert from 'node:assert/strict';
import { runOptimizer } from '../src/optimizer/optimizer.mjs';
import { setLadder } from '../src/optimizer/executor.mjs';
import { setState } from '../src/jobs.mjs';
import { setup, fakeClaude, toolUse, text } from './helpers.mjs';
import { fakeAccount } from './account-fake.mjs';

const LADDER = ['pause_ad', 'unpause_ad', 'scale_budget', 'descale_budget'].map((t) => ({ action_type: t, mode: 'propose' }));

// Claude proposes four moves; two are sound, one hits a guardrail, one is moot.
function proposer() {
  let n = 0;
  return fakeClaude([() => toolUse(`p${n++}`, 'propose_actions', {
    summary: 'one loser, one winning ad set',
    actions: [
      { action_type: 'pause_ad', target_id: '30', reason: 'no test rides after a fair test' },
      { action_type: 'scale_budget', target_id: '20', reason: 'cheap test rides' },
      { action_type: 'pause_ad', target_id: '33', reason: 'a bad idea' },
      { action_type: 'pause_ad', target_id: '31', reason: 'already off' },
    ],
  }), text('done')]);
}

test('no target, no optimizer', async () => {
  setup({ TARGET_COST_PER_RESULT: '' });
  const r = await runOptimizer();
  assert.equal(r.held, true);
  assert.equal(r.needsTarget, true);
});

test('a manual freeze holds it', async () => {
  setup();
  await setState('optimizer/freeze', { on: true, by: 'UOPERATOR', note: 'promo week' });
  const r = await runOptimizer();
  assert.equal(r.held, true);
  assert.match(r.summary, /promo week/);
});

test('the full run: only the sound moves are filed, and nothing is asked twice', async () => {
  const { db } = setup({}, { seed: { autonomy_policy: LADDER } });
  const acct = fakeAccount();
  const requests = proposer();
  const r = await runOptimizer({ cadence: 'daily' });
  assert.equal(r.frozen, undefined, JSON.stringify(r.freezeReasons));
  assert.deepEqual(r.actions.map((a) => [a.action_type, a.target_id, a.disposition]), [['pause_ad', '30', 'proposed'], ['scale_budget', '20', 'escalated']]);
  assert.deepEqual(r.blocked.map((b) => [b.target_id, b.blocked]), [['33', 'guardrail'], ['31', 'moot']]);
  assert.deepEqual(r.actions[1].after, { dailyBudget: 120 });
  assert.equal(acct.writes().length, 0, 'proposals never write');
  // Claude saw the result label, the target and only mature numbers
  const state = JSON.parse(requests[0].messages[0].content.replace(/^STATE[^\n]*\n/, ''));
  assert.equal(state.result_event, 'test rides');
  assert.equal(state.target_cost_per_result, 150);
  assert.ok(state.data_window.until < new Date().toISOString().slice(0, 10));
  // second run: both are already waiting
  proposer();
  const again = await runOptimizer({ cadence: 'check' });
  assert.equal(again.actions.length, 0);
  assert.deepEqual(again.blocked.filter((b) => b.blocked === 'already_open').map((b) => b.target_id).sort(), ['20', '30']);
  assert.equal(db.tables.actions_log.length, 2);
});

test('a dry run files nothing', async () => {
  const { db } = setup({}, { seed: { autonomy_policy: LADDER } });
  fakeAccount();
  proposer();
  const r = await runOptimizer({ dryRun: true });
  assert.equal(r.actions.length, 2);
  assert.ok(r.actions.every((a) => a.dry_run));
  assert.equal((db.tables.actions_log || []).length, 0);
});

test('on auto, a clear pause applies itself; budget moves still wait', async () => {
  setup({}, { seed: { autonomy_policy: LADDER } });
  await setLadder('pause_ad', 'auto', { by: 'UOPERATOR' });
  const acct = fakeAccount();
  proposer();
  const r = await runOptimizer();
  const pause = r.actions.find((a) => a.action_type === 'pause_ad');
  assert.equal(pause.disposition, 'auto_applied');
  assert.deepEqual(acct.writes().map((w) => [w.path, w.params.status]), [['30', 'PAUSED']]);
  assert.equal(r.actions.find((a) => a.action_type === 'scale_budget').disposition, 'escalated');
});

test('budget moves cannot be put on auto, even by editing the table', async () => {
  setup({}, { seed: { autonomy_policy: LADDER.map((l) => ({ ...l, mode: 'auto' })) } });
  assert.equal((await setLadder('scale_budget', 'auto', { by: 'UOPERATOR' })).ok, false);
  const acct = fakeAccount();
  proposer();
  const r = await runOptimizer();
  assert.equal(r.actions.find((a) => a.action_type === 'scale_budget').disposition, 'escalated');
  assert.ok(!acct.writes().some((w) => w.params.daily_budget));
});

test('broken tracking freezes the run', async () => {
  setup({ TARGET_COST_PER_RESULT: '50' });
  fakeAccount({ tracking: false });
  proposer();
  const r = await runOptimizer();
  assert.equal(r.frozen, true);
  assert.match(r.freezeReasons.join(' '), /no results/);
  assert.equal(r.actions.length, 0);
});

test('OPTIMIZER_ENABLED=false turns the optimizer off everywhere, and says so', async () => {
  const { db } = setup({ OPTIMIZER_ENABLED: 'false', REPORT_ENABLED: 'false', MODERATION_ENABLED: 'false' });
  const { runNamedJob, OPTIMIZER_OFF, jobOff } = await import('../src/scheduled.mjs');
  const { handleCommand } = await import('../src/slack/commands.mjs');
  const { buildHome } = await import('../src/slack/home.mjs');
  for (const name of ['optimizer', 'optimizer-check']) {
    assert.deepEqual(await runNamedJob(name), { off: true, summary: OPTIMIZER_OFF }, name);
    assert.deepEqual(await runNamedJob(name, { dryRun: true }), { off: true, summary: OPTIMIZER_OFF });
  }
  assert.equal((db.tables.job_runs || []).length, 0, 'no slot is claimed or recorded');
  const out = [];
  let ran = false;
  const reply = async (p) => { out.push(typeof p === 'string' ? p : p.text); };
  await handleCommand({ text: 'optimize', user: 'UOPERATOR', reply, jobs: { optimize: async () => { ran = true; } } });
  assert.equal(ran, false);
  assert.match(out[0], /The optimizer is off in the settings[\s\S]*OPTIMIZER_ENABLED=true[\s\S]*Nothing was run/);
  await handleCommand({ text: 'status', user: 'USOMEONE', reply, jobs: {} });
  assert.match(out[1], /Optimizer: off \(OPTIMIZER_ENABLED=false/);
  assert.match(JSON.stringify(await buildHome('USOMEONE')), /Optimizer off/);
  // the report and the comment sweep keep their on demand runs; only their timers stop
  for (const name of ['report', 'moderation', 'weekly']) assert.equal(jobOff(name), null, name);
});

test('the scheduler arms no optimizer timer when it is off', async () => {
  setup({ OPTIMIZER_ENABLED: 'false', INTERNAL_SCHEDULER: 'true', MODERATION_ENABLED: 'false', REPORT_ENABLED: 'false' });
  const { startScheduler, stopScheduler } = await import('../src/scheduler.mjs');
  const logs = [];
  const log = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try { startScheduler(); } finally { console.log = log; stopScheduler(); }
  assert.ok(!logs.some((l) => /\boptimizer\b/.test(l)), logs.join('\n'));
  assert.ok(logs.some((l) => /weekly/.test(l)));
});
