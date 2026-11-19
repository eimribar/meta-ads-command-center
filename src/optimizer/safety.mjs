// Two checks run before any judgment. If either fails, the optimizer freezes: it proposes
// nothing and tells the team why.
//   dataTrustGate  are the stored numbers sane (no negatives, results not far above clicks,
//                  spend present where impressions are)?
//   circuitBreaker did something break (spend running past budget, cost per result jumping,
//                  delivery collapsing)?
import { db } from '../runtime.mjs';
import { daysAgo } from '../clock.mjs';
import { policy } from './policy.mjs';
import { totalDailyBudget } from '../account.mjs';
import { storedBudgetOn } from '../insights.mjs';
import { money } from '../money.mjs';
import { rowsWith } from './rows.mjs';

const round = (v) => (v == null ? null : Math.round(v * 100) / 100);
const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return null; const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// fresh: rows pulled this run and not stored (a dry run), laid over the stored ones.
export async function dataTrustGate({ days = 3, fresh = null } = {}) {
  const lag = policy().t.data.lagDays;
  const until = daysAgo(lag), since = daysAgo(days + lag - 1);
  let rows;
  try {
    rows = rowsWith(await db().select('performance_daily', { where: { level: 'ad', date: { gte: since } } }), fresh?.filter((r) => r.level === 'ad'))
      .filter((r) => r.date >= since && r.date <= until);
  } catch (e) {
    return { trusted: false, failures: [{ check: 'read', detail: `could not read stored numbers: ${String(e.message).slice(0, 120)}` }], window: { since, until } };
  }
  const failures = [];
  let results = 0, clicks = 0, spend = 0;
  for (const r of rows) {
    const where = `ad ${r.entity_id} on ${r.date}`;
    for (const k of ['impressions', 'clicks', 'spend', 'results']) {
      const v = Number(r[k]);
      if (!Number.isFinite(v)) failures.push({ check: 'not_a_number', detail: `${where}: ${k} is not a number` });
      else if (v < 0) failures.push({ check: 'negative', detail: `${where}: ${k} is negative` });
    }
    if (Number(r.results) >= 5 && Number(r.results) > Number(r.clicks) * 2) failures.push({ check: 'results_above_clicks', detail: `${where}: ${r.results} results on ${r.clicks} clicks (event may fire twice)` });
    if (Number(r.impressions) >= 10 && !(Number(r.spend) > 0)) failures.push({ check: 'spend_missing', detail: `${where}: ${r.impressions} impressions and no spend` });
    results += Number(r.results) || 0; clicks += Number(r.clicks) || 0; spend += Number(r.spend) || 0;
  }
  if (results >= 20 && results > clicks * 1.2) failures.push({ check: 'results_above_clicks_window', detail: `${results} results on ${clicks} clicks across the window` });
  // Zero results while spending well past several targets usually means tracking broke.
  const target = policy().target;
  if (rows.length && results === 0 && target && spend >= target * 5) failures.push({ check: 'no_results', detail: `no results on ${money(round(spend))} of spend in ${days} mature days; check the pixel and RESULT_EVENT` });
  if (!rows.length) failures.push({ check: 'no_data', detail: `no stored ad rows between ${since} and ${until}` });
  return { trusted: failures.length === 0, failures: failures.slice(0, 10), window: { since, until }, adDays: rows.length, results, clicks };
}

// Uses the stored campaign rows and the live structure (with its budgets).
export async function circuitBreaker({ live, fresh = null }) {
  const lag = policy().t.data.lagDays;
  const cutoff = daysAgo(lag), since = daysAgo(12);
  const rows = rowsWith(await db().select('performance_daily', { where: { level: 'campaign', date: { gte: since } } }), fresh?.filter((r) => r.level === 'campaign'))
    .filter((r) => r.date >= since && r.date <= cutoff);
  const active = new Set(Object.entries(live.campaigns).filter(([, c]) => c.effective === 'ACTIVE').map(([id]) => id));
  const byDay = {};
  for (const r of rows) {
    if (!active.has(r.entity_id)) continue;
    const b = (byDay[r.date] ||= { spend: 0, impressions: 0, results: 0 });
    b.spend += Number(r.spend) || 0; b.impressions += Number(r.impressions) || 0; b.results += Number(r.results) || 0;
  }
  const days = Object.entries(byDay).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const reasons = [], metrics = {};
  if (days.length < 2) return { tripped: false, reasons, metrics: { note: 'not enough mature history yet' } };
  const [evalDate, evalDay] = days[days.length - 1];
  const prior = days.slice(0, -1);
  metrics.evalDay = { date: evalDate, spend: round(evalDay.spend), results: evalDay.results };

  // spend far past what was budgeted (Meta may overspend a day by up to 75% while pacing a week)
  const storedBudget = await storedBudgetOn(evalDate);
  const budgetRef = storedBudget ?? totalDailyBudget(live);
  metrics.budget = budgetRef;
  if (budgetRef > 0 && evalDay.spend > 1.75 * budgetRef) reasons.push(`spend runaway: ${money(round(evalDay.spend))} on ${evalDate} against a ${money(round(budgetRef))} daily budget`);

  // cost per result jumping far above its recent median
  const priorCosts = prior.slice(-7).map(([, b]) => (b.results ? b.spend / b.results : null)).filter(Number.isFinite);
  const med = median(priorCosts);
  const evalCost = evalDay.results ? evalDay.spend / evalDay.results : null;
  metrics.evalCost = round(evalCost); metrics.medianCost = round(med);
  if (med != null && evalCost != null && evalCost > 3 * med && evalDay.results >= 2) reasons.push(`cost per result jumped to ${money(round(evalCost))} on ${evalDate}, over 3x the recent median of ${money(round(med))}`);

  // a live campaign's delivery collapsing day over day
  const perCamp = {};
  for (const r of rows) if (active.has(r.entity_id)) (perCamp[r.entity_id] ||= {})[r.date] = Number(r.impressions) || 0;
  for (const [cid, m] of Object.entries(perCamp)) {
    const ds = Object.keys(m).sort();
    if (ds.length < 2) continue;
    const was = m[ds[ds.length - 2]], cur = m[ds[ds.length - 1]];
    const activeAds = Object.values(live.ads).filter((a) => a.campaign_id === cid && a.effective === 'ACTIVE').length;
    if (was >= 500 && (was - cur) / was > 0.7 && activeAds > 0) reasons.push(`delivery collapse: ${live.campaigns[cid]?.name || cid} went from ${was} to ${cur} impressions`);
  }
  return { tripped: reasons.length > 0, reasons, metrics };
}
