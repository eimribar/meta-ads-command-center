// A small fake ad account behind the fake Graph API: one campaign that budgets per ad set,
// one active ad set with a $100 daily budget, a losing ad, a winning ad and a paused ad.
// Daily numbers cover the last `days` days.
import { fakeGraph } from './helpers.mjs';
import { daysAgo } from '../src/clock.mjs';

export function fakeAccount({ days = 10, adsetBudget = 100, tracking = true, extra = {} } = {}) {
  const state = {
    campaigns: [{ id: '10', name: 'Prospecting', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: null, objective: 'OUTCOME_LEADS' }],
    adsets: [{ id: '20', name: 'Broad', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: String(adsetBudget * 100), campaign_id: '10' }],
    ads: [
      { id: '30', name: 'Loser', status: 'ACTIVE', effective_status: 'ACTIVE', adset_id: '20', campaign_id: '10' },
      { id: '33', name: 'Winner', status: 'ACTIVE', effective_status: 'ACTIVE', adset_id: '20', campaign_id: '10' },
      { id: '31', name: 'Old', status: 'PAUSED', effective_status: 'PAUSED', adset_id: '20', campaign_id: '10' },
    ],
    posts: [],
    ...extra,
  };
  // per day: the loser spends $60 with no result, the winner $60 for two results
  const perDay = { 30: { spend: 60, results: 0 }, 33: { spend: 60, results: 2 } };
  const dates = Array.from({ length: days }, (_, i) => daysAgo(i));
  const conv = (n) => (n && tracking ? [{ action_type: 'schedule_website', value: String(n) }] : []);
  // Like Meta: only the days inside time_range, one row per day with time_increment=1, otherwise
  // one row per entity summed over the range.
  const insights = ({ level, time_range, time_increment }) => {
    const range = time_range ? JSON.parse(time_range) : null;
    const inRange = dates.filter((d) => !range || (d >= range.since && d <= range.until));
    const rows = [];
    for (const d of inRange) {
      if (level === 'ad') {
        for (const [id, v] of Object.entries(perDay)) rows.push({ key: id, date_start: d, ad_id: id, ad_name: id === '30' ? 'Loser' : 'Winner', adset_id: '20', campaign_id: '10', spend: v.spend, impressions: 2000, clicks: 30, results: v.results });
      } else {
        const row = { key: level, date_start: d, spend: 120, impressions: 4000, clicks: 60, results: 2 };
        if (level === 'adset') rows.push({ ...row, adset_id: '20', adset_name: 'Broad', campaign_id: '10' });
        if (level === 'campaign') rows.push({ ...row, campaign_id: '10', campaign_name: 'Prospecting' });
        if (level === 'account') rows.push(row);
      }
    }
    const daily = String(time_increment) === '1';
    const merged = daily ? rows : Object.values(rows.reduce((acc, r) => {
      const a = acc[r.key] || (acc[r.key] = { ...r, date_start: range?.since || r.date_start, spend: 0, impressions: 0, clicks: 0, results: 0 });
      a.spend += r.spend; a.impressions += r.impressions; a.clicks += r.clicks; a.results += r.results;
      return acc;
    }, {}));
    return merged.map(({ key, results, ...r }) => ({ ...r, spend: String(r.spend), impressions: String(r.impressions), clicks: String(r.clicks), conversions: conv(results) }));
  };
  const byId = () => Object.fromEntries([...state.campaigns, ...state.adsets, ...state.ads].map((o) => [o.id, o]));
  const calls = fakeGraph(({ method, path, params }) => {
    if (method === 'GET' && path === 'act_111/insights') return { data: insights(params) };
    if (method === 'GET' && path === 'act_111/ads') return { data: state.ads };
    if (method === 'GET' && path === 'act_111/adsets') return { data: state.adsets };
    if (method === 'GET' && path === 'act_111/campaigns') return { data: state.campaigns };
    if (method === 'GET' && /^\d+\/ads$/.test(path)) return { data: state.ads.filter((a) => a.adset_id === path.split('/')[0]) };
    if (method === 'GET' && byId()[path]) {
      const o = byId()[path];
      return { id: o.id, account_id: '111', campaign_id: o.campaign_id || o.id, name: o.name, configured_status: o.status, effective_status: o.effective_status, daily_budget: o.daily_budget };
    }
    if (method === 'POST' && byId()[path]) {
      const o = byId()[path];
      if (params.status) { o.status = params.status; o.effective_status = params.status; }
      if (params.daily_budget) o.daily_budget = params.daily_budget;
      return { success: true };
    }
    if (extra.handler) return extra.handler({ method, path, params });
    return { error: { code: 100, message: `fake account has no ${method} ${path}` } };
  });
  return { state, calls, writes: () => calls.filter((c) => c.method !== 'GET') };
}
