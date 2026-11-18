// Carrying out a decision: applying an approved card, undoing an applied one, and the autonomy
// ladder that says which action types may apply on their own.
import { db, rt } from '../runtime.mjs';
import { graph } from '../meta.mjs';
import { setStatus, setBudget } from '../meta-write.mjs';
import { withExecution } from '../context.mjs';
import { runJob, timeline } from '../jobs.mjs';
import { ACTION_TYPES, NEVER_AUTO, BUDGET_TYPES, ACTION_WORDS, ACTION_PHRASES } from './policy.mjs';
import { BUDGET_DRIFT, failureKey } from './decisions.mjs';
import { money, fromMinor } from '../money.mjs';

const nowIso = () => rt.now().toISOString();
const OPEN = ['proposed', 'escalated'];

// The Meta write for one action row.
async function write(row) {
  if (row.action_type === 'pause_ad') return setStatus('ad', row.target_id, 'PAUSED');
  if (row.action_type === 'unpause_ad') return setStatus('ad', row.target_id, 'ACTIVE');
  if (BUDGET_TYPES.has(row.action_type)) {
    // Stale guard: the card's numbers were read when it was proposed. If the live budget moved
    // since (a manual edit, another approval), applying the old number could be a big jump.
    const cur = await graph(row.target_id, { fields: 'daily_budget,effective_status' });
    const live = fromMinor(cur.daily_budget);
    const before = row.before?.dailyBudget;
    if (cur.effective_status !== 'ACTIVE') throw new Error(`stale: the target is ${cur.effective_status} now; run the optimizer again`);
    if (live == null || before == null || Math.abs(live - before) > Math.max(1, before * BUDGET_DRIFT)) {
      throw new Error(`stale: the card assumed ${money(before)} a day but Meta shows ${money(live)} now; run the optimizer again`);
    }
    return setBudget(row.target_level, row.target_id, row.after?.dailyBudget);
  }
  throw new Error(`no executor for ${row.action_type}`);
}

// Apply an approved card. Re-reads the row so a stale or already decided card never applies.
// Returns { ok, row, result } or { ok:false, reason }.
export async function applyApproved(id, { by, note = null }) {
  const [row] = await db().select('actions_log', { where: { id: Number(id) } });
  if (!row) return { ok: false, reason: `action #${id} was not found` };
  if (!OPEN.includes(row.disposition)) return { ok: false, decided: true, row, reason: describeDecided(row) };
  const run = await runJob('approval', String(row.id), () => withExecution(
    { actor: by, kind: 'approval', key: `approval:${row.id}` },
    async () => {
      try { return { applied: true, result: await write(row) }; }
      catch (e) { return { applied: false, error: e }; }
    }));
  if (run?.jobSkipped) return { ok: false, reason: 'this approval is already being handled' };
  if (!run.applied) {
    const msg = String(run.error?.message || run.error).slice(0, 200);
    await db().update('actions_log', { id: row.id }, {
      disposition: 'skipped', applied_by: by, applied_at: nowIso(), close_reason: 'execution_needs_review',
      fail_key: failureKey(run.error), decision_note: [note, `apply failed: ${msg}`].filter(Boolean).join(' | '),
    }).catch(() => {});
    return { ok: false, failed: true, row, reason: msg };
  }
  // Bookkeeping after the write landed must never read as a failure: the change is live.
  let bookkeeping = null;
  await db().update('actions_log', { id: row.id }, {
    disposition: 'applied_by_human', applied: true, applied_by: by, applied_at: nowIso(), escalated: false, decision_note: note,
  }).catch((e) => { bookkeeping = String(e.message).slice(0, 120); });
  return { ok: true, row: { ...row, disposition: 'applied_by_human', applied_by: by }, result: run.result, bookkeeping };
}

export async function rejectCard(id, { by, note = null }) {
  const [row] = await db().select('actions_log', { where: { id: Number(id) } });
  if (!row) return { ok: false, reason: `action #${id} was not found` };
  if (!OPEN.includes(row.disposition)) return { ok: false, decided: true, row, reason: describeDecided(row) };
  await db().update('actions_log', { id: row.id }, { disposition: 'skipped', applied: false, applied_by: by, applied_at: nowIso(), close_reason: 'human_reject', decision_note: note });
  return { ok: true, row };
}

export function describeDecided(row) {
  if (row.undone_at) return `already undone by ${row.undone_by || 'someone'}`;
  if (row.disposition === 'applied_by_human') return `already approved and applied${row.applied_by ? ` by ${row.applied_by}` : ''}`;
  if (row.disposition === 'auto_applied') return 'already applied automatically';
  if (row.close_reason === 'human_reject') return `already rejected${row.applied_by ? ` by ${row.applied_by}` : ''}`;
  return `already closed (${row.close_reason || row.disposition})`;
}

// Undo an applied action. Undoing an automatic one sends that action type back to propose.
export async function undo(id, { by }) {
  const [row] = await db().select('actions_log', { where: { id: Number(id) } });
  if (!row) return { ok: false, reason: `action #${id} was not found` };
  if (!row.applied) return { ok: false, reason: `action #${id} (${row.action_type}) was never applied; nothing to undo` };
  if (row.undone_at) return { ok: false, reason: `action #${id} was already undone` };
  const r = await withExecution({ actor: by, kind: 'approval', key: `undo:${row.id}` }, async () => {
    if (row.action_type === 'pause_ad') return setStatus('ad', row.target_id, 'ACTIVE');
    if (row.action_type === 'unpause_ad') return setStatus('ad', row.target_id, 'PAUSED');
    if (BUDGET_TYPES.has(row.action_type) && row.before?.dailyBudget) return setBudget(row.target_level, row.target_id, row.before.dailyBudget);
    throw new Error(`no undo path for ${row.action_type}`);
  });
  await db().update('actions_log', { id: row.id }, { undone_at: nowIso(), undone_by: by, close_reason: 'undone' });
  let demoted = false;
  if (row.disposition === 'auto_applied') {
    await db().update('autonomy_policy', { action_type: row.action_type }, { mode: 'propose', updated_at: nowIso(), updated_by: 'undo of an automatic action' });
    demoted = true;
  }
  await timeline('undo', { action_id: row.id, action_type: row.action_type, by });
  return { ok: true, row, result: r, demoted };
}

// ── the ladder ──────────────────────────────────────────────────────────────
export async function ladder() {
  const rows = await db().select('autonomy_policy', { order: 'action_type' });
  const by = Object.fromEntries(rows.map((r) => [r.action_type, r]));
  return ACTION_TYPES.map((t) => ({ action_type: t, mode: by[t]?.mode || 'propose', updated_by: by[t]?.updated_by || null, locked: NEVER_AUTO.has(t) }));
}

export async function setLadder(type, mode, { by }) {
  if (!ACTION_TYPES.includes(type)) return { ok: false, reason: `"${type}" is not a kind of move; the kinds are ${Object.values(ACTION_WORDS).join(', ')}` };
  if (!['auto', 'propose'].includes(mode)) return { ok: false, reason: 'the mode is auto (it happens on its own) or ask (it waits for a person)' };
  if (mode === 'auto' && NEVER_AUTO.has(type)) return { ok: false, reason: `${ACTION_PHRASES[type]} always waits for a person` };
  await db().upsert('autonomy_policy', [{ action_type: type, mode, updated_at: nowIso(), updated_by: by }], ['action_type']);
  return { ok: true };
}

export async function modeOf(type) {
  if (NEVER_AUTO.has(type)) return 'propose';
  const [row] = await db().select('autonomy_policy', { where: { action_type: type } });
  return row?.mode === 'auto' ? 'auto' : 'propose';
}

// An automatic apply (ladder on auto). Runs under the scheduled job's identity.
export async function applyAuto(row, { slot }) {
  const run = await runJob('auto-apply', `${slot}:${row.decision_key}`, () => withExecution(
    { actor: null, kind: 'scheduled', key: `auto:${slot}:${row.decision_key}` }, () => write(row)));
  if (run?.jobSkipped) throw new Error('already handled in this slot');
  return run;
}
