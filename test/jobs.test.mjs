import test from 'node:test';
import assert from 'node:assert/strict';
import { runJob, beat, postOnce, setAlerter, incident, resolveIncident, openIncidents } from '../src/jobs.mjs';
import { setRuntime } from '../src/runtime.mjs';
import { setup } from './helpers.mjs';
import { fakeAccount } from './account-fake.mjs';

test('a job runs once per slot', async () => {
  setup();
  let n = 0;
  const work = async () => { n++; return { summary: 'did it' }; };
  assert.equal((await runJob('report', '2026-11-18', work)).summary, 'did it');
  const again = await runJob('report', '2026-11-18', work);
  assert.equal(again.jobSkipped, true);
  assert.equal(again.status, 'ok');
  await runJob('report', '2026-11-19', work);
  assert.equal(n, 2);
});

test('a failed slot can run again; a held result is stored as held', async () => {
  const { db } = setup();
  await assert.rejects(() => runJob('optimizer', 's1', async () => { throw new Error('Meta down'); }));
  assert.equal(db.tables.job_runs[0].status, 'failed');
  await runJob('optimizer', 's1', async () => ({ held: true, summary: 'no target' }));
  assert.equal(db.tables.job_runs[0].status, 'held');
});

test('a claim that went stale is released', async () => {
  const { db } = setup({}, { seed: { job_runs: [{ name: 'weekly', slot: 'w1', status: 'running', started_at: new Date(Date.now() - 3 * 3600_000).toISOString() }] } });
  const first = await runJob('weekly', 'w1', async () => ({ summary: 'x' }));
  assert.equal(first.jobSkipped, true);
  assert.equal(db.tables.job_runs[0].status, 'failed');
  assert.equal((await runJob('weekly', 'w1', async () => ({ summary: 'ran' }))).summary, 'ran');
});

test('three failures in a row open one incident; a success resolves it', async () => {
  setup();
  const posts = [];
  setAlerter(async (t) => { posts.push(t); });
  for (let i = 0; i < 4; i++) await beat('moderation', { ok: false, error: new Error('boom') });
  assert.equal(posts.length, 1);
  assert.match(posts[0], /failed 3 times/);
  assert.equal((await openIncidents()).length, 1);
  await beat('moderation', { ok: true });
  assert.equal((await openIncidents()).length, 0);
  assert.match(posts[1], /Resolved/);
  setAlerter(null);
});

test('an incident is posted once while it stays open', async () => {
  setup();
  const posts = [];
  setAlerter(async (t) => { posts.push(t); });
  await incident({ key: 'k', text: 'token expired' });
  await incident({ key: 'k', text: 'token expired' });
  assert.equal(posts.length, 1);
  await resolveIncident('k');
  await incident({ key: 'k', text: 'token expired' });
  assert.equal(posts.length, 3);
  setAlerter(null);
});

test('postOnce holds a repeat inside the window', async () => {
  setup();
  let now = new Date('2026-11-18T10:00:00Z');
  setRuntime({ now: () => now });
  assert.equal(await postOnce('x', 4), true);
  assert.equal(await postOnce('x', 4), false);
  now = new Date('2026-11-18T15:00:00Z');
  assert.equal(await postOnce('x', 4), true);
});

test('the daily report counts yesterday once per ad and matches the account total', async () => {
  setup();
  fakeAccount();
  const { reportNumbers } = await import('../src/report.mjs');
  const n = await reportNumbers();
  assert.equal(n.yesterday.spend, 120);
  assert.equal(n.yesterday.results, 2);
  assert.deepEqual(n.best.map((a) => a.name), ['Winner']);
  assert.deepEqual(n.worst.map((a) => [a.name, a.spend]), [['Loser', 60]]);
  assert.equal(n.week.spend, 840);
});
