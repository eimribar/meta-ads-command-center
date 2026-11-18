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
  assert.equal(r.body, 'ok\nslack: starting\n');
  r = await healthResponse({ state, secret: 's3cret', header: 'wrong', jobs: null });
  assert.equal(r.type, 'text/plain');
  r = await healthResponse({ state, secret: 's3cret', header: 's3cret', jobs: null });
  assert.equal(r.type, 'application/json', 'JSON before the database is up, too');
  assert.deepEqual(JSON.parse(r.body), { ok: true, slack: 'starting', started_at: state.started_at, jobs: null, incidents: null });
  const jobs = { loopHealth: async () => [{ loop: 'report', consecutive_failures: 0 }], openIncidents: async () => [{ key: 'k', text: 'Meta refused the token', opened_at: 't' }] };
  r = await healthResponse({ state: { ...state, slack: 'connected' }, secret: 's3cret', header: 's3cret', jobs });
  const j = JSON.parse(r.body);
  assert.equal(j.slack, 'connected');
  assert.equal(j.jobs[0].loop, 'report');
  assert.deepEqual(j.incidents, [{ key: 'k', text: 'Meta refused the token', since: 't' }]);
  r = await healthResponse({ state, secret: undefined, header: '', jobs });
  assert.equal(r.type, 'text/plain', 'no secret set: never JSON');
  for (const s of Object.values(SOCKET_EVENTS)) assert.ok(SLACK_STATES.includes(s), s);
  const install = read('docs/INSTALL.md');
  for (const s of SLACK_STATES) assert.match(install, new RegExp(`\\| \`${s}\` \\|`), `INSTALL.md documents ${s}`);
});

test('only GET /health is served; any other path is 404', async () => {
  const base = { state: { slack: 'connected', started_at: 't' }, secret: undefined, header: undefined, jobs: null };
  for (const url of ['/health', '/health/', '/health?probe=1']) {
    const r = await healthHttp({ ...base, method: 'GET', url });
    assert.equal(r.status, 200, url);
    assert.equal(r.body, 'ok\nslack: connected\n');
  }
  assert.equal((await healthHttp({ ...base, method: 'HEAD', url: '/health' })).status, 200);
  for (const url of ['/', '/other', '/healthz', '/health/x']) assert.equal((await healthHttp({ ...base, method: 'GET', url })).status, 404, url);
  assert.equal((await healthHttp({ ...base, method: 'POST', url: '/health' })).status, 405);
});
