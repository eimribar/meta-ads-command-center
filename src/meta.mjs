// Read access to the Meta Graph API, plus the low level POST and DELETE used by meta-write.mjs.
// Scope: the whole ad account, or only the campaigns in CAMPAIGN_ALLOWLIST when it is set.
import { getConfig } from './config.mjs';
import { rt } from './runtime.mjs';
import { redact } from './redact.mjs';

const cfg = () => getConfig();
const base = () => `https://graph.facebook.com/${cfg().META_API_VERSION}`;
export const account = () => cfg().META_AD_ACCOUNT_ID;

// Rate limits: developers.facebook.com/docs/graph-api/overview/rate-limiting/ (read 2026-11-19).
// Throttled calls are not retried quickly: when Meta says how long the block lasts, the call
// fails at once with that time; otherwise a read waits a little and tries again.
const THROTTLED = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014]);
const SERVICE = new Set([1, 2]);           // Meta's own temporary errors
const TRANSIENT = new Set([...THROTTLED, ...SERVICE]);

// Never let a token reach a log line or a Slack message.
export { redact };

function encode(params) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

// Minutes until Meta lifts a throttle, from the X-Business-Use-Case-Usage (or X-Ad-Account-Usage)
// header; 0 when the header does not say.
export function throttleMinutes(headers) {
  const get = (k) => { try { return headers?.get?.(k) ?? null; } catch { return null; } };
  let most = 0;
  try {
    const buc = JSON.parse(get('x-business-use-case-usage') || '{}');
    for (const list of Object.values(buc)) for (const u of Array.isArray(list) ? list : []) most = Math.max(most, Number(u?.estimated_time_to_regain_access) || 0);
  } catch { /* not JSON */ }
  try {
    const acc = JSON.parse(get('x-ad-account-usage') || '{}');
    const secs = Number(acc?.reset_time_duration) || 0;
    if (secs > 0) most = Math.max(most, Math.ceil(secs / 60));
  } catch { /* not JSON */ }
  return most;
}

// A write with no clear answer has an unknown outcome: no response at all, a server error, or
// Meta's own "unknown error, try again" codes. It is never retried and holds the journal.
const unknownOutcome = (msg) => Object.assign(new Error(msg), { network: true });

async function request(method, path, params = {}, { token = null, timeoutMs = 60_000, retries = 2 } = {}) {
  const t = token || cfg().META_ACCESS_TOKEN;
  const url = new URL(/^https?:/.test(path) ? path : `${base()}/${String(path).replace(/^\//, '')}`);
  const isRead = method === 'GET';
  let body;
  if (method === 'GET' || method === 'DELETE') {
    for (const [k, v] of Object.entries(encode(params))) url.searchParams.set(k, v);
    if (!url.searchParams.has('access_token')) url.searchParams.set('access_token', t);
  } else {
    body = new URLSearchParams({ ...encode(params), access_token: t });
  }
  for (let attempt = 0; ; attempt++) {
    let res, json;
    try {
      res = await rt.fetch(url, { method, body, signal: AbortSignal.timeout(timeoutMs) });
      json = await res.json().catch(() => ({}));
    } catch (e) {
      // A GET can be retried; a write with no answer has an unknown outcome and must not be.
      if (isRead && attempt < retries) { await sleep(800 * (attempt + 1)); continue; }
      throw unknownOutcome(`Meta ${method} failed: ${redact(e?.message || e)}`);
    }
    const status = Number(res?.status) || 200;
    if (json?.error) {
      const code = Number(json.error.code);
      const text = `${code}: ${redact(json.error.message)}${json.error.error_user_msg ? ` (${redact(json.error.error_user_msg)})` : ''}`;
      if (THROTTLED.has(code)) {
        const minutes = throttleMinutes(res?.headers);
        if (minutes > 0) throw Object.assign(new Error(`Meta is throttling this for ${minutes} minute${minutes === 1 ? '' : 's'} (error ${text}); try again after that`), { code, throttledMinutes: minutes });
      }
      if (isRead && TRANSIENT.has(code) && attempt < retries) { await sleep((THROTTLED.has(code) ? 5000 : 1500) * (attempt + 1)); continue; }
      if (!isRead && (SERVICE.has(code) || status >= 500)) throw Object.assign(unknownOutcome(text), { code });
      throw Object.assign(new Error(text), { code });
    }
    if (!res.ok) {
      if (isRead && status >= 500 && attempt < retries) { await sleep(1500 * (attempt + 1)); continue; }
      if (!isRead && status >= 500) throw Object.assign(unknownOutcome(`Meta HTTP ${status} with no clear answer`), { status });
      throw Object.assign(new Error(`Meta HTTP ${status}`), { status });
    }
    return json;
  }
}
const sleep = (ms) => rt.sleep(ms);

export const graph = (path, params, opts) => request('GET', path, params, opts);
export const graphPostRaw = (path, params, opts) => request('POST', path, params, { ...opts, retries: 0 });
export const graphDeleteRaw = (path, params, opts) => request('DELETE', path, params, { ...opts, retries: 0 });

// Follow paging up to `cap` rows. When there is more than that, the list is marked `truncated`;
// with { complete: true } it throws instead, for reads a money decision depends on.
export async function graphAll(path, params = {}, cap = 500, opts = {}) {
  const { complete = false, ...reqOpts } = opts;
  const out = [];
  let j = await graph(path, { limit: 100, ...params }, reqOpts);
  out.push(...(j.data || []));
  let next = j.paging?.next;
  while (next && out.length < cap) {
    j = await request('GET', next, {}, reqOpts);
    out.push(...(j.data || []));
    next = j.paging?.next;
  }
  const truncated = Boolean(next) || out.length > cap;
  if (truncated && complete) {
    const what = String(path).split('/').pop();
    throw new Error(`REFUSED: there are more than ${cap} ${what} to read, so the totals would be incomplete; narrow the scope with CAMPAIGN_ALLOWLIST or archive old ${what} in Ads Manager`);
  }
  const list = out.slice(0, cap);
  Object.defineProperty(list, 'truncated', { value: truncated, enumerable: false });
  return list;
}

// ── scope ────────────────────────────────────────────────────────────────────
// Campaigns the agent created itself (a duplicate) join the allowlist; they are kept in the
// `state` table so a restart keeps them in scope.
const extraCampaigns = new Set();
export function addToScope(campaignId) { extraCampaigns.add(String(campaignId)); }
export function allowlist() {
  const list = cfg().CAMPAIGN_ALLOWLIST || [];
  return list.length ? [...new Set([...list.map(String), ...extraCampaigns])] : null;
}
export async function loadScope() {
  if (!rt.db) return;
  const [row] = await rt.db.select('state', { where: { key: 'scope/extra_campaigns' } }).catch(() => []);
  for (const id of Array.isArray(row?.value) ? row.value : []) extraCampaigns.add(String(id));
}
export async function persistScope(campaignId) {
  addToScope(campaignId);
  if (rt.db) await rt.db.upsert('state', [{ key: 'scope/extra_campaigns', value: [...extraCampaigns], updated_at: new Date().toISOString() }], ['key']);
}
export function campaignInScope(campaignId) {
  const list = allowlist();
  return !list || list.includes(String(campaignId));
}
// Insights `filtering` for the scope (none when the whole account is in scope).
export function scopeFilter(field = 'campaign.id') {
  const list = allowlist();
  return list ? [{ field, operator: 'IN', value: list }] : undefined;
}

// ── page and Instagram ───────────────────────────────────────────────────────
let pageTokenCache = null;
// The Page token (needed for Page comments and messages). A system user token with the Page
// assigned can read it; if it can't, the main token is used as is.
export async function pageToken() {
  const pageId = cfg().META_PAGE_ID;
  if (!pageId) return null;
  if (pageTokenCache && Date.now() - pageTokenCache.at < 6 * 3600_000) return pageTokenCache.token;
  let token = cfg().META_ACCESS_TOKEN;
  try { const r = await graph(pageId, { fields: 'access_token' }); if (r.access_token) token = r.access_token; } catch { /* main token */ }
  pageTokenCache = { token, at: Date.now() };
  return token;
}

let igCache = null;
export async function instagramUserId() {
  if (cfg().META_IG_USER_ID) return cfg().META_IG_USER_ID;
  if (!cfg().META_PAGE_ID) return null;
  if (igCache !== null) return igCache || null;
  try {
    const r = await graph(cfg().META_PAGE_ID, { fields: 'instagram_business_account' }, { token: await pageToken() });
    igCache = r.instagram_business_account?.id || '';
  } catch { igCache = ''; }
  return igCache || null;
}

export function resetMetaCaches() { pageTokenCache = null; igCache = null; extraCampaigns.clear(); }

export { daysAgo as isoDaysAgo, range } from './clock.mjs';
