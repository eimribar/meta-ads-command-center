// The only place that changes the ad account. Every call checks the object belongs to this ad
// account and is in scope, goes through the write journal, and respects the daily budget ceiling.
// Budget changes and new campaigns need an operator behind them (an approval tap or a confirmed
// order); scheduled jobs can only pause ads or turn them back on, and only when the ladder allows it.
// Anything that spends from a lifetime budget is left to Ads Manager: the ceiling is a daily one.
import { graph, graphAll, graphPostRaw, account, campaignInScope, persistScope } from './meta.mjs';
import { journalWrite } from './write-journal.mjs';
import { currentExecution } from './context.mjs';
import { isOperator } from './auth.mjs';
import { liveStructure, totalDailyBudget, ensureCurrency, entityAt, levelOf, levelWords, usesLifetimeBudget } from './account.mjs';
import { budgetCeiling } from './optimizer/guardrails.mjs';
import { policy } from './optimizer/policy.mjs';
import { timeline } from './jobs.mjs';
import { fromMinor, toMinor } from './money.mjs';

const LEVELS = ['ad', 'adset', 'campaign'];
const STATUSES = ['ACTIVE', 'PAUSED'];

function requireOperator(what) {
  const actor = currentExecution()?.actor;
  if (!isOperator(actor)) throw new Error(`${what} needs an operator behind it`);
}

// Refuse anything outside this ad account or outside CAMPAIGN_ALLOWLIST.
export async function assertInScope(level, id) {
  if (!LEVELS.includes(level)) throw new Error(`unknown level ${level}`);
  if (!/^\d+$/.test(String(id))) throw new Error(`not a Meta object id: ${id}`);
  const fields = level === 'campaign' ? 'account_id' : 'account_id,campaign_id';
  const obj = await graph(String(id), { fields });
  if (`act_${obj.account_id}` !== account()) throw new Error(`REFUSED: ${level} ${id} is not in this ad account`);
  const campaignId = level === 'campaign' ? String(id) : String(obj.campaign_id);
  if (!campaignInScope(campaignId)) throw new Error(`REFUSED: ${level} ${id} belongs to a campaign outside CAMPAIGN_ALLOWLIST`);
  return { campaignId };
}

// ref names what an operation is a copy of (a source ad), so two creates with the same body
// in one order are two writes, not a replay of one.
function post(node, body, metadata = {}, ref = null) {
  return journalWrite({
    operations: [{ node: String(node), body, ...(ref ? { ref: String(ref) } : {}) }],
    metadata: { provider: 'meta', ...metadata },
    dispatch: () => graphPostRaw(node, body),
  });
}

const CURRENCY_UNKNOWN = 'REFUSED: the ad account\'s currency could not be read from Meta, so budgets cannot be read or converted; try again';
const LIFETIME = 'it spends from a lifetime budget, which the daily budget ceiling cannot measure; change it in Ads Manager';

// The live account, and the entity at the level the caller named. Refuses an id that is not
// there at that level (with the level it really is, when it is in scope).
async function liveEntity(level, id) {
  if (!(await ensureCurrency())) throw new Error(CURRENCY_UNKNOWN);
  const live = await liveStructure();
  const entity = entityAt(live, level, id);
  if (!entity) {
    const real = levelOf(live, String(id));
    throw new Error(`REFUSED: ${id} is not ${levelWords(level)} in scope${real ? ` (it is ${levelWords(real)})` : ''}`);
  }
  return { live, entity };
}

export async function currentState(level, id) {
  const fields = level === 'ad' ? 'name,effective_status,configured_status' : 'name,effective_status,configured_status,daily_budget';
  const d = await graph(String(id), { fields });
  return {
    name: d.name || null,
    status: d.effective_status || d.configured_status,
    configured: d.configured_status || null,
    dailyBudget: fromMinor(d.daily_budget),
  };
}

export async function setStatus(level, id, status) {
  if (!STATUSES.includes(status)) throw new Error(`status must be ACTIVE or PAUSED`);
  await assertInScope(level, id);
  // Turning spend on for a campaign or ad set is an operator decision, inside the ceiling.
  if (status === 'ACTIVE' && level !== 'ad') {
    requireOperator(`Activating ${levelWords(level)}`);
    const { live, entity } = await liveEntity(level, id);
    if (usesLifetimeBudget(live, level, id)) throw new Error(`REFUSED: not activated: ${LIFETIME}`);
    const add = level === 'campaign' ? campaignSpend(live, id) : (entity.daily_budget || 0);
    const parentOn = level === 'campaign' || live.campaigns[entity.campaign_id]?.effective === 'ACTIVE';
    if (entity.effective !== 'ACTIVE' && parentOn && add > 0) {
      const c = budgetCeiling({ newBudget: add, newTotal: totalDailyBudget(live) + add, max: policy().maxDailyBudget });
      if (!c.ok) throw new Error(`REFUSED: ${c.reason}`);
    }
  }
  const r = await post(id, { status }, { kind: 'status', level });
  await timeline('status_changed', { level, id, status, by: currentExecution()?.actor || currentExecution()?.kind || null });
  return { ok: true, level, id, status, journalId: r.journalId };
}

// What a campaign spends a day once it is on: its campaign budget, or the daily budgets of its
// ad sets that are switched on.
function campaignSpend(live, id) {
  const c = live.campaigns[id];
  if (!c) return 0;
  if (c.daily_budget) return c.daily_budget;
  return Object.values(live.adsets).filter((s) => String(s.campaign_id) === String(id) && s.configured === 'ACTIVE').reduce((n, s) => n + (s.daily_budget || 0), 0);
}

// Set a daily budget, in the ad account's currency, on a campaign (campaign budget) or an ad set.
export async function setBudget(level, id, amount) {
  if (level !== 'campaign' && level !== 'adset') throw new Error('budgets live on a campaign or an ad set');
  requireOperator('A budget change');
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`REFUSED: ${amount} is not a valid daily budget`);
  if (!(await ensureCurrency())) throw new Error(CURRENCY_UNKNOWN);
  await assertInScope(level, id);
  const { live, entity } = await liveEntity(level, id);
  if (usesLifetimeBudget(live, level, id)) throw new Error(`REFUSED: ${LIFETIME}`);
  if (entity.daily_budget == null) throw new Error(`REFUSED: ${entity.name || id} has no daily budget of its own (the budget is set at the ${level === 'campaign' ? 'ad set' : 'campaign'} level)`);
  const parentActive = level === 'campaign' || live.campaigns[entity.campaign_id]?.effective === 'ACTIVE';
  const counts = entity.effective === 'ACTIVE' && parentActive;
  const newTotal = totalDailyBudget(live) - (counts ? entity.daily_budget : 0) + (counts ? amount : 0);
  const c = budgetCeiling({ newBudget: amount, newTotal, max: policy().maxDailyBudget });
  if (!c.ok) throw new Error(`REFUSED: ${c.reason}`);
  const r = await post(id, { daily_budget: toMinor(amount) }, { kind: 'budget', level });
  await timeline('budget_changed', { level, id, from: entity.daily_budget ?? null, to: amount, by: currentExecution()?.actor || null });
  return { ok: true, level, id, dailyBudget: amount, before: entity.daily_budget ?? null, journalId: r.journalId };
}

// Copy a campaign with its ad sets and ads. The copy is built PAUSED and is only switched on at
// the very end, after every piece landed, and only if asked.
export async function duplicateCampaign({ source_campaign_id, name_suffix = 'copy', include_paused_ads = false, activate = false }) {
  requireOperator('Duplicating a campaign');
  const sourceId = String(source_campaign_id);
  await assertInScope('campaign', sourceId);
  const src = await graph(sourceId, { fields: 'name,objective,daily_budget,lifetime_budget,bid_strategy,buying_type,special_ad_categories,is_adset_budget_sharing_enabled' });
  // Ad sets that target the EU carry who benefits from and who pays for the ads (DSA).
  const sets = await graphAll(`${sourceId}/adsets`, {
    fields: 'name,status,daily_budget,lifetime_budget,optimization_goal,billing_event,bid_amount,bid_strategy,promoted_object,attribution_spec,targeting,start_time,end_time,dsa_beneficiary,dsa_payor',
  }, 500, { complete: true });
  if (activate) {
    if (!(await ensureCurrency())) throw new Error(CURRENCY_UNKNOWN);
    if (src.lifetime_budget || sets.some((s) => s.status === 'ACTIVE' && s.lifetime_budget)) {
      throw new Error(`REFUSED: the copy was not made: ${LIFETIME}. Ask for the copy without activating it, then switch it on in Ads Manager`);
    }
    const live = await liveStructure();
    const add = src.daily_budget ? fromMinor(src.daily_budget)
      : sets.filter((s) => s.status === 'ACTIVE').reduce((n, s) => n + (fromMinor(s.daily_budget) || 0), 0);
    if (add > 0) {
      const c = budgetCeiling({ newBudget: add, newTotal: totalDailyBudget(live) + add, max: policy().maxDailyBudget });
      if (!c.ok) throw new Error(`REFUSED: activating the copy: ${c.reason}`);
    }
  }
  const named = (n) => `${n} ${name_suffix}`.trim();
  const campaignBudget = Boolean(src.daily_budget || src.lifetime_budget);
  const camp = await post(`${account()}/campaigns`, {
    name: named(src.name), objective: src.objective, status: 'PAUSED', special_ad_categories: src.special_ad_categories || [],
    buying_type: src.buying_type || 'AUCTION',
    ...(src.daily_budget ? { daily_budget: src.daily_budget } : {}),
    ...(src.lifetime_budget ? { lifetime_budget: src.lifetime_budget } : {}),
    ...(src.bid_strategy ? { bid_strategy: src.bid_strategy } : {}),
    // Required since v24 when the budget is not at the campaign level (error 4834011).
    // developers.facebook.com/documentation/ads-commerce/marketing-api/bidding/guides/adset-budget-sharing
    ...(campaignBudget ? {} : { is_adset_budget_sharing_enabled: Boolean(src.is_adset_budget_sharing_enabled) }),
  }, { kind: 'create_campaign' }, sourceId);
  const campaignId = String(camp.id);
  await persistScope(campaignId);
  const out = { campaignId, name: named(src.name), adsets: [], skipped: [] };
  try {
    for (const s of sets) {
      if (s.status === 'ARCHIVED' || s.status === 'DELETED') continue;
      const set = await post(`${account()}/adsets`, {
        name: named(s.name), campaign_id: campaignId, status: s.status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED',
        optimization_goal: s.optimization_goal, billing_event: s.billing_event, targeting: s.targeting,
        ...(s.daily_budget ? { daily_budget: s.daily_budget } : {}),
        ...(s.lifetime_budget ? { lifetime_budget: s.lifetime_budget, end_time: s.end_time } : {}),
        ...(s.bid_amount ? { bid_amount: s.bid_amount } : {}),
        ...(s.bid_strategy ? { bid_strategy: s.bid_strategy } : {}),
        ...(s.promoted_object ? { promoted_object: s.promoted_object } : {}),
        ...(s.attribution_spec ? { attribution_spec: s.attribution_spec } : {}),
        ...(s.dsa_beneficiary ? { dsa_beneficiary: s.dsa_beneficiary } : {}),
        ...(s.dsa_payor ? { dsa_payor: s.dsa_payor } : {}),
      }, { kind: 'create_adset' }, s.id);
      const rec = { id: String(set.id), name: named(s.name), ads: [] };
      const ads = await graphAll(`${s.id}/ads`, { fields: 'name,status,creative{id}' }, 500, { complete: true });
      for (const a of ads) {
        if (a.status !== 'ACTIVE' && !include_paused_ads) continue;
        if (!a.creative?.id) { out.skipped.push({ ad: a.id, why: 'no creative id' }); continue; }
        const ad = await post(`${account()}/ads`, { name: a.name, adset_id: rec.id, creative: { creative_id: a.creative.id }, status: 'ACTIVE' }, { kind: 'create_ad' }, a.id);
        rec.ads.push({ ad_id: String(ad.id), name: a.name, source_ad: a.id });
      }
      out.adsets.push(rec);
    }
  } catch (e) {
    // The copy exists but is incomplete. It is PAUSED and spends nothing; say so plainly.
    out.partial = true;
    out.partial_error = String(e?.message || e).slice(0, 200);
    await timeline('campaign_duplicated', { source: sourceId, campaignId, partial: true, by: currentExecution()?.actor || null });
    return out;
  }
  if (activate) { await post(campaignId, { status: 'ACTIVE' }, { kind: 'status', level: 'campaign' }); out.activated = true; }
  await timeline('campaign_duplicated', { source: sourceId, campaignId, adsets: out.adsets.length, activated: Boolean(out.activated), by: currentExecution()?.actor || null });
  return out;
}
