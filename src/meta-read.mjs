// Live reads behind the chat tools and reports. Every result count goes through metrics.mjs,
// so "results" always means the configured RESULT_EVENT.
import { graph, graphAll, account, scopeFilter, allowlist, pageToken, instagramUserId } from './meta.mjs';
import { metricSpec, resultsOf, secondaryOf, INSIGHT_FIELDS, round2, costPer, actionTypesSeen } from './metrics.mjs';
import { range } from './clock.mjs';
import { getConfig } from './config.mjs';
import { fromMinor } from './money.mjs';

const num = (v) => Number(v) || 0;
function shape(r, spec = metricSpec()) {
  const spend = round2(num(r.spend));
  const results = resultsOf(r, spec);
  const secondary = secondaryOf(r, spec);
  const out = {
    spend, impressions: num(r.impressions), clicks: num(r.clicks),
    ctr_pct: num(r.impressions) ? round2((num(r.clicks) / num(r.impressions)) * 100) : null,
    results, cost_per_result: costPer(spend, results),
  };
  if (spec.secondary) { out.secondary = secondary; out.cost_per_secondary = costPer(spend, secondary); }
  return out;
}
const labels = () => { const s = metricSpec(); return { results: s.result.label, secondary: s.secondary?.label || null }; };

function insights(level, days, extra = {}, cap = 5000) {
  return graphAll(`${account()}/insights`, { level, time_range: range(days), filtering: scopeFilter(), ...extra }, cap);
}

// Match a campaign by id, exact name, or a word in the name.
export async function resolveCampaign(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  const camps = await campaignsList();
  return camps.find((c) => c.id === t) || camps.find((c) => c.name.toLowerCase() === t)
    || camps.find((c) => c.name.toLowerCase().includes(t)) || null;
}
export async function campaignsList() {
  const list = allowlist();
  return graphAll(`${account()}/campaigns`, {
    fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,bid_strategy',
    ...(list ? { filtering: [{ field: 'id', operator: 'IN', value: list }] } : {}),
  }, 500);
}
const campaignFilter = (id) => (id ? [{ field: 'campaign.id', operator: 'IN', value: [id] }] : scopeFilter());

export async function accountOverview(days = 7) {
  const rows = await insights('campaign', days, { fields: `campaign_id,campaign_name,${INSIGHT_FIELDS}`, time_increment: 1 });
  const spec = metricSpec();
  const byCampaign = {}, total = { spend: 0, impressions: 0, clicks: 0 };
  for (const r of rows) {
    const c = (byCampaign[r.campaign_id] ||= { campaign: r.campaign_name, days: [] });
    c.days.push({ date: r.date_start, ...shape(r, spec) });
    total.spend += num(r.spend); total.impressions += num(r.impressions); total.clicks += num(r.clicks);
  }
  const sum = Object.values(byCampaign).reduce((s, c) => {
    for (const d of c.days) { s.results += d.results; s.secondary += d.secondary || 0; }
    return s;
  }, { results: 0, secondary: 0 });
  return {
    labels: labels(), window_days: days,
    totals: { spend: round2(total.spend), impressions: total.impressions, clicks: total.clicks, results: sum.results, cost_per_result: costPer(total.spend, sum.results), ...(spec.secondary ? { secondary: sum.secondary, cost_per_secondary: costPer(total.spend, sum.secondary) } : {}) },
    campaigns: byCampaign,
  };
}

export async function campaignDetail(campaignId, days = 14) {
  const [config, rows] = await Promise.all([
    graph(campaignId, { fields: 'name,objective,status,effective_status,daily_budget,lifetime_budget,bid_strategy,buying_type,special_ad_categories,start_time' }),
    graphAll(`${account()}/insights`, { level: 'campaign', time_range: range(days), time_increment: 1, filtering: campaignFilter(campaignId), fields: INSIGHT_FIELDS }, 200),
  ]);
  const spec = metricSpec();
  return {
    labels: labels(),
    config: { ...config, daily_budget: fromMinor(config.daily_budget), lifetime_budget: fromMinor(config.lifetime_budget) },
    days: rows.map((r) => ({ date: r.date_start, ...shape(r, spec) })),
  };
}

export async function adsetDetail(campaignId = null, days = 14) {
  const list = campaignId ? [campaignId] : allowlist();
  const [sets, rows] = await Promise.all([
    graphAll(`${account()}/adsets`, { fields: 'id,name,status,effective_status,daily_budget,optimization_goal,promoted_object,targeting{geo_locations,age_min,age_max,genders,targeting_automation},campaign_id', ...(list ? { filtering: [{ field: 'campaign.id', operator: 'IN', value: list }] } : {}) }, 500),
    insights('adset', days, { fields: `adset_id,${INSIGHT_FIELDS}`, filtering: campaignFilter(campaignId) }),
  ]);
  const spec = metricSpec();
  const perf = Object.fromEntries(rows.map((r) => [r.adset_id, shape(r, spec)]));
  return { labels: labels(), adsets: sets.map((s) => ({ id: s.id, name: s.name, status: s.effective_status, campaign_id: s.campaign_id, daily_budget: fromMinor(s.daily_budget), optimization_goal: s.optimization_goal, optimizing_for: s.promoted_object?.custom_event_type || null, targeting: s.targeting, ...(perf[s.id] || { spend: 0, results: 0 }) })) };
}

export async function adPerformance(campaignId = null, days = 14) {
  const list = campaignId ? [campaignId] : allowlist();
  const [ads, rows] = await Promise.all([
    graphAll(`${account()}/ads`, { fields: 'id,name,effective_status,adset_id,campaign_id', ...(list ? { filtering: [{ field: 'campaign.id', operator: 'IN', value: list }] } : {}) }, 3000),
    insights('ad', days, { fields: `ad_id,${INSIGHT_FIELDS}`, filtering: campaignFilter(campaignId) }),
  ]);
  const spec = metricSpec();
  const perf = Object.fromEntries(rows.map((r) => [r.ad_id, shape(r, spec)]));
  return {
    labels: labels(),
    ads: ads.map((a) => ({ id: a.id, name: a.name, status: a.effective_status, adset_id: a.adset_id, campaign_id: a.campaign_id, ...(perf[a.id] || { spend: 0, results: 0 }) }))
      .filter((a) => a.spend > 0 || a.status === 'ACTIVE')
      .sort((x, y) => (y.results - x.results) || (y.spend - x.spend)),
  };
}

export const BREAKDOWNS = ['age', 'gender', 'publisher_platform', 'platform_position', 'region', 'country', 'impression_device'];
export async function breakdown(by, campaignId = null, days = 14) {
  if (!BREAKDOWNS.includes(by)) throw new Error(`breakdown must be one of ${BREAKDOWNS.join(', ')}`);
  const breakdowns = by === 'platform_position' ? 'publisher_platform,platform_position' : by;
  const rows = await graphAll(`${account()}/insights`, { level: 'account', time_range: range(days), breakdowns, filtering: campaignFilter(campaignId), fields: INSIGHT_FIELDS }, 500);
  const spec = metricSpec();
  return { labels: labels(), by, rows: rows.map((r) => ({ bucket: by === 'platform_position' ? `${r.publisher_platform}/${r.platform_position}` : r[by], ...shape(r, spec) })).sort((a, b) => b.spend - a.spend) };
}

export async function spendByTime(campaignId = null, mode = 'daily', days = 7) {
  const spec = metricSpec();
  if (mode === 'hourly') {
    const rows = await graphAll(`${account()}/insights`, { level: 'account', time_range: range(1, { endOffset: 0 }), breakdowns: 'hourly_stats_aggregated_by_advertiser_time_zone', filtering: campaignFilter(campaignId), fields: INSIGHT_FIELDS }, 100);
    return { labels: labels(), mode, series: rows.map((r) => ({ hour: r.hourly_stats_aggregated_by_advertiser_time_zone, ...shape(r, spec) })) };
  }
  const rows = await graphAll(`${account()}/insights`, { level: 'account', time_range: range(days), time_increment: 1, filtering: campaignFilter(campaignId), fields: INSIGHT_FIELDS }, 100);
  return { labels: labels(), mode, series: rows.map((r) => ({ date: r.date_start, ...shape(r, spec) })) };
}

export async function recentChanges(days = 3) {
  const since = Math.floor((Date.now() - days * 864e5) / 1000);
  const rows = await graphAll(`${account()}/activities`, { fields: 'event_time,event_type,translated_event_type,object_name,object_id,actor_name,extra_data', since }, 200);
  return rows.map((r) => ({ when: r.event_time, what: r.translated_event_type || r.event_type, object: r.object_name, object_id: r.object_id, by: r.actor_name, detail: String(r.extra_data || '').slice(0, 300) }));
}

export async function runInsights({ level = 'campaign', days = 14, increment = null, breakdowns = null, campaign = null, fields = null }) {
  const c = campaign ? await resolveCampaign(campaign) : null;
  if (campaign && !c) throw new Error(`no campaign matched "${campaign}"`);
  const idField = level === 'account' ? '' : `${level}_id,${level}_name,`;
  const rows = await graphAll(`${account()}/insights`, {
    level, time_range: range(days), filtering: campaignFilter(c?.id || null),
    fields: fields || `${idField}${INSIGHT_FIELDS},cpm,frequency,reach`,
    ...(increment ? { time_increment: increment } : {}), ...(breakdowns ? { breakdowns } : {}),
  }, 2000);
  const spec = metricSpec();
  return { labels: labels(), rows: rows.map((r) => ({ ...Object.fromEntries(Object.entries(r).filter(([k]) => !['actions', 'conversions'].includes(k))), ...shape(r, spec) })) };
}

export async function adCreative(adId) {
  return graph(adId, { fields: 'name,effective_status,adset_id,campaign_id,preview_shareable_link,creative{title,body,call_to_action_type,image_url,thumbnail_url,video_id,link_url,object_type,effective_object_story_id,instagram_permalink_url,asset_feed_spec}' });
}

// How far people watch each video ad: plays, 25/50/75/100% and ThruPlays, as a share of plays.
const VIDEO_FIELDS = ['video_play_actions', 'video_p25_watched_actions', 'video_p50_watched_actions', 'video_p75_watched_actions', 'video_p100_watched_actions', 'video_thruplay_watched_actions', 'video_avg_time_watched_actions'];
export async function videoRetention(campaignId = null, days = 14) {
  const rows = await insights('ad', days, { fields: `ad_id,ad_name,spend,impressions,${VIDEO_FIELDS.join(',')}`, filtering: campaignFilter(campaignId) });
  const total = (list) => (list || []).reduce((n, a) => n + num(a.value), 0);
  return rows.map((r) => {
    const plays = total(r.video_play_actions);
    const share = (k) => (plays ? round2((total(r[k]) / plays) * 100) : null);
    return { ad_id: r.ad_id, name: r.ad_name, spend: round2(num(r.spend)), impressions: num(r.impressions), plays,
      p25_pct: share('video_p25_watched_actions'), p50_pct: share('video_p50_watched_actions'), p75_pct: share('video_p75_watched_actions'),
      p100_pct: share('video_p100_watched_actions'), thruplay_pct: share('video_thruplay_watched_actions'), avg_seconds: total(r.video_avg_time_watched_actions) || null };
  }).filter((r) => r.plays > 0).sort((a, b) => b.plays - a.plays);
}

// The ad account's custom and lookalike audiences.
export async function audiences() {
  const rows = await graphAll(`${account()}/customaudiences`, { fields: 'id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound,delivery_status,operation_status,time_updated' }, 300);
  return rows.map((a) => ({ id: a.id, name: a.name, type: a.subtype, size: a.approximate_count_lower_bound != null ? `${a.approximate_count_lower_bound} to ${a.approximate_count_upper_bound}` : null, delivery: a.delivery_status?.description || null, updated: a.time_updated || null }));
}

// The Page's instant forms (lead forms) and how many leads each collected.
export async function leadForms() {
  const pageId = getConfig().META_PAGE_ID;
  if (!pageId) return { error: 'META_PAGE_ID is not set' };
  return graphAll(`${pageId}/leadgen_forms`, { fields: 'id,name,status,leads_count,created_time' }, 200, { token: await pageToken() });
}

// The dataset (pixel) and which action types the account reported recently.
export async function pixelHealth(days = 30) {
  const cfg = getConfig();
  const pixel = cfg.META_PIXEL_ID ? await graph(cfg.META_PIXEL_ID, { fields: 'name,last_fired_time,is_unavailable,creation_time' }).catch((e) => ({ error: String(e.message).slice(0, 160) })) : null;
  const rows = await graphAll(`${account()}/insights`, { level: 'account', time_range: range(days), fields: 'actions,conversions', filtering: scopeFilter() }, 10);
  const spec = metricSpec();
  return { pixel, result_event: spec.result.event, result_action_types: spec.result.types, secondary_event: spec.secondary?.event || null, action_types_seen: actionTypesSeen(rows).slice(0, 40) };
}

export async function pageOverview() {
  const pageId = getConfig().META_PAGE_ID;
  if (!pageId) return { error: 'META_PAGE_ID is not set' };
  const tok = await pageToken();
  const [profile, posts] = await Promise.all([
    graph(pageId, { fields: 'name,fan_count,followers_count,link,category' }, { token: tok }).catch((e) => ({ error: String(e.message).slice(0, 160) })),
    graph(`${pageId}/posts`, { fields: 'message,created_time,permalink_url,shares,comments.summary(true),reactions.summary(true)', limit: 8 }, { token: tok }).catch(() => ({ data: [] })),
  ]);
  return { profile, recent_posts: (posts.data || []).map((p) => ({ id: p.id, when: p.created_time, text: String(p.message || '').slice(0, 200), link: p.permalink_url, comments: p.comments?.summary?.total_count ?? null, reactions: p.reactions?.summary?.total_count ?? null, shares: p.shares?.count ?? 0 })) };
}

export async function instagramOverview(limit = 12) {
  const ig = await instagramUserId();
  if (!ig) return { error: 'No Instagram account is linked (set META_IG_USER_ID or link one to the Page)' };
  const [profile, media] = await Promise.all([
    graph(ig, { fields: 'username,name,followers_count,media_count' }).catch((e) => ({ error: String(e.message).slice(0, 160) })),
    graph(`${ig}/media`, { fields: 'id,media_type,caption,timestamp,permalink,like_count,comments_count', limit }).catch(() => ({ data: [] })),
  ]);
  return { profile, recent_media: (media.data || []).map((m) => ({ id: m.id, type: m.media_type, when: m.timestamp, caption: String(m.caption || '').slice(0, 160), link: m.permalink, likes: m.like_count, comments: m.comments_count })) };
}

// The Page's message inbox (Messenger or Instagram).
export async function inbox(platform = 'facebook', limit = 10) {
  const pageId = getConfig().META_PAGE_ID;
  if (!pageId) return { error: 'META_PAGE_ID is not set' };
  const r = await graph(`${pageId}/conversations`, {
    ...(platform === 'instagram' ? { platform: 'instagram' } : {}),
    fields: 'id,updated_time,unread_count,participants,messages.limit(3){message,from,created_time}', limit,
  }, { token: await pageToken() });
  return (r.data || []).map((c) => ({ conversation_id: c.id, updated: c.updated_time, unread: c.unread_count, with: (c.participants?.data || []).map((p) => ({ id: p.id, name: p.name || p.username })), last: (c.messages?.data || []).map((m) => ({ from: m.from?.name || m.from?.username, fromId: m.from?.id, text: String(m.message || '').slice(0, 300), when: m.created_time })) }));
}

export async function conversation(conversationId, limit = 20) {
  const r = await graph(conversationId, { fields: `messages.limit(${limit}){message,from,created_time}` }, { token: await pageToken() });
  return (r.messages?.data || []).map((m) => ({ from: m.from?.name || m.from?.username, fromId: m.from?.id, text: m.message, when: m.created_time }));
}
