// Every write to Meta is recorded before it is sent and closed after the answer comes back.
// If a write has no clear answer (a timeout, a dropped connection), its outcome is unknown: the
// journal then holds every further write until that one is reconciled, by reading the account
// back at boot or by an operator in Slack ("journal" / "journal clear <id>").
import { createHash } from 'node:crypto';
import { rt, db } from './runtime.mjs';
import { currentExecution } from './context.mjs';

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}
export const fingerprint = (v) => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');

const OPEN = ['claimed', 'dispatching', 'unknown'];
const nowIso = () => rt.now().toISOString();

export async function unresolvedWrites() {
  return db().select('write_journal', { where: { state: { in: OPEN } }, order: 'id' });
}

// operations: [{ node, body }]   validate: async () => throws to refuse   dispatch: async () => receipt
export async function journalWrite({ operations, metadata = {}, validate = async () => {}, dispatch }, { source = currentExecution() } = {}) {
  if (!source?.key) throw new Error('A write needs an attributable source (an operator order, an approval or a scheduled job)');
  const d = db();
  const writeKey = fingerprint({ source: source.key, operations });
  const blocking = (await unresolvedWrites()).filter((r) => r.write_key !== writeKey);
  if (blocking.some((r) => r.state !== 'claimed' || rt.now() - new Date(r.updated_at) > 15 * 60_000)) {
    throw new Error(`Writes are on hold: write #${blocking[0].id} has an unknown outcome. Check it in Ads Manager, then run "journal clear ${blocking[0].id}".`);
  }
  let row = await d.insertIgnore('write_journal', {
    write_key: writeKey, source, operations, metadata, state: 'claimed', updated_at: nowIso(),
  }, ['write_key']);
  if (!row) {
    const [prev] = await d.select('write_journal', { where: { write_key: writeKey } });
    if (['applied', 'reconciled'].includes(prev?.state)) return { ...(prev.receipt || {}), replay: true, journalId: prev.id };
    throw new Error(`Write #${prev?.id} is ${prev?.state}; it is not sent again`);
  }
  const move = (state, receipt = null) => d.update('write_journal', { id: row.id }, { state, receipt, updated_at: nowIso() });
  try { await validate(); }
  catch (e) { await move('not_applied', { error: String(e.message).slice(0, 250), stage: 'preflight' }); throw e; }
  await move('dispatching');
  let receipt;
  try { receipt = await dispatch(); }
  catch (e) {
    // A clear refusal from Meta means nothing changed; no answer at all means we don't know.
    if (e?.network) {
      await move('unknown', { error: String(e.message).slice(0, 250) }).catch(() => {});
      throw new Error(`Write #${row.id} has an unknown outcome; further writes are held until it is checked. ${String(e.message).slice(0, 160)}`);
    }
    await move('not_applied', { error: String(e.message).slice(0, 250) }).catch(() => {});
    throw e;
  }
  await move('applied', receipt ?? { ok: true }).catch(() => {});
  return { ...(receipt || {}), journalId: row.id };
}

// At boot: settle what can be settled by reading the account back. A status or budget write
// whose requested value is live now is reconciled; a claim that never dispatched is cancelled.
export async function recoverWrites({ graph }) {
  const out = [];
  for (const row of await unresolvedWrites()) {
    let state = null, receipt = null;
    if (row.state === 'claimed' && rt.now() - new Date(row.updated_at) > 15 * 60_000) {
      state = 'not_applied'; receipt = { verification: 'claim cancelled before dispatch' };
    }
    if (['dispatching', 'unknown'].includes(row.state)) {
      const op = row.operations?.[0];
      if (row.operations?.length === 1 && op && /^\d+$/.test(op.node) && Object.keys(op.body).every((k) => ['status', 'daily_budget'].includes(k))) {
        const fields = Object.keys(op.body).map((k) => (k === 'status' ? 'configured_status' : k));
        const live = await graph(op.node, { fields: fields.join(',') }).catch(() => null);
        if (live && Object.entries(op.body).every(([k, v]) => String(live[k === 'status' ? 'configured_status' : k]) === String(v))) {
          state = 'reconciled'; receipt = { verification: 'requested state observed on Meta' };
        }
      }
    }
    if (!state) { out.push({ id: row.id, resolved: false, state: row.state }); continue; }
    await db().update('write_journal', { id: row.id }, { state, receipt, updated_at: nowIso() });
    out.push({ id: row.id, resolved: true, state });
  }
  return out;
}

// An operator checked Ads Manager and clears a held write by hand.
export async function clearWrite(id, by) {
  const [row] = await db().select('write_journal', { where: { id: Number(id) } });
  if (!row) return { ok: false, error: `no write #${id}` };
  if (!OPEN.includes(row.state)) return { ok: false, error: `write #${id} is already ${row.state}` };
  await db().update('write_journal', { id: row.id }, { state: 'reconciled', receipt: { verification: 'cleared by operator', by }, updated_at: nowIso() });
  return { ok: true };
}
