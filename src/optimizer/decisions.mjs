// What makes a proposal worth a card. Three pure checks, all against the live account:
//   decisionKey   one canonical name per decision, so the same move is never asked twice
//   gateProposal  is the move still meaningful right now (the ad is live, the budget differs)?
//   suppression   was it already decided, and has anything changed since?
import { db } from '../runtime.mjs';
import { policy } from './policy.mjs';
import { money } from '../money.mjs';

export const BUDGET_DRIFT = 0.05;   // shared with the stale budget guard at approval time

export function decisionKey(p) {
  const t = String(p.target_id || '');
  if (!t) return null;
  switch (p.action_type) {
    case 'pause_ad': return `pause:${t}`;
    case 'unpause_ad': return `unpause:${t}`;
    case 'scale_budget': return `budget:${t}|up`;
    case 'descale_budget': return `budget:${t}|down`;
    default: return null;
  }
}

const budgetEntity = (live, id) => live.adsets[id] || live.campaigns[id] || null;

export function gateProposal(p, live) {
  const t = String(p.target_id || '');
  const fail = (code, detail) => ({ ok: false, code, detail });
  switch (p.action_type) {
    case 'pause_ad': {
      const ad = live.ads[t];
      if (!ad) return fail('unknown_target', `ad ${t} is not in scope`);
      if (ad.effective !== 'ACTIVE') return fail('not_delivering', `ad ${t} is ${ad.effective}; nothing to stop`);
      return { ok: true };
    }
    case 'unpause_ad': {
      const ad = live.ads[t];
      if (!ad) return fail('unknown_target', `ad ${t} is not in scope`);
      if (ad.configured === 'ACTIVE') return fail('already_active', `ad ${t} is already switched on (${ad.effective})`);
      const set = live.adsets[ad.adset_id], camp = set && live.campaigns[set.campaign_id];
      if (!set || set.effective !== 'ACTIVE' || !camp || camp.effective !== 'ACTIVE') {
        return fail('parent_paused', `its ${!set || set.effective !== 'ACTIVE' ? 'ad set' : 'campaign'} is not active, so turning the ad on delivers nothing`);
      }
      return { ok: true };
    }
    case 'scale_budget': case 'descale_budget': {
      const e = budgetEntity(live, t);
      if (!e) return fail('unknown_target', `${t} is not an ad set or campaign in scope`);
      if (e.daily_budget == null) return fail('no_budget', `${e.name || t} has no daily budget of its own`);
      if (e.effective !== 'ACTIVE') return fail('not_active', `${e.name || t} is ${e.effective}`);
      const want = p.after?.dailyBudget;
      if (want != null && Math.abs(want - e.daily_budget) <= Math.max(1, e.daily_budget * BUDGET_DRIFT)) return fail('no_change', `the proposed budget is the live budget`);
      return { ok: true };
    }
    default: return fail('unknown_action', String(p.action_type));
  }
}

// The standing of each decision key, from the last row filed for it.
//   open (a card is waiting) | committed (applied) | undone | unknown (no clear answer from
//   Meta) | rejected | apply_failed | closed
export function standingOf(r) {
  if (['proposed', 'escalated'].includes(r.disposition)) return 'open';
  if (r.disposition === 'unknown') return 'unknown';
  if (r.undone_at) return 'undone';
  if (['auto_applied', 'applied_by_human'].includes(r.disposition)) return 'committed';
  if (r.close_reason === 'human_reject') return 'rejected';
  if (r.close_reason === 'execution_needs_review') return 'apply_failed';
  return 'closed';
}
export async function loadLedger({ days = 60 } = {}) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const rows = await db().select('actions_log', { where: { run_date: { gte: since } }, order: 'id' });
  const ledger = new Map();
  for (const r of rows) {
    if (!r.decision_key) continue;
    const standing = standingOf(r);
    ledger.set(r.decision_key, { ...r, standing });
  }
  return ledger;
}

const daysSince = (iso, now) => (iso ? (now - new Date(iso).getTime()) / 864e5 : Infinity);

function regressed(key, row, live, now) {
  const [family, rest] = [key.split(':')[0], key.slice(key.indexOf(':') + 1)];
  if (family === 'pause') return live.ads[rest]?.effective === 'ACTIVE';     // someone turned it back on
  if (family === 'unpause') return live.ads[rest]?.effective === 'PAUSED';
  if (family === 'budget') return daysSince(row.applied_at, now) >= policy().t.suppression.budgetRecommitDays;
  return true;
}

// Has the evidence moved enough since a rejection to ask again?
function evidenceChanged(row, cur) {
  const old = row.evidence || {};
  if (!cur) return null;
  if (old.cost != null && cur.cost != null && old.cost > 0) {
    const worse = row.decision_key.startsWith('pause') || row.decision_key.endsWith('|down');
    if (worse ? cur.cost >= old.cost * 1.25 : cur.cost <= old.cost * 0.75) return `cost per result moved from ${money(old.cost)} to ${money(cur.cost)}`;
  }
  const target = policy().target;
  if (old.spend != null && cur.spend != null && target && cur.spend - old.spend >= target) return `${money(Math.round(cur.spend - old.spend))} more spend since the rejection`;
  return null;
}

export function checkSuppression(key, ledger, live, evidence = null, now = Date.now()) {
  const row = ledger.get(key);
  if (!row) return { suppressed: false };
  const day = String(row.applied_at || row.created_at || '').slice(0, 10);
  switch (row.standing) {
    case 'open': return { suppressed: true, standing: 'open', why: `card #${row.id} is already waiting` };
    case 'unknown': return { suppressed: true, standing: 'unknown', why: `move #${row.id} has an unknown outcome; check it in Ads Manager, then send journal clear ${row.journal_id ?? '<number>'}` };
    // A person reversed this move: asking again is for a person to decide, never automatic.
    case 'undone': return { suppressed: false, escalate: true, reopened: `#${row.id} was undone${row.undone_by ? ` by ${row.undone_by}` : ''} ${String(row.undone_at || '').slice(0, 10)}, so this waits for a person` };
    case 'committed':
      if (!regressed(key, row, live, now)) return { suppressed: true, standing: 'committed', why: `applied ${day} and still holds` };
      // Someone turned a paused ad back on (or the other way round) since: a person decides.
      if (!key.startsWith('budget:')) return { suppressed: false, escalate: true, reopened: `it was applied ${day}, and someone changed it back since, so this waits for a person` };
      return { suppressed: false, reopened: `the account moved since it was applied ${day}` };
    case 'rejected': {
      const hold = policy().t.suppression.rejectCooldownDays;
      const d = daysSince(row.applied_at, now);
      const moved = evidenceChanged(row, evidence);
      if (d < hold && !moved) return { suppressed: true, standing: 'rejected', why: `rejected ${day}${row.decision_note ? ` ("${row.decision_note}")` : ''}; holds ${Math.ceil(hold - d)} more days unless the numbers move` };
      return { suppressed: false, reopened: moved ? `asking again: ${moved}` : `the ${hold} day hold after the rejection is over` };
    }
    default: return { suppressed: false };
  }
}

// Failure causes, compared instead of error text.
export function failureKey(err) {
  const m = String(err?.message || err || '').toLowerCase();
  if (m.includes('stale')) return 'stale_budget';
  if (m.includes('ceiling')) return 'budget_ceiling';
  if (m.includes('refused')) return 'refused';
  if (m.includes('on hold')) return 'journal_hold';
  const code = m.match(/^(\d+):/);
  if (code) return `meta:${code[1]}`;
  return 'other';
}

// Re-run the gate over open cards: close the ones that no longer make sense, expire old ones.
export async function sweepOpen(live, { expireDays = 7, now = Date.now() } = {}) {
  const open = await db().select('actions_log', { where: { disposition: { in: ['proposed', 'escalated'] } } });
  const cutoff = new Date(now - expireDays * 864e5).toISOString().slice(0, 10);
  const closed = [];
  for (const r of open) {
    const g = gateProposal({ action_type: r.action_type, target_id: r.target_id, after: r.after }, live);
    if (!g.ok && g.code !== 'unknown_action') {
      await db().update('actions_log', { id: r.id }, { disposition: 'skipped', close_reason: 'moot', applied_by: 'sweep', decision_note: `closed: ${g.detail}` });
      closed.push({ ...r, why: g.detail });
    } else if (r.run_date < cutoff) {
      await db().update('actions_log', { id: r.id }, { disposition: 'skipped', close_reason: 'expiry', applied_by: 'sweep', decision_note: `expired after ${expireDays} days` });
      closed.push({ ...r, why: 'expired' });
    }
  }
  return closed;
}
