// The server: a small health endpoint, Slack in Socket Mode, and the scheduled jobs.
//   npm start
import http from 'node:http';
import { getConfig } from './config.mjs';
import { healthHttp, SOCKET_EVENTS } from './health.mjs';
import { isReconnectNoise, slackStartProblem } from './slack/problems.mjs';

const state = { slack: 'starting', started_at: new Date().toISOString() };
const line = (e) => String(e?.message || e).split('\n')[0].slice(0, 300);

// While the Socket Mode connection is being replaced, a send or an ack can fail outside any
// handler; the client reconnects on its own, so these are logged and the process keeps running
// (see slack/problems.mjs). Anything else stops the process with one plain line, so a
// supervisor restarts it. DEBUG=1 prints the full stack as well.
const fatal = (kind) => (e) => {
  if (isReconnectNoise(e)) { console.warn('[slack] reconnecting:', line(e).slice(0, 120)); return; }
  console.error(`[fatal] ${kind}: ${line(e)}`);
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
};
process.on('unhandledRejection', fatal('unhandled rejection'));
process.on('uncaughtException', fatal('uncaught exception'));

const stop = (msg, hint = 'Run `npm run check` to see what needs attention.') => {
  console.error(msg);
  if (hint) console.error(hint);
  process.exit(1);
};

let cfg;
try { cfg = getConfig(); }
catch (e) { stop(String(e?.message || e)); }

// ── health, first, so a platform's health check sees the process while Slack connects ──
// See health.mjs for the states and what the secret header adds.
let jobsModule = null;
http.createServer(async (req, res) => {
  const r = await healthHttp({ method: req.method, url: req.url, state, secret: cfg.HEALTH_SECRET, header: req.headers['x-health-secret'], jobs: jobsModule });
  res.writeHead(r.status, { 'Content-Type': r.type });
  res.end(req.method === 'HEAD' ? undefined : r.body);
}).on('error', (e) => console.warn(`[health] not listening on ${cfg.PORT} (${e.code}); continuing without it`))
  .listen(cfg.PORT, () => console.log(`[health] listening on ${cfg.PORT}`));

// ── database, tables, the ad account ──
const { boot } = await import('./boot.mjs');
try { await boot(); }
catch (e) { stop(String(e?.message || e)); }
jobsModule = await import('./jobs.mjs');

const { recoverWrites } = await import('./write-journal.mjs');
const { graph } = await import('./meta.mjs');
const recovered = await recoverWrites({ graph }).catch((e) => { console.error('[journal] recovery failed:', line(e).slice(0, 160)); return []; });
for (const r of recovered) console.log(`[journal] write #${r.id}: ${r.resolved ? r.state : `still ${r.state}; writes are held until an operator clears it`}`);

// ── Slack ──
// Both tokens are tried first, so a wrong one gives one plain line instead of a stack trace.
// A refusal (an error code from Slack) and no answer at all (no network, DNS, a proxy) are
// different problems with different fixes.
const { WebClient } = await import('@slack/web-api');
try { await new WebClient(cfg.SLACK_BOT_TOKEN, { retryConfig: { retries: 1 }, logLevel: 'error' }).auth.test(); }
catch (e) { stop(slackStartProblem(e, 'bot')); }
try { await new WebClient(cfg.SLACK_APP_TOKEN, { retryConfig: { retries: 1 }, logLevel: 'error' }).apps.connections.open(); }
catch (e) { stop(slackStartProblem(e, 'app')); }

const { createSlackApp } = await import('./slack/app.mjs');
let app, socket;
try { ({ app, socket } = await createSlackApp()); }
catch (e) { stop(slackStartProblem(e, 'connect')); }
for (const [event, s] of Object.entries(SOCKET_EVENTS)) {
  socket?.on?.(event, () => { state.slack = s; if (event !== 'connecting') console.log(`[slack] ${event}`); });
}
state.slack = 'connecting';
try { await app.start(); }
catch (e) { stop(slackStartProblem(e, 'connect')); }
state.slack = 'connected';
console.log('[slack] connected (Socket Mode)');

const { startScheduler } = await import('./scheduler.mjs');
startScheduler();
