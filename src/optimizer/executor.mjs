// Carrying out a decision: applying an approved card, undoing an applied one, and the autonomy
// ladder that says which action types may apply on their own.
import { db, rt } from '../runtime.mjs';
import { graph, graphAll } from '../meta.mjs';
import { setStatus, setBudget } from '../meta-write.mjs';
import { withExecution } from '../context.mjs';
import { runJob, timeline } from '../jobs.mjs';
import { ACTION_TYPES, NEVER_AUTO, BUDGET_TYPES, ACTION_WORDS, ACTION_PHRASES, refreshPolicy, policy } from './policy.mjs';
import { BUDGET_DRIFT, failureKey } from './decisions.mjs';
import { money, fromMinor } from '../money.mjs';
import { liveStructure, totalDailyBudget } from '../account.mjs';
import { storedBudgetOn } from '../insights.mjs';
import { daysAgo } from '../clock.mjs';

const nowIso = () => rt.now().toISOString();
const OPEN = ['proposed', 'escalated'];
const unknownWords = (journalId) => `Meta gave no clear answer, so the outcome is unknown. Check it in Ads Manager, then send \`journal clear ${journalId}\``;

// The account-wide growth cap, checked again at apply time: several raises approved one after
// another each passed it when proposed, but together they could exceed it.
async function checkGrowthCap(row) {
  await refreshPolicy();
  const cap = policy().t.scale.accountCapMult;
  const live = await liveStructure();
  const total = totalDailyBudget(live);
  const baseline = (await storedBudgetOn(daysAgo(7))) ?? total;
  const newTotal = total - (row.before?.dailyBudget || 0) + (row.after?.dailyBudget || 0);
  if (baseline > 0 && newTotal > baseline * cap + 0.005) {
    throw new Error(`refused: the total daily budget would be ${money(newTotal)}, past ${cap}x its level a week ago (${money(baseline)}); other raises were applied since this card was filed`);
  }
}

// The ad set floor, checked again before an automatic pause: the ad set must keep
// keepMinActive ads running after this one stops.
async function checkSetFloor(row, adsetId) {
  if (!adsetId) return;
  const floor = policy().t.pause.keepMinActive;
  const ads = await graphAll(`${adsetId}/ads`, { fields: 'id,effective_status', limit: 200 }, 1000);
  const others = ads.filter((a) => a.effective_status === 'ACTIVE' && String(a.id) !== String(row.target_id)).length;
  if (others < floor) throw new Error(`refused: pausing would leave ${others} active ad${others === 1 ? '' : 's'} in the ad set (it keeps at least ${floor})`);
}

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
    if (row.action_type === 'scale_budget') await checkGrowthCap(row);
    return setBudget(row.target_level, row.target_id, row.after?.dailyBudget);
  }
  throw new Error(`no executor for ${row.action_type}`);
}

// Apply an approved card. Approve and reject claim the same slot, so only one of them ever acts
// on a card, and the row is read again under the claim. Returns { ok, row, result } or
// { ok:false, reason } (decided: someone else decided first; unknown: Meta gave no clear answer).
export async function applyApproved(id, { by, note = null }) {
  const [row] = await db().select('actions_log', { where: { id: Number(id) } });
  if (!row) return { ok: false, reason: `action #${id} was not found` };
  if (!OPEN.includes(row.disposition)) return { ok: false, decided: true, row, reason: describeDecided(row) };
  const run = await runJob('approval', String(row.id), () => withExecution(
    { actor: by, kind: 'approval', key: `approval:${row.id}` },
    async () => {
      const [cur] = await db().select('actions_log', { where: { id: row.id } });
      if (!cur || !OPEN.includes(cur.disposition)) return { decided: true, row: cur || row };
      try { return { applied: true, result: await write(cur) }; }
      catch (e) { return { applied: false, error: e }; }
    }));
  if (run?.jobSkipped || run?.decided) return decidedElsewhere(row, run?.row);
  const close = (patch) => db().update('actions_log', { id: row.id, disposition: { in: OPEN } }, patch);
  if (!run.applied) {
    const msg = String(run.error?.message || run.error).slice(0, 200);
    if (run.error?.unknown) {
      await close({ disposition: 'unknown', applied_by: by, applied_at: nowIso(), journal_id: run.error.journalId ?? null,
        decision_note: [note, `outcome unknown: ${msg}`].filter(Boolean).join(' | ') }).catch(() => {});
      return { ok: false, unknown: true, row, journalId: run.error.journalId ?? null, reason: unknownWords(run.error.journalId) };
    }
    await close({
      disposition: 'skipped', applied_by: by, applied_at: nowIso(), close_reason: 'execution_needs_review',
      fail_key: failureKey(run.error), decision_note: [note, `apply failed: ${msg}`].filter(Boolean).join(' | '),
    }).catch(() => {});
    return { ok: false, failed: true, row, reason: msg };
  }
  // Bookkeeping after the write landed must never read as a failure: the change is live.
  let bookkeeping = null;
  await close({
    disposition: 'applied_by_human', applied: true, applied_by: by, applied_at: nowIso(), escalated: false, decision_note: note,
    journal_id: run.result?.journalId ?? null,
  }).catch((e) => { bookkeeping = String(e.message).slice(0, 120); });
  return { ok: true, row: { ...row, disposition: 'applied_by_human', applied_by: by }, result: run.result, bookkeeping };
}

async function decidedElsewhere(row, seen = null) {
  const [cur] = seen && !OPEN.includes(seen.disposition) ? [seen] : await db().select('actions_log', { where: { id: row.id } }).catch(() => []);
  if (cur && !OPEN.includes(cur.disposition)) return { ok: false, decided: true, row: cur, reason: describeDecided(cur) };
  return { ok: false, decided: true, row, reason: 'this card is already being handled' };
}

export async function rejectCard(id, { by, note = null }) {
  const [row] = await db().select('actions_log', { where: { id: Number(id) } });
  if (!row) return { ok: false, reason: `action #${id} was not found` };
  if (!OPEN.includes(row.disposition)) return { ok: false, decided: true, row, reason: describeDecided(row) };
  const run = await runJob('approval', String(row.id), async () => {
    const done = await db().update('actions_log', { id: row.id, disposition: { in: OPEN } }, { disposition: 'skipped', applied: false, applied_by: by, applied_at: nowIso(), close_reason: 'human_reject', decision_note: note });
    return { updated: done.length };
  });
  if (run?.jobSkipped || !run?.updated) return decidedElsewhere(row);
  return { ok: true, row };
}

export function describeDecided(row) {
  if (row.undone_at) return `already undone by ${row.undone_by || 'someone'}`;
  if (row.disposition === 'applied_by_human') return `already approved and applied${row.applied_by ? ` by ${row.applied_by}` : ''}`;
  if (row.disposition === 'auto_applied') return 'already applied automatically';
  if (row.close_reason === 'human_reject') return `already rejected${row.applied_by ? ` by ${row.applied_by}` : ''}`;
  if (row.disposition === 'unknown') return `already approved, and the outcome is unknown (write #${row.journal_id ?? '?'}); check it in Ads Manager, then send \`journal clear ${row.journal_id ?? '<number>'}\``;
  return `already closed (${row.close_reason || row.disposition})`;
}

// Undo an applied action. Undoing an automatic one sends that action type back to propose.
// A budget is only set back when it still is what the move set; a newer change is never
// overwritten. A failed undo can be tried again (each try is its own journaled write).
export async function undo(id, { by }) {
  const [row] = await db().select('actions_log', { where: { id: Number(id) } });
  if (!row) return { ok: false, reason: `action #${id} was not found` };
  if (row.disposition === 'unknown') return { ok: false, row, reason: `action #${id} has an unknown outcome, so there is nothing certain to undo. Check it in Ads Manager, then send \`journal clear ${row.journal_id ?? '<number>'}\` first` };
  if (!row.applied) return { ok: false, row, reason: `action #${id} (${row.action_type}) was never applied; nothing to undo` };
  if (row.undone_at) return { ok: false, row, reason: `action #${id} was already undone` };
  if (BUDGET_TYPES.has(row.action_type)) {
    const before = row.before?.dailyBudget, after = row.after?.dailyBudget;
    if (!(before > 0)) return { ok: false, row, reason: `action #${id} has no budget recorded from before, so there is nothing to set back` };
    const cur = await graph(row.target_id, { fields: 'daily_budget' });
    const live = fromMinor(cur.daily_budget);
    if (live == null || after == null || Math.abs(live - after) > Math.max(1, after * BUDGET_DRIFT)) {
      return { ok: false, row, reason: `the budget changed again since #${id} (it set ${money(after)} a day; Meta shows ${money(live)} now), so undoing it would overwrite the newer change. Give an order for the budget you want instead` };
    }
  }
  const tries = (await db().select('timeline', { where: { event: 'undo_failed' } }).catch(() => [])).filter((e) => Number(e.detail?.action_id) === row.id).length;
  let r;
  try {
    r = await withExecution({ actor: by, kind: 'approval', key: `undo:${row.id}:${tries}` }, async () => {
      if (row.action_type === 'pause_ad') return setStatus('ad', row.target_id, 'ACTIVE');
      if (row.action_type === 'unpause_ad') return setStatus('ad', row.target_id, 'PAUSED');
      if (BUDGET_TYPES.has(row.action_type)) return setBudget(row.target_level, row.target_id, row.before.dailyBudget);
      throw new Error(`no undo path for ${row.action_type}`);
    });
  } catch (e) {
    await timeline('undo_failed', { action_id: row.id, by, error: String(e?.message || e).slice(0, 200) });
    if (e?.unknown) return { ok: false, unknown: true, row, reason: `Undo of #${id}: ${unknownWords(e.journalId)}` };
    throw e;
  }
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

// An automatic apply (ladder on auto). Runs under the scheduled job's identity. A pause reads the
// ad set again first, so it never takes it below its floor of running ads.
export async function applyAuto(row, { slot, adsetId = null }) {
  const run = await runJob('auto-apply', `${slot}:${row.decision_key}`, () => withExecution(
    { actor: null, kind: 'scheduled', key: `auto:${slot}:${row.decision_key}` }, async () => {
      if (row.action_type === 'pause_ad') await checkSetFloor(row, adsetId);
      return write(row);
    }));
  if (run?.jobSkipped) throw new Error('already handled in this slot');
  return run;
}
