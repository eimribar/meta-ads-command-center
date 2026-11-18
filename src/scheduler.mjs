// In-process timers for the scheduled jobs. Turn them off with INTERNAL_SCHEDULER=false and run
// `npm run job -- <name>` from your own scheduler instead (see docs/INSTALL.md).
import { getConfig } from './config.mjs';
import { nextDaily, nextWeekly, passedToday, timezone } from './clock.mjs';
import { runNamedJob } from './scheduled.mjs';
import { rt } from './runtime.mjs';

const timers = [];
const MAX_TIMEOUT = 2 ** 31 - 1;

function at(when, fn) {
  const ms = Math.max(1000, when - rt.now());
  // setTimeout caps at about 24.8 days; re-arm for longer waits
  const t = setTimeout(() => (ms > MAX_TIMEOUT ? at(when, fn) : fn()), Math.min(ms, MAX_TIMEOUT));
  timers.push(t);
}

const run = (name) => runNamedJob(name).then((r) => {
  if (r?.jobSkipped) console.log(`[scheduler] ${name}: already ${r.status} for this slot`);
  else console.log(`[scheduler] ${name}: ${r?.summary || 'done'}`);
}).catch((e) => console.error(`[scheduler] ${name} failed:`, String(e?.message || e).slice(0, 240)));

function daily(name, time) {
  const loop = () => at(nextDaily(time), async () => { await run(name); loop(); });
  loop();
  // A process started after today's time still runs today's job (the claim stops a repeat).
  if (passedToday(time)) setTimeout(() => run(name), 15_000);
  console.log(`[scheduler] ${name} daily at ${time.text} ${timezone()}, next ${nextDaily(time).toISOString()}`);
}

function every(name, minutes) {
  const ms = minutes * 60_000;
  const first = ms - (rt.now().getTime() % ms) + 5_000;
  const t = setTimeout(() => { run(name); const i = setInterval(() => run(name), ms); timers.push(i); }, first);
  timers.push(t);
  console.log(`[scheduler] ${name} every ${minutes} minutes`);
}

function weekly(name, day, time) {
  const loop = () => at(nextWeekly(day, time), async () => { await run(name); loop(); });
  loop();
  console.log(`[scheduler] ${name} on ${day} at ${time.text} ${timezone()}`);
}

export function startScheduler() {
  const cfg = getConfig();
  if (!cfg.INTERNAL_SCHEDULER) { console.log('[scheduler] internal timers are off (INTERNAL_SCHEDULER=false); run jobs from your own scheduler'); return; }
  if (cfg.REPORT_ENABLED) daily('report', cfg.REPORT_TIME);
  if (cfg.OPTIMIZER_ENABLED) {
    daily('optimizer', cfg.OPTIMIZER_TIME);
    if (cfg.OPTIMIZER_EVERY_HOURS > 0) every('optimizer-check', cfg.OPTIMIZER_EVERY_HOURS * 60);
  }
  if (cfg.MODERATION_ENABLED) every('moderation', cfg.MODERATION_EVERY_MINUTES);
  weekly('weekly', cfg.WEEKLY_DAY, cfg.REPORT_TIME);
}

export function stopScheduler() { for (const t of timers.splice(0)) { clearTimeout(t); clearInterval(t); } }
