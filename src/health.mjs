// GET /health, the only path served (any other path is 404). Plain text for any caller: "ok" and Slack's state. With the header
// x-health-secret equal to HEALTH_SECRET: JSON with job health and open issues as well.
import { timingSafeEqual } from 'node:crypto';

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

// state: { slack, started_at }. jobs: { loopHealth(), openIncidents() } once the database is up,
// else null (then jobs and incidents are null in the JSON).
export async function healthResponse({ state, secret, header, jobs }) {
  if (!secretMatches(secret, header)) return { type: 'text/plain', body: `ok\nslack: ${state.slack}\n` };
  let health = null, incidents = null;
  if (jobs) {
    try {
      const [h, i] = await Promise.all([jobs.loopHealth(), jobs.openIncidents()]);
      health = h;
      incidents = i.map((x) => ({ key: x.key, text: x.text, since: x.opened_at }));
    } catch { /* the database is not answering; leave them null */ }
  }
  return { type: 'application/json', body: JSON.stringify({ ok: true, slack: state.slack, started_at: state.started_at, jobs: health, incidents }, null, 1) };
}

// The answer to any HTTP request the server gets. Only GET or HEAD /health is answered.
export async function healthHttp({ method = 'GET', url = '/', ...rest }) {
  const path = String(url).split('?')[0].replace(/\/+$/, '') || '/';
  if (path !== '/health') return { status: 404, type: 'text/plain', body: 'not found: the health check is GET /health\n' };
  if (!['GET', 'HEAD'].includes(String(method).toUpperCase())) return { status: 405, type: 'text/plain', body: 'use GET /health\n' };
  return { status: 200, ...(await healthResponse(rest)) };
}
