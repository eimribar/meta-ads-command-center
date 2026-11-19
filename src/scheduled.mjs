// The scheduled jobs. Each runs once per slot (see runJob), from the internal timers or from the
// command line (`npm run job -- <name>`), so a team can use its own scheduler instead.
import { rt, db } from './runtime.mjs';
import { getConfig } from './config.mjs';
import { runJob, getState, setState, postOnce, forgetSeen } from './jobs.mjs';
import { today, daysAgo, dayOf } from './clock.mjs';
import { buildDailyReport } from './report.mjs';
import { runOptimizer } from './optimizer/optimizer.mjs';
import { runModeration, moderationSummary } from './moderation.mjs';
import { distillLearnings } from './learn.mjs';
import { freezeDiagnosis } from './agentic.mjs';
import { postToDesk, updateDesk } from './slack/desk.mjs';
import { postCards } from './slack/approvals.mjs';
import { doneBlocks } from './slack/cards.mjs';
import { moveEffects, effectsText } from './review.mjs';
import { metricSpec } from './metrics.mjs';
import { scoreboardText, buildScoreboard } from './scoreboard.mjs';
import { money } from './money.mjs';
import { plural } from './words.mjs';

// Where job output goes: under today's desk in Slack, or to stdout on a dry run.
function poster({ dryRun }) {
  return async (payload, opts = {}) => {
    const p = typeof payload === 'string' ? { text: payload } : payload;
    if (dryRun || !rt.slack) { console.log(`\n${p.text}\n`); return null; }
    return postToDesk(p, opts);
  };
}

const hourSlot = (minutes) => {
  const n = rt.now();
  const bucket = Math.floor(n.getTime() / (minutes * 60_000));
  return `${dayOf(n)}#${bucket}`;
};
const isoWeek = () => {
  const d = new Date(`${today()}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return `${d.getUTCFullYear()}-W${String(1 + Math.round(((d - first) / 864e5 - 3 + ((first.getUTCDay() + 6) % 7)) / 7)).padStart(2, '0')}`;
};

async function reportJob({ dryRun }) {
  const post = poster({ dryRun });
  const day = daysAgo(1);
  const r = await buildDailyReport(day);
  await post({ text: r.text }, { broadcast: true });
  // the morning creative scoreboard: every ad that spent this week against the target
  const sb = await buildScoreboard({ days: 7, limit: 15 }).catch(() => null);
  if (sb?.ads?.length) await post({ text: scoreboardText(sb) });
  return { summary: `report for ${day}` };
}

async function optimizerJob({ dryRun, investigate, cadence }) {
  const post = poster({ dryRun });
  const run = await runOptimizer({ cadence, investigate, dryRun });
  if (run.held) {
    if (!dryRun && run.needsTarget && await postOnce('optimizer-needs-target', 24)) await post(`:information_source: ${run.summary}`);
    if (dryRun) await post(run.summary);
    return { held: true, summary: run.summary };
  }
  if (run.frozen) {
    const sig = run.freezeReasons.join(' | ');
    const prev = await getState('optimizer/freeze_signature');
    if (dryRun || prev?.sig !== sig) {
      const diag = await freezeDiagnosis(run.freezeReasons, run.evidence);
      await post({ text: `:rotating_light: *Optimizer paused itself*: ${run.freezeReasons.join('; ')}${diag ? `\n${diag}` : ''}` }, { broadcast: true });
      if (!dryRun) await setState('optimizer/freeze_signature', { sig, at: rt.now().toISOString() });
    }
    return { held: true, summary: `frozen: ${sig.slice(0, 200)}` };
  }
  if (!dryRun) {
    const prev = await getState('optimizer/freeze_signature');
    if (prev?.sig) { await setState('optimizer/freeze_signature', { sig: null }); await post(':white_check_mark: The optimizer trusts the data again and is back to work.'); }
  }
  // Cards the sweep closed (the move no longer makes sense, or a week went by) lose their buttons.
  if (!dryRun && rt.slack) {
    for (const c of run.closed || []) {
      if (c.card_ts && c.card_channel) await rt.slack.chat.update({ channel: c.card_channel, ts: c.card_ts, text: 'Closed', blocks: doneBlocks(c, `:information_source: Closed on its own: ${c.why}`) }).catch(() => {});
    }
  }
  const pending = run.actions.filter((a) => ['proposed', 'escalated'].includes(a.disposition));
  const auto = run.actions.filter((a) => a.disposition === 'auto_applied');
  const label = metricSpec().result.label;
  if (dryRun) {
    await post([`*Optimizer dry run* (target ${money(run.target)} per ${label})`, run.summary,
      ...run.actions.map((a) => `• would file: ${a.action_type} ${a.target_name || a.target_id}: ${a.explain}`),
      ...run.blocked.map((b) => `• blocked: ${b.action_type} ${b.target_id}: ${b.blocked} ${b.why || b.reason || b.detail || ''}`)].join('\n'));
    return { summary: `dry run: ${run.actions.length} would be filed` };
  }
  for (const a of auto) await post(`:robot_face: Applied on its own (ladder is on auto): ${a.action_type.replace(/_/g, ' ')} *${a.target_name || a.target_id}*. ${a.explain}\n_Send \`undo ${a.id}\` to reverse it._`);
  const unknown = run.actions.filter((a) => a.disposition === 'unknown');
  for (const a of unknown) await post(`:question: Outcome unknown: ${a.action_type.replace(/_/g, ' ')} *${a.target_name || a.target_id}* was sent on its own, and Meta gave no clear answer. Check it in Ads Manager, then send \`journal clear ${a.journal_id}\`. Further changes wait until then.`);
  if (pending.length) {
    const header = `:bulb: *${pending.length} decision${pending.length === 1 ? '' : 's'} for you* (target ${money(run.target)} per ${label})\n${run.summary || ''}`;
    await postCards(pending, null, { header });
  } else if (cadence === 'daily') {
    await post(`:white_check_mark: Optimizer: nothing needs approval today. ${run.summary || ''}`);
  }
  await updateDesk().catch(() => {});
  return { summary: `${plural(pending.length, 'card')}, ${auto.length} automatic, ${run.blocked.length} blocked${unknown.length ? `, ${unknown.length} with an unknown outcome` : ''}`, auto: auto.length };
}

async function moderationJob({ dryRun }) {
  const post = poster({ dryRun });
  const r = await runModeration({ act: !dryRun });
  if (dryRun || r.hidden.length || r.deleted.length || r.flagged.length || r.errors.length || r.readErrors?.length) await post(moderationSummary(r));
  return { summary: `${r.scanned} scanned, ${r.hidden.length} hidden, ${r.deleted.length} deleted, ${r.flagged.length} flagged` };
}

async function weeklyJob({ dryRun }) {
  const post = poster({ dryRun });
  // Slack event ids older than a week are no longer needed to answer each message once.
  if (!dryRun) await forgetSeen(7).catch(() => {});
  const lessons = dryRun ? { held: true, summary: 'dry run: lessons not changed' } : await distillLearnings().catch((e) => ({ held: true, summary: `lessons failed: ${String(e.message).slice(0, 100)}` }));
  const since = daysAgo(7);
  const decided = await db().select('actions_log', { where: { run_date: { gte: since } } }).catch(() => []);
  const approved = decided.filter((a) => a.disposition === 'applied_by_human').length;
  const rejected = decided.filter((a) => a.close_reason === 'human_reject').length;
  const autoN = decided.filter((a) => a.disposition === 'auto_applied').length;
  const sb = await buildScoreboard({ days: 7, limit: 8 });
  const effects = await moveEffects().catch(() => []);
  const lines = [`:calendar: *Weekly review*`,
    `• Last 7 days of decisions: ${approved} approved, ${rejected} rejected${autoN ? `, ${autoN} automatic` : ''}, ${decided.filter((a) => ['proposed', 'escalated'].includes(a.disposition)).length} still open`,
    lessons.lessons?.length ? `• Lessons the optimizer now follows:\n${lessons.lessons.map((l) => `   ◦ ${l}`).join('\n')}` : `• Lessons: ${lessons.summary}`,
    '', '*What the applied moves did* (mature days before and after, from Meta)', effectsText(effects),
    '', scoreboardText(sb)];
  await post({ text: lines.join('\n') }, { broadcast: true });
  return { summary: `weekly review; ${lessons.summary}` };
}

// name -> { slot(), run(opts) }
export const JOBS = {
  report: { slot: () => today(), run: (o) => reportJob(o) },
  optimizer: { slot: () => today(), run: (o) => optimizerJob({ ...o, investigate: true, cadence: 'daily' }) },
  'optimizer-check': { slot: () => hourSlot(Math.max(60, getConfig().OPTIMIZER_EVERY_HOURS * 60)), run: (o) => optimizerJob({ ...o, investigate: false, cadence: 'check' }) },
  moderation: { slot: () => hourSlot(getConfig().MODERATION_EVERY_MINUTES), run: (o) => moderationJob(o) },
  weekly: { slot: () => isoWeek(), run: (o) => weeklyJob(o) },
};

// OPTIMIZER_ENABLED=false turns the optimizer off everywhere: the timers, npm run job and
// `optimize` in Slack. The report and the comment sweep keep their on demand runs when their
// own setting is false; only their timers stop.
export const OPTIMIZER_OFF = 'The optimizer is off in the settings. Whoever set up the agent can turn it on (OPTIMIZER_ENABLED=true) and restart it.';
export function jobOff(name) {
  return ['optimizer', 'optimizer-check'].includes(name) && getConfig().OPTIMIZER_ENABLED === false ? OPTIMIZER_OFF : null;
}

// Run a job by name. A dry run skips the claim and posts nothing. A job that is turned off
// returns { off: true, summary } and runs nothing.
export async function runNamedJob(name, { dryRun = false, force = false } = {}) {
  const job = JOBS[name];
  if (!job) throw new Error(`unknown job "${name}"; one of ${Object.keys(JOBS).join(', ')}`);
  const off = jobOff(name);
  if (off) return { off: true, summary: off };
  if (dryRun) return job.run({ dryRun: true });
  const slot = force ? `${job.slot()}:manual:${rt.now().toISOString()}` : job.slot();
  return runJob(name, slot, () => job.run({ dryRun: false }));
}
