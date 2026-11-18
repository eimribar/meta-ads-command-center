// Every setting the agent reads, in one place. Settings come only from environment variables
// (a local .env file is loaded for convenience). A missing or invalid value is reported by its
// name, never by its value.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// The raw .env text, kept so a value cut short by a # can be named (see dotenvProblems).
let dotenvText = null;
if (!process.env.NODE_TEST_CONTEXT && !process.env.SKIP_DOTENV) {
  try { dotenvText = readFileSync(join(root, '.env'), 'utf8'); } catch { /* no .env file */ }
  try { (await import('dotenv')).default.config({ path: join(root, '.env'), quiet: true }); } catch { /* dotenv is optional */ }
}

const text = () => z.string().trim().min(1);
const optionalText = () => z.string().trim().optional().transform((v) => (v ? v : undefined));
// On and off settings are written true or false (any case). Anything else is refused, with the
// spelling it most likely meant, so `off` or `ture` is never read as a guess.
const MEANS_TRUE = ['1', 'yes', 'y', 'on', 'enabled', 'enable', 'ture', 'treu', 'tru', 'rue'];
const MEANS_FALSE = ['0', 'no', 'n', 'off', 'disabled', 'disable', 'flase', 'fasle', 'fales', 'fals', 'alse'];
export function boolProblem(v) {
  const s = String(v).trim().toLowerCase();
  const meant = MEANS_TRUE.includes(s) ? 'true' : MEANS_FALSE.includes(s) ? 'false' : null;
  return meant ? `must be true or false; write ${meant}` : 'must be true or false';
}
const bool = (fallback) => z.string().optional().transform((v, ctx) => {
  if (v == null || v.trim() === '') return fallback;
  const s = v.trim().toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  ctx.addIssue({ code: 'custom', message: boolProblem(v) });
  return z.NEVER;
});
// A value that must match a shape. `why(v)` names the likely mix-up without repeating the value.
const shaped = (test, why) => z.string().trim().min(1).superRefine((v, ctx) => {
  if (!test(v)) ctx.addIssue({ code: 'custom', message: why(v) });
});
const optionalDigits = (what) => z.string().trim().optional().transform((v, ctx) => {
  if (!v) return undefined;
  if (!/^\d+$/.test(v)) { ctx.addIssue({ code: 'custom', message: `must be the ${what} id (digits only)` }); return z.NEVER; }
  return v;
});
const botToken = shaped((v) => /^(xoxe\.)?xoxb-/.test(v), (v) => (v.startsWith('xapp-')
  ? 'looks like the app level token (xapp-); that one goes in SLACK_APP_TOKEN, and this one is the Bot User OAuth Token (xoxb-)'
  : v.startsWith('xoxp-') ? 'looks like a user token (xoxp-); use the Bot User OAuth Token (xoxb-) from OAuth & Permissions'
    : 'must be the Bot User OAuth Token, which starts with xoxb-'));
const appToken = shaped((v) => v.startsWith('xapp-'), (v) => (/^(xoxe\.)?xoxb-/.test(v)
  ? 'looks like the bot token (xoxb-); that one goes in SLACK_BOT_TOKEN, and this one is the app level token (xapp-)'
  : 'must be the app level token, which starts with xapp-'));
// A channel link (https://team.slack.com/archives/C0123ABC) has the id in it: name it in the fix.
export function channelProblem(v) {
  const s = String(v).trim();
  const inLink = /slack\.com\//i.test(s) ? (s.match(/\/([CG][A-Z0-9]{6,})(?=[/?#]|$)/) || [])[1] : null;
  if (inLink) return `is a channel link; the channel id in it is ${inLink}, so write SLACK_CHANNEL=${inLink}`;
  if (/^#|[a-z]/.test(s)) return 'looks like a channel name; use the channel id, which starts with C (channel details, at the bottom)';
  return 'must be a channel id, which starts with C (channel details, at the bottom)';
}
const channelId = shaped((v) => /^[CG][A-Z0-9]+$/.test(v), channelProblem);
const memberIds = () => z.string().optional().transform((v, ctx) => {
  const ids = (v || '').split(',').map((x) => x.trim()).filter(Boolean);
  const bad = ids.filter((x) => !/^[UW][A-Z0-9]+$/.test(x));
  if (bad.length) {
    ctx.addIssue({ code: 'custom', message: `has ${bad.length} entr${bad.length === 1 ? 'y' : 'ies'} that ${bad.length === 1 ? 'is not a member id' : 'are not member ids'}; use member ids (they start with U), not names or emails` });
    return z.NEVER;
  }
  return ids;
});
const campaignIds = () => z.string().optional().transform((v, ctx) => {
  const ids = (v || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (ids.some((x) => !/^\d+$/.test(x))) { ctx.addIssue({ code: 'custom', message: 'must be campaign ids (digits), separated by commas' }); return z.NEVER; }
  return ids;
});
const timeZone = () => z.string().trim().optional().transform((v, ctx) => {
  if (!v) return undefined;
  try { new Intl.DateTimeFormat('en-US', { timeZone: v }); return v; }
  catch { ctx.addIssue({ code: 'custom', message: 'must be a time zone name like America/New_York or Europe/London' }); return z.NEVER; }
});
// A Postgres URL. Special characters in the user name or password must be URL-encoded, or the
// URL reads part of the password as the host. The raw text is checked before it is parsed,
// because a parser silently accepts many broken URLs (a # turns the rest into a fragment).
export const ENCODE_HINT = 'URL-encode special characters in the password: @ is %40, : is %3A, / is %2F, ? is %3F, # is %23, [ is %5B, ] is %5D, % is %25, a space is %20 (docs/INSTALL.md, step 2)';
const BREAKS_URL = /[@:/?#[\]\s]|%(?![0-9A-Fa-f]{2})/;
export function credentialProblem(raw) {
  const m = String(raw || '').match(/^postgres(?:ql)?:\/\/(.*)$/is);
  if (!m) return null;
  const rest = m[1];
  const at = rest.lastIndexOf('@');
  if (at < 0) return null;
  const userinfo = rest.slice(0, at);
  const colon = userinfo.indexOf(':');
  const user = colon < 0 ? userinfo : userinfo.slice(0, colon);
  const password = colon < 0 ? '' : userinfo.slice(colon + 1);
  if (BREAKS_URL.test(password)) return `has a password with a character that breaks the URL; ${ENCODE_HINT}`;
  if (BREAKS_URL.test(user)) return `has a user name with a character that breaks the URL; ${ENCODE_HINT}`;
  return null;
}
const dbUrl = () => z.string().trim().min(1).superRefine((v, ctx) => {
  const cred = credentialProblem(v);
  if (cred) { ctx.addIssue({ code: 'custom', message: cred }); return; }
  let u;
  try { u = new URL(v); } catch { ctx.addIssue({ code: 'custom', message: `is not a valid connection string; if the password has special characters, ${ENCODE_HINT}` }); return; }
  if (!['postgres:', 'postgresql:'].includes(u.protocol)) { ctx.addIssue({ code: 'custom', message: 'must start with postgres:// or postgresql://' }); return; }
  if (!u.hostname) { ctx.addIssue({ code: 'custom', message: 'has no host name' }); return; }
  try { decodeURIComponent(u.password); decodeURIComponent(u.username); }
  catch { ctx.addIssue({ code: 'custom', message: `has a password that is not URL-encoded correctly; ${ENCODE_HINT}` }); }
});
// The user name in a connection string, for messages that name it. Never the password.
export function dbUser(url) {
  try { return decodeURIComponent(new URL(url).username) || null; } catch { return null; }
}
const money = () => z.string().optional().transform((v, ctx) => {
  if (v == null || v.trim() === '') return undefined;
  const n = Number(v.replace(/[\p{Sc},\s]/gu, ''));
  if (!Number.isFinite(n) || n <= 0) { ctx.addIssue({ code: 'custom', message: 'must be a positive number' }); return z.NEVER; }
  return n;
});
const number = (fallback, { min = 0, max = Infinity } = {}) => z.string().optional().transform((v, ctx) => {
  if (v == null || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) { ctx.addIssue({ code: 'custom', message: `must be a number from ${min} to ${max}` }); return z.NEVER; }
  return n;
});
const clock = (fallback) => z.string().optional().transform((v, ctx) => {
  const s = (v || '').trim() || fallback;
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(s)) { ctx.addIssue({ code: 'custom', message: 'must be HH:MM in 24 hour time' }); return z.NEVER; }
  const [h, m] = s.split(':').map(Number);
  return { h, m, text: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` };
});
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// The settings a running agent cannot do without.
export const REQUIRED = [
  'META_ACCESS_TOKEN', 'META_AD_ACCOUNT_ID', 'RESULT_EVENT', 'ANTHROPIC_API_KEY',
  'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_CHANNEL', 'DATABASE_URL',
];

const schema = z.object({
  // Meta
  META_ACCESS_TOKEN: text(),
  META_AD_ACCOUNT_ID: text().transform((v) => (v.startsWith('act_') ? v : `act_${v}`))
    .refine((v) => /^act_\d+$/.test(v), 'must be act_ followed by the account number, like act_1234567890'),
  META_PAGE_ID: optionalDigits('Page'),
  META_PIXEL_ID: optionalDigits('dataset'),
  META_IG_USER_ID: optionalDigits('Instagram account'),
  // 25, v25 and v25.0 all mean v25.0.
  META_API_VERSION: z.string().trim().optional().transform((v, ctx) => {
    if (!v) return 'v25.0';
    const m = v.match(/^v?(\d{1,3})(?:\.(\d))?$/i);
    if (!m) { ctx.addIssue({ code: 'custom', message: 'must be a Graph API version like v25.0 (25 and v25 work too)' }); return z.NEVER; }
    return `v${m[1]}.${m[2] || '0'}`;
  }),
  CAMPAIGN_ALLOWLIST: campaignIds(),
  // What counts as a result
  RESULT_EVENT: text(),
  RESULT_LABEL: optionalText(),
  RESULT_ACTION_TYPE: optionalText(),
  SECONDARY_EVENT: optionalText(),
  SECONDARY_LABEL: optionalText(),
  SECONDARY_ACTION_TYPE: optionalText(),
  // Money
  TARGET_COST_PER_RESULT: money(),
  MAX_DAILY_BUDGET: money(),
  // Claude
  ANTHROPIC_API_KEY: text(),
  MODEL: z.string().trim().optional().transform((v) => v || 'claude-opus-5-5'),
  // The effort levels claude-opus-5-5 accepts. The agent sets one explicitly (high by default).
  MODEL_EFFORT: z.string().trim().toLowerCase().optional().transform((v) => v || 'high')
    .refine((v) => EFFORTS.includes(v), `must be one of ${EFFORTS.join(', ')}`),
  WEB_RESEARCH_ENABLED: bool(true),
  // Slack
  SLACK_BOT_TOKEN: botToken,
  SLACK_APP_TOKEN: appToken,
  SLACK_CHANNEL: channelId,
  ADMIN_SLACK_USER_IDS: memberIds(),
  // Database
  DATABASE_URL: dbUrl(),
  DATABASE_SSL: z.enum(['auto', 'require', 'verify', 'disable']).optional().transform((v) => v || 'auto'),
  DATABASE_SSL_CA: optionalText(),
  // Time and schedules
  TIMEZONE: timeZone(),
  INTERNAL_SCHEDULER: bool(true),
  REPORT_ENABLED: bool(true),
  REPORT_TIME: clock('09:00'),
  OPTIMIZER_ENABLED: bool(true),
  OPTIMIZER_TIME: clock('08:45'),
  OPTIMIZER_EVERY_HOURS: number(6, { min: 0, max: 24 }),
  WEEKLY_DAY: z.string().trim().toLowerCase().optional().transform((v) => v || 'monday')
    .refine((v) => DAYS.includes(v), 'must be a day name like monday'),
  // Comment moderation
  MODERATION_ENABLED: bool(true),
  MODERATION_EVERY_MINUTES: number(60, { min: 10, max: 1440 }),
  MODERATION_ACTION: z.enum(['hide', 'delete', 'flag']).optional().transform((v) => v || 'hide'),
  MODERATION_MIN_CONFIDENCE: number(0.7, { min: 0, max: 1 }),
  // Process
  PORT: number(3000, { min: 1, max: 65535 }),
  HEALTH_SECRET: optionalText(),
});

export const WEEKDAYS = DAYS;
export const KEYS = Object.keys(schema.shape);
// Every setting except the ones that start with one of `prefixes`.
export const keysExcept = (...prefixes) => KEYS.filter((k) => !prefixes.some((p) => k.startsWith(p)));

// In a .env file an unquoted # starts a comment, so `SLACK_CHANNEL=#ads` or a password with a #
// in it arrives cut short (often empty). Returns { KEY: message } for each setting whose value in
// `env` is such a cut-short .env value. A # after a space (`KEY=value # note`) is a real comment.
export function dotenvProblems(text, env = process.env) {
  const out = {};
  for (const lineText of String(text || '').split(/\r?\n/)) {
    const m = lineText.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m || !KEYS.includes(m[1])) continue;
    const [, key, value] = m;
    if (/^['"`]/.test(value)) continue;
    const hash = value.search(/(^|[^\s])#/);
    if (hash < 0) continue;
    const kept = value.slice(0, value.indexOf('#')).trim();
    if (String(env[key] ?? '').trim() !== kept) continue;     // a real environment variable won
    out[key] = 'has a # in .env, and an unquoted # starts a comment there, so the value is cut off at the #. Take the # out (in a password, write it as %23)';
  }
  return out;
}

// Parse an environment object. Returns { config, problems }: problems name the setting and what
// is wrong with it, and never carry the value.
export function parseConfig(env = process.env, { require = REQUIRED, dotenv = dotenvText } = {}) {
  const config = {};
  const problems = [];
  const cut = dotenvProblems(dotenv, env);
  for (const [key, field] of Object.entries(schema.shape)) {
    const raw = env[key] == null ? undefined : String(env[key]);
    if (cut[key]) { problems.push({ key, message: cut[key] }); continue; }
    if (raw === undefined || raw.trim() === '') {
      if (require.includes(key)) { problems.push({ key, message: 'is not set' }); continue; }
      // a required setting skipped for this command (a dry run needs no Slack) stays unset
      if (REQUIRED.includes(key)) continue;
    }
    const r = field.safeParse(raw === undefined || raw.trim() === '' ? undefined : raw);
    if (r.success) config[key] = r.data;
    else problems.push({ key, message: r.error.issues[0]?.message || 'is not valid' });
  }
  return { config, problems };
}

let current = null;
// The settings for this process. Throws once, listing every problem by name. A command that
// needs only some settings passes `only`: problems with any other setting do not stop it, and
// those settings stay unset.
export function getConfig({ require = REQUIRED, only = null } = {}) {
  if (current) return current;
  const parsed = parseConfig(process.env, { require });
  const { config } = parsed;
  const problems = only ? parsed.problems.filter((p) => only.includes(p.key)) : parsed.problems;
  if (problems.length) {
    const lines = problems.map((p) => `  ${p.key} ${p.message}`).join('\n');
    throw new Error(`Settings need attention (see docs/SETTINGS.md):\n${lines}`);
  }
  current = config;
  return current;
}
// Tests and the first-run check build their own config.
export function setConfig(cfg) { current = cfg; }
export function resetConfig() { current = null; }
