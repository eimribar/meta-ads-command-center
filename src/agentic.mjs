// Cards the agent raises on its own: a proposed brain update (Apply / Dismiss), a question for
// the team (answer buttons), and the self-diagnosis posted when the optimizer freezes.
import { rt } from './runtime.mjs';
import { getConfig } from './config.mjs';
import { complete, textOf } from './reasoning.mjs';
import { OPERATING_RULES, BRAIN_UPDATE_RULES, FREEZE_RULES } from './prompts.mjs';
import { checkName, getBrain } from './brain.mjs';
import { checkBrainRow } from './brain-rules.mjs';
import { brainCardBlocks, askTeamBlocks } from './slack/cards.mjs';
import { setState, postOnce } from './jobs.mjs';
import { currentExecution } from './context.mjs';

async function post(text, blocks) {
  if (!rt.slack) throw new Error('Slack is not connected');
  const thread = currentExecution()?.thread;
  return rt.slack.chat.postMessage({ channel: thread?.channel || getConfig().SLACK_CHANNEL, ...(thread?.thread_ts ? { thread_ts: thread.thread_ts } : {}), text, blocks });
}

export async function proposeBrainUpdate({ scope, key, content, why }) {
  checkName(scope, key);
  content = checkBrainRow(scope, key, content);   // a row the code would ignore is refused here, before any card
  const current = await getBrain(scope, key).catch(() => null);
  let line = why || '';
  try {
    const msg = await complete({
      system: `${OPERATING_RULES}\n\n${BRAIN_UPDATE_RULES}`,
      messages: [{ role: 'user', content: `Row: ${scope}/${key}\nNow: ${JSON.stringify(current)}\nProposed: ${JSON.stringify(content)}\nWhy: ${why || 'n/a'}` }],
      maxTokens: 2000,
    });
    line = textOf(msg) || line;
  } catch { /* keep the given reason */ }
  const id = `${Date.now().toString(36)}`;
  await setState(`brain_proposal/${id}`, { scope, key, content, why: line, by: currentExecution()?.actor || 'agent' });
  const r = await post(`Brain update proposed: ${scope}/${key}`, brainCardBlocks({ id, scope, key, content, current, why: line }));
  return { ok: true, posted: true, proposal_id: id, ts: r.ts };
}

export async function askTeam({ question, key, options = [] }) {
  checkName('answers', key);
  // A question is asked once: an answered one returns its answer, an open one is not posted again.
  const known = await getBrain('answers', key).catch(() => null);
  if (known != null) return { ok: true, posted: false, answer: known, note: `Already answered (answers/${key}).` };
  if (!(await postOnce(`ask/${key}`, 24 * 7))) return { ok: true, posted: false, note: `Already asked this week and not answered yet (answers/${key}).` };
  const opts = options.slice(0, 4).map((o) => String(o).slice(0, 70));
  const r = await post(`Question for the team: ${question}`, askTeamBlocks({ question, key, options: opts }));
  return { ok: true, posted: true, ts: r.ts, note: `Answers are saved to the brain as answers/${key}.` };
}

export async function freezeDiagnosis(reasons, evidence) {
  try {
    const msg = await complete({
      system: `${OPERATING_RULES}\n\n${FREEZE_RULES}`,
      messages: [{ role: 'user', content: `Reasons:\n${(reasons || []).join('\n')}\n\nEvidence:\n${JSON.stringify(evidence || {}).slice(0, 6000)}` }],
      maxTokens: 2000,
    });
    return textOf(msg);
  } catch { return ''; }
}
