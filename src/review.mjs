// What the applied moves did: for each move applied in the last few weeks, the target's numbers
// over the days before it against the mature days after it, from the stored daily rows.
import { db } from './runtime.mjs';
import { daysAgo, dayOf } from './clock.mjs';
import { policy } from './optimizer/policy.mjs';
import { metricSpec } from './metrics.mjs';
import { VERB } from './slack/cards.mjs';
import { money } from './money.mjs';

const addDays = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

function sum(rows) {
  const spend = rows.reduce((s, r) => s + (Number(r.spend) || 0), 0);
  const results = rows.reduce((s, r) => s + (Number(r.results) || 0), 0);
  const days = rows.length;
  return { days, spend: r2(spend), results, perDay: days ? r2(results / days) : null, spendPerDay: days ? r2(spend / days) : null, cost: results ? r2(spend / results) : null };
}

export async function moveEffects({ sinceDays = 21, windowDays = 7 } = {}) {
  const lag = policy().t.data.lagDays;
  const matureUntil = daysAgo(lag);
  const rows = await db().select('actions_log', { where: { applied: true, run_date: { gte: daysAgo(sinceDays) } }, order: 'id' }).catch(() => []);
  const out = [];
  for (const a of rows) {
    if (!a.applied_at || a.undone_at) continue;
    const day = dayOf(new Date(a.applied_at));
    const level = a.target_level || 'ad';
    const perf = (await db().select('performance_daily', { where: { level, entity_id: String(a.target_id), date: { gte: addDays(day, -windowDays) } } }).catch(() => []))
      .filter((r) => r.date <= matureUntil && r.spend != null);
    const before = sum(perf.filter((r) => r.date < day));
    const after = sum(perf.filter((r) => r.date > day && r.date <= addDays(day, windowDays)));
    out.push({ id: a.id, action_type: a.action_type, target: a.target_name || a.target_id, applied: day, by: a.applied_by, before, after, tooEarly: after.days < 2 && a.action_type !== 'pause_ad' });
  }
  return out;
}


export function effectsText(effects) {
  if (!effects.length) return '• No moves were applied in the last 3 weeks.';
  const label = metricSpec().result.label;
  return effects.map((e) => {
    const head = `• ${VERB[e.action_type] || e.action_type} *${e.target}* (${e.applied}${e.by ? `, ${e.by === 'optimizer' ? 'automatic' : `by ${/^[UW][A-Z0-9]+$/.test(e.by) ? `<@${e.by}>` : e.by}`}` : ''})`;
    if (e.action_type === 'pause_ad') {
      return `${head}: before, ${money(e.before.spendPerDay)} a day for ${e.before.results} ${label} in ${e.before.days} days${e.before.cost ? ` (${money(e.before.cost)} each)` : ''}; after, ${money(e.after.spendPerDay ?? 0)} a day.`;
    }
    if (e.tooEarly) return `${head}: too early to tell (fewer than 2 mature days since).`;
    return `${head}: ${label} a day ${e.before.perDay ?? 0} to ${e.after.perDay ?? 0}, cost each ${money(e.before.cost)} to ${money(e.after.cost)}, spend a day ${money(e.before.spendPerDay)} to ${money(e.after.spendPerDay)}.`;
  }).join('\n');
}
