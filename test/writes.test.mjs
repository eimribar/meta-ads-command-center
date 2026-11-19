// Writes to Meta: what counts as an unknown outcome, throttling, scope and budget refusals, and
// the campaign copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, fakeGraph } from './helpers.mjs';
import { fakeAccount } from './account-fake.mjs';
import { graph, graphPostRaw, graphAll, throttleMinutes } from '../src/meta.mjs';
import { withExecution } from '../src/context.mjs';
import { setStatus, setBudget, duplicateCampaign } from '../src/meta-write.mjs';
import { journalWrite, clearWrite, recoverWrites } from '../src/write-journal.mjs';
import { setCurrency } from '../src/money.mjs';

const asOperator = (key, fn) => withExecution({ actor: 'UOPERATOR', kind: 'order', key }, fn);

test('a write that gets a server error has an unknown outcome and is not retried; a read is retried', async () => {
  setup();
  let posts = 0, gets = 0;
  fakeGraph(({ method }) => {
    if (method === 'POST') { posts++; return { http: { status: 502, body: '<html>Bad Gateway</html>' } }; }
    gets++;
    return gets < 2 ? { http: { status: 503, body: 'busy' } } : { id: '1' };
  });
  await assert.rejects(() => graphPostRaw('30', { status: 'PAUSED' }), (e) => e.network === true && /HTTP 502 with no clear answer/.test(e.message));
  assert.equal(posts, 1, 'a write is sent once');
  assert.deepEqual(await graph('1'), { id: '1' });
  assert.equal(gets, 2, 'a read is tried again');
  fakeGraph(({ method }) => (method === 'POST' ? { error: { code: 2, message: 'Service temporarily unavailable' } } : {}));
  await assert.rejects(() => graphPostRaw('30', { status: 'PAUSED' }), (e) => e.network === true);
  fakeGraph(() => { throw new Error('socket hang up'); });
  await assert.rejects(() => graphPostRaw('30', { status: 'PAUSED' }), (e) => e.network === true);
});

test('throttling with a known wait fails at once and says for how long', async () => {
  setup();
  let n = 0;
  fakeGraph(() => {
    n++;
    return { http: { status: 400, headers: { 'X-Business-Use-Case-Usage': JSON.stringify({ 111: [{ type: 'ads_management', estimated_time_to_regain_access: 12 }] }) }, body: { error: { code: 80004, message: 'too many calls' } } } };
  });
  await assert.rejects(() => graph('act_111/ads'), (e) => e.throttledMinutes === 12 && /Meta is throttling this for 12 minutes/.test(e.message));
  assert.equal(n, 1, 'no retry while the wait is known');
  for (const code of [80001, 80002, 80005, 80006]) {
    fakeGraph(() => ({ http: { status: 400, headers: { 'x-ad-account-usage': JSON.stringify({ reset_time_duration: 90 }) }, body: { error: { code, message: 'limit' } } } }));
    await assert.rejects(() => graph('x'), (e) => e.throttledMinutes === 2, String(code));
  }
  assert.equal(throttleMinutes({ get: () => 'not json' }), 0);
});

test('a write whose outcome is unknown holds later writes until it is cleared, and settles the card waiting on it', async () => {
  const { db } = setup({}, { seed: { actions_log: [{ run_date: '2026-11-18', action_type: 'pause_ad', target_id: '30', decision_key: 'pause:30', disposition: 'unknown', applied: false, applied_by: 'UOPERATOR', journal_id: 1 }] } });
  const ops = (n) => ({ operations: [{ node: n, body: { status: 'PAUSED' } }], dispatch: async () => { throw Object.assign(new Error('no answer'), { network: true }); } });
  await assert.rejects(() => asOperator('k1', () => journalWrite(ops('30'))), (e) => e.unknown === true && e.journalId === 1);
  await assert.rejects(() => asOperator('k2', () => journalWrite({ ...ops('31'), dispatch: async () => ({ ok: true }) })), /on hold: write #1/);
  const r = await clearWrite(1, 'UOPERATOR');
  assert.deepEqual(r, { ok: true, moves: 1 });
  assert.equal(db.tables.actions_log[0].disposition, 'applied_by_human');
  assert.equal(db.tables.actions_log[0].applied, true);
});

test('at start, a write seen live on Meta is reconciled, and the automatic move waiting on it counts as applied', async () => {
  const { db } = setup({}, { seed: {
    write_journal: [{ id: 5, write_key: 'w', state: 'unknown', operations: [{ node: '30', body: { status: 'PAUSED' } }], updated_at: new Date().toISOString() }],
    actions_log: [{ run_date: '2026-11-18', action_type: 'pause_ad', target_id: '30', decision_key: 'pause:30', disposition: 'unknown', applied: false, applied_by: 'optimizer', journal_id: 5 }],
  } });
  const out = await recoverWrites({ graph: async () => ({ configured_status: 'PAUSED' }) });
  assert.equal(out[0].state, 'reconciled');
  assert.equal(db.tables.actions_log[0].disposition, 'auto_applied');
});

test('budgets: an id at the wrong level, a lifetime budget and a budget set elsewhere are refused', async () => {
  setup();
  const lifetimeSet = { id: '21', name: 'Lifetime', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: null, lifetime_budget: '300000', campaign_id: '10' };
  const acct = fakeAccount({ extra: { adsets: [{ id: '20', name: 'Broad', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '10000', campaign_id: '10' }, lifetimeSet] } });
  await assert.rejects(() => asOperator('b1', () => setBudget('adset', '10', 120)), /10 is not an ad set in scope \(it is a campaign\)/);
  await assert.rejects(() => asOperator('b2', () => setBudget('adset', '21', 120)), /lifetime budget/);
  await assert.rejects(() => asOperator('b3', () => setBudget('campaign', '10', 120)), /lifetime budget|no daily budget of its own/);
  assert.equal(acct.writes().length, 0);
});

test('activating an ad set adds its budget to the ceiling check; a lifetime one is left to Ads Manager', async () => {
  setup({ MAX_DAILY_BUDGET: '150' });
  const acct = fakeAccount({ extra: { adsets: [
    { id: '20', name: 'Broad', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '10000', campaign_id: '10' },
    { id: '22', name: 'Retarget', status: 'PAUSED', effective_status: 'PAUSED', daily_budget: '8000', campaign_id: '10' },
  ] } });
  await assert.rejects(() => asOperator('a1', () => setStatus('adset', '22', 'ACTIVE')), /daily ceiling/);
  await assert.rejects(() => withExecution({ actor: null, kind: 'scheduled', key: 'a2' }, () => setStatus('adset', '22', 'ACTIVE')), /needs an operator/);
  assert.equal(acct.writes().length, 0);
});

test('a budget is never read or written while the currency is unknown', async () => {
  setup();
  setCurrency(null);
  fakeGraph(() => ({ error: { code: 100, message: 'unreadable' } }));
  await assert.rejects(() => asOperator('c1', () => setBudget('adset', '20', 120)), /currency could not be read/);
  setCurrency('USD');
});

test('a read a money decision depends on refuses to stop at its cap', async () => {
  setup();
  fakeGraph(({ params }) => ({ data: [{ id: String(params.after || 1) }], paging: { next: 'https://graph.facebook.com/v27.0/act_111/ads?after=2' } }));
  const some = await graphAll('act_111/ads', {}, 2);
  assert.equal(some.truncated, true);
  await assert.rejects(() => graphAll('act_111/ads', {}, 2, { complete: true }), /more than 2 ads to read/);
});

test('a copy carries the budget sharing flag and the DSA fields, and two ads with one body are two writes', async () => {
  setup();
  const posts = [];
  let id = 900;
  fakeGraph(({ method, path, params }) => {
    if (method === 'GET' && path === '10') return { account_id: '111', name: 'Prospecting', objective: 'OUTCOME_LEADS', is_adset_budget_sharing_enabled: false, special_ad_categories: [] };
    if (method === 'GET' && path === '10/adsets') return { data: [{ id: '20', name: 'Broad', status: 'ACTIVE', daily_budget: '10000', optimization_goal: 'LEAD', billing_event: 'IMPRESSIONS', targeting: { geo_locations: { countries: ['DE'] } }, dsa_beneficiary: 'Northfield Bikes', dsa_payor: 'Northfield Bikes' }] };
    if (method === 'GET' && path === '20/ads') return { data: [{ id: '30', name: 'Same', status: 'ACTIVE', creative: { id: '77' } }, { id: '33', name: 'Same', status: 'ACTIVE', creative: { id: '77' } }] };
    if (method === 'POST') { posts.push({ path, params }); return { id: String(id++) }; }
    return { error: { code: 100, message: `no ${method} ${path}` } };
  });
  const r = await asOperator('dup1', () => duplicateCampaign({ source_campaign_id: '10' }));
  const camp = posts.find((p) => p.path === 'act_111/campaigns');
  assert.equal(camp.params.is_adset_budget_sharing_enabled, 'false');
  const set = posts.find((p) => p.path === 'act_111/adsets');
  assert.equal(set.params.dsa_beneficiary, 'Northfield Bikes');
  assert.equal(set.params.dsa_payor, 'Northfield Bikes');
  assert.equal(posts.filter((p) => p.path === 'act_111/ads').length, 2, 'both ads were created');
  assert.equal(r.adsets[0].ads.length, 2);
  assert.equal(camp.params.status, 'PAUSED');
});
