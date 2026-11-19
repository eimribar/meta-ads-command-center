import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, REQUIRED, dotenvProblems, credentialProblem } from '../src/config.mjs';
import { BASE_ENV } from './helpers.mjs';
import { explainDbError } from '../src/schema.mjs';

test('missing required settings are named, one line each', () => {
  const { problems } = parseConfig({});
  assert.deepEqual(problems.map((p) => p.key).sort(), [...REQUIRED].sort());
  assert.ok(problems.every((p) => p.message === 'is not set'));
});

test('problems never carry the value', () => {
  const { problems } = parseConfig({ ...BASE_ENV, META_AD_ACCOUNT_ID: 'secret-looking-123', TARGET_COST_PER_RESULT: 'abc-secret', REPORT_TIME: '25:99' });
  assert.deepEqual(problems.map((p) => p.key).sort(), ['META_AD_ACCOUNT_ID', 'REPORT_TIME', 'TARGET_COST_PER_RESULT']);
  for (const p of problems) assert.ok(!p.message.includes('secret'), p.message);
});

test('values are normalized and defaults filled', () => {
  const { config, problems } = parseConfig({ ...BASE_ENV, META_AD_ACCOUNT_ID: '987', TARGET_COST_PER_RESULT: '$1,250', CAMPAIGN_ALLOWLIST: ' 1, 2 ,', ADMIN_SLACK_USER_IDS: 'U1,U2', INTERNAL_SCHEDULER: 'false', REPORT_TIME: '7:05' });
  assert.equal(problems.length, 0);
  assert.equal(config.META_AD_ACCOUNT_ID, 'act_987');
  assert.equal(config.TARGET_COST_PER_RESULT, 1250);
  assert.deepEqual(config.CAMPAIGN_ALLOWLIST, ['1', '2']);
  assert.deepEqual(config.ADMIN_SLACK_USER_IDS, ['U1', 'U2']);
  assert.equal(config.INTERNAL_SCHEDULER, false);
  assert.deepEqual(config.REPORT_TIME, { h: 7, m: 5, text: '07:05' });
  assert.equal(config.MODEL, 'claude-opus-5-5');
  assert.equal(config.MODEL_EFFORT, 'high');
  assert.equal(config.MODERATION_ACTION, 'hide');
  assert.deepEqual(config.OPTIMIZER_TIME, { h: 8, m: 45, text: '08:45' });
});

test('moderation action only accepts hide, delete or flag', () => {
  assert.equal(parseConfig({ ...BASE_ENV, MODERATION_ACTION: 'delete' }).config.MODERATION_ACTION, 'delete');
  assert.ok(parseConfig({ ...BASE_ENV, MODERATION_ACTION: 'nuke' }).problems.some((p) => p.key === 'MODERATION_ACTION'));
});

test('target and ceiling are optional at boot', () => {
  const { problems, config } = parseConfig({ ...BASE_ENV, TARGET_COST_PER_RESULT: '', MAX_DAILY_BUDGET: '' });
  assert.equal(problems.length, 0);
  assert.equal(config.TARGET_COST_PER_RESULT, undefined);
  assert.equal(config.MAX_DAILY_BUDGET, undefined);
});

const tok = (a, b) => [a, b].join('');   // token-shaped strings are built at run time

const BOT = tok('xo', 'xb-1-2-abc'), APP = tok('xa', 'pp-1-abc'), USER_TOKEN = tok('xo', 'xp-1-2-abc');

const keys = (env) => parseConfig({ ...BASE_ENV, ...env }).problems.map((p) => p.key);

const msg = (env, key) => parseConfig({ ...BASE_ENV, ...env }).problems.find((p) => p.key === key)?.message || '';

test('swapped or wrong Slack tokens are named for what they look like', () => {
  assert.match(msg({ SLACK_BOT_TOKEN: APP }, 'SLACK_BOT_TOKEN'), /app level token.*SLACK_APP_TOKEN/);
  assert.match(msg({ SLACK_APP_TOKEN: BOT }, 'SLACK_APP_TOKEN'), /bot token.*SLACK_BOT_TOKEN/);
  assert.match(msg({ SLACK_BOT_TOKEN: USER_TOKEN }, 'SLACK_BOT_TOKEN'), /user token/);
  assert.deepEqual(keys({ SLACK_BOT_TOKEN: BOT, SLACK_APP_TOKEN: APP }), []);
});

test('a channel name, member names and bad ids are caught before anything connects', () => {
  assert.match(msg({ SLACK_CHANNEL: '#ads' }, 'SLACK_CHANNEL'), /channel name/);
  assert.match(msg({ SLACK_CHANNEL: 'ads-team' }, 'SLACK_CHANNEL'), /channel name/);
  assert.match(msg({ ADMIN_SLACK_USER_IDS: 'U123,@dana' }, 'ADMIN_SLACK_USER_IDS'), /1 entry that is not a member id/);
  assert.match(msg({ CAMPAIGN_ALLOWLIST: '123, Spring sale' }, 'CAMPAIGN_ALLOWLIST'), /campaign ids/);
  assert.match(msg({ META_PAGE_ID: 'my-page' }, 'META_PAGE_ID'), /Page id/);
  assert.match(msg({ META_AD_ACCOUNT_ID: 'act_' }, 'META_AD_ACCOUNT_ID'), /act_1234567890/);
});

test('time zones and true or false settings are checked, not guessed', () => {
  assert.match(msg({ TIMEZONE: 'Mars/Base' }, 'TIMEZONE'), /time zone name/);
  assert.deepEqual(keys({ TIMEZONE: 'Europe/Lisbon' }), []);
  assert.match(msg({ INTERNAL_SCHEDULER: 'ture' }, 'INTERNAL_SCHEDULER'), /must be true or false; write true/);
  assert.match(msg({ INTERNAL_SCHEDULER: 'flase' }, 'INTERNAL_SCHEDULER'), /write false/);
  // only true or false, in any case: off, yes and 1 are refused with the spelling to use
  assert.match(msg({ MODERATION_ENABLED: 'off' }, 'MODERATION_ENABLED'), /must be true or false; write false/);
  assert.match(msg({ WEB_RESEARCH_ENABLED: 'YES' }, 'WEB_RESEARCH_ENABLED'), /write true/);
  assert.match(msg({ OPTIMIZER_ENABLED: '1' }, 'OPTIMIZER_ENABLED'), /write true/);
  assert.equal(msg({ OPTIMIZER_ENABLED: 'maybe' }, 'OPTIMIZER_ENABLED'), 'must be true or false');
  assert.equal(parseConfig({ ...BASE_ENV, OPTIMIZER_ENABLED: 'False' }).config.OPTIMIZER_ENABLED, false);
  assert.equal(parseConfig({ ...BASE_ENV, REPORT_ENABLED: 'TRUE' }).config.REPORT_ENABLED, true);
});

test('the Graph API version is written any of three ways and stored one way; the default is v27.0', () => {
  for (const v of ['27', 'v27', 'v27.0', 'V27.0']) assert.equal(parseConfig({ ...BASE_ENV, META_API_VERSION: v }).config.META_API_VERSION, 'v27.0', v);
  assert.equal(parseConfig({ ...BASE_ENV }).config.META_API_VERSION, 'v27.0');
  assert.match(msg({ META_API_VERSION: 'latest' }, 'META_API_VERSION'), /like v27\.0/);
});

test('word settings take any case, and amounts take a currency sign but not a decimal comma', () => {
  const { config } = parseConfig({ ...BASE_ENV, DATABASE_SSL: 'Require', MODERATION_ACTION: 'FLAG', TARGET_COST_PER_RESULT: '$1,250.50' });
  assert.equal(config.DATABASE_SSL, 'require');
  assert.equal(config.MODERATION_ACTION, 'flag');
  assert.equal(config.TARGET_COST_PER_RESULT, 1250.5);
  assert.match(msg({ MAX_DAILY_BUDGET: '12,5' }, 'MAX_DAILY_BUDGET'), /decimal point/);
});

test('a Slack channel link names the channel id in it', () => {
  assert.match(msg({ SLACK_CHANNEL: 'https://northfield.slack.com/archives/C07AB12CD' }, 'SLACK_CHANNEL'), /channel link; the channel id in it is C07AB12CD, so write SLACK_CHANNEL=C07AB12CD/);
  assert.match(msg({ SLACK_CHANNEL: 'https://app.slack.com/client/T01ABCDEF/C07AB12CD' }, 'SLACK_CHANNEL'), /C07AB12CD/);
  assert.match(msg({ SLACK_CHANNEL: 'https://northfield.slack.com/archives/' }, 'SLACK_CHANNEL'), /channel name/);
});

test('a database URL with an unencoded password says to encode it, without the value', () => {
  const m = msg({ DATABASE_URL: 'postgres://agent:pa#ss/word@db.example.com:5432/ads' }, 'DATABASE_URL');
  assert.match(m, /URL-encode/);
  assert.ok(!m.includes('pa#ss'));
  assert.match(msg({ DATABASE_URL: 'mysql://a:b@h/d' }, 'DATABASE_URL'), /postgres:\/\//);
  assert.deepEqual(keys({ DATABASE_URL: 'postgres://agent:pa%23ss@db.example.com:5432/ads' }), []);
});

test('a value cut short by a # in .env is named, instead of "is not set"', () => {
  const text = 'SLACK_CHANNEL=#ads\nRESULT_LABEL=test rides # our word for it\nDATABASE_URL=postgres://agent:p#ss@localhost/agent\n';
  const env = { ...BASE_ENV, SLACK_CHANNEL: '', RESULT_LABEL: 'test rides', DATABASE_URL: 'postgres://agent:p' };
  const found = dotenvProblems(text, env);
  assert.deepEqual(Object.keys(found).sort(), ['DATABASE_URL', 'SLACK_CHANNEL'], 'a # after a space is a real comment');
  const problems = parseConfig(env, { dotenv: text }).problems;
  const ch = problems.find((p) => p.key === 'SLACK_CHANNEL');
  assert.match(ch.message, /# in \.env.*starts a comment/);
  assert.ok(!problems.some((p) => p.message === 'is not set'));
  assert.match(problems.find((p) => p.key === 'DATABASE_URL').message, /%23/);
  // a real environment variable wins over .env, so nothing is reported for it
  assert.deepEqual(dotenvProblems(text, { ...env, SLACK_CHANNEL: 'C0123' }).SLACK_CHANNEL, undefined);
});

test('every character that breaks a connection string is caught, and the message never repeats it', () => {
  for (const ch of ['@', ':', '/', '?', '#', '[', ']', '%', ' ']) {
    const pw = `se${ch}cret9`;
    const m = credentialProblem(`postgres://agent:${pw}@db.example.com:5432/agent`);
    assert.match(m || '', /password with a character that breaks the URL/, `"${ch}"`);
    assert.ok(!m.includes(pw));
    const encoded = `postgres://agent:${encodeURIComponent(pw)}@db.example.com:5432/agent`;
    assert.equal(credentialProblem(encoded), null, `"${ch}" encoded`);
    assert.deepEqual(parseConfig({ ...BASE_ENV, DATABASE_URL: encoded }).problems, []);
  }
  const msg = parseConfig({ ...BASE_ENV, DATABASE_URL: 'postgres://agent:p@ss#w/rd:1@db.example.com:5432/agent' }).problems.find((p) => p.key === 'DATABASE_URL').message;
  assert.match(msg, /@ is %40, : is %3A, \/ is %2F, \? is %3F, # is %23/);
  assert.match(explainDbError(Object.assign(new Error('getaddrinfo ENOTFOUND ss'), { code: 'ENOTFOUND' })), /^the host name in DATABASE_URL was not found\. Check the host; when the password has a special character that is not URL-encoded, part of the password is read as the host/);
});

test('MODEL_EFFORT takes every level claude-opus-5-5 accepts, and nothing else', () => {
  for (const e of ['low', 'medium', 'high', 'xhigh', 'max', 'XHIGH']) assert.deepEqual(parseConfig({ ...BASE_ENV, MODEL_EFFORT: e }).problems, [], e);
  assert.equal(parseConfig({ ...BASE_ENV, MODEL_EFFORT: 'Max' }).config.MODEL_EFFORT, 'max');
  assert.match(parseConfig({ ...BASE_ENV, MODEL_EFFORT: 'extreme' }).problems[0].message, /low, medium, high, xhigh, max/);
});
