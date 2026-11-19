// Approve and reject: the cards, the "why" modal, approve-all for the non-budget moves, and the
// brain and ask-team buttons.
import { rt, db } from '../runtime.mjs';
import { approvalBlocks, batchHeaderBlocks, decisionModal, doneBlocks, orderDoneBlocks, BATCH_SAFE } from './cards.mjs';
import { confirmOrder, cancelOrder, describeOrder } from '../orders.mjs';
import { applyApproved, rejectCard, describeDecided } from '../optimizer/executor.mjs';
import { postToDesk, updateDesk } from './desk.mjs';
import { getState, setState } from '../jobs.mjs';
import { setBrain, getBrain } from '../brain.mjs';
import { publishHome } from './home.mjs';

const who = (body) => body.user?.id || 'someone';
const mention = (id) => (/^[UW][A-Z0-9]+$/.test(id) ? `<@${id}>` : id);

// Post one card per filed row (in a thread if given, else under the desk) and remember where.
export async function postCards(rows, thread = null, { header = null } = {}) {
  const client = rt.slack;
  if (!client) return;
  let parent = thread;
  if (header) {
    const h = thread?.channel
      ? await client.chat.postMessage({ channel: thread.channel, thread_ts: thread.thread_ts, text: header, blocks: batchHeaderBlocks(header, rows) })
      : await postToDesk({ text: header, blocks: batchHeaderBlocks(header, rows) });
    parent = parent || { channel: h.channel, thread_ts: h.ts };
  }
  for (const a of rows) {
    if (!a.id || !['proposed', 'escalated'].includes(a.disposition)) continue;
    const payload = { text: `Needs approval: ${a.action_type} ${a.target_name || a.target_id}`, blocks: approvalBlocks(a) };
    const msg = parent?.channel
      ? await client.chat.postMessage({ channel: parent.channel, thread_ts: parent.thread_ts, ...payload }).catch(() => null)
      : await postToDesk(payload).catch(() => null);
    if (msg?.ts) await db().update('actions_log', { id: a.id }, { card_ts: msg.ts, card_channel: msg.channel || parent?.channel }).catch(() => {});
  }
  await updateDesk().catch(() => {});
}

async function closeCard(client, row, line) {
  if (row.card_channel && row.card_ts) {
    await client.chat.update({ channel: row.card_channel, ts: row.card_ts, text: line.replace(/[:*_~]/g, '').slice(0, 80), blocks: doneBlocks(row, line) }).catch(() => {});
  }
}

export function registerApprovals(app) {
  const openModal = (decision) => async ({ ack, body, action, client }) => {
    await ack();
    try {
      const { id } = JSON.parse(action.value);
      const [row] = await db().select('actions_log', { where: { id: Number(id) } });
      if (!row) return;
      // A tap on a card in a channel, or on the Home tab (then the channel card is the one to update).
      const fromHome = body.view?.type === 'home';
      const channel = body.channel?.id || row.card_channel || null;
      const ts = body.message?.ts || row.card_ts || null;
      if (!['proposed', 'escalated'].includes(row.disposition)) {
        if (channel && ts) await client.chat.update({ channel, ts, text: 'already decided', blocks: doneBlocks(row, `:information_source: ${describeDecided(row)}.`) }).catch(() => {});
        if (fromHome) await publishHome(client, body.user.id).catch(() => {});
        return;
      }
      await client.views.open({ trigger_id: body.trigger_id, view: decisionModal(decision, row, channel, ts, fromHome ? body.user.id : null) });
    } catch (e) { console.error('[approval] could not open the modal:', String(e?.message || e).slice(0, 160)); }
  };
  app.action('opt_approve', openModal('approve'));
  app.action('opt_reject', openModal('reject'));

  app.view('opt_decision', async ({ ack, body, view, client }) => {
    await ack();
    const meta = JSON.parse(view.private_metadata);
    const note = view.state?.values?.why?.note?.value?.trim() || null;
    const user = who(body);
    const [row] = await db().select('actions_log', { where: { id: Number(meta.id) } }).catch(() => []);
    // Where the outcome goes: the card itself, or a message when there is no card to update.
    const tell = (text) => (meta.channel ? client.chat.postMessage({ channel: meta.channel, ...(meta.messageTs ? { thread_ts: meta.messageTs } : {}), text }) : client.chat.postMessage({ channel: user, text })).catch(() => {});
    const update = (line, r) => (meta.channel && meta.messageTs
      ? client.chat.update({ channel: meta.channel, ts: meta.messageTs, text: line.replace(/[:*_]/g, '').slice(0, 80), blocks: doneBlocks(r, line) }).catch(() => tell(line))
      : tell(line));
    // The card must still be the card that was reviewed.
    if (!row || JSON.stringify([row.action_type, row.target_id, row.after]) !== JSON.stringify(meta.check)) {
      await tell('Not applied: this card changed after it was opened. Open the current card.');
      return;
    }
    if (meta.decision === 'approve') {
      const r = await applyApproved(row.id, { by: user, note });
      const line = r.ok ? `:white_check_mark: *Approved* by ${mention(user)}${note ? `: "${note}"` : ''} · applied to Meta${r.bookkeeping ? ' (the change is live; the record update failed)' : ''}`
        : r.decided ? `:information_source: ${r.reason}.`
          : `:warning: Not applied: ${r.reason}\n_The card is closed. If the move still makes sense, the next optimizer run proposes it again with fresh numbers._`;
      await update(line, row);
    } else {
      const r = await rejectCard(row.id, { by: user, note });
      const line = r.ok ? `:x: *Rejected* by ${mention(user)}${note ? `: "${note}"` : ''} · no change` : `:information_source: ${r.reason}.`;
      await update(line, row);
    }
    await updateDesk(client).catch(() => {});
    if (meta.home) await publishHome(client, meta.home).catch(() => {});
  });

  app.action('opt_approve_all', async ({ ack, body, action, client }) => {
    await ack();
    const user = who(body);
    const { ids } = JSON.parse(action.value);
    const rows = await db().select('actions_log', { where: { id: { in: ids.map(Number) }, disposition: { in: ['proposed', 'escalated'] } } });
    let ok = 0;
    const fails = [];
    for (const row of rows.filter((r) => BATCH_SAFE.has(r.action_type))) {
      const r = await applyApproved(row.id, { by: user, note: 'approved in batch' });
      if (r.ok) { ok++; await closeCard(client, row, `:white_check_mark: *Approved* in batch by ${mention(user)} · applied to Meta`); }
      else { fails.push(`#${row.id}: ${r.reason}`); await closeCard(client, row, `:warning: Not applied: ${r.reason}`); }
    }
    await client.chat.postMessage({ channel: body.channel?.id, thread_ts: body.message?.ts, text: `:white_check_mark: ${ok} of ${rows.length} applied by ${mention(user)}${fails.length ? `\n:warning: ${fails.join('\n')}` : ''}` }).catch(() => {});
    await updateDesk(client).catch(() => {});
  });

  // order cards: Confirm carries the order out once, as the operator who tapped
  const onOrder = (decide) => async ({ ack, body, action, client }) => {
    await ack();
    const user = who(body);
    const channel = body.channel?.id, ts = body.message?.ts;
    let r;
    try {
      const { id } = JSON.parse(action.value);
      r = await decide(id, { by: user });
    } catch (e) { r = { ok: false, line: `Not done: ${String(e?.message || e).slice(0, 200)}` }; }
    const icon = r.ok ? ':white_check_mark:' : r.unknown ? '' : r.decided ? ':information_source:' : ':warning:';
    const status = `${icon ? `${icon} ` : ''}${r.decided ? r.line : `${r.line}${r.order ? ` (${mention(user)})` : ''}`}`;
    if (channel && ts && r.order) {
      await client.chat.update({ channel, ts, text: status.replace(/[:*_`]/g, '').slice(0, 150), blocks: orderDoneBlocks(describeOrder(r.order), status) }).catch(() => {});
    } else if (channel) await client.chat.postMessage({ channel, ...(ts ? { thread_ts: ts } : {}), text: status }).catch(() => {});
  };
  app.action('order_confirm', onOrder(confirmOrder));
  app.action('order_cancel', onOrder(cancelOrder));

  // brain update cards
  app.action('brain_apply', async ({ ack, body, action, client }) => {
    await ack();
    const { id } = JSON.parse(action.value);
    const p = await getState(`brain_proposal/${id}`);
    if (!p || p.closed) { await client.chat.update({ channel: body.channel.id, ts: body.message.ts, text: 'Already handled.', blocks: [] }).catch(() => {}); return; }
    try { await setBrain(p.scope, p.key, p.content, who(body)); }
    catch (e) {
      await client.chat.postMessage({ channel: body.channel.id, thread_ts: body.message.ts, text: `:warning: Not applied: ${String(e.message).slice(0, 400)}` }).catch(() => {});
      return;
    }
    await setState(`brain_proposal/${id}`, { ...p, closed: 'applied', by: who(body) });
    await client.chat.update({ channel: body.channel.id, ts: body.message.ts, text: `Applied brain ${p.scope}/${p.key}`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `:brain: \`${p.scope}/${p.key}\` *applied* by ${mention(who(body))}.` } }] }).catch(() => {});
  });
  app.action('brain_dismiss', async ({ ack, body, action, client }) => {
    await ack();
    const { id } = JSON.parse(action.value);
    const p = await getState(`brain_proposal/${id}`);
    if (p) await setState(`brain_proposal/${id}`, { ...p, closed: 'dismissed', by: who(body) });
    await client.chat.update({ channel: body.channel.id, ts: body.message.ts, text: 'Dismissed', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `~Brain update ${p ? `${p.scope}/${p.key}` : ''}~ dismissed by ${mention(who(body))}.` } }] }).catch(() => {});
  });

  // ask-team answer buttons
  for (const i of [0, 1, 2, 3]) {
    app.action(`team_answer_${i}`, async ({ ack, body, action, client }) => {
      await ack();
      const { key, answer } = JSON.parse(action.value);
      const prev = await getBrain('answers', key).catch(() => null);
      await setBrain('answers', key, answer, who(body));
      await client.chat.postMessage({ channel: body.channel.id, thread_ts: body.message.ts, text: `Saved: \`answers/${key}\` = "${answer}" (by ${mention(who(body))}${prev ? `, was "${typeof prev === 'string' ? prev : JSON.stringify(prev)}"` : ''}).` }).catch(() => {});
    });
  }
}
