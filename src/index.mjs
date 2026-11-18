// The server: a small health endpoint, Slack in Socket Mode, and the scheduled jobs.
//   npm start
import http from 'node:http';
import { getConfig } from './config.mjs';
import { healthHttp, SOCKET_EVENTS } from './health.mjs';

const state = { slack: 'starting', started_at: new Date().toISOString() };
const line = (e) => String(e?.message || e).split('\n')[0].slice(0, 300);

// A Socket Mode reconnect race can throw outside any handler; it is harmless, so it is logged
// and the process keeps running. Anything else stops the process with one plain line, so a
// supervisor restarts it. DEBUG=1 prints the full stack as well.
const BENIGN = /server explicit disconnect|Unhandled event .* in state|socket hang up/i;
const fatal = (kind) => (e) => {
  if (BENIGN.test(String(e?.message || e))) { console.warn('[slack] reconnect noise:', line(e).slice(0, 120)); return; }
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
const { WebClient } = await import('@slack/web-api');
const slackErr = (e) => e?.data?.error || line(e);
try { await new WebClient(cfg.SLACK_BOT_TOKEN, { retryConfig: { retries: 1 }, logLevel: 'error' }).auth.test(); }
catch (e) { stop(`[slack] Slack refused the bot token (${slackErr(e)}). Check SLACK_BOT_TOKEN: the Bot User OAuth Token (xoxb-) from OAuth & Permissions.`); }
try { await new WebClient(cfg.SLACK_APP_TOKEN, { retryConfig: { retries: 1 }, logLevel: 'error' }).apps.connections.open(); }
catch (e) { stop(`[slack] Slack refused the app level token (${slackErr(e)}). Check SLACK_APP_TOKEN: an App-Level Token (xapp-) with connections:write, and Socket Mode turned on.`); }

const { createSlackApp } = await import('./slack/app.mjs');
const { app, socket } = await createSlackApp();
for (const [event, s] of Object.entries(SOCKET_EVENTS)) {
  socket?.on?.(event, () => { state.slack = s; if (event !== 'connecting') console.log(`[slack] ${event}`); });
}
state.slack = 'connecting';
try { await app.start(); }
catch (e) { stop(`[slack] could not connect: ${slackErr(e)}.`); }
state.slack = 'connected';
console.log('[slack] connected (Socket Mode)');

const { startScheduler } = await import('./scheduler.mjs');
startScheduler();
