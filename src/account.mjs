// The live shape of the account right now: ads, ad sets, campaigns, statuses and budgets.
// Read fresh from Meta whenever a decision depends on it.
import { graph, graphAll, account, scopeFilter, allowlist } from './meta.mjs';
import { rt } from './runtime.mjs';
import { fromMinor, setCurrency, currency } from './money.mjs';


// The ad account's currency and time zone. Read at start; budgets cannot be converted without
// the currency, so anything that reads or writes a budget makes sure it is known.
export async function loadAccountBasics() {
  const a = await graph(account(), { fields: 'currency,timezone_name' });
  if (a.currency) setCurrency(a.currency);
  return { currency: a.currency || null, timezone: a.timezone_name || null };
}
export async function ensureCurrency() {
  if (!currency()) await loadAccountBasics().catch(() => null);
  return currency();
}

export async function liveStructure() {
  await ensureCurrency();
  const list = allowlist();
  const byCampaign = list ? { filtering: [{ field: 'campaign.id', operator: 'IN', value: list }] } : {};
  const campFilter = list ? { filtering: [{ field: 'id', operator: 'IN', value: list }] } : {};
  const [ads, adsets, campaigns] = await Promise.all([
    graphAll(`${account()}/ads`, { fields: 'id,name,status,effective_status,adset_id,campaign_id', ...byCampaign }, 3000),
    graphAll(`${account()}/adsets`, { fields: 'id,name,status,effective_status,daily_budget,campaign_id', ...byCampaign }, 1000),
    graphAll(`${account()}/campaigns`, { fields: 'id,name,status,effective_status,daily_budget,objective', ...campFilter }, 500),
  ]);
  const out = { ads: {}, adsets: {}, campaigns: {}, pulledAt: rt.now().toISOString() };
  for (const c of campaigns) out.campaigns[c.id] = { name: c.name, configured: c.status, effective: c.effective_status, daily_budget: fromMinor(c.daily_budget), objective: c.objective };
  for (const s of adsets) out.adsets[s.id] = { name: s.name, configured: s.status, effective: s.effective_status, daily_budget: fromMinor(s.daily_budget), campaign_id: s.campaign_id };
  for (const a of ads) out.ads[a.id] = { name: a.name, configured: a.status, effective: a.effective_status, adset_id: a.adset_id, campaign_id: a.campaign_id };
  return out;
}

// Sum of the daily budgets that are spending: active campaigns with a campaign budget, plus
// active ad sets inside active campaigns that budget per ad set.
export function totalDailyBudget(live) {
  let total = 0;
  for (const c of Object.values(live.campaigns)) if (c.effective === 'ACTIVE' && c.daily_budget) total += c.daily_budget;
  for (const s of Object.values(live.adsets)) {
    const c = live.campaigns[s.campaign_id];
    if (s.effective === 'ACTIVE' && s.daily_budget && c && c.effective === 'ACTIVE' && !c.daily_budget) total += s.daily_budget;
  }
  return Math.round(total * 100) / 100;
}

// Active ads per ad set.
export function activeAdsBySet(live) {
  const counts = {};
  for (const a of Object.values(live.ads)) if (a.effective === 'ACTIVE') counts[a.adset_id] = (counts[a.adset_id] || 0) + 1;
  return counts;
}

export function levelOf(live, id) {
  if (live.campaigns[id]) return 'campaign';
  if (live.adsets[id]) return 'adset';
  if (live.ads[id]) return 'ad';
  return null;
}

export function nameOf(live, id) {
  return live?.campaigns[id]?.name || live?.adsets[id]?.name || live?.ads[id]?.name || null;
}
