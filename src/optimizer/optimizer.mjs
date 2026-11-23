// The optimizer run: refresh the numbers, check they can be trusted, ask Claude what to do,
// then put every proposed move through the gate, the suppression check and the guardrails.
// What survives is filed in actions_log; the caller posts the cards.
import { db, rt } from '../runtime.mjs';
import { refreshPolicy, policy, ACTION_TYPES, NEVER_AUTO } from './policy.mjs';
import { refreshPerformance } from '../insights.mjs';
import { rollup, storedBudgetOn } from '../insights.mjs';
import { liveStructure, totalDailyBudget, activeAdsBySet, nameOf } from '../account.mjs';
import { dataTrustGate, circuitBreaker } from './safety.mjs';
import { rowsWith } from './rows.mjs';
import { decisionKey, gateProposal, loadLedger, checkSuppression, sweepOpen } from './decisions.mjs';
import { checkPause, checkScale, checkDescale } from './guardrails.mjs';
import { costPosterior, isProvenWinner } from './stats.mjs';
import { modeOf, applyAuto } from './executor.mjs';
import { daysAgo, today } from '../clock.mjs';
import { runTools } from '../reasoning.mjs';
import { OPERATING_RULES, OPTIMIZER_RULES, INVESTIGATE_ADDENDUM } from '../prompts.mjs';
import { brainBlock } from '../brain.mjs';
import { learningsBlock } from '../learn.mjs';
import { recordBlock, resultViewsBlock } from '../record.mjs';
import { metricSpec } from '../metrics.mjs';
import { getState, withLease } from '../jobs.mjs';
import { getConfig } from '../config.mjs';
import { tool, z } from '../tool.mjs';
import { money } from '../money.mjs';

const round = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

// Numbers per ad, ad set and campaign over the mature window, with the posterior.
async function decisionInputs(fresh = null) {
  const { t, target } = policy();
  const since = daysAgo(t.data.windowDays - 1), until = daysAgo(t.data.lagDays);
  const rows = rowsWith(await db().select('performance_daily', { where: { date: { gte: since } } }), fresh).filter((r) => r.date >= since && r.date <= until);
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

// The last budget change on a target: applied moves, moves whose outcome is unknown (they may
// have landed), and changes seen in the timeline.
async function lastBudgetChange(id) {
  const rows = await db().select('actions_log', { where: { target_id: String(id), action_type: { in: ['scale_budget', 'descale_budget'] } }, order: 'id desc', limit: 10 });
  const fromActions = rows.filter((r) => r.applied || r.disposition === 'unknown').map((r) => r.applied_at || r.created_at).filter(Boolean).sort().pop() || null;
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

// One proposal through every check. Files a row unless something stops it. noAuto: never
// applies on its own (proposals filed from chat always wait for a person).
export async function processProposal(p, ctx, { cadence, dryRun = false, noAuto = false }) {
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
  const escalate = Boolean(v.escalate || sup.escalate);
  const mode = await modeOf(p.action_type);
  const auto = !dryRun && !noAuto && !escalate && mode === 'auto' && !NEVER_AUTO.has(p.action_type);
  const row = {
    run_date: today(), cadence, action_type: p.action_type, target_level: v.level, target_id: String(p.target_id),
    target_name: nameOf(ctx.live, p.target_id), before: v.before, after: v.after, reason: p.reason || v.reason, explain,
    guardrail_checks: v.checks, autonomy_level: mode, decision_key: key, evidence: v.evidence,
    disposition: escalate ? 'escalated' : 'proposed', escalated: escalate, applied: false,
  };
  if (dryRun) return { ok: true, key, row: { ...row, id: null, dry_run: true } };
  if (auto) {
    try {
      const res = await applyAuto(row, { slot: `${today()}:${cadence}`, adsetId: ctx.live.ads[p.target_id]?.adset_id || null });
      Object.assign(row, { disposition: 'auto_applied', applied: true, applied_by: 'optimizer', applied_at: rt.now().toISOString(), journal_id: res?.journalId ?? null });
      applyToLive(ctx.live, row);
    } catch (e) {
      if (e?.unknown) {
        Object.assign(row, { disposition: 'unknown', applied_by: 'optimizer', applied_at: rt.now().toISOString(), journal_id: e.journalId ?? null,
          explain: `${explain}\n_Applied on its own, but Meta gave no clear answer, so the outcome is unknown. Check it in Ads Manager, then send \`journal clear ${e.journalId}\`._` });
        applyToLive(ctx.live, row);
      } else {
        Object.assign(row, { disposition: 'escalated', escalated: true, explain: `${explain}\n_Automatic apply failed (${String(e.message).slice(0, 120)}), so it needs you._` });
      }
    }
  }
  // One open card per move (a unique index): if another run filed the same move a moment ago,
  // this one is not filed again.
  const saved = await db().insertIgnore('actions_log', row, null);
  if (!saved) {
    const [open] = await db().select('actions_log', { where: { decision_key: key, disposition: { in: ['proposed', 'escalated'] } }, limit: 1 }).catch(() => []);
    return { blocked: 'already_open', key, why: `card #${open?.id ?? '?'} is already waiting`, action_id: open?.id, card_ts: open?.card_ts, card_channel: open?.card_channel };
  }
  ctx.ledger.set(key, { ...saved, standing: saved.disposition === 'auto_applied' ? 'committed' : saved.disposition === 'unknown' ? 'unknown' : 'open' });
  return { ok: true, key, row: saved };
}

// After a move lands (or may have), the live picture used by the rest of the run follows it, so
// two pauses in one ad set are judged against the ads still running.
function applyToLive(live, row) {
  const ad = live.ads[row.target_id];
  if (ad && row.action_type === 'pause_ad') { ad.effective = 'PAUSED'; ad.configured = 'PAUSED'; }
  if (ad && row.action_type === 'unpause_ad') { ad.effective = 'ACTIVE'; ad.configured = 'ACTIVE'; }
  const e = live.adsets[row.target_id] || live.campaigns[row.target_id];
  if (e && row.after?.dailyBudget != null && ['scale_budget', 'descale_budget'].includes(row.action_type)) e.daily_budget = row.after.dailyBudget;
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
  const [business, lessons, record, results] = await Promise.all([brainBlock().catch(() => ''), learningsBlock().catch(() => ''), recordBlock().catch(() => ''), resultViewsBlock().catch(() => '')]);
  const tools = [captureTool(capture)];
  if (investigate) tools.push(...(await import('../tools.mjs')).readTools());
  await runTools({
    system: [`${OPERATING_RULES}\n\n${OPTIMIZER_RULES}${investigate ? INVESTIGATE_ADDENDUM : ''}`, [business, lessons, record, results].filter(Boolean).join('\n\n')],
    messages: [{ role: 'user', content: `STATE (mature data, pulled live this run):\n${JSON.stringify(state)}` }],
    tools, maxIterations: investigate ? 14 : 3, mustCall: 'propose_actions', done: () => Boolean(capture.plan),
  });
  return capture.plan || { summary: 'no proposal came back', actions: [] };
}

// Build everything a proposal is judged on. store:false reads fresh numbers without saving
// them (a dry run).
export async function buildContext({ refresh = true, store = true } = {}) {
  let live, fresh = null;
  if (refresh) ({ live, fresh } = await refreshPerformance(policy().t.data.windowDays, { store }));
  else live = await liveStructure();
  const { stats, window } = await decisionInputs(store ? null : fresh);
  const ledger = await loadLedger();
  return { live, stats, window, ledger, fresh: store ? null : fresh, baseline: await baselineBudget(live) };
}

// The two safety checks. Either one failing, or failing to run, freezes the run.
async function safetyChecks(ctx) {
  const trust = await dataTrustGate({ fresh: ctx.fresh }).catch((e) => ({ trusted: false, failures: [{ check: 'gate_error', detail: `the data check could not run: ${String(e.message).slice(0, 120)}` }] }));
  const breaker = await circuitBreaker({ live: ctx.live, fresh: ctx.fresh }).catch((e) => ({ tripped: true, reasons: [`the safety check could not run: ${String(e.message).slice(0, 120)}`] }));
  return { trust, breaker, frozen: !trust.trusted || breaker.tripped, reasons: [...(trust.failures || []).map((f) => f.detail), ...(breaker.reasons || [])] };
}

const BUSY = 'Another optimizer run is in progress; this one did not start. Try again in a few minutes.';
const OFF = 'The optimizer is off in the settings (OPTIMIZER_ENABLED=false), so nothing is filed.';

export async function runOptimizer({ cadence = 'daily', investigate = false, dryRun = false } = {}) {
  await refreshPolicy();
  const { target } = policy();
  if (!target) return { held: true, needsTarget: true, summary: 'No target cost per result is set (TARGET_COST_PER_RESULT or brain policy/target), so the optimizer does not run.' };
  const manual = await getState('optimizer/freeze');
  if (manual?.on) return { held: true, manual: true, summary: `The optimizer is frozen by ${manual.by || 'an operator'}${manual.note ? ` ("${manual.note}")` : ''}. Send "unfreeze" to resume.` };
  // One run at a time across every copy of the process.
  const r = await withLease('optimizer', async () => {
    // Numbers that cannot be read are a failed run, not a judgment: it throws, the job is recorded
    // as failed (three in a row open an issue in Slack) and a command exits with an error.
    let ctx;
    try { ctx = await buildContext({ store: !dryRun }); }
    catch (e) { throw new Error(`could not read the numbers from Meta: ${String(e.message).slice(0, 160)}`); }
    const safety = await safetyChecks(ctx);
    if (safety.frozen) return { frozen: true, freezeReasons: safety.reasons, evidence: { trust: safety.trust, breaker: safety.breaker.metrics }, actions: [] };
    const closed = dryRun ? [] : await sweepOpen(ctx.live).catch(() => []);
    const plan = await propose(stateFor(ctx, ctx.ledger), { investigate });
    const filed = [], blocked = [];
    for (const p of plan.actions || []) {
      const x = await processProposal(p, ctx, { cadence, dryRun });
      if (x.ok) filed.push(x.row); else blocked.push({ ...p, ...x });
    }
    return { cadence, summary: plan.summary, actions: filed, blocked, closed, target, dryRun };
  });
  if (r?.busy) return { held: true, busy: true, summary: BUSY };
  return r;
}

// Proposals filed from chat go through exactly the same checks, and always wait for a person.
export async function fileProposals(proposals, { cadence = 'chat' } = {}) {
  if (getConfig().OPTIMIZER_ENABLED === false) return [{ ok: false, blocked: 'off', detail: OFF }];
  await refreshPolicy();
  if (!policy().target) return [{ ok: false, blocked: 'no_target', detail: 'set TARGET_COST_PER_RESULT or brain policy/target first' }];
  const manual = await getState('optimizer/freeze');
  if (manual?.on) return [{ ok: false, blocked: 'frozen', detail: `the optimizer is frozen by ${manual.by || 'an operator'}; send "unfreeze" first` }];
  const r = await withLease('optimizer', async () => {
    const ctx = await buildContext({ refresh: true });
    const safety = await safetyChecks(ctx);
    if (safety.frozen) return [{ ok: false, blocked: 'frozen', detail: `the safety checks froze the optimizer: ${safety.reasons.join('; ').slice(0, 300)}` }];
    const out = [];
    for (const p of proposals || []) out.push(await processProposal(p, ctx, { cadence, noAuto: true }));
    return out;
  });
  if (r?.busy) return [{ ok: false, blocked: 'busy', detail: BUSY }];
  return r;
}
