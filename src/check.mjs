// The first-run check (`npm run check`). One line per piece: OK, a warning, or a problem with
// the fix. Each problem is reported once, and no line ever carries a setting's value.
import { parseConfig, REQUIRED, dbUser, DEFAULT_META_API_VERSION } from './config.mjs';
import { actionTypeFor, actionTypesSeen } from './metrics.mjs';
import { redact } from './redact.mjs';
import { TABLES, explainDbError, tableStatus, describeTables } from './schema.mjs';
import { parseResultViews } from './brain-rules.mjs';
import { parseTarget } from './brain-rules.mjs';

export { TABLES };
export const SLACK_SCOPES = ['app_mentions:read', 'channels:history', 'channels:read', 'chat:write', 'groups:history', 'groups:read',
  'im:history', 'pins:write', 'users:read'];
const META_CORE = ['ads_read', 'ads_management'];
const META_PAGE = ['pages_show_list', 'pages_read_engagement', 'pages_read_user_content', 'pages_manage_engagement'];
const META_OPTIONAL = { pages_messaging: 'replying to Page messages', instagram_basic: 'reading Instagram', instagram_manage_comments: 'moderating Instagram comments', instagram_manage_messages: 'answering Instagram messages', business_management: 'reading assets owned by the business', pages_manage_ads: 'reading lead forms', leads_retrieval: 'reading lead forms' };

const HINT = {
  META_ACCESS_TOKEN: 'create a system user token in Business Settings (docs/INSTALL.md, step 3)',
  META_AD_ACCOUNT_ID: 'the ad account id from Ads Manager, like act_1234567890',
  META_PAGE_ID: 'the Page id: Business Settings > Accounts > Pages, or the Page\'s About section > Page transparency',
  META_PIXEL_ID: 'the dataset id: Events Manager > Data sources, under the dataset name',
  META_IG_USER_ID: 'leave it empty; it is found from the Page',
  CAMPAIGN_ALLOWLIST: 'campaign ids from Ads Manager (the Campaign ID column), separated by commas, or leave it empty for the whole account',
  RESULT_EVENT: 'the event that counts as a result, for example Purchase, Lead or Schedule',
  RESULT_ACTION_TYPE: 'one action type, for a custom conversion offsite_conversion.custom.<its id> (Events Manager > Custom conversions, the ID column)',
  SECONDARY_ACTION_TYPE: 'one action type, for a custom conversion offsite_conversion.custom.<its id> (Events Manager > Custom conversions, the ID column)',
  ANTHROPIC_API_KEY: 'create a key in the Claude Console (platform.claude.com) > API keys',
  SLACK_BOT_TOKEN: 'Slack app settings > OAuth & Permissions > Bot User OAuth Token (starts with xoxb-)',
  SLACK_APP_TOKEN: 'Slack app settings > Basic Information > App-Level Tokens, scope connections:write (starts with xapp-)',
  SLACK_CHANNEL: 'open the channel, click its name, and copy the Channel ID at the bottom of the About tab (starts with C)',
  ADMIN_SLACK_USER_IDS: 'for each operator: their profile > the three dots > Copy member ID; separate them with commas',
  DATABASE_URL: 'a Postgres connection string, for example postgres://user:password@host:5432/dbname',
  TIMEZONE: 'an IANA time zone name like America/New_York, or leave it empty to use the ad account\'s',
};

function lineMaker() {
  const lines = [];
  return {
    lines,
    ok: (what) => lines.push({ level: 'ok', text: `OK    ${what}` }),
    warn: (what, why) => lines.push({ level: 'warn', text: `WARN  ${what}${why ? `: ${String(why).replace(/\n/g, '\n      ')}` : ''}` }),
    bad: (what, fix) => lines.push({ level: 'bad', text: `FIX   ${what}\n      fix: ${String(fix).replace(/\n/g, '\n      ')}` }),
    head: (what) => lines.push({ level: 'head', text: `\n${what}` }),
  };
}
const short = (e) => redact(String(e?.data?.error || e?.message || e)).slice(0, 160);

// What a Meta error means, in plain words, with the fix.
export function metaProblem(e, { what, assign }) {
  const code = Number(e?.code);
  const text = String(e?.message || '');
  if (code === 190 || code === 102) return { what: `${what}: the token is invalid or has expired (Meta error 190)`, fix: 'generate a new system user token and put it in META_ACCESS_TOKEN (docs/INSTALL.md, step 3)', fatal: true };
  if (code === 10 || (code >= 200 && code < 300)) return { what: `${what}: the token is missing a permission for it (Meta error ${code})`, fix: `generate the token again with the permissions in docs/INSTALL.md ticked, and ${assign}` };
  if (code === 100 && /does not exist|cannot be loaded|Unsupported get request/i.test(text)) return { what: `${what}: Meta says the id does not exist or the token cannot see it`, fix: `check the id, and ${assign}` };
  if ([4, 17, 32, 613].includes(code) || (code >= 80000 && code < 80100)) return { what: `${what}: Meta is limiting calls right now (error ${code})`, fix: 'wait a few minutes and run the check again' };
  if (e?.network || /fetch failed|ENOTFOUND|ETIMEDOUT|ECONNRESET|aborted/i.test(text)) return { what: `${what}: Meta could not be reached`, fix: 'check this machine\'s internet access to graph.facebook.com and run the check again' };
  return { what: `${what}: ${short(e)}`, fix: assign };
}

// deps: { graph(path, params, opts), slack(token) -> WebClient-like, pg(url, ssl, ca) -> {query, close, sslMode}, anthropic(key) -> client }
export async function runCheck(env, deps) {
  const L = lineMaker();
  const { config: c, problems } = parseConfig(env, deps.dotenv !== undefined ? { dotenv: deps.dotenv } : {});
  const problemKeys = new Set(problems.map((p) => p.key));
  L.head('Settings');
  for (const p of problems) L.bad(`${p.key} ${p.message}`, HINT[p.key] || 'see docs/SETTINGS.md');
  if (!problems.length) L.ok('every setting is present and valid');
  else if (!problems.some((p) => REQUIRED.includes(p.key) && p.message === 'is not set')) L.ok('every required setting is present');
  // A setting that has a problem above is not reported again as "not set".
  const unset = (k) => !problemKeys.has(k) && !c[k] && !(Array.isArray(c[k]) && c[k].length);
  if (!problemKeys.has('ADMIN_SLACK_USER_IDS') && !c.ADMIN_SLACK_USER_IDS?.length) L.warn('ADMIN_SLACK_USER_IDS is empty', 'nobody can approve cards or give orders');
  if (unset('META_PAGE_ID')) L.warn('META_PAGE_ID is not set', 'comment moderation is off (no timer) and message replies are off');
  const has = (k) => !problemKeys.has(k) && c[k];
  const flags = { targetUnset: unset('TARGET_COST_PER_RESULT'), ceilingUnset: unset('MAX_DAILY_BUDGET') };

  // ── Meta ──
  L.head('Meta');
  if (has('META_ACCESS_TOKEN') && has('META_AD_ACCOUNT_ID')) {
    const g = (path, params = {}, opts = {}) => deps.graph(path, params, { token: c.META_ACCESS_TOKEN, version: c.META_API_VERSION, ...opts });
    const assignAccount = 'assign the ad account to the system user (Business Settings > Users > System users > Assign assets)';
    let accountOk = false;
    try {
      const a = await g(c.META_AD_ACCOUNT_ID, { fields: 'name,account_status,currency,timezone_name' });
      if (a.account_status !== 1) L.bad(`the ad account is readable but not active (status ${a.account_status})`, 'check the account in Ads Manager (billing, restrictions)');
      else L.ok(`reads the ad account (currency ${a.currency}, time zone ${a.timezone_name})`);
      flags.currency = a.currency;
      accountOk = true;
    } catch (e) {
      const p = metaProblem(e, { what: 'cannot read the ad account', assign: assignAccount });
      L.bad(p.what, p.fix);
      if (p.fatal) L.warn('the other Meta checks are skipped', 'they need a working token');
      if (p.fatal) return finish(L, { ...(await rest(L, c, has, deps)), ...flags }, c);
    }
    if (accountOk) {
      if (c.CAMPAIGN_ALLOWLIST?.length) L.ok(`scope: ${c.CAMPAIGN_ALLOWLIST.length} campaign${c.CAMPAIGN_ALLOWLIST.length === 1 ? '' : 's'} in CAMPAIGN_ALLOWLIST`);
      else L.ok('scope: the whole ad account');
    }
    try {
      const perms = (await g('me/permissions')).data || [];
      const granted = new Set(perms.filter((p) => p.status === 'granted').map((p) => p.permission));
      const missCore = META_CORE.filter((p) => !granted.has(p));
      const missPage = c.META_PAGE_ID ? META_PAGE.filter((p) => !granted.has(p)) : [];
      if (missCore.length || missPage.length) L.bad(`the token is missing permissions: ${[...missCore, ...missPage].join(', ')}`, 'generate the system user token again with these permissions ticked (docs/INSTALL.md, step 3)');
      else L.ok('the token has the permissions the agent needs');
      for (const [p, what] of Object.entries(META_OPTIONAL)) if (!granted.has(p)) L.warn(`the token has no ${p}`, `${what} will not work`);
    } catch (e) { L.warn('could not list the token\'s permissions', metaProblem(e, { what: 'me/permissions', assign: '' }).what); }
    if (has('META_PAGE_ID')) {
      try {
        const p = await g(c.META_PAGE_ID, { fields: 'name,access_token' });
        L.ok(`reads the Page${p.access_token ? ' and its Page token' : ''}`);
        if (!p.access_token) L.warn('no Page token came back', 'assign the Page to the system user with full control so the agent can moderate and reply');
      } catch (e) {
        const p = metaProblem(e, { what: 'cannot read the Page', assign: 'assign the Page to the system user (Business Settings > Users > System users > Assign assets)' });
        L.bad(p.what, p.fix);
      }
    }
    if (has('META_PIXEL_ID')) {
      try {
        const px = await g(c.META_PIXEL_ID, { fields: 'name,last_fired_time' });
        if (px.last_fired_time) L.ok(`reads the dataset (pixel); it last fired ${String(px.last_fired_time).slice(0, 10)}`);
        else L.warn('the dataset (pixel) is readable but has never fired');
      } catch (e) {
        const p = metaProblem(e, { what: 'cannot read the dataset (pixel)', assign: 'assign the dataset to the system user, or leave META_PIXEL_ID empty' });
        L.bad(p.what, p.fix);
      }
    }
    if (has('RESULT_EVENT') && accountOk) {
      try {
        const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10), until = new Date().toISOString().slice(0, 10);
        const rows = (await g(`${c.META_AD_ACCOUNT_ID}/insights`, { level: 'account', fields: 'actions,conversions', time_range: JSON.stringify({ since, until }) })).data || [];
        const seen = actionTypesSeen(rows);
        // One action type per event for the whole install (metrics.mjs). The check says which one it
        // counts, and what else the account reported, so a wrong pick is easy to see.
        const report = (name, event, override, label) => {
          const setting = name === 'result' ? 'RESULT_ACTION_TYPE' : 'SECONDARY_ACTION_TYPE';
          const type = actionTypeFor(event, override);
          if (!type) return;    // a custom event with no action type is reported under Settings
          const hit = seen.find((x) => x.type === type);
          const others = seen.filter((x) => x.type !== type).slice(0, 12).map((x) => `${x.type} (${x.total})`);
          const also = others.length ? `\n      the account also reported: ${others.join(', ')}` : '';
          if (hit) L.ok(`${name} "${label || event}" seen: ${hit.total} in the last 30 days, counted as ${type}${also}`);
          else L.bad(`${name} "${label || event}" was not reported in the last 30 days (counted as ${type})`,
            seen.length ? `set ${setting} to the one that counts it, from what the account reported (or fix the event name): ${seen.slice(0, 15).map((x) => x.type).join(', ')}` : 'the account reported no conversions in 30 days; check the pixel is installed and the event fires');
        };
        report('result', c.RESULT_EVENT, c.RESULT_ACTION_TYPE, c.RESULT_LABEL);
        if (c.SECONDARY_EVENT) report('secondary', c.SECONDARY_EVENT, c.SECONDARY_ACTION_TYPE, c.SECONDARY_LABEL);
      } catch (e) { L.warn('could not read the last 30 days of conversions', metaProblem(e, { what: 'insights', assign: '' }).what); }
    }
  } else L.warn('skipped', 'META_ACCESS_TOKEN and META_AD_ACCOUNT_ID are needed first');

  return finish(L, { ...(await rest(L, c, has, deps)), ...flags }, c);
}

// Slack, the database and Claude.
async function rest(L, c, has, deps) {
  const out = { brainTarget: false };
  // ── Slack ──
  L.head('Slack');
  if (has('SLACK_BOT_TOKEN')) {
    const s = deps.slack(c.SLACK_BOT_TOKEN);
    try {
      const a = await s.auth.test();
      L.ok(`the bot token works${a.team ? ` (workspace ${a.team})` : ''}`);
      const scopes = String(a.response_metadata?.scopes || '').split(',').map((x) => x.trim()).filter(Boolean);
      const missing = scopes.length ? SLACK_SCOPES.filter((x) => !scopes.includes(x)) : [];
      if (missing.length) L.bad(`the bot is missing scopes: ${missing.join(', ')}`, 'update the app from slack-app-manifest.yaml (App Manifest in the app settings), then reinstall it to the workspace');
      if (has('SLACK_CHANNEL')) {
        try {
          const ch = await s.conversations.info({ channel: c.SLACK_CHANNEL });
          if (ch.channel?.is_member) L.ok('the bot is in the channel');
          else L.bad('the bot is not in the channel', 'in that channel, type /invite and pick the app');
        } catch (e) {
          const err = e?.data?.error || '';
          L.bad(`cannot find the channel${err ? ` (${err})` : ''}`, err === 'channel_not_found' ? 'check the channel id (C...); for a private channel, invite the app first (/invite in the channel)' : HINT.SLACK_CHANNEL);
        }
      }
      const unknown = [];
      for (const id of c.ADMIN_SLACK_USER_IDS || []) {
        try { const u = await s.users.info({ user: id }); if (u.user?.deleted) unknown.push(id); } catch { unknown.push(id); }
      }
      if (unknown.length) L.bad(`${unknown.length} operator id${unknown.length === 1 ? '' : 's'} in ADMIN_SLACK_USER_IDS not found in this workspace`, HINT.ADMIN_SLACK_USER_IDS);
      else if (c.ADMIN_SLACK_USER_IDS?.length) L.ok(`${c.ADMIN_SLACK_USER_IDS.length} operator${c.ADMIN_SLACK_USER_IDS.length === 1 ? '' : 's'} found`);
    } catch (e) {
      const err = e?.data?.error || '';
      const fix = ['invalid_auth', 'not_authed', 'token_revoked', 'account_inactive'].includes(err)
        ? 'copy the Bot User OAuth Token again from OAuth & Permissions (reinstalling the app gives a new one)' : HINT.SLACK_BOT_TOKEN;
      L.bad(`the bot token was refused${err ? ` (${err})` : `: ${short(e)}`}`, fix);
    }
  } else L.warn('skipped', 'a valid SLACK_BOT_TOKEN is needed first');
  if (has('SLACK_APP_TOKEN')) {
    try { await deps.slack(c.SLACK_APP_TOKEN).apps.connections.open(); L.ok('the app token can open a Socket Mode connection'); }
    catch (e) { L.bad(`the app token was refused: ${short(e)}`, `${HINT.SLACK_APP_TOKEN}; Socket Mode must be on (Settings > Socket Mode)`); }
  }

  // ── Database ──
  L.head('Database');
  if (has('DATABASE_URL')) {
    let pg;
    try {
      pg = await deps.pg(c.DATABASE_URL, c.DATABASE_SSL, c.DATABASE_SSL_CA);
      const ssl = pg.sslMode ? ` (SSL: ${pg.sslMode})` : '';
      const status = await tableStatus(pg);
      L.ok(`connected${ssl}`);
      const t = describeTables(status);
      if (t.level === 'ok') L.ok(`tables: ${t.what}`);
      else if (t.level === 'warn') L.warn(`tables: ${t.what}`, t.fix);
      else L.bad(`tables: ${t.what}`, t.fix);
      if (t.level !== 'bad') {
        const [row] = await pg.query("select content from brain where lower(scope) = 'policy' and lower(key) = 'target'").catch(() => []);
        out.brainTargetValue = parseTarget(row?.content);
        out.brainTarget = Boolean(out.brainTargetValue);
        await checkResultViews(L, pg);
      }
    } catch (e) { L.bad('cannot use the database', explainDbError(e, { user: dbUser(c.DATABASE_URL) })); }
    finally { await pg?.close?.().catch?.(() => {}); }
  } else L.warn('skipped', 'a valid DATABASE_URL is needed first');

  // ── Claude ──
  L.head('Claude');
  if (has('ANTHROPIC_API_KEY')) {
    try { await deps.anthropic(c.ANTHROPIC_API_KEY).models.retrieve(c.MODEL); L.ok(`the key works and can use ${c.MODEL}`); }
    catch (e) {
      const status = e?.status;
      if (status === 404) L.bad(`${c.MODEL} is not available to this key`, 'set MODEL to a model your key can use');
      else if (status === 401) L.bad('the key was refused (401)', `${HINT.ANTHROPIC_API_KEY}; copy it again, it is shown only once`);
      else if (status === 403) L.bad('the key is not allowed to use the API (403)', 'check the key\'s workspace in the Claude Console');
      else if (status === 400 && /credit|billing/i.test(String(e?.message))) L.bad('the organization has no API credit', 'buy credits in the Claude Console, Settings > Billing (docs/INSTALL.md, step 5)');
      else L.bad(`the key could not be checked: ${short(e)}`, HINT.ANTHROPIC_API_KEY);
    }
  } else L.warn('skipped', 'ANTHROPIC_API_KEY is needed first');
  return out;
}

// The team's result views named in the brain row context/result_views: each must exist and be
// readable by this user. Without the row there is nothing to check and no line.
async function checkResultViews(L, pg) {
  const [row] = await pg.query("select content from brain where lower(scope) = 'context' and lower(key) = 'result_views'").catch(() => []);
  if (row?.content == null) return;
  const { value, problems } = parseResultViews(row.content);
  if (problems.length) { L.warn(`result views: the brain row context/result_views is not valid (${problems.join('; ')})`, 'write it again: brain set context/result_views <names or JSON> (docs/SETTINGS.md)'); return; }
  const names = value.map((v) => v.name);
  const found = await pg.query(`select n as name, to_regclass(n) is not null as found,
      case when to_regclass(n) is null then false else has_table_privilege(to_regclass(n), 'select') end as readable
    from unnest($1::text[]) as n`, [names]).catch(() => null);
  if (!found) { L.warn('result views: could not be checked', 'run npm run check again; the agent skips a view it cannot read'); return; }
  const missing = found.filter((r) => !r.found).map((r) => r.name);
  const closed = found.filter((r) => r.found && !r.readable).map((r) => r.name);
  if (!missing.length && !closed.length) { L.ok(`result views: ${names.join(', ')}`); return; }
  if (missing.length) L.warn(`result views: ${missing.join(', ')} not set up (no table or view by that name)`, 'create it in this database, or remove it from the brain row context/result_views; the agent skips it until then');
  if (closed.length) L.warn(`result views: this user may not read ${closed.join(', ')}`, `GRANT SELECT ON ${closed.join(', ')} TO <the agent's database user>;`);
}

// The business numbers: where the target comes from, the ceiling, and whether the optimizer is on.
// An amount as the check read it, in the account currency when the account was read, so a typo
// (1.25 for 1250) is visible.
export function shownAmount(n, currency) {
  const whole = Math.abs(n - Math.round(n)) < 0.005;
  const digits = { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 };
  if (currency) {
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency, ...digits }).format(n); } catch { /* unknown code */ }
  }
  return `${n.toLocaleString('en-US', digits)}${currency ? ` ${currency}` : ' (in the ad account\'s currency)'}`;
}

function numbers(L, r, c) {
  L.head('Your numbers');
  const show = (n) => shownAmount(Number(n), r.currency);
  if (r.brainTarget) L.ok(`target cost per result: ${show(r.brainTargetValue)}, set in the brain (policy/target)${c.TARGET_COST_PER_RESULT ? ', which overrides TARGET_COST_PER_RESULT' : ''}`);
  else if (c.TARGET_COST_PER_RESULT) L.ok(`target cost per result: ${show(c.TARGET_COST_PER_RESULT)}, from TARGET_COST_PER_RESULT`);
  else if (r.targetUnset) L.warn('no target cost per result', 'the optimizer proposes nothing until one is set, in TARGET_COST_PER_RESULT or by an operator in Slack (brain set policy/target)');
  if (c.MAX_DAILY_BUDGET) L.ok(`daily budget ceiling: ${show(c.MAX_DAILY_BUDGET)}, from MAX_DAILY_BUDGET`);
  else if (r.ceilingUnset) L.warn('MAX_DAILY_BUDGET is not set', 'every budget change (approvals and orders) is refused until it is set');
  if (c.OPTIMIZER_ENABLED === false) L.warn('the optimizer is off (OPTIMIZER_ENABLED=false)', 'it proposes nothing: no timer, no npm run job -- optimizer, no optimize in Slack');
}

// The last lines: what to fix, and what stays off until the business numbers are set.
function finish(L, r = {}, c = {}) {
  numbers(L, r, c);
  const bad = L.lines.filter((l) => l.level === 'bad').length;
  L.lines.push({ level: 'head', text: bad ? `\n${bad} thing${bad === 1 ? '' : 's'} to fix. Fix ${bad === 1 ? 'it' : 'them'} and run npm run check again.` : '\nReady. Start it with npm start (or docker compose up).' });
  const off = [];
  if (!c.TARGET_COST_PER_RESULT && !r.brainTarget) off.push('the optimizer proposes nothing until there is a target cost per result');
  if (!c.MAX_DAILY_BUDGET) off.push('every budget change is refused until there is a daily budget ceiling');
  if (off.length) L.lines.push({ level: 'head', text: `Meanwhile ${off.join(', and ')}. Both numbers come from whoever owns the ad budget.` });
  return { ok: bad === 0, lines: L.lines, text: L.lines.map((l) => l.text).join('\n') };
}

// Real dependencies for the command line.
export async function realDeps() {
  const { WebClient } = await import('@slack/web-api');
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const { createPgDb } = await import('./db.mjs');
  return {
    graph: async (path, params, { token, version }) => {
      const url = new URL(`https://graph.facebook.com/${version || DEFAULT_META_API_VERSION}/${path}`);
      for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      url.searchParams.set('access_token', token);
      let j;
      try { j = await (await fetch(url, { signal: AbortSignal.timeout(30_000) })).json(); }
      catch (e) { throw Object.assign(new Error(String(e?.message || e)), { network: true }); }
      if (j.error) throw Object.assign(new Error(`${j.error.code}: ${j.error.message}`), { code: j.error.code });
      return j;
    },
    slack: (token) => new WebClient(token, { retryConfig: { retries: 0 }, logLevel: 'error' }),
    pg: (url, ssl, ca) => createPgDb(url, { ssl, ca }),
    anthropic: (key) => new Anthropic({ apiKey: key, maxRetries: 0 }),
  };
}

export { REQUIRED };
