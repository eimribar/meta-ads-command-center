import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPause, checkScale, checkDescale, budgetCeiling } from '../src/optimizer/guardrails.mjs';
import { DEFAULTS } from '../src/optimizer/policy.mjs';

const P = { target: 100, t: DEFAULTS, maxDailyBudget: 1000 };

test('pause: zero results after 3x the target spend is a clear loss', () => {
  assert.equal(checkPause({ spend: 299, results: 0, cost: null, days: 5, activeInSet: 3 }, P).pass, false);
  const r = checkPause({ spend: 300, results: 0, cost: null, days: 5, activeInSet: 3 }, P);
  assert.equal(r.pass, true);
  assert.match(r.reason, /no results/);
});

test('pause: 3x target cost needs 3 mature days', () => {
  assert.equal(checkPause({ spend: 600, results: 2, cost: 300, days: 2, activeInSet: 3 }, P).pass, false);
  assert.equal(checkPause({ spend: 600, results: 2, cost: 300, days: 3, activeInSet: 3 }, P).pass, true);
});

test('pause: a heavy spender 1.5x over target', () => {
  assert.equal(checkPause({ spend: 1000, results: 6, cost: 166.67, days: 4, activeInSet: 3 }, P).pass, true);
  assert.equal(checkPause({ spend: 900, results: 6, cost: 150, days: 4, activeInSet: 3 }, P).pass, false);
});

test('pause: the last active ad in a set is escalated, not paused', () => {
  const r = checkPause({ spend: 400, results: 0, cost: null, days: 4, activeInSet: 1 }, P);
  assert.equal(r.pass, false);
  assert.equal(r.escalate, true);
  assert.match(r.reason, /escalated/);
});

test('pause: no target, no judgment', () => {
  const r = checkPause({ spend: 10000, results: 0, cost: null, days: 9 }, { ...P, target: null });
  assert.equal(r.pass, false);
  assert.match(r.reason, /no target/);
});

const winner = { proven: true, results: 8, lastBudgetChangeAt: null, currentBudget: 100, liveTotal: 300, baselineTotal: 300 };

test('scale: a proven winner gets one 20% step', () => {
  const r = checkScale(winner, P);
  assert.equal(r.pass, true);
  assert.equal(r.proposedBudget, 120);
});

test('scale: every guard can stop it', () => {
  assert.equal(checkScale({ ...winner, proven: false }, P).pass, false);
  assert.equal(checkScale({ ...winner, results: 4 }, P).pass, false);
  assert.equal(checkScale({ ...winner, lastBudgetChangeAt: new Date(Date.now() - 10 * 3.6e6).toISOString() }, P).pass, false);
  assert.equal(checkScale({ ...winner, liveTotal: 390, baselineTotal: 300 }, P).pass, false);
  const ceil = checkScale(winner, { ...P, maxDailyBudget: 310 });
  assert.equal(ceil.pass, false);
  assert.match(ceil.reason, /daily ceiling/);
  const off = checkScale(winner, { ...P, maxDailyBudget: null });
  assert.equal(off.pass, false);
  assert.match(off.reason, /MAX_DAILY_BUDGET is not set/);
});

test('descale: only clearly over target, one 20% step', () => {
  assert.equal(checkDescale({ cost: 120, results: 5, currentBudget: 100 }, P).pass, false);
  const r = checkDescale({ cost: 130, results: 5, currentBudget: 100 }, P);
  assert.equal(r.pass, true);
  assert.equal(r.proposedBudget, 80);
  assert.equal(checkDescale({ cost: null, results: 0, currentBudget: 100 }, P).pass, false);
});

test('the ceiling binds each budget and the account total', () => {
  assert.equal(budgetCeiling({ newBudget: 100, newTotal: 400, max: 500 }).ok, true);
  assert.equal(budgetCeiling({ newBudget: 600, max: 500 }).ok, false);
  assert.equal(budgetCeiling({ newBudget: 100, newTotal: 501, max: 500 }).ok, false);
  assert.equal(budgetCeiling({ newBudget: 100, newTotal: 100, max: null }).ok, false);
  assert.equal(budgetCeiling({ newBudget: -5, max: 500 }).ok, false);
});
