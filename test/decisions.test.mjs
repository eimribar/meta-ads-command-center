import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionKey, gateProposal, loadLedger, checkSuppression, sweepOpen, failureKey } from '../src/optimizer/decisions.mjs';
import { setup } from './helpers.mjs';

export const LIVE = {
  campaigns: { 10: { name: 'Prospecting', configured: 'ACTIVE', effective: 'ACTIVE', daily_budget: null } },
  adsets: {
    20: { name: 'Broad', configured: 'ACTIVE', effective: 'ACTIVE', daily_budget: 100, campaign_id: '10' },
    21: { name: 'Off set', configured: 'PAUSED', effective: 'PAUSED', daily_budget: 50, campaign_id: '10' },
  },
  ads: {
    30: { name: 'Ad A', configured: 'ACTIVE', effective: 'ACTIVE', adset_id: '20', campaign_id: '10' },
    31: { name: 'Ad B', configured: 'PAUSED', effective: 'PAUSED', adset_id: '20', campaign_id: '10' },
    32: { name: 'Ad C', configured: 'PAUSED', effective: 'PAUSED', adset_id: '21', campaign_id: '10' },
  },
};

test('one key per decision', () => {
  assert.equal(decisionKey({ action_type: 'pause_ad', target_id: 30 }), 'pause:30');
  assert.equal(decisionKey({ action_type: 'scale_budget', target_id: '20' }), 'budget:20|up');
  assert.equal(decisionKey({ action_type: 'descale_budget', target_id: '20' }), 'budget:20|down');
  assert.equal(decisionKey({ action_type: 'pause_ad' }), null);
});

test('the gate drops moves that mean nothing right now', () => {
  assert.equal(gateProposal({ action_type: 'pause_ad', target_id: '30' }, LIVE).ok, true);
  assert.equal(gateProposal({ action_type: 'pause_ad', target_id: '31' }, LIVE).code, 'not_delivering');
  assert.equal(gateProposal({ action_type: 'pause_ad', target_id: '99' }, LIVE).code, 'unknown_target');
  assert.equal(gateProposal({ action_type: 'unpause_ad', target_id: '30' }, LIVE).code, 'already_active');
  assert.equal(gateProposal({ action_type: 'unpause_ad', target_id: '31' }, LIVE).ok, true);
  assert.equal(gateProposal({ action_type: 'unpause_ad', target_id: '32' }, LIVE).code, 'parent_paused');
  assert.equal(gateProposal({ action_type: 'scale_budget', target_id: '20', after: { dailyBudget: 120 } }, LIVE).ok, true);
  assert.equal(gateProposal({ action_type: 'scale_budget', target_id: '20', after: { dailyBudget: 102 } }, LIVE).code, 'no_change');
  assert.equal(gateProposal({ action_type: 'scale_budget', target_id: '10' }, LIVE).code, 'no_budget');
  assert.equal(gateProposal({ action_type: 'scale_budget', target_id: '21' }, LIVE).code, 'not_active');
});

test('suppression: open cards, rejections and applied moves are not asked again', async () => {
  const now = Date.now();
  const day = (k) => new Date(now - k * 864e5).toISOString();
  setup({}, { seed: { actions_log: [
    { run_date: day(1).slice(0, 10), decision_key: 'pause:30', disposition: 'proposed' },
    { run_date: day(2).slice(0, 10), decision_key: 'budget:20|up', disposition: 'skipped', close_reason: 'human_reject', applied_at: day(2), evidence: { cost: 100, spend: 500 }, decision_note: 'wait for the promo' },
    { run_date: day(3).slice(0, 10), decision_key: 'pause:31', disposition: 'applied_by_human', applied: true, applied_at: day(3) },
  ] } });
  const ledger = await loadLedger();
  assert.equal(checkSuppression('pause:30', ledger, LIVE).standing, 'open');
  const rej = checkSuppression('budget:20|up', ledger, LIVE, { cost: 95, spend: 520 }, now);
  assert.equal(rej.suppressed, true);
  assert.match(rej.why, /wait for the promo/);
  // the numbers moved a lot: ask again
  const moved = checkSuppression('budget:20|up', ledger, LIVE, { cost: 60, spend: 900 }, now);
  assert.equal(moved.suppressed, false);
  assert.match(moved.reopened, /cost per result moved/);
  // the paused ad is still paused: the decision holds
  assert.equal(checkSuppression('pause:31', ledger, LIVE).suppressed, true);
  // someone switched it back on: the decision can be made again
  const back = { ...LIVE, ads: { ...LIVE.ads, 31: { ...LIVE.ads[31], effective: 'ACTIVE' } } };
  assert.equal(checkSuppression('pause:31', ledger, back).suppressed, false);
  // after the hold, a rejection can be asked again
  assert.equal(checkSuppression('budget:20|up', ledger, LIVE, null, now + 8 * 864e5).suppressed, false);
});

test('the sweep closes open cards that no longer make sense, and old ones', async () => {
  const old = new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10);
  const { db } = setup({}, { seed: { actions_log: [
    { run_date: new Date().toISOString().slice(0, 10), action_type: 'pause_ad', target_id: '31', disposition: 'proposed' },
    { run_date: new Date().toISOString().slice(0, 10), action_type: 'pause_ad', target_id: '30', disposition: 'proposed' },
    { run_date: old, action_type: 'scale_budget', target_id: '20', after: { dailyBudget: 120 }, disposition: 'escalated' },
  ] } });
  const closed = await sweepOpen(LIVE);
  assert.equal(closed.length, 2);
  const rows = db.tables.actions_log;
  assert.equal(rows[0].close_reason, 'moot');
  assert.equal(rows[1].disposition, 'proposed');
  assert.equal(rows[2].close_reason, 'expiry');
});

test('failure causes are compared by kind', () => {
  assert.equal(failureKey(new Error('stale: the card assumed')), 'stale_budget');
  assert.equal(failureKey(new Error('100: Invalid parameter')), 'meta:100');
  assert.equal(failureKey(new Error('Writes are on hold: write #3')), 'journal_hold');
});
