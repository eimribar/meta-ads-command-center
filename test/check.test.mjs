import test from 'node:test';
import assert from 'node:assert/strict';
import { runCheck, TABLES, SLACK_SCOPES, metaProblem } from '../src/check.mjs';
import { REQUIRED } from '../src/config.mjs';
import { fakePg, setup, BASE_ENV } from './helpers.mjs';

// Token-shaped fakes are assembled at run time so the source holds nothing that looks like a key.
const FAKE = { meta: ['EA', 'Asecretsecretsecretsecret123'].join(''), bot: ['xo', 'xb-secret-bot'].join(''), app: ['xa', 'pp-secret-app'].join(''), claude: ['sk', 'ant', 'supersecretkey'].join('-') };
const SECRETS = {
  META_ACCESS_TOKEN: FAKE.meta, META_AD_ACCOUNT_ID: 'act_4242', META_PAGE_ID: '5151', META_PIXEL_ID: '6161',
  RESULT_EVENT: 'Schedule', RESULT_LABEL: 'test rides', SECONDARY_EVENT: 'Lead', SECONDARY_LABEL: 'leads',
  TARGET_COST_PER_RESULT: '150', MAX_DAILY_BUDGET: '700', ANTHROPIC_API_KEY: FAKE.claude,
  SLACK_BOT_TOKEN: FAKE.bot, SLACK_APP_TOKEN: FAKE.app, SLACK_CHANNEL: 'CSECRETCHANNEL',
  ADMIN_SLACK_USER_IDS: 'USECRETOPERATOR', DATABASE_URL: 'postgres://user:dbpassword@db.example:5432/x',
};
const PERMS = ['ads_read', 'ads_management', 'pages_show_list', 'pages_read_engagement', 'pages_read_user_content', 'pages_manage_engagement', 'pages_messaging', 'instagram_basic', 'instagram_manage_comments', 'business_management'];

function deps({ seen = [{ action_type: 'schedule_website', value: '12' }, { action_type: 'lead', value: '40' }, { action_type: 'schedule_total', value: '14' }], tables = TABLES, inChannel = true, upgraded = true, owner = 'agent' } = {}) {
  return {
    graph: async (path) => {
      if (path === 'me/permissions') return { data: PERMS.map((p) => ({ permission: p, status: 'granted' })) };
      if (path === 'act_4242') return { name: 'x', account_status: 1, currency: 'USD', timezone_name: 'America/New_York' };
      if (path === '5151') return { name: 'Page', access_token: 'page-token-secret' };
      if (path === '6161') return { name: 'Pixel', last_fired_time: '2026-11-17T10:00:00+0000' };
      if (path === 'act_4242/insights') return { data: [{ actions: seen.filter((s) => s.action_type.startsWith('offsite')), conversions: seen.filter((s) => !s.action_type.startsWith('offsite')) }] };
      throw new Error(`unexpected ${path}`);
    },
    slack: (token) => ({
      auth: { test: async () => ({ team: 'Northfield Bikes', response_metadata: { scopes: SLACK_SCOPES.join(',') } }) },
      conversations: { info: async () => ({ channel: { is_member: inChannel } }) },
      users: { info: async () => ({ user: { deleted: false } }) },
      apps: { connections: { open: async () => { if (token !== FAKE.app) throw new Error('not_allowed_token_type'); return { ok: true }; } } },
    }),
    pg: async () => fakePg({ tables, upgraded, owner }),
    anthropic: () => ({ models: { retrieve: async () => ({ id: 'claude-opus-5-5' }) } }),
  };
}

const noValues = (out) => {
  for (const [k, v] of Object.entries(SECRETS)) if (v.length > 4 && !['Schedule', 'test rides', 'leads'].includes(v)) assert.ok(!out.includes(v), `${k} value leaked`);
  assert.ok(!out.includes('dbpassword') && !out.includes('page-token-secret'));
};

test('with nothing set, every required setting is named with its fix, and it exits red', async () => {
  const r = await runCheck({}, deps());
  assert.equal(r.ok, false);
  for (const k of REQUIRED) assert.match(r.text, new RegExp(`FIX   ${k} is not set\\n      fix: `));
});

test('all green with a working setup, and no value is ever printed', async () => {
  const r = await runCheck(SECRETS, deps());
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /result "test rides" seen: 12 in the last 30 days, counted as schedule_website\n      the account also reported: lead \(40\), schedule_total \(14\)/);
  assert.match(r.text, /secondary "leads" seen: 40/);
  assert.match(r.text, /Ready\./);
  noValues(r.text);
});

test('a result event the account never reported names what it did report', async () => {
  const r = await runCheck(SECRETS, deps({ seen: [{ action_type: 'offsite_conversion.fb_pixel_lead', value: '40' }, { action_type: 'link_click', value: '900' }] }));
  assert.equal(r.ok, false);
  assert.match(r.text, /result "test rides" was not reported/);
  assert.match(r.text, /set RESULT_ACTION_TYPE.*link_click/);
  noValues(r.text);
});

test('missing tables this user can create are a warning; a bot outside the channel is a red line', async () => {
  let r = await runCheck(SECRETS, deps({ tables: [] }));
  assert.equal(r.ok, true, 'a fresh database is not a problem: npm start creates the tables');
  assert.match(r.text, /OK    connected \(SSL: require\)\nWARN  tables: the tables are not there yet: npm start creates them, or run npm run db:setup/);
  r = await runCheck(SECRETS, deps({ tables: ['brain'], inChannel: false }));
  assert.equal(r.ok, false);
  assert.match(r.text, /WARN  tables: 13 of the 14 tables are missing[\s\S]*npm run db:setup/);
  assert.match(r.text, /bot is not in the channel[\s\S]*fix: in that channel, type \/invite/);
  noValues(r.text);
});

test('errors that carry a token are shown without it', async () => {
  const d = deps();
  d.anthropic = () => ({ models: { retrieve: async () => { throw Object.assign(new Error(`invalid x-api-key ${FAKE.claude}`), { status: 401 }); } } });
  const r = await runCheck(SECRETS, d);
  assert.equal(r.ok, false);
  noValues(r.text);
});

const tok = (a, b) => [a, b].join('');   // token-shaped strings are built at run time

const BOT = tok('xo', 'xb-1-2-abc'), APP = tok('xa', 'pp-1-abc'), USER_TOKEN = tok('xo', 'xp-1-2-abc');

const okDeps = (over = {}) => ({
  graph: async (path) => {
    if (path === 'act_111') return { account_status: 1, currency: 'EUR', timezone_name: 'Europe/Berlin' };
    if (path === 'me/permissions') return { data: ['ads_read', 'ads_management', 'pages_show_list', 'pages_read_engagement', 'pages_read_user_content', 'pages_manage_engagement'].map((p) => ({ permission: p, status: 'granted' })) };
    if (path === '222') return { access_token: 'x' };
    if (path.endsWith('/insights')) return { data: [{ conversions: [{ action_type: 'schedule_website', value: '3' }], actions: [{ action_type: 'lead', value: '9' }] }] };
    throw new Error(`unexpected ${path}`);
  },
  slack: () => ({ auth: { test: async () => ({ team: 'Northfield Bikes', response_metadata: { scopes: SLACK_SCOPES.join(',') } }) }, conversations: { info: async () => ({ channel: { is_member: true } }) }, users: { info: async () => ({ user: {} }) }, apps: { connections: { open: async () => ({ ok: true }) } } }),
  pg: async () => fakePg(),
  anthropic: () => ({ models: { retrieve: async () => ({}) } }),
  ...over,
});

const ENV = { ...BASE_ENV, SLACK_BOT_TOKEN: BOT, SLACK_APP_TOKEN: APP };

test('a bad value is reported once, not again as "not set"', async () => {
  const r = await runCheck({ ...ENV, TARGET_COST_PER_RESULT: 'abc' }, okDeps());
  assert.equal(r.text.match(/TARGET_COST_PER_RESULT/g).length, 1, r.text);
  assert.match(r.text, /FIX   TARGET_COST_PER_RESULT must be a positive number/);
});

test('an invalid or expired Meta token is one line that says so, and the scope is not claimed', async () => {
  const dead = Object.assign(new Error('190: Invalid OAuth access token'), { code: 190 });
  const r = await runCheck(ENV, okDeps({ graph: async () => { throw dead; } }));
  assert.match(r.text, /the token is invalid or has expired \(Meta error 190\)/);
  assert.equal(r.text.match(/190/g).length, 1, r.text);
  assert.ok(!/OK    scope/.test(r.text), 'scope is OK only after the account was read');
  assert.match(r.text, /OK    the bot token works/);   // the rest still runs
});

test('the check shows the currency and the database SSL mode when all is well', async () => {
  const r = await runCheck(ENV, okDeps());
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /currency EUR/);
  assert.match(r.text, /OK    scope: the whole ad account/);
  assert.match(r.text, /OK    connected \(SSL: require\)\nOK    tables: every table exists and this user can use them/);
});

test('Meta errors get plain fixes', () => {
  assert.match(metaProblem({ code: 100, message: 'Object with ID x does not exist' }, { what: 'w', assign: 'assign it' }).fix, /check the id, and assign it/);
  assert.match(metaProblem({ code: 200, message: 'Permissions error' }, { what: 'w', assign: 'assign it' }).what, /missing a permission/);
  assert.match(metaProblem({ code: 17, message: 'limit' }, { what: 'w', assign: '' }).fix, /wait a few minutes/);
});

test('the check ends by saying what stays off until the business numbers are set', async () => {
  const env = { ...BASE_ENV, TARGET_COST_PER_RESULT: '', MAX_DAILY_BUDGET: '', META_ACCESS_TOKEN: '', META_AD_ACCOUNT_ID: '', SLACK_BOT_TOKEN: '', SLACK_APP_TOKEN: '', ANTHROPIC_API_KEY: '' };
  let r = await runCheck(env, { pg: async () => fakePg() });
  assert.match(r.text, /Meanwhile the optimizer proposes nothing until there is a target cost per result, and every budget change is refused until there is a daily budget ceiling\. Both numbers come from whoever owns the ad budget\.$/);
  r = await runCheck(env, { pg: async () => fakePg({ brainTarget: 40 }) });
  assert.ok(!/proposes nothing/.test(r.text), 'a target in the brain counts');
  assert.match(r.text, /daily budget ceiling/);
  r = await runCheck({ ...env, MAX_DAILY_BUDGET: '500', TARGET_COST_PER_RESULT: '40' }, { pg: async () => fakePg() });
  assert.ok(!/Meanwhile/.test(r.text));
});

test('the bot line names the workspace, not a guessed bot user name', async () => {
  const tok = (a, b) => [a, b].join('');
  const env = { ...BASE_ENV, SLACK_BOT_TOKEN: tok('xo', 'xb-1-2-abc'), SLACK_APP_TOKEN: tok('xa', 'pp-1-abc'), META_ACCESS_TOKEN: '', META_AD_ACCOUNT_ID: '', ANTHROPIC_API_KEY: '' };
  const slack = () => ({ auth: { test: async () => ({ team: 'Northfield Bikes', user: 'x', response_metadata: { scopes: SLACK_SCOPES.join(',') } }) }, conversations: { info: async () => ({ channel: { is_member: true } }) }, users: { info: async () => ({ user: {} }) }, apps: { connections: { open: async () => ({ ok: true }) } } });
  const r = await runCheck(env, { slack, pg: async () => fakePg() });
  assert.match(r.text, /OK    the bot token works \(workspace Northfield Bikes\)/);
});

test('the check reports owned tables as one red line, never as missing', async () => {
  const env = { ...BASE_ENV, META_ACCESS_TOKEN: '', META_AD_ACCOUNT_ID: '', SLACK_BOT_TOKEN: '', SLACK_APP_TOKEN: '', ANTHROPIC_API_KEY: '', DATABASE_URL: 'postgres://agent:pw@db.example.com:5432/agent' };
  const r = await runCheck(env, { pg: async () => fakePg({ owner: 'dbadmin', user: 'agent', canUse: false }) });
  assert.match(r.text, /OK    connected \(SSL: require\)\nFIX   tables: 14 of the tables exist but belong to the database user dbadmin/);
  assert.ok(!/missing/.test(r.text.split('Database')[1]));
});

test('a target in the brain is named as the source, with no warning that it is missing', async () => {
  const env = { ...BASE_ENV, TARGET_COST_PER_RESULT: '', META_ACCESS_TOKEN: '', META_AD_ACCOUNT_ID: '', SLACK_BOT_TOKEN: '', SLACK_APP_TOKEN: '', ANTHROPIC_API_KEY: '' };
  let r = await runCheck(env, { pg: async () => fakePg({ brainTarget: 40 }) });
  assert.match(r.text, /Your numbers\nOK    target cost per result: set in the brain \(policy\/target\)\n/);
  assert.ok(!/WARN.*target/i.test(r.text), r.text);
  r = await runCheck({ ...env, TARGET_COST_PER_RESULT: '150' }, { pg: async () => fakePg({ brainTarget: '45' }) });
  assert.match(r.text, /set in the brain \(policy\/target\), which overrides TARGET_COST_PER_RESULT/);
  r = await runCheck(env, { pg: async () => fakePg({ brainTarget: 'soon' }) });
  assert.match(r.text, /WARN  no target cost per result: the optimizer proposes nothing until one is set/);
  r = await runCheck({ ...env, TARGET_COST_PER_RESULT: '150' }, { pg: async () => fakePg() });
  assert.match(r.text, /OK    target cost per result: set in TARGET_COST_PER_RESULT/);
});

test('the check says when the optimizer is turned off', async () => {
  const env = { ...BASE_ENV, OPTIMIZER_ENABLED: 'false', META_ACCESS_TOKEN: '', META_AD_ACCOUNT_ID: '', SLACK_BOT_TOKEN: '', SLACK_APP_TOKEN: '', ANTHROPIC_API_KEY: '' };
  const r = await runCheck(env, { pg: async () => fakePg() });
  assert.match(r.text, /WARN  the optimizer is off \(OPTIMIZER_ENABLED=false\)/);
});

test('the check itself reports a database user that cannot create the tables, with the GRANT', async () => {
  const env = { ...BASE_ENV, META_ACCESS_TOKEN: '', META_AD_ACCOUNT_ID: '', SLACK_BOT_TOKEN: '', SLACK_APP_TOKEN: '', ANTHROPIC_API_KEY: '', DATABASE_URL: 'postgres://agent:pw@db.example.com:5432/agent' };
  const r = await runCheck(env, { pg: async () => fakePg({ tables: [], canCreate: false, user: 'agent' }) });
  assert.match(r.text, /OK    connected \(SSL: require\)\nFIX   tables: the tables are not there yet, and this user cannot create them\n      fix: this database user \(agent\) is not allowed to create tables[\s\S]*GRANT CREATE ON SCHEMA public TO agent;/);
  assert.ok(!/run npm run db:setup/.test(r.text.split('Database')[1].split('Claude')[0]), 'not sent round to db:setup');
});

test('a fix that spans several lines stays indented under its FIX line', async () => {
  const env = { ...BASE_ENV, META_ACCESS_TOKEN: '', META_AD_ACCOUNT_ID: '', SLACK_BOT_TOKEN: '', SLACK_APP_TOKEN: '', ANTHROPIC_API_KEY: '', DATABASE_URL: 'postgres://agent:pw@db.example.com:5432/agent' };
  const r = await runCheck(env, { pg: async () => fakePg({ owner: 'postgres', user: 'agent', canUse: false }) });
  const block = r.text.split('Database\n')[1].split('\n\n')[0].split('\n');
  assert.match(block[0], /^OK    connected/);
  assert.match(block[1], /^FIX   tables: /);
  assert.ok(block.slice(2).every((l) => l.startsWith('      ')), block.join('\n'));
  assert.ok(block.some((l) => /ALTER DEFAULT PRIVILEGES FOR ROLE postgres/.test(l)));
});

test('tables from before an upgrade are named, and only their owner can add what is missing', async () => {
  let r = await runCheck(SECRETS, deps({ upgraded: false }));
  assert.equal(r.ok, true);
  assert.match(r.text, /WARN  tables: the tables need an upgrade \(the column actions_log\.journal_id, the index actions_log_one_open\): npm start adds it, or run npm run db:setup/);
  r = await runCheck(SECRETS, deps({ upgraded: false, owner: 'dbadmin' }));
  assert.equal(r.ok, false);
  assert.match(r.text, /FIX   tables: the tables need an upgrade [\s\S]*only their owner, dbadmin, can add it/);
});
