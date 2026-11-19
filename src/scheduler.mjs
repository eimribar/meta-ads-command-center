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

// Every N minutes on the clock in UTC (an hourly job runs just after each full UTC hour), so
// every copy of the process lands on the same slot and the claim runs it once.
function every(name, minutes) {
  const ms = minutes * 60_000;
  const first = ms - (rt.now().getTime() % ms) + 5_000;
  const t = setTimeout(() => { run(name); const i = setInterval(() => run(name), ms); timers.push(i); }, first);
  timers.push(t);
  console.log(`[scheduler] ${name} every ${minutes} minutes (on the UTC clock)`);
}

function weekly(name, day, time) {
  const loop = () => at(nextWeekly(day, time), async () => { await run(name); loop(); });
  loop();
  console.log(`[scheduler] ${name} on ${day} at ${time.text} ${timezone()}`);
}

// Which timers a set of settings starts: [{ name, kind: daily | every | weekly, ... }], plus the
// notes printed for what is off.
export function timerPlan(cfg) {
  const plan = [], notes = [];
  if (!cfg.INTERNAL_SCHEDULER) return { plan, notes: ['internal timers are off (INTERNAL_SCHEDULER=false); run jobs from your own scheduler'] };
  if (cfg.REPORT_ENABLED) plan.push({ name: 'report', kind: 'daily', time: cfg.REPORT_TIME });
  if (cfg.OPTIMIZER_ENABLED) {
    plan.push({ name: 'optimizer', kind: 'daily', time: cfg.OPTIMIZER_TIME });
    if (cfg.OPTIMIZER_EVERY_HOURS > 0) plan.push({ name: 'optimizer-check', kind: 'every', minutes: cfg.OPTIMIZER_EVERY_HOURS * 60 });
  }
  // The comment sweep needs a Page to read; without META_PAGE_ID there is no timer for it.
  if (cfg.MODERATION_ENABLED && cfg.META_PAGE_ID) plan.push({ name: 'moderation', kind: 'every', minutes: cfg.MODERATION_EVERY_MINUTES });
  else if (cfg.MODERATION_ENABLED) notes.push('moderation: no timer (META_PAGE_ID is not set)');
  // The weekly review runs even when REPORT_ENABLED=false; it shares REPORT_TIME.
  plan.push({ name: 'weekly', kind: 'weekly', day: cfg.WEEKLY_DAY, time: cfg.REPORT_TIME });
  return { plan, notes };
}

export function startScheduler() {
  const { plan, notes } = timerPlan(getConfig());
  for (const n of notes) console.log(`[scheduler] ${n}`);
  for (const t of plan) {
    if (t.kind === 'daily') daily(t.name, t.time);
    else if (t.kind === 'every') every(t.name, t.minutes);
    else weekly(t.name, t.day, t.time);
  }
}

export function stopScheduler() { for (const t of timers.splice(0)) { clearTimeout(t); clearInterval(t); } }
