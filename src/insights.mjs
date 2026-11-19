// Pull daily numbers from Meta and keep them in performance_daily. Every judgment reads rows
// refreshed in the same run, so a missed day never leaves an old hole in the window.
import { graphAll, account, scopeFilter } from './meta.mjs';
import { metricSpec, resultsOf, secondaryOf, INSIGHT_FIELDS, round2 } from './metrics.mjs';
import { rt, db } from './runtime.mjs';
import { range, today } from './clock.mjs';
import { liveStructure } from './account.mjs';

const ID = { ad: 'ad_id', adset: 'adset_id', campaign: 'campaign_id' };
const NAME = { ad: 'ad_name', adset: 'adset_name', campaign: 'campaign_name' };

// Daily insights rows for one level, normalized.
export async function pullDaily(level, { since, until }, spec = metricSpec()) {
  const fields = ['date_start', ID[level], NAME[level], level !== 'campaign' ? 'campaign_id' : null, level === 'ad' ? 'adset_id' : null, INSIGHT_FIELDS].filter(Boolean).join(',');
  const rows = await graphAll(`${account()}/insights`, {
    level, fields, time_increment: 1, time_range: { since, until }, filtering: scopeFilter(),
  }, 20_000);
  return rows.map((r) => ({
    date: r.date_start,
    level,
    entity_id: String(r[ID[level]]),
    name: r[NAME[level]] || null,
    campaign_id: r.campaign_id ? String(r.campaign_id) : null,
    adset_id: r.adset_id ? String(r.adset_id) : null,
    spend: round2(Number(r.spend) || 0),
    impressions: Number(r.impressions) || 0,
    clicks: Number(r.clicks) || 0,
    results: resultsOf(r, spec),
    secondary: secondaryOf(r, spec),
  }));
}

// Re-pull the last `days` days at all three levels and store them, with today's budgets and
// statuses on the ad set and campaign rows.
// Pull the window from Meta and store it, with today's budget snapshot. store:false pulls the
// same numbers and returns them (as `fresh`) without writing anything: a dry run.
export async function refreshPerformance(days = 10, { store = true } = {}) {
  const win = range(days);
  const spec = metricSpec();
  const pulled = rt.now().toISOString();
  const [ad, adset, campaign] = await Promise.all(['ad', 'adset', 'campaign'].map((l) => pullDaily(l, win, spec)));
  const rows = [...ad, ...adset, ...campaign].map((r) => ({ ...r, pulled_at: pulled }));
  const live = await liveStructure();
  if (!store) return { rows: rows.length, window: win, live, fresh: rows };
  for (let i = 0; i < rows.length; i += 500) await db().upsert('performance_daily', rows.slice(i, i + 500), ['date', 'level', 'entity_id']);
  const day = today();
  const snap = [
    ...Object.entries(live.campaigns).map(([id, c]) => ({ date: day, level: 'campaign', entity_id: id, name: c.name, status: c.effective, daily_budget: c.daily_budget, pulled_at: pulled })),
    ...Object.entries(live.adsets).map(([id, s]) => ({ date: day, level: 'adset', entity_id: id, name: s.name, campaign_id: s.campaign_id, status: s.effective, daily_budget: s.daily_budget, pulled_at: pulled })),
  ];
  for (let i = 0; i < snap.length; i += 500) await db().upsert('performance_daily', snap.slice(i, i + 500), ['date', 'level', 'entity_id']);
  return { rows: rows.length, window: win, live, fresh: null };
}

// Stored rows for one level over a window.
export async function storedRows(level, { since, until = today() }) {
  const rows = await db().select('performance_daily', { where: { level, date: { gte: since } }, order: 'date' });
  return rows.filter((r) => r.date <= until);
}

// Sum rows per entity.
export function rollup(rows) {
  const out = {};
  for (const r of rows) {
    const e = (out[r.entity_id] ||= { entity_id: r.entity_id, name: r.name, campaign_id: r.campaign_id, adset_id: r.adset_id, spend: 0, impressions: 0, clicks: 0, results: 0, secondary: 0, days: new Set() });
    e.spend += Number(r.spend) || 0; e.impressions += Number(r.impressions) || 0; e.clicks += Number(r.clicks) || 0;
    e.results += Number(r.results) || 0; e.secondary += Number(r.secondary) || 0;
    if ((Number(r.spend) || 0) > 0) e.days.add(r.date);
    if (r.name) e.name = r.name;
  }
  for (const e of Object.values(out)) {
    e.spend = round2(e.spend); e.days = e.days.size;
    e.cost = e.results > 0 ? round2(e.spend / e.results) : null;
    e.secondary_cost = e.secondary > 0 ? round2(e.spend / e.secondary) : null;
  }
  return out;
}

// The total daily budget that was live on a stored day: campaign budgets for campaigns that
// budget at the campaign level, plus active ad set budgets inside the other active campaigns.
// Null when that day has no snapshot.
export async function storedBudgetOn(day) {
  const rows = await db().select('performance_daily', { where: { date: day } }).catch(() => []);
  const camps = rows.filter((r) => r.level === 'campaign' && r.status === 'ACTIVE');
  if (!camps.length) return null;
  const withBudget = new Set(camps.filter((c) => c.daily_budget != null).map((c) => c.entity_id));
  const active = new Set(camps.map((c) => c.entity_id));
  let total = camps.reduce((s, c) => s + (Number(c.daily_budget) || 0), 0);
  for (const r of rows) {
    if (r.level === 'adset' && r.status === 'ACTIVE' && r.daily_budget != null && active.has(r.campaign_id) && !withBudget.has(r.campaign_id)) total += Number(r.daily_budget);
  }
  return total > 0 ? round2(total) : null;
}

// Account totals per day from stored campaign rows.
export function dailyTotals(rows) {
  const by = {};
  for (const r of rows) {
    const d = (by[r.date] ||= { date: r.date, spend: 0, impressions: 0, clicks: 0, results: 0, secondary: 0 });
    d.spend += Number(r.spend) || 0; d.impressions += Number(r.impressions) || 0; d.clicks += Number(r.clicks) || 0;
    d.results += Number(r.results) || 0; d.secondary += Number(r.secondary) || 0;
  }
  return Object.values(by).sort((a, b) => (a.date < b.date ? -1 : 1)).map((d) => ({ ...d, spend: round2(d.spend), cost: d.results > 0 ? round2(d.spend / d.results) : null }));
}

