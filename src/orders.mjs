// Orders. An operator asks for a change in chat; the agent files it as a card that names the
// exact change; nothing happens until an operator taps Confirm. An order is one message plus one
// tap, so a misread message, a prompt hidden in a comment or a teammate's words can never change
// the account on their own.
//   set_status, set_budget, duplicate_campaign   the ad account (through meta-write.mjs)
//   comment, dm                                  a public reply, hide, unhide or delete, or a DM
// A pending order lives in `state` as order/<id>, expires after a day, and is carried out once
// (the confirm tap claims it with runJob), under the identity of the operator who tapped.
import { rt } from './runtime.mjs';
import { getConfig } from './config.mjs';
import { getState, setState, runJob, timeline } from './jobs.mjs';
import { currentExecution, withExecution, reportEffect, reportBlocked } from './context.mjs';
import { isOperator } from './auth.mjs';
import { money } from './money.mjs';
import { commentAction, sendMessage, commentContext, logModeration } from './meta-actions.mjs';
import { orderCardBlocks } from './slack/cards.mjs';

export const ORDER_TTL_HOURS = 24;
const MAX_PUBLIC_TEXT = 2500;      // the exact text must fit on the card the operator confirms
const LEVEL = { campaign: 'campaign', adset: 'ad set', ad: 'ad' };
// Text from Meta or from the model is shown as it is: Slack's control characters are escaped, so
// a comment cannot ping the channel or hide a link on the card.
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const quote = (t) => `"${esc(t).replace(/\s+/g, ' ').trim()}"`;
const block = (t) => `>${esc(t).replace(/\n/g, '\n>')}`;
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// The card's words for an order, from what was read when it was filed.
export function describeOrder(o) {
  const p = o.params || {}, v = o.preview || {};
  const name = v.name ? `*${esc(v.name)}*` : `\`${esc(p.target_id || p.source_campaign_id || '')}\``;
  switch (o.kind) {
    case 'set_status': return `${p.status === 'PAUSED' ? 'Pause' : 'Activate'} ${LEVEL[p.level] || p.level} ${name}${v.status ? ` (now ${String(v.status).toLowerCase()})` : ''}`;
    case 'set_budget': return `Set the daily budget of ${LEVEL[p.level] || p.level} ${name} ${v.dailyBudget != null ? `from ${money(v.dailyBudget)} ` : ''}to ${money(p.daily_budget)}`;
    case 'duplicate_campaign': return `Duplicate campaign ${name} as ${quote(`${v.name || p.source_campaign_id} ${p.name_suffix || 'copy'}`)}, ${p.activate ? 'then switch the copy on (inside the daily ceiling)' : 'built paused'}${p.include_paused_ads ? ', with its paused ads too' : ''}`;
    case 'comment': {
      const on = v.user ? ` by ${esc(v.user)}` : '';
      const said = v.text ? ` (${quote(String(v.text).slice(0, 300))})` : '';
      if (p.action === 'reply') return `Reply in public to the ${p.platform} comment${on}${said}:\n${block(p.message)}`;
      return `${p.action[0].toUpperCase()}${p.action.slice(1)} the ${p.platform} comment${on}${said}`;
    }
    case 'dm': return `Send this message on ${p.platform === 'instagram' ? 'Instagram' : 'Messenger'} to \`${esc(p.recipient_id)}\`:\n${block(p.text)}`;
    default: return o.kind;
  }
}

async function postCard(order, thread) {
  if (!rt.slack) throw new Error('Slack is not connected here, so there is no card to confirm; give the order in Slack');
  const channel = thread?.channel || getConfig().SLACK_CHANNEL;
  return rt.slack.chat.postMessage({ channel, ...(thread?.thread_ts ? { thread_ts: thread.thread_ts } : {}), text: `To confirm: ${describeOrder(order).slice(0, 150)}`, blocks: orderCardBlocks(order, describeOrder(order)) });
}

// What the card shows, read live when the order is filed.
async function previewFor(kind, p) {
  if (kind === 'set_status' || kind === 'set_budget') {
    const { currentState } = await import('./meta-write.mjs');
    return currentState(p.level, p.target_id).catch(() => ({}));
  }
  if (kind === 'duplicate_campaign') {
    const { currentState } = await import('./meta-write.mjs');
    return currentState('campaign', p.source_campaign_id).catch(() => ({}));
  }
  if (kind === 'comment') return commentContext(p.platform, p.comment_id);
  return {};
}

function check(kind, p) {
  if (kind === 'set_status' && (!p.level || !p.target_id || !p.status)) return 'set_status needs level, target_id and status';
  if (kind === 'set_budget' && (!p.level || !p.target_id || !p.daily_budget)) return 'set_budget needs level, target_id and daily_budget';
  if (kind === 'set_budget' && p.level === 'ad') return 'budgets live on a campaign or an ad set';
  if (kind === 'duplicate_campaign' && !p.source_campaign_id) return 'duplicate_campaign needs source_campaign_id';
  if (kind === 'comment' && p.action === 'reply' && !String(p.message || '').trim()) return 'a reply needs its text';
  if (kind === 'dm' && !String(p.text || '').trim()) return 'a message needs its text';
  const text = kind === 'comment' ? p.message : kind === 'dm' ? p.text : null;
  if (text && String(text).length > MAX_PUBLIC_TEXT) return `the text is ${String(text).length} characters; keep it under ${MAX_PUBLIC_TEXT} so the whole of it fits on the card that is confirmed`;
  return null;
}

// File an order from chat. Only an operator's own message can file one. Returns what the tool
// tells Claude: the card is posted, nothing has changed yet.
export async function fileOrder(kind, params) {
  const ex = currentExecution();
  const tool = kind === 'comment' ? 'comment_action' : kind === 'dm' ? 'send_dm' : 'execute_order';
  if (!isOperator(ex?.actor)) { reportBlocked(tool, 'not an operator'); return { ok: false, refused: 'only an operator\'s own message can file an order; file a proposal instead' }; }
  const problem = check(kind, params);
  if (problem) { reportBlocked(tool, problem); return { ok: false, error: problem }; }
  const order = { id: newId(), kind, params, by: ex.actor, words: ex.words || null, thread: ex.thread || null, at: rt.now().toISOString(), status: 'pending' };
  order.preview = await previewFor(kind, params);
  try {
    const msg = await postCard(order, ex.thread);
    order.card = { channel: msg?.channel || ex.thread?.channel || null, ts: msg?.ts || null };
  } catch (e) { reportBlocked(tool, String(e.message).slice(0, 160)); return { ok: false, error: String(e.message).slice(0, 200) }; }
  await setState(`order/${order.id}`, order);
  reportEffect(tool, [], `posted a card to confirm: ${describeOrder(order).split('\n')[0].replace(/[*`]/g, '').slice(0, 120)} (nothing changes until an operator taps Confirm)`);
  return { ok: true, pending: true, order_id: order.id, note: 'Nothing has changed yet. The card is posted; the change is made only when an operator taps Confirm on it. Tell the person that, in one line.' };
}

// The order, carried out. Never throws: the outcome is returned for the card.
async function carryOut(o) {
  const p = o.params;
  const w = await import('./meta-write.mjs');
  const record = (result) => timeline('order', { kind: o.kind, op: o.kind, level: p.level || null, target_id: p.target_id || p.source_campaign_id || p.comment_id || p.recipient_id || null, words: o.words, filed_by: o.by, by: currentExecution()?.actor || null, result });
  try {
    if (o.kind === 'set_status') {
      const before = await w.currentState(p.level, p.target_id).catch(() => null);
      const res = await w.setStatus(p.level, p.target_id, p.status);
      const after = await w.currentState(p.level, p.target_id).catch(() => null);
      await record({ before: before?.status ?? null, after: after?.status ?? null });
      return { ok: true, line: `${p.status === 'PAUSED' ? 'Paused' : 'Activated'}. Meta now shows it ${after?.status ? String(after.status).toLowerCase() : '(could not read it back)'}.`, result: { ...res, read_back: after?.status ?? null } };
    }
    if (o.kind === 'set_budget') {
      const res = await w.setBudget(p.level, p.target_id, p.daily_budget);
      const after = await w.currentState(p.level, p.target_id).catch(() => null);
      await record({ before: res.before, after: after?.dailyBudget ?? null });
      return { ok: true, line: `Done: ${res.before != null ? money(res.before) : '?'} to ${money(p.daily_budget)} a day. Meta now shows ${after?.dailyBudget != null ? money(after.dailyBudget) : '(could not read it back)'}.`, result: { ...res, read_back: after?.dailyBudget ?? null } };
    }
    if (o.kind === 'duplicate_campaign') {
      const res = await w.duplicateCampaign(p);
      await record({ campaign_id: res.campaignId, adsets: res.adsets.length, activated: Boolean(res.activated), partial: Boolean(res.partial) });
      const sets = res.adsets.length, ads = res.adsets.reduce((n, s) => n + s.ads.length, 0);
      if (res.partial) return { ok: false, line: `The copy (\`${res.campaignId}\`) is INCOMPLETE and paused: ${res.partial_error}. Finish or delete it in Ads Manager.`, result: res };
      return { ok: true, line: `Copied as \`${res.campaignId}\` with ${sets} ad set${sets === 1 ? '' : 's'} and ${ads} ad${ads === 1 ? '' : 's'}, ${res.activated ? 'switched on' : 'paused'}.`, result: res };
    }
    if (o.kind === 'comment') {
      const r = await commentAction({ ...p, confirm: true });
      if (!r.ok) return { ok: false, line: `Not done: ${r.error}`, result: r };
      await logModeration({ platform: p.platform, comment_id: p.comment_id, author: o.preview?.user, text: o.preview?.text, action: p.action, outcome: 'done', source: `order:${currentExecution()?.actor || ''}` });
      await record({ action: p.action });
      return { ok: true, line: p.action === 'reply' ? 'Replied.' : `Done: ${p.action === 'hide' ? 'hidden' : p.action === 'unhide' ? 'visible again' : 'deleted'}.`, result: r };
    }
    if (o.kind === 'dm') {
      const r = await sendMessage({ ...p, confirm: true });
      if (!r.ok) return { ok: false, line: `Not sent: ${r.error}${r.hint ? ` (${r.hint})` : ''}`, result: r };
      await record({ message_id: r.message_id });
      return { ok: true, line: 'Sent.', result: r };
    }
    return { ok: false, line: `Unknown order ${o.kind}` };
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 300);
    if (e?.unknown) return { ok: false, unknown: true, line: `:question: Outcome unknown: ${msg} Check it in Ads Manager, then send \`journal clear ${e.journalId}\`.` };
    return { ok: false, line: `Not done: ${msg}` };
  }
}

const expired = (o) => rt.now() - new Date(o.at) > ORDER_TTL_HOURS * 3600_000;

// Confirm tapped. Carried out once; returns { ok, order, line } for the card.
export async function confirmOrder(id, { by }) {
  const o = await getState(`order/${id}`);
  if (!o) return { ok: false, line: 'This order was not found.' };
  if (o.status !== 'pending') return { ok: false, decided: true, order: o, line: `Already ${o.status}${o.decided_by ? ` by <@${o.decided_by}>` : ''}.` };
  if (expired(o)) {
    await setState(`order/${id}`, { ...o, status: 'expired' });
    return { ok: false, order: o, line: `Expired: an order waits ${ORDER_TTL_HOURS} hours. Ask again for fresh numbers.` };
  }
  const run = await runJob('order', String(id), () => withExecution(
    { actor: by, kind: 'order', key: `order:${id}`, words: o.words, thread: o.thread }, () => carryOut(o)));
  if (run?.jobSkipped) return { ok: false, decided: true, order: o, line: 'This order is already being carried out.' };
  const done = { ...o, status: run.ok ? 'done' : run.unknown ? 'unknown' : 'failed', decided_by: by, decided_at: rt.now().toISOString(), outcome: run.line };
  await setState(`order/${id}`, done);
  return { ok: run.ok, order: done, line: run.line, unknown: Boolean(run.unknown) };
}

export async function cancelOrder(id, { by }) {
  const o = await getState(`order/${id}`);
  if (!o) return { ok: false, line: 'This order was not found.' };
  if (o.status !== 'pending') return { ok: false, decided: true, order: o, line: `Already ${o.status}.` };
  const run = await runJob('order', String(id), async () => ({ cancelled: true }));
  if (run?.jobSkipped) return { ok: false, decided: true, order: o, line: 'This order is already being carried out.' };
  const done = { ...o, status: 'cancelled', decided_by: by, decided_at: rt.now().toISOString() };
  await setState(`order/${id}`, done);
  return { ok: true, order: done, line: 'Cancelled. Nothing changed.' };
}
