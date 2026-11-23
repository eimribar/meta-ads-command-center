// Slack Block Kit for every card. Button values carry only an id; handlers re-read the row.
// Text the model wrote is cut to Block Kit's limits (docs.slack.dev/reference/block-kit/blocks):
// a section's text 3,000 characters, a block_id 255, a button value 2,000, a button label 75.
import { money } from '../money.mjs';

export const VERB = { pause_ad: 'Pause ad', unpause_ad: 'Turn ad back on', scale_budget: 'Raise budget', descale_budget: 'Trim budget' };
export const LIMITS = { section: 3000, blockId: 255, value: 2000, button: 75 };
const cut = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 3)}...` : t; };
const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text: cut(text, LIMITS.section) } });
const ICON = { pause_ad: ':double_vertical_bar:', unpause_ad: ':arrow_forward:', scale_budget: ':chart_with_upwards_trend:', descale_budget: ':chart_with_downwards_trend:' };
// Non-budget moves can be approved together; budget moves are one tap each, with the stale guard.
export const BATCH_SAFE = new Set(['pause_ad', 'unpause_ad']);

const label = (a) => a.target_name || a.target_id;
const budgetMove = (a) => (a.after?.dailyBudget != null ? `  \`${a.before?.dailyBudget != null ? money(a.before.dailyBudget) : '?'} to ${money(a.after.dailyBudget)} a day\`` : '');
const head = (a) => `${ICON[a.action_type] || ''} *${VERB[a.action_type] || a.action_type}: ${label(a)}*${budgetMove(a)}`;
const plain = (s, n = 150) => String(s || '').replace(/[*_~`]/g, '').slice(0, n);

export function approvalBlocks(a) {
  return [
    section(`${head(a)}\n${a.explain || a.reason || ''}`),
    { type: 'context', elements: [{ type: 'mrkdwn', text: `#${a.id}${a.disposition === 'escalated' ? ' · needs a person' : ''}` }] },
    { type: 'actions', block_id: `opt:${a.id}`, elements: [
      { type: 'button', action_id: 'opt_approve', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, value: JSON.stringify({ id: a.id }) },
      { type: 'button', action_id: 'opt_reject', style: 'danger', text: { type: 'plain_text', text: 'Reject' }, value: JSON.stringify({ id: a.id }) },
    ] },
  ];
}

export function batchHeaderBlocks(text, pending) {
  const safe = (pending || []).filter((a) => a.id && BATCH_SAFE.has(a.action_type));
  const blocks = [section(text)];
  if (safe.length >= 2) {
    blocks.push({ type: 'actions', block_id: 'opt_batch', elements: [{
      type: 'button', action_id: 'opt_approve_all', text: { type: 'plain_text', text: `Approve all ${safe.length} non-budget moves` },
      value: JSON.stringify({ ids: safe.map((a) => a.id).slice(0, 40) }),
      confirm: {
        title: { type: 'plain_text', text: 'Approve all?' },
        text: { type: 'mrkdwn', text: `Applies ${safe.length} moves that pause an ad or turn one back on. Budget moves are not included.` },
        confirm: { type: 'plain_text', text: 'Apply all' }, deny: { type: 'plain_text', text: 'Cancel' },
      },
    }] });
  }
  return blocks;
}

// Opened on Approve or Reject: the move plus an optional "why" that teaches the optimizer.
// channel and messageTs point at the card to update afterwards (may be empty when the tap came
// from the Home tab); home is the user whose Home tab to refresh.
export function decisionModal(decision, a, channel, messageTs, home = null) {
  const approve = decision === 'approve';
  return {
    type: 'modal', callback_id: 'opt_decision',
    private_metadata: JSON.stringify({ decision, id: a.id, channel, messageTs, home, check: [a.action_type, a.target_id, a.after] }),
    title: { type: 'plain_text', text: approve ? 'Approve' : 'Reject' },
    submit: { type: 'plain_text', text: approve ? 'Approve and apply' : 'Reject' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      section(`${head(a)}\n${a.explain || ''}`),
      { type: 'input', block_id: 'why', optional: true,
        label: { type: 'plain_text', text: approve ? 'Why approve? (optional, teaches the agent)' : 'Why reject? (optional, teaches the agent)' },
        element: { type: 'plain_text_input', action_id: 'note', multiline: true } },
    ],
  };
}

export function doneBlocks(a, statusLine) {
  return [section(`~${plain(VERB[a.action_type] || a.action_type, 40)}: ${plain(label(a), 120)}~\n${statusLine}`)];
}

export function brainCardBlocks({ id, scope, key, content, current, why }) {
  const show = (c) => (c == null ? '_(empty)_' : `\`\`\`${String(typeof c === 'string' ? c : JSON.stringify(c, null, 1)).slice(0, 1200)}\`\`\``);
  return [
    section(`:brain: *Brain update proposed: \`${scope}/${key}\`*\n${cut(why || '', 1500)}`),
    section(`*Now*\n${show(current)}\n*Proposed*\n${show(content)}`),
    { type: 'actions', block_id: cut(`brain:${id}`, LIMITS.blockId), elements: [
      { type: 'button', action_id: 'brain_apply', style: 'primary', text: { type: 'plain_text', text: 'Apply' }, value: JSON.stringify({ id }) },
      { type: 'button', action_id: 'brain_dismiss', text: { type: 'plain_text', text: 'Dismiss' }, value: JSON.stringify({ id }) },
    ] },
  ];
}

// A decision, hypothesis or grade to record. Text from the conversation is escaped, so it cannot
// ping the channel or hide a link.
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const labelsOf = (l) => { const e = Object.entries(l || {}); return e.length ? e.map(([k, v]) => `${esc(k)}=${esc(v)}`).join(', ') : ''; };
export function recordText({ kind, payload: p, context: c }) {
  if (kind === 'decision') {
    return [`:memo: *Decision to record*${p.topic ? ` (${esc(p.topic)})` : ''}`, `*Decision:* ${esc(p.decision)}`, `*Why:* ${esc(p.why)}`,
      ...(p.replaces ? [`_Replaces #${p.replaces}${c ? `: ${esc(c.decision).slice(0, 200)}` : ''}_`] : []), ...(p.brain_key ? [`_Brain row: ${esc(p.brain_key)}_`] : [])].join('\n');
  }
  if (kind === 'hypothesis') {
    const l = labelsOf(p.labels);
    return [`:test_tube: *${p.kind === 'test' ? 'Test' : 'Hypothesis'} to record*`, esc(p.claim), ...(l ? [`_Labels: ${l}_`] : []),
      ...(p.kind === 'test' ? [`_Started ${p.started}${p.ended ? `, ends ${p.ended}` : ''}_`] : [])].join('\n');
  }
  return [`:straight_ruler: *Grade hypothesis #${p.id}: ${p.verdict}*`, ...(c ? [esc(c.claim)] : []), `*Why:* ${esc(p.why)}`].join('\n');
}
export function recordCardBlocks({ id, kind, payload, context, asked_by }) {
  return [
    section(recordText({ kind, payload, context })),
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${asked_by ? `From <@${asked_by}>'s message. ` : ''}Nothing is recorded until an operator taps Record.` }] },
    { type: 'actions', block_id: cut(`record:${id}`, LIMITS.blockId), elements: [
      { type: 'button', action_id: 'record_apply', style: 'primary', text: { type: 'plain_text', text: 'Record' }, value: JSON.stringify({ id }) },
      { type: 'button', action_id: 'record_dismiss', text: { type: 'plain_text', text: 'Dismiss' }, value: JSON.stringify({ id }) },
    ] },
  ];
}

// A question for the team. The answer buttons carry the answer itself, so each answer is cut to
// fit a button value with its key.
export function askTeamBlocks({ question, key, options }) {
  const blocks = [section(`:raising_hand: *Question for the team*\n${question}`)];
  if (options.length) {
    blocks.push({ type: 'actions', block_id: cut(`ask:${key}`, LIMITS.blockId), elements: options.slice(0, 4).map((o, i) => ({
      type: 'button', action_id: `team_answer_${i}`, text: { type: 'plain_text', text: cut(o, 70) }, value: cut(JSON.stringify({ key, answer: cut(o, 300) }), LIMITS.value),
    })) });
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: options.length ? 'Tap an answer, or reply in the thread.' : 'Reply in the thread and mention me.' }] });
  return blocks;
}

// An order waiting for an operator's tap. `line` names the exact change (orders.mjs).
export function orderCardBlocks(order, line) {
  return [
    section(`:pencil: *To confirm* (asked by <@${order.by}>)\n${line}`),
    { type: 'context', elements: [{ type: 'mrkdwn', text: 'Nothing changes until an operator taps Confirm. The daily budget ceiling still applies. This card expires in a day.' }] },
    { type: 'actions', block_id: cut(`order:${order.id}`, LIMITS.blockId), elements: [
      { type: 'button', action_id: 'order_confirm', style: 'primary', text: { type: 'plain_text', text: 'Confirm' }, value: JSON.stringify({ id: order.id }) },
      { type: 'button', action_id: 'order_cancel', text: { type: 'plain_text', text: 'Cancel' }, value: JSON.stringify({ id: order.id }) },
    ] },
  ];
}
export const orderDoneBlocks = (line, statusLine) => [section(`${line}\n${statusLine}`)];
