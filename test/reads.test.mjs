import test from 'node:test';
import assert from 'node:assert/strict';
import { videoRetention, audiences, leadForms } from '../src/meta-read.mjs';
import { setup, fakeGraph } from './helpers.mjs';

test('video retention is a share of plays per ad', async () => {
  setup();
  fakeGraph(({ path }) => (path === 'act_111/insights' ? { data: [
    { ad_id: '1', ad_name: 'Video A', spend: '50', impressions: '1000', video_play_actions: [{ action_type: 'video_view', value: '400' }], video_p25_watched_actions: [{ action_type: 'video_view', value: '200' }], video_p100_watched_actions: [{ action_type: 'video_view', value: '40' }] },
    { ad_id: '2', ad_name: 'Static', spend: '30', impressions: '900' },
  ] } : { data: [] }));
  const rows = await videoRetention(null, 7);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].p25_pct, 50);
  assert.equal(rows[0].p100_pct, 10);
});

test('audiences and lead forms read from the account and the Page', async () => {
  setup();
  const calls = fakeGraph(({ path }) => {
    if (path === 'act_111/customaudiences') return { data: [{ id: '9', name: 'Site visitors 30d', subtype: 'WEBSITE', approximate_count_lower_bound: 1000, approximate_count_upper_bound: 1200, delivery_status: { description: 'Ready' } }] };
    if (path === '222') return { access_token: 'page-token' };
    if (path === '222/leadgen_forms') return { data: [{ id: '7', name: 'Test ride form', status: 'ACTIVE', leads_count: 12 }] };
    return { data: [] };
  });
  assert.equal((await audiences())[0].size, '1000 to 1200');
  assert.equal((await leadForms())[0].leads_count, 12);
  assert.ok(calls.some((c) => c.path === '222/leadgen_forms'));
});
