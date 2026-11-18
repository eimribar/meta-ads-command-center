// The daily report: yesterday against the target and the week before, the best and worst ads,
// what moderation did, and what is waiting for a person. Numbers come from Meta in code; Claude
// only writes the short read on top.
import { graphAll, account, scopeFilter } from './meta.mjs';
import { metricSpec, resultsOf, secondaryOf, INSIGHT_FIELDS, round2, costPer } from './metrics.mjs';
import { daysAgo } from './clock.mjs';
import { db } from './runtime.mjs';
import { policy, refreshPolicy } from './optimizer/policy.mjs';
import { complete, textOf } from './reasoning.mjs';
import { OPERATING_RULES, REPORT_RULES } from './prompts.mjs';
import { brainBlock } from './brain.mjs';
import { openIncidents } from './jobs.mjs';
import { money } from './money.mjs';

const fmt = money;
const pct = (a, b) => (a == null || !b ? null : Math.round(((a - b) / b) * 100));
const arrow = (p) => (p == null ? '' : ` (${p >= 0 ? '+' : ''}${p}% vs 7 day avg)`);

export async function reportNumbers(day = daysAgo(1)) {
  const spec = metricSpec();
  const since = daysAgo(8);
  const [daily, ads] = await Promise.all([
    graphAll(`${account()}/insights`, { level: 'account', time_range: { since, until: day }, time_increment: 1, fields: INSIGHT_FIELDS, filtering: scopeFilter() }, 20),
    graphAll(`${account()}/insights`, { level: 'ad', time_range: { since: day, until: day }, fields: `ad_id,ad_name,${INSIGHT_FIELDS}`, filtering: scopeFilter() }, 2000),
  ]);
  const shape = (r) => ({ date: r.date_start, spend: round2(Number(r.spend) || 0), clicks: Number(r.clicks) || 0, impressions: Number(r.impressions) || 0, results: resultsOf(r, spec), secondary: secondaryOf(r, spec) });
  const days = daily.map(shape);
  const y = days.find((d) => d.date === day) || { date: day, spend: 0, clicks: 0, impressions: 0, results: 0, secondary: 0 };
  const prior = days.filter((d) => d.date < day).slice(-7);
  const avg = (k) => (prior.length ? prior.reduce((s, d) => s + d[k], 0) / prior.length : null);
  const avgSpend = avg('spend'), avgResults = avg('results');
  const adRows = ads.map((r) => ({ id: r.ad_id, name: r.ad_name, ...shape(r) })).filter((a) => a.spend > 0);
  const best = [...adRows].filter((a) => a.results > 0).sort((a, b) => a.spend / a.results - b.spend / b.results).slice(0, 3);
  const worst = [...adRows].filter((a) => a.results === 0).sort((a, b) => b.spend - a.spend).slice(0, 3);
  return {
    day, label: spec.result.label, secondaryLabel: spec.secondary?.label || null, yesterday: { ...y, cost: costPer(y.spend, y.results), secondary_cost: costPer(y.spend, y.secondary) },
    weekAvg: { spend: round2(avgSpend), results: avgResults == null ? null : round2(avgResults), cost: avgResults ? round2(avgSpend / avgResults) : null },
    week: { spend: round2(prior.reduce((s, d) => s + d.spend, 0)), results: prior.reduce((s, d) => s + d.results, 0) },
    best, worst,
  };
}

async function openItems(day) {
  const [open, mod, incidents] = await Promise.all([
    db().select('actions_log', { where: { disposition: { in: ['proposed', 'escalated'] } } }).catch(() => []),
    db().select('moderation_log', { where: { at: { gte: `${day}T00:00:00Z` } } }).catch(() => []),
    openIncidents(),
  ]);
  return {
    approvals: open.length,
    moderation: { hidden: mod.filter((m) => m.action === 'hide').length, deleted: mod.filter((m) => m.action === 'delete').length, flagged: mod.filter((m) => m.action === 'flag').length },
    incidents: incidents.map((i) => i.text),
  };
}

export async function buildDailyReport(day = daysAgo(1), { narrate = true } = {}) {
  await refreshPolicy().catch(() => {});
  const { target } = policy();
  const n = await reportNumbers(day);
  const items = await openItems(day);
  const y = n.yesterday;
  const lines = [];
  lines.push(`*Meta ads, ${day}*`);
  lines.push(`• Spend ${fmt(y.spend)}${arrow(pct(y.spend, n.weekAvg.spend))}`);
  lines.push(`• ${n.label}: ${y.results}${y.cost != null ? ` at ${fmt(y.cost)} each` : ''}${target ? ` (target ${fmt(target)})` : ''}${arrow(pct(y.results, n.weekAvg.results))}`);
  if (n.secondaryLabel) lines.push(`• ${n.secondaryLabel}: ${y.secondary}${y.secondary_cost != null ? ` at ${fmt(y.secondary_cost)} each` : ''}`);
  lines.push(`• Last 7 days: ${fmt(n.week.spend)} for ${n.week.results} ${n.label}${n.week.results ? ` (${fmt(round2(n.week.spend / n.week.results))} each)` : ''}`);
  if (n.best.length) lines.push(`• Best yesterday: ${n.best.map((a) => `${a.name} (${a.results} at ${fmt(round2(a.spend / a.results))})`).join(', ')}`);
  if (n.worst.length) lines.push(`• Spent with no ${n.label}: ${n.worst.map((a) => `${a.name} (${fmt(a.spend)})`).join(', ')}`);
  const m = items.moderation;
  if (m.hidden || m.deleted || m.flagged) lines.push(`• Comments: ${m.hidden} hidden${m.deleted ? `, ${m.deleted} deleted` : ''}${m.flagged ? `, ${m.flagged} flagged for you` : ''}`);
  if (items.approvals) lines.push(`• Waiting for approval: ${items.approvals} card${items.approvals === 1 ? '' : 's'}`);
  for (const i of items.incidents.slice(0, 3)) lines.push(`• Open issue: ${i}`);
  lines.push('_Meta keeps attributing results for about two days, so yesterday can still go up._');
  let read = '';
  if (narrate) {
    try {
      const msg = await complete({
        system: [`${OPERATING_RULES}\n\n${REPORT_RULES}`, await brainBlock()],
        messages: [{ role: 'user', content: JSON.stringify({ target, numbers: n, open: items }) }],
        maxTokens: 4000,
      });
      read = textOf(msg).replace(/~(?=[$\d])/g, 'about ');
    } catch (e) { console.error('[report] narration failed:', String(e.message).slice(0, 120)); }
  }
  return { text: [read, lines.join('\n')].filter(Boolean).join('\n\n'), numbers: n, items };
}
