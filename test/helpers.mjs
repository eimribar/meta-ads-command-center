// Fakes for the tests: settings with placeholder values, an in-memory database, a fake Meta
// Graph API and a scripted Claude. No keys, no network, no database server.
import { parseConfig, setConfig } from '../src/config.mjs';
import { setRuntime } from '../src/runtime.mjs';
import { createMemoryDb } from '../src/db.mjs';
import { setPolicy } from '../src/optimizer/policy.mjs';
import { resetMetaCaches } from '../src/meta.mjs';
import { clearBrainCache } from '../src/brain.mjs';
import { setCurrency } from '../src/money.mjs';
import { TABLES } from '../src/schema.mjs';

export const BASE_ENV = {
  META_ACCESS_TOKEN: 'test-meta-token',
  META_AD_ACCOUNT_ID: 'act_111',
  META_PAGE_ID: '222',
  RESULT_EVENT: 'Schedule',
  RESULT_LABEL: 'test rides',
  SECONDARY_EVENT: 'Lead',
  SECONDARY_LABEL: 'leads',
  TARGET_COST_PER_RESULT: '150',
  MAX_DAILY_BUDGET: '500',
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_APP_TOKEN: 'xapp-test',
  SLACK_CHANNEL: 'CTEST',
  ADMIN_SLACK_USER_IDS: 'UOPERATOR',
  DATABASE_URL: 'postgres://test',
  TIMEZONE: 'UTC',
};

export function setup(env = {}, { seed = {} } = {}) {
  const { config, problems } = parseConfig({ ...BASE_ENV, ...env });
  if (problems.length) throw new Error(`test config: ${problems.map((p) => p.key).join(', ')}`);
  setConfig(config);
  setPolicy(null);
  resetMetaCaches();
  clearBrainCache();
  const db = createMemoryDb(seed);
  setCurrency('USD');
  setRuntime({ db, slack: null, anthropic: null, fetch: () => { throw new Error('no network in tests'); }, now: () => new Date() });
  return { db, config };
}

// A Postgres that answers the queries the check, db:setup and boot send about the tables:
// tables (names present), owner (their owner), user (who is connected), canUse (privileges),
// canCreate (may create tables in the schema), brainTarget (the policy/target row, or undefined).
export function fakePg({ tables = TABLES, owner = 'agent', user = 'agent', canUse = true, canCreate = true, brainTarget, sslMode = 'require', onApply = null } = {}) {
  const sent = [];
  return {
    sslMode,
    sent,
    query: async (sql) => {
      sent.push(sql);
      if (/select current_user/.test(sql)) return [{ me: user, can_create: canCreate }];
      if (/from pg_class/.test(sql)) return tables.map((name) => ({ name, owner, can_use: canUse }));
      if (/from brain where/.test(sql)) return brainTarget === undefined ? [] : [{ content: brainTarget }];
      if (/create table if not exists/i.test(sql)) { if (onApply) return onApply(); return []; }
      throw new Error(`fakePg: unexpected query ${sql.slice(0, 60)}`);
    },
    close: async () => {},
  };
}

// handler({ method, path, params }) returns the JSON body (or throws to simulate a network error).
export function fakeGraph(handler) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    const path = u.pathname.replace(/^\/v[\d.]+\//, '');
    const params = Object.fromEntries(method === 'GET' || method === 'DELETE' ? u.searchParams : new URLSearchParams(String(opts.body || '')));
    delete params.access_token;
    calls.push({ method, path, params });
    const body = await handler({ method, path, params });
    return { ok: true, status: 200, json: async () => body };
  };
  setRuntime({ fetch });
  return calls;
}

// A scripted Claude: each call gets the next response from `script` (a message or a function of
// the request body).
export function fakeClaude(script) {
  const requests = [];
  let i = 0;
  const client = {
    messages: {
      stream: (body) => ({
        finalMessage: async () => {
          requests.push(structuredClone(body));
          const step = script[Math.min(i++, script.length - 1)];
          const msg = typeof step === 'function' ? step(body) : step;
          return { model: 'fake', usage: {}, stop_reason: 'end_turn', ...msg };
        },
      }),
    },
  };
  setRuntime({ anthropic: client });
  return requests;
}

export const text = (t) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' });
export const toolUse = (id, name, input, extra = []) => ({ content: [...extra, { type: 'tool_use', id, name, input }], stop_reason: 'tool_use' });
