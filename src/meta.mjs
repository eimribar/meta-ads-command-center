// Read access to the Meta Graph API, plus the low level POST and DELETE used by meta-write.mjs.
// Scope: the whole ad account, or only the campaigns in CAMPAIGN_ALLOWLIST when it is set.
import { getConfig } from './config.mjs';
import { rt } from './runtime.mjs';

const cfg = () => getConfig();
const base = () => `https://graph.facebook.com/${cfg().META_API_VERSION}`;
export const account = () => cfg().META_AD_ACCOUNT_ID;

const TRANSIENT = new Set([1, 2, 4, 17, 32, 341, 613, 80000, 80003, 80004]);

// Never let a token reach a log line or a Slack message.
export function redact(text) {
  return String(text ?? '')
    .replace(/access_token=[^&\s"']+/gi, 'access_token=[hidden]')
    .replace(/\bEAA[A-Za-z0-9]{20,}/g, '[hidden token]');
}

function encode(params) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

async function request(method, path, params = {}, { token = null, timeoutMs = 60_000, retries = 2 } = {}) {
  const t = token || cfg().META_ACCESS_TOKEN;
  const url = new URL(/^https?:/.test(path) ? path : `${base()}/${String(path).replace(/^\//, '')}`);
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
      if (method === 'GET' && attempt < retries) { await sleep(800 * (attempt + 1)); continue; }
      const err = new Error(`Meta ${method} failed: ${redact(e?.message || e)}`);
      err.network = true;
      throw err;
    }
    if (json?.error) {
      const code = json.error.code;
      if (method === 'GET' && TRANSIENT.has(code) && attempt < retries) { await sleep(1500 * (attempt + 1)); continue; }
      const err = new Error(`${code}: ${redact(json.error.message)}${json.error.error_user_msg ? ` (${redact(json.error.error_user_msg)})` : ''}`);
      err.code = code;
      throw err;
    }
    if (!res.ok) { const err = new Error(`Meta HTTP ${res.status}`); err.status = res.status; throw err; }
    return json;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const graph = (path, params, opts) => request('GET', path, params, opts);
export const graphPostRaw = (path, params, opts) => request('POST', path, params, { ...opts, retries: 0 });
export const graphDeleteRaw = (path, params, opts) => request('DELETE', path, params, { ...opts, retries: 0 });

// Follow paging up to `cap` rows.
export async function graphAll(path, params = {}, cap = 500, opts = {}) {
  const out = [];
  let j = await graph(path, { limit: 100, ...params }, opts);
  out.push(...(j.data || []));
  let next = j.paging?.next;
  while (next && out.length < cap) {
    j = await request('GET', next, {}, opts);
    out.push(...(j.data || []));
    next = j.paging?.next;
  }
  return out.slice(0, cap);
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
