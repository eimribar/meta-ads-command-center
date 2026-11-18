// Deterministic checks every proposal must pass. They read only numbers the agent pulled from
// Meta itself, never numbers the model reports. Each returns { pass, checks, reason }.
import { policy } from './policy.mjs';
import { money } from '../money.mjs';

const hoursSince = (iso, now = Date.now()) => (iso ? (now - new Date(iso).getTime()) / 3.6e6 : Infinity);
const roundAmount = (v) => Math.round(v * 100) / 100;

// Pause an ad only when the loss is clear, and escalate instead if it would leave the ad set
// with too few active ads.
export function checkPause({ spend, results, cost, days, activeInSet }, { target, t } = policy()) {
  const p = t.pause;
  const checks = {};
  checks.has_target = target > 0;
  checks.clear_loss = checks.has_target && (
    (spend >= p.zeroResultSpend * target && results === 0)
    || (cost != null && cost >= p.overTargetMult * target && days >= p.minDays)
    || (cost != null && cost >= p.heavyOverMult * target && spend >= p.heavySpendMult * target && days >= p.minDays));
  checks.keeps_set_alive = activeInSet == null || activeInSet - 1 >= p.keepMinActive;
  const pass = checks.clear_loss && checks.keeps_set_alive;
  const escalate = checks.clear_loss && !checks.keeps_set_alive;
  const reason = !checks.has_target ? 'no target cost per result is set'
    : !checks.clear_loss ? `loss not clear yet (${money(spend)} spent, ${results} results, ${money(cost)} each vs ${money(target)} target)`
      : !checks.keeps_set_alive ? `pausing would leave fewer than ${p.keepMinActive} active ads in the ad set; escalated`
        : results === 0 ? `${money(spend)} spent with no results` : `${money(cost)} per result over ${days} days vs ${money(target)} target`;
  return { pass, escalate, checks, reason };
}

// Raise a proven winner's budget by one bounded step.
export function checkScale({ proven, results, lastBudgetChangeAt, currentBudget, liveTotal, baselineTotal, now = Date.now() }, { target, t, maxDailyBudget } = policy()) {
  const s = t.scale;
  const proposedBudget = currentBudget > 0 ? roundAmount(currentBudget * (1 + s.stepPct / 100)) : null;
  const newTotal = liveTotal != null && currentBudget != null && proposedBudget != null ? liveTotal - currentBudget + proposedBudget : null;
  const checks = {};
  checks.has_target = target > 0;
  checks.is_winner = proven === true;
  checks.enough_results = (results || 0) >= s.minResults;
  checks.spacing = hoursSince(lastBudgetChangeAt, now) >= s.minHours;
  checks.under_account_cap = newTotal == null || baselineTotal == null || newTotal <= baselineTotal * s.accountCapMult;
  checks.under_ceiling = budgetCeiling({ newBudget: proposedBudget, newTotal, max: maxDailyBudget }).ok;
  const pass = Object.values(checks).every(Boolean) && proposedBudget != null;
  const reason = !checks.has_target ? 'no target cost per result is set'
    : !checks.is_winner ? 'not a proven winner yet'
      : !checks.enough_results ? `only ${results || 0} results in the window (needs ${s.minResults})`
        : !checks.spacing ? `last budget change was less than ${s.minHours} hours ago`
          : !checks.under_account_cap ? `would take the total daily budget past ${s.accountCapMult}x its level`
            : !checks.under_ceiling ? budgetCeiling({ newBudget: proposedBudget, newTotal, max: maxDailyBudget }).reason
              : `proven winner: raise ${s.stepPct}% (${money(currentBudget)} to ${money(proposedBudget)} a day)`;
  return { pass, checks, reason, proposedBudget };
}

// Trim an ad set or campaign that converts but costs clearly more than target.
export function checkDescale({ cost, results, lastBudgetChangeAt, currentBudget, now = Date.now() }, { target, t } = policy()) {
  const s = t.descale;
  const proposedBudget = currentBudget > 0 ? roundAmount(currentBudget * (1 - s.stepPct / 100)) : null;
  const checks = {};
  checks.has_target = target > 0;
  checks.over_target = cost != null && (results || 0) > 0 && cost > target * s.overTargetMult;
  checks.spacing = hoursSince(lastBudgetChangeAt, now) >= s.minHours;
  checks.positive = proposedBudget > 0;
  const pass = Object.values(checks).every(Boolean);
  const reason = !checks.has_target ? 'no target cost per result is set'
    : !checks.over_target ? `not clearly over target (${money(cost)} per result vs ${money(target)})`
      : !checks.spacing ? `last budget change was less than ${s.minHours} hours ago`
        : !checks.positive ? 'no budget to trim'
          : `${money(cost)} per result vs ${money(target)} target: trim ${s.stepPct}% (${money(currentBudget)} to ${money(proposedBudget)} a day)`;
  return { pass, checks, reason, proposedBudget };
}

// MAX_DAILY_BUDGET caps the total daily budget across everything in scope, and so every single
// budget too. With no ceiling set, budget changes are refused.
export function budgetCeiling({ newBudget, newTotal = null, max }) {
  if (!(max > 0)) return { ok: false, reason: 'MAX_DAILY_BUDGET is not set, so budget changes are turned off' };
  if (!Number.isFinite(newBudget) || newBudget <= 0) return { ok: false, reason: `not a valid daily budget (${newBudget})` };
  if (newBudget > max) return { ok: false, reason: `${money(newBudget)} a day is above the ${money(max)} daily ceiling (MAX_DAILY_BUDGET)` };
  if (newTotal != null && newTotal > max + 0.005) return { ok: false, reason: `the account total would be ${money(newTotal)} a day, above the ${money(max)} daily ceiling (MAX_DAILY_BUDGET)` };
  return { ok: true };
}
