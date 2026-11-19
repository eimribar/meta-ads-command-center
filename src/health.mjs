// GET /health, the only path served (any other path is 404). Plain text for any caller: ok or
// not ok, Slack's state and the database's. With the header x-health-secret equal to
// HEALTH_SECRET: JSON with job health and open issues as well. When the database does not
// answer, the status is 503 and the body says so, so a platform health check sees it.
import { timingSafeEqual } from 'node:crypto';
import { redact } from './redact.mjs';

// Slack's state, in the order a start goes through them:
//   starting      settings, the database and the ad account are read, the Slack tokens checked
//   connecting    opening the Socket Mode connection
//   connected     working
//   reconnecting  the connection dropped and is coming back on its own
//   disconnected  the connection is closed (the process is stopping, or Slack closed it)
export const SLACK_STATES = ['starting', 'connecting', 'connected', 'reconnecting', 'disconnected'];
// Socket Mode client events, mapped onto those states.
export const SOCKET_EVENTS = { connecting: 'connecting', connected: 'connected', reconnecting: 'reconnecting', disconnecting: 'disconnected', disconnected: 'disconnected' };

export function secretMatches(secret, got) {
  if (!secret || !got) return false;
  const a = Buffer.from(String(got)), b = Buffer.from(String(secret));
  return a.length === b.length && timingSafeEqual(a, b);
}

// state: { slack, started_at }. jobs: { dbAnswers(), loopHealth(), openIncidents() } once the
// database is up, else null (the process is still starting).
export async function healthResponse({ state, secret, header, jobs }) {
  let database = 'starting', reason = null;
  if (jobs) {
    try { await jobs.dbAnswers(); database = 'ok'; }
    catch (e) { database = 'not answering'; reason = `the database is not answering: ${redact(String(e?.message || e)).slice(0, 160)}`; }
  }
  const ok = database !== 'not answering';
  const status = ok ? 200 : 503;
  if (!secretMatches(secret, header)) return { status, type: 'text/plain', body: `${ok ? 'ok' : 'not ok'}\nslack: ${state.slack}\ndatabase: ${database}\n` };
  let health = null, incidents = null;
  if (jobs && ok) {
    try {
      const [h, i] = await Promise.all([jobs.loopHealth(), jobs.openIncidents()]);
      health = h;
      incidents = i.map((x) => ({ key: x.key, text: x.text, since: x.opened_at }));
    } catch { /* left null */ }
  }
  return { status, type: 'application/json', body: JSON.stringify({ ok, ...(reason ? { reason } : {}), slack: state.slack, database, started_at: state.started_at, jobs: health, incidents }, null, 1) };
}

// The answer to any HTTP request the server gets. Only GET or HEAD /health is answered.
export async function healthHttp({ method = 'GET', url = '/', ...rest }) {
  const path = String(url).split('?')[0].replace(/\/+$/, '') || '/';
  if (path !== '/health') return { status: 404, type: 'text/plain', body: 'not found: the health check is GET /health\n' };
  if (!['GET', 'HEAD'].includes(String(method).toUpperCase())) return { status: 405, type: 'text/plain', body: 'use GET /health\n' };
  return healthResponse(rest);
}
