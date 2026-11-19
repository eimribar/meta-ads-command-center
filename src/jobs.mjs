// Operating machinery: one claim per job and slot (nothing runs or posts twice, even with two
// copies of the process), loop health, incidents, a repeat-post guard and the timeline.
import { rt, db } from './runtime.mjs';

const nowIso = () => rt.now().toISOString();
const STALE_MS = 2 * 3600_000;

// Run `work` once for (name, slot). Returns the work's result, or { jobSkipped, status } when the
// slot was already done or is running elsewhere. A failed slot may be tried again.
export async function runJob(name, slot, work) {
  const d = db();
  let claimed = await d.insertIgnore('job_runs', { name, slot, status: 'running', started_at: nowIso() }, ['name', 'slot']);
  if (!claimed) {
    const [row] = await d.select('job_runs', { where: { name, slot } });
    if (row?.status === 'failed') {
      [claimed] = await d.update('job_runs', { name, slot, status: 'failed' }, { status: 'running', started_at: nowIso(), error: null });
    } else if (row?.status === 'running' && rt.now() - new Date(row.started_at) > STALE_MS) {
      await d.update('job_runs', { name, slot, status: 'running' }, { status: 'failed', error: 'claim went stale (process stopped mid-run)', finished_at: nowIso() });
    }
    if (!claimed) return { jobSkipped: true, status: row?.status || 'unknown' };
  }
  try {
    const result = await work();
    const held = Boolean(result?.held);
    await d.update('job_runs', { name, slot }, {
      status: held ? 'held' : 'ok', finished_at: nowIso(),
      summary: String(result?.summary ?? '').slice(0, 500) || null,
    });
    await beat(name, { ok: true });
    return result;
  } catch (e) {
    await d.update('job_runs', { name, slot }, { status: 'failed', finished_at: nowIso(), error: String(e?.message || e).slice(0, 500) }).catch(() => {});
    await beat(name, { ok: false, error: e }).catch(() => {});
    throw e;
  }
}

// ── loop health ─────────────────────────────────────────────────────────────
let alerter = null;          // (text, { critical }) => posts to Slack; wired at boot
export function setAlerter(fn) { alerter = fn; }

export async function beat(loop, { ok = true, error = null } = {}) {
  const d = db();
  const [prev] = await d.select('loop_health', { where: { loop } }).catch(() => []);
  const fails = ok ? 0 : (prev?.consecutive_failures || 0) + 1;
  await d.upsert('loop_health', [{
    loop, updated_at: nowIso(), consecutive_failures: fails,
    ...(ok ? { last_ok_at: nowIso() } : { last_error_at: nowIso(), last_error: String(error?.message || error).slice(0, 300) }),
  }], ['loop']);
  if (ok && prev?.consecutive_failures >= 3) await resolveIncident(`loop:${loop}`);
  if (!ok && fails === 3) {
    await incident({ key: `loop:${loop}`, severity: 'warn', text: `The ${loop} job failed 3 times in a row. Last error: ${String(error?.message || error).slice(0, 160)}` });
  }
}

export async function loopHealth() {
  return db().select('loop_health', { order: 'loop' }).catch(() => []);
}

// ── incidents ───────────────────────────────────────────────────────────────
// Open (or refresh) an incident. Only a newly opened incident is posted.
export async function incident({ key, text, severity = 'warn' }) {
  const d = db();
  const [prev] = await d.select('incidents', { where: { key } }).catch(() => []);
  const isNew = !prev || prev.resolved_at;
  await d.upsert('incidents', [{
    key, text, severity, last_seen_at: nowIso(), resolved_at: null, ...(isNew ? { opened_at: nowIso() } : {}),
  }], ['key']);
  if (isNew && alerter) await alerter(`:rotating_light: ${text}`, { critical: severity === 'critical' }).catch(() => {});
  return { opened: isNew };
}

export async function resolveIncident(key, { note = null } = {}) {
  const d = db();
  const [prev] = await d.select('incidents', { where: { key } }).catch(() => []);
  if (!prev || prev.resolved_at) return { resolved: false };
  await d.update('incidents', { key }, { resolved_at: nowIso() });
  if (alerter) await alerter(`:white_check_mark: Resolved: ${prev.text.slice(0, 160)}${note ? ` (${note})` : ''}`, { critical: false }).catch(() => {});
  return { resolved: true };
}

export const openIncidents = () => db().select('incidents', { where: { resolved_at: { isNull: true } }, order: 'opened_at desc' }).catch(() => []);

// ── repeat-post guard ───────────────────────────────────────────────────────
// True when `key` was not posted in the last `hours`; records the post.
export async function postOnce(key, hours = 4) {
  const d = db();
  const k = `posted/${key}`;
  const [row] = await d.select('state', { where: { key: k } }).catch(() => []);
  const at = row?.value?.at ? new Date(row.value.at) : null;
  if (at && rt.now() - at < hours * 3600_000) return false;
  await d.upsert('state', [{ key: k, value: { at: nowIso() }, updated_at: nowIso() }], ['key']);
  return true;
}

// ── small key/value state ──────────────────────────────────────────────────
export async function getState(key) {
  const [row] = await db().select('state', { where: { key } }).catch(() => []);
  return row?.value ?? null;
}
export async function setState(key, value) {
  await db().upsert('state', [{ key, value, updated_at: nowIso() }], ['key']);
}

// ── timeline ───────────────────────────────────────────────────────────────
export async function timeline(event, detail = {}) {
  await db().insert('timeline', [{ event, detail, at: nowIso() }]).catch(() => {});
}

// ── one at a time ─────────────────────────────────────────────────────────
// A lease in `state`: only one holder at a time across every copy of the process. A lease older
// than ttlMs is taken over (its holder stopped mid-run). Returns fn's result, or { busy: true }.
export async function withLease(name, fn, { ttlMs = 30 * 60_000 } = {}) {
  const d = db();
  const key = `lease/${name}`;
  const mine = { at: nowIso(), id: Math.random().toString(36).slice(2) };
  let got = await d.insertIgnore('state', { key, value: mine, updated_at: nowIso() }, ['key']);
  if (!got) {
    const [row] = await d.select('state', { where: { key } });
    const held = row?.value?.at && rt.now() - new Date(row.value.at) < ttlMs;
    if (held) return { busy: true, since: row.value.at };
    [got] = await d.update('state', { key, updated_at: row?.updated_at ?? null }, { value: mine, updated_at: nowIso() });
    if (!got) return { busy: true };
  }
  try { return await fn(); }
  finally { await d.remove('state', { key }).catch(() => {}); }
}

// True the first time `key` is seen (a Slack event delivered twice is answered once).
export async function firstTime(key) {
  return Boolean(await db().insertIgnore('state', { key: `seen/${key}`, value: { at: nowIso() }, updated_at: nowIso() }, ['key']));
}
export async function forgetSeen(olderThanDays = 7) {
  const cutoff = new Date(rt.now().getTime() - olderThanDays * 864e5).toISOString();
  const rows = await db().select('state', { where: { key: { prefix: 'seen/' }, updated_at: { lt: cutoff } } }).catch(() => []);
  for (const r of rows) await db().remove('state', { key: r.key }).catch(() => {});
  return rows.length;
}

// A read that fails loudly, for the health check.
export async function dbAnswers() {
  await db().select('state', { limit: 1 });
  return true;
}
