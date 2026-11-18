// The optimizer run: refresh the numbers, check they can be trusted, ask Claude what to do,
// then put every proposed move through the gate, the suppression check and the guardrails.
// What survives is filed in actions_log; the caller posts the cards.
import { db, rt } from '../runtime.mjs';
import { refreshPolicy, policy, ACTION_TYPES, NEVER_AUTO } from './policy.mjs';
import { refreshPerformance } from '../insights.mjs';
import { rollup, storedBudgetOn } from '../insights.mjs';
import { liveStructure, totalDailyBudget, activeAdsBySet, nameOf } from '../account.mjs';
import { dataTrustGate, circuitBreaker } from './safety.mjs';
import { decisionKey, gateProposal, loadLedger, checkSuppression, sweepOpen } from './decisions.mjs';
import { checkPause, checkScale, checkDescale } from './guardrails.mjs';
import { costPosterior, isProvenWinner } from './stats.mjs';
import { modeOf, applyAuto } from './executor.mjs';
import { daysAgo, today } from '../clock.mjs';
import { runTools } from '../reasoning.mjs';
import { OPERATING_RULES, OPTIMIZER_RULES, INVESTIGATE_ADDENDUM } from '../prompts.mjs';
import { brainBlock } from '../brain.mjs';
import { learningsBlock } from '../learn.mjs';
import { metricSpec } from '../metrics.mjs';
import { getState } from '../jobs.mjs';
import { tool, z } from '../tool.mjs';
import { money } from '../money.mjs';

const round = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

// Numbers per ad, ad set and campaign over the mature window, with the posterior.
async function decisionInputs() {
  const { t, target } = policy();
  const since = daysAgo(t.data.windowDays - 1), until = daysAgo(t.data.lagDays);
  const rows = (await db().select('performance_daily', { where: { date: { gte: since } } })).filter((r) => r.date <= until);
  const byLevel = { ad: [], adset: [], campaign: [] };
  for (const r of rows) byLevel[r.level]?.push(r);
  const stats = {};
  for (const level of ['ad', 'adset', 'campaign']) {
    stats[level] = rollup(byLevel[level]);
    for (const e of Object.values(stats[level])) {
      const stat = { spend: e.spend, results: e.results, priorCost: target, priorResults: t.winner.priorResults };
      e.posterior = costPosterior(stat);
      const w = isProvenWinner(stat, { bar: target, matureDays: e.days, minDays: t.winner.minDays, minProb: t.winner.minProb });
      e.prob_beats_target = w.prob; e.proven = w.proven;
    }
  }
  return { stats, window: { since, until } };
}

async function lastBudgetChange(id) {
  const rows = await db().select('actions_log', { where: { target_id: String(id), applied: true }, order: 'applied_at desc', limit: 5 });
  const fromActions = rows.find((r) => ['scale_budget', 'descale_budget'].includes(r.action_type))?.applied_at || null;
  const events = await db().select('timeline', { where: { event: 'budget_changed' }, order: 'at desc', limit: 200 }).catch(() => []);
  const fromTimeline = events.find((e) => String(e.detail?.id) === String(id))?.at || null;
  return [fromActions, fromTimeline].filter(Boolean).sort().pop() || null;
}

// The total daily budget a week ago, from the stored snapshots (falls back to today's).
async function baselineBudget(live) {
  return (await storedBudgetOn(daysAgo(7))) ?? totalDailyBudget(live);
}


// Check one proposal against the live numbers. Returns what to file, or why not.
async function validate(p, ctx) {
  const { live, stats } = ctx;
  const { target } = policy();
  const label = metricSpec().result.label;
  if (p.action_type === 'pause_ad') {
    const a = stats.ad[p.target_id] || { spend: 0, results: 0, cost: null, days: 0 };
    const set = live.ads[p.target_id]?.adset_id;
    const r = checkPause({ spend: a.spend, results: a.results, cost: a.cost, days: a.days, activeInSet: activeAdsBySet(live)[set] });
    const explain = a.results > 0
      ? `${money(a.cost)} per ${label} against the ${money(target)} target, on ${money(a.spend)} over ${a.days} days (${a.results} ${label}). It had a fair test.`
      : `${money(a.spend)} spent over ${a.days} days with no ${label}.`;
    return { level: 'ad', before: { status: 'ACTIVE' }, after: { status: 'PAUSED' }, checks: r.checks, reason: r.reason, explain, ok: r.pass || r.escalate, escalate: r.escalate, evidence: { cost: a.cost, spend: a.spend, results: a.results } };
  }
  if (p.action_type === 'unpause_ad') {
    const a = stats.ad[p.target_id];
    const explain = `${p.reason}${a ? ` Window so far: ${money(a.spend)} spent, ${a.results} ${label}${a.cost ? ` at ${money(a.cost)} each` : ''}.` : ''}`;
    return { level: 'ad', before: { status: 'PAUSED' }, after: { status: 'ACTIVE' }, checks: { gate: true }, reason: p.reason, explain, ok: true, escalate: true, evidence: a ? { cost: a.cost, spend: a.spend, results: a.results } : null };
  }
  const level = live.campaigns[p.target_id] ? 'campaign' : 'adset';
  const e = stats[level][p.target_id] || { spend: 0, results: 0, cost: null, days: 0, proven: false };
  const current = (level === 'campaign' ? live.campaigns : live.adsets)[p.target_id]?.daily_budget;
  const lastChange = await lastBudgetChange(p.target_id);
  if (p.action_type === 'scale_budget') {
    const r = checkScale({ proven: e.proven, results: e.results, lastBudgetChangeAt: lastChange, currentBudget: current, liveTotal: totalDailyBudget(live), baselineTotal: ctx.baseline });
    const explain = `${money(e.cost)} per ${label} over ${e.days} mature days, ${Math.round((e.prob_beats_target || 0) * 100)}% likely under the ${money(target)} target. Raise ${money(current)} to ${money(r.proposedBudget)} a day.`;
    return { level, before: { dailyBudget: current }, after: { dailyBudget: r.proposedBudget }, checks: r.checks, reason: r.reason, explain, ok: r.pass, escalate: true, evidence: { cost: e.cost, spend: e.spend, results: e.results } };
  }
  if (p.action_type === 'descale_budget') {
    const r = checkDescale({ cost: e.cost, results: e.results, lastBudgetChangeAt: lastChange, currentBudget: current });
    const explain = `${money(e.cost)} per ${label} over ${e.days} mature days against the ${money(target)} target. Trim ${money(current)} to ${money(r.proposedBudget)} a day.`;
    return { level, before: { dailyBudget: current }, after: { dailyBudget: r.proposedBudget }, checks: r.checks, reason: r.reason, explain, ok: r.pass, escalate: true, evidence: { cost: e.cost, spend: e.spend, results: e.results } };
  }
  return { ok: false, reason: `unknown action ${p.action_type}` };
}

// One proposal through every check. Files a row unless something stops it.
export async function processProposal(p, ctx, { cadence, dryRun = false }) {
  if (!ACTION_TYPES.includes(p.action_type)) return { blocked: 'unknown_action', detail: p.action_type };
  const key = decisionKey(p);
  if (!key) return { blocked: 'no_target', detail: 'missing target_id' };
  const gate = gateProposal(p, ctx.live);
  if (!gate.ok) return { blocked: 'moot', key, code: gate.code, detail: gate.detail };
  const v = await validate(p, ctx);
  const sup = checkSuppression(key, ctx.ledger, ctx.live, v.evidence);
  if (sup.suppressed) {
    const open = sup.standing === 'open' ? ctx.ledger.get(key) : null;
    return { blocked: sup.standing === 'open' ? 'already_open' : 'suppressed', key, why: sup.why, action_id: open?.id, card_ts: open?.card_ts, card_channel: open?.card_channel };
  }
  if (!v.ok) return { blocked: 'guardrail', key, reason: v.reason, checks: v.checks };
  const explain = sup.reopened ? `${v.explain}\n_${sup.reopened}_` : v.explain;
  const mode = await modeOf(p.action_type);
  const auto = !dryRun && !v.escalate && mode === 'auto' && !NEVER_AUTO.has(p.action_type);
  const row = {
    run_date: today(), cadence, action_type: p.action_type, target_level: v.level, target_id: String(p.target_id),
    target_name: nameOf(ctx.live, p.target_id), before: v.before, after: v.after, reason: p.reason || v.reason, explain,
    guardrail_checks: v.checks, autonomy_level: mode, decision_key: key, evidence: v.evidence,
    disposition: v.escalate ? 'escalated' : 'proposed', escalated: Boolean(v.escalate), applied: false,
  };
  if (dryRun) return { ok: true, key, row: { ...row, id: null, dry_run: true } };
  if (auto) {
    try {
      await applyAuto(row, { slot: `${today()}:${cadence}` });
      Object.assign(row, { disposition: 'auto_applied', applied: true, applied_by: 'optimizer', applied_at: rt.now().toISOString() });
    } catch (e) {
      Object.assign(row, { disposition: 'escalated', escalated: true, explain: `${explain}\n_Automatic apply failed (${String(e.message).slice(0, 120)}), so it needs you._` });
    }
  }
  const [saved] = await db().insert('actions_log', [row]);
  ctx.ledger.set(key, { ...saved, standing: saved.disposition === 'auto_applied' ? 'committed' : 'open' });
  return { ok: true, key, row: saved };
}

// The STATE Claude sees.
function stateFor(ctx, ledger) {
  const { target, t } = policy();
  const spec = metricSpec();
  const pick = (e, extra = {}) => ({ name: e.name, spend: e.spend, results: e.results, cost_per_result: e.cost, mature_days: e.days, prob_under_target: e.prob_beats_target, proven_winner: e.proven, ...extra });
  const live = ctx.live;
  return {
    today: today(), result_event: spec.result.label, target_cost_per_result: target,
    max_daily_budget: policy().maxDailyBudget, total_daily_budget_now: totalDailyBudget(live),
    data_window: ctx.window, thresholds: t,
    campaigns: Object.fromEntries(Object.entries(live.campaigns).map(([id, c]) => [id, { name: c.name, status: c.effective, campaign_budget: c.daily_budget, ...(ctx.stats.campaign[id] ? pick(ctx.stats.campaign[id]) : {}) }])),
    adsets: Object.fromEntries(Object.entries(live.adsets).map(([id, s]) => [id, { name: s.name, campaign_id: s.campaign_id, status: s.effective, daily_budget: s.daily_budget, ...(ctx.stats.adset[id] ? pick(ctx.stats.adset[id]) : {}) }])),
    ads: Object.entries(live.ads).filter(([id, a]) => a.effective === 'ACTIVE' || ctx.stats.ad[id]).map(([id, a]) => ({ ad_id: id, adset_id: a.adset_id, status: a.effective, ...(ctx.stats.ad[id] ? pick(ctx.stats.ad[id]) : { name: a.name, spend: 0, results: 0 }) })),
    standing_decisions: [...ledger.values()].filter((r) => ['open', 'committed', 'rejected'].includes(r.standing)).slice(-30)
      .map((r) => ({ key: r.decision_key, standing: r.standing, since: String(r.applied_at || r.created_at || '').slice(0, 10), note: r.decision_note || null })),
  };
}

function captureTool(capture) {
  return tool({
    name: 'propose_actions',
    description: 'Final step: the set of moves for this run, each with its reason. Call exactly once.',
    input: z.object({
      summary: z.string().describe('one line on the account this run'),
      actions: z.array(z.object({
        action_type: z.enum(ACTION_TYPES),
        target_id: z.string().describe('an ad id for pause_ad and unpause_ad; an ad set or campaign id for budget moves'),
        reason: z.string(),
        confidence: z.enum(['high', 'medium', 'low']).optional(),
      })),
    }),
    run: async (input) => { capture.plan = input; return 'Proposal recorded. You are done; end the turn.'; },
  });
}

async function propose(state, { investigate }) {
  const capture = { plan: null };
  const [business, lessons] = await Promise.all([brainBlock().catch(() => ''), learningsBlock().catch(() => '')]);
  const tools = [captureTool(capture)];
  if (investigate) tools.push(...(await import('../tools.mjs')).readTools());
  await runTools({
    system: [`${OPERATING_RULES}\n\n${OPTIMIZER_RULES}${investigate ? INVESTIGATE_ADDENDUM : ''}`, `${business}\n\n${lessons}`],
    messages: [{ role: 'user', content: `STATE (mature data, pulled live this run):\n${JSON.stringify(state)}` }],
    tools, maxIterations: investigate ? 14 : 3, mustCall: 'propose_actions', done: () => Boolean(capture.plan),
  });
  return capture.plan || { summary: 'no proposal came back', actions: [] };
}

// Build everything a proposal is judged on.
export async function buildContext({ refresh = true } = {}) {
  let live;
  if (refresh) live = (await refreshPerformance(policy().t.data.windowDays)).live;
  else live = await liveStructure();
  const { stats, window } = await decisionInputs();
  const ledger = await loadLedger();
  return { live, stats, window, ledger, baseline: await baselineBudget(live) };
}

export async function runOptimizer({ cadence = 'daily', investigate = false, dryRun = false } = {}) {
  await refreshPolicy();
  const { target } = policy();
  if (!target) return { held: true, needsTarget: true, summary: 'No target cost per result is set (TARGET_COST_PER_RESULT or brain policy/target), so the optimizer does not run.' };
  const manual = await getState('optimizer/freeze');
  if (manual?.on) return { held: true, manual: true, summary: `The optimizer is frozen by ${manual.by || 'an operator'}${manual.note ? ` ("${manual.note}")` : ''}. Send "unfreeze" to resume.` };
  // Numbers that cannot be read are a failed run, not a judgment: it throws, the job is recorded
  // as failed (three in a row open an issue in Slack) and a command exits with an error.
  let ctx;
  try { ctx = await buildContext(); }
  catch (e) { throw new Error(`could not read the numbers from Meta: ${String(e.message).slice(0, 160)}`); }
  const trust = await dataTrustGate().catch((e) => ({ trusted: false, failures: [{ check: 'gate_error', detail: String(e.message).slice(0, 120) }] }));
  const breaker = await circuitBreaker({ live: ctx.live }).catch(() => ({ tripped: false, reasons: [] }));
  if (!trust.trusted || breaker.tripped) {
    return { frozen: true, freezeReasons: [...(trust.failures || []).map((f) => f.detail), ...(breaker.reasons || [])], evidence: { trust, breaker: breaker.metrics }, actions: [] };
  }
  const closed = dryRun ? [] : await sweepOpen(ctx.live).catch(() => []);
  const plan = await propose(stateFor(ctx, ctx.ledger), { investigate });
  const filed = [], blocked = [];
  for (const p of plan.actions || []) {
    const r = await processProposal(p, ctx, { cadence, dryRun });
    if (r.ok) filed.push(r.row); else blocked.push({ ...p, ...r });
  }
  return { cadence, summary: plan.summary, actions: filed, blocked, closed, target, dryRun };
}

// Proposals filed from chat go through exactly the same checks.
export async function fileProposals(proposals, { cadence = 'chat' } = {}) {
  await refreshPolicy();
  if (!policy().target) return [{ ok: false, blocked: 'no_target', detail: 'set TARGET_COST_PER_RESULT or brain policy/target first' }];
  const ctx = await buildContext({ refresh: true });
  const out = [];
  for (const p of proposals || []) out.push(await processProposal(p, ctx, { cadence }));
  return out;
}
