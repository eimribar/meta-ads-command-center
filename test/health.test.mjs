// The health endpoint: its states, plain text for anyone, JSON with the secret, 404 elsewhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { healthResponse, healthHttp, SLACK_STATES, SOCKET_EVENTS } from '../src/health.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const read = (p) => readFileSync(join(root, p), 'utf8');

test('health answers every state in plain text, and JSON only with the right secret', async () => {
  const state = { slack: 'starting', started_at: '2026-11-18T10:00:00.000Z' };
  let r = await healthResponse({ state, secret: 's3cret', header: undefined, jobs: null });
  assert.equal(r.type, 'text/plain');
  assert.equal(r.status, 200);
  assert.equal(r.body, 'ok\nslack: starting\ndatabase: starting\n');
  r = await healthResponse({ state, secret: 's3cret', header: 'wrong', jobs: null });
  assert.equal(r.type, 'text/plain');
  r = await healthResponse({ state, secret: 's3cret', header: 's3cret', jobs: null });
  assert.equal(r.type, 'application/json', 'JSON before the database is up, too');
  assert.deepEqual(JSON.parse(r.body), { ok: true, slack: 'starting', database: 'starting', started_at: state.started_at, jobs: null, incidents: null });
  const jobs = { dbAnswers: async () => true, loopHealth: async () => [{ loop: 'report', consecutive_failures: 0 }], openIncidents: async () => [{ key: 'k', text: 'Meta refused the token', opened_at: 't' }] };
  r = await healthResponse({ state: { ...state, slack: 'connected' }, secret: 's3cret', header: 's3cret', jobs });
  const j = JSON.parse(r.body);
  assert.equal(j.slack, 'connected');
  assert.equal(j.database, 'ok');
  assert.equal(j.jobs[0].loop, 'report');
  assert.deepEqual(j.incidents, [{ key: 'k', text: 'Meta refused the token', since: 't' }]);
  r = await healthResponse({ state, secret: undefined, header: '', jobs });
  assert.equal(r.type, 'text/plain', 'no secret set: never JSON');
  assert.equal(r.body, 'ok\nslack: starting\ndatabase: ok\n');
  for (const s of Object.values(SOCKET_EVENTS)) assert.ok(SLACK_STATES.includes(s), s);
  const install = read('docs/INSTALL.md');
  for (const s of SLACK_STATES) assert.match(install, new RegExp(`\\| \`${s}\` \\|`), `INSTALL.md documents ${s}`);
});

test('a database that does not answer is not ok: 503, and the reason without the connection string', async () => {
  const jobs = { dbAnswers: async () => { throw new Error('connect ECONNREFUSED for postgres://agent:pw@db:5432/agent'); }, loopHealth: async () => [], openIncidents: async () => [] };
  const state = { slack: 'connected', started_at: 't' };
  let r = await healthHttp({ method: 'GET', url: '/health', state, secret: undefined, header: undefined, jobs });
  assert.equal(r.status, 503);
  assert.equal(r.body, 'not ok\nslack: connected\ndatabase: not answering\n');
  r = await healthResponse({ state, secret: 's', header: 's', jobs });
  const j = JSON.parse(r.body);
  assert.equal(j.ok, false);
  assert.match(j.reason, /the database is not answering: connect ECONNREFUSED/);
  assert.ok(!r.body.includes('pw@db'));
});

test('only GET /health is served; any other path is 404', async () => {
  const base = { state: { slack: 'connected', started_at: 't' }, secret: undefined, header: undefined, jobs: null };
  for (const url of ['/health', '/health/', '/health?probe=1']) {
    const r = await healthHttp({ ...base, method: 'GET', url });
    assert.equal(r.status, 200, url);
    assert.equal(r.body, 'ok\nslack: connected\ndatabase: starting\n');
  }
  assert.equal((await healthHttp({ ...base, method: 'HEAD', url: '/health' })).status, 200);
  for (const url of ['/', '/other', '/healthz', '/health/x']) assert.equal((await healthHttp({ ...base, method: 'GET', url })).status, 404, url);
  assert.equal((await healthHttp({ ...base, method: 'POST', url: '/health' })).status, 405);
});
