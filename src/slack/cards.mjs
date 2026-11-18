// Slack Block Kit for every card. Button values carry only an id; handlers re-read the row.
import { money } from '../money.mjs';

export const VERB = { pause_ad: 'Pause ad', unpause_ad: 'Re-activate ad', scale_budget: 'Raise budget', descale_budget: 'Trim budget' };
const ICON = { pause_ad: ':double_vertical_bar:', unpause_ad: ':arrow_forward:', scale_budget: ':chart_with_upwards_trend:', descale_budget: ':chart_with_downwards_trend:' };
// Non-budget moves can be approved together; budget moves are one tap each, with the stale guard.
export const BATCH_SAFE = new Set(['pause_ad', 'unpause_ad']);

const label = (a) => a.target_name || a.target_id;
const budgetMove = (a) => (a.after?.dailyBudget != null ? `  \`${a.before?.dailyBudget != null ? money(a.before.dailyBudget) : '?'} to ${money(a.after.dailyBudget)} a day\`` : '');
const head = (a) => `${ICON[a.action_type] || ''} *${VERB[a.action_type] || a.action_type}: ${label(a)}*${budgetMove(a)}`;
const plain = (s, n = 150) => String(s || '').replace(/[*_~`]/g, '').slice(0, n);

export function approvalBlocks(a) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `${head(a)}\n${a.explain || a.reason || ''}` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `#${a.id}${a.disposition === 'escalated' ? ' · needs a person' : ''}` }] },
    { type: 'actions', block_id: `opt:${a.id}`, elements: [
      { type: 'button', action_id: 'opt_approve', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, value: JSON.stringify({ id: a.id }) },
      { type: 'button', action_id: 'opt_reject', style: 'danger', text: { type: 'plain_text', text: 'Reject' }, value: JSON.stringify({ id: a.id }) },
    ] },
  ];
}

export function batchHeaderBlocks(text, pending) {
  const safe = (pending || []).filter((a) => a.id && BATCH_SAFE.has(a.action_type));
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text } }];
  if (safe.length >= 2) {
    blocks.push({ type: 'actions', block_id: 'opt_batch', elements: [{
      type: 'button', action_id: 'opt_approve_all', text: { type: 'plain_text', text: `Approve all ${safe.length} non-budget moves` },
      value: JSON.stringify({ ids: safe.map((a) => a.id).slice(0, 40) }),
      confirm: {
        title: { type: 'plain_text', text: 'Approve all?' },
        text: { type: 'mrkdwn', text: `Applies ${safe.length} pause or re-activate moves. Budget moves are not included.` },
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
      { type: 'section', text: { type: 'mrkdwn', text: `${head(a)}\n${a.explain || ''}` } },
      { type: 'input', block_id: 'why', optional: true,
        label: { type: 'plain_text', text: approve ? 'Why approve? (optional, teaches the agent)' : 'Why reject? (optional, teaches the agent)' },
        element: { type: 'plain_text_input', action_id: 'note', multiline: true } },
    ],
  };
}

export function doneBlocks(a, statusLine) {
  return [{ type: 'section', text: { type: 'mrkdwn', text: `~${plain(VERB[a.action_type] || a.action_type, 40)}: ${plain(label(a), 120)}~\n${statusLine}` } }];
}

export function brainCardBlocks({ id, scope, key, content, current, why }) {
  const show = (c) => (c == null ? '_(empty)_' : `\`\`\`${String(typeof c === 'string' ? c : JSON.stringify(c, null, 1)).slice(0, 1200)}\`\`\``);
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `:brain: *Brain update proposed: \`${scope}/${key}\`*\n${why || ''}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Now*\n${show(current)}\n*Proposed*\n${show(content)}` } },
    { type: 'actions', block_id: `brain:${id}`, elements: [
      { type: 'button', action_id: 'brain_apply', style: 'primary', text: { type: 'plain_text', text: 'Apply' }, value: JSON.stringify({ id }) },
      { type: 'button', action_id: 'brain_dismiss', text: { type: 'plain_text', text: 'Dismiss' }, value: JSON.stringify({ id }) },
    ] },
  ];
}

export function askTeamBlocks({ question, key, options }) {
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: `:raising_hand: *Question for the team*\n${question}` } }];
  if (options.length) {
    blocks.push({ type: 'actions', block_id: `ask:${key}`, elements: options.map((o, i) => ({
      type: 'button', action_id: `team_answer_${i}`, text: { type: 'plain_text', text: o.slice(0, 70) }, value: JSON.stringify({ key, answer: o }),
    })) });
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: options.length ? 'Tap an answer, or reply in the thread.' : 'Reply in the thread and mention me.' }] });
  return blocks;
}
