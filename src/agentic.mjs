// Cards the agent raises on its own: a proposed brain update (Apply / Dismiss), a decision,
// hypothesis or grade to record (Record / Dismiss), a question for the team (answer buttons), and
// the self-diagnosis posted when the optimizer freezes.
import { rt } from './runtime.mjs';
import { getConfig } from './config.mjs';
import { complete, textOf } from './reasoning.mjs';
import { OPERATING_RULES, BRAIN_UPDATE_RULES, FREEZE_RULES } from './prompts.mjs';
import { checkName, getBrain } from './brain.mjs';
import { checkBrainRow } from './brain-rules.mjs';
import { brainCardBlocks, askTeamBlocks, recordCardBlocks } from './slack/cards.mjs';
import { checkDecision, checkHypothesis, checkGrade, RecordError } from './record.mjs';
import { db } from './runtime.mjs';
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

// A decision, a hypothesis or a grade the agent heard in the conversation, put on a card. It is
// checked first (a decision without its reason never reaches a card) and written only when an
// operator taps Record; the operator who taps is kept as the one who decided.
export async function proposeRecord(kind, input) {
  let payload, context = null;
  if (kind === 'decision') {
    payload = checkDecision(input);
    if (payload.replaces) {
      const [old] = await db().select('decisions', { where: { id: payload.replaces } });
      if (!old || old.status !== 'active') throw new RecordError(`Decision #${payload.replaces} is not an active decision, so nothing can replace it.`);
      context = old;
    }
  } else if (kind === 'hypothesis') payload = checkHypothesis(input);
  else if (kind === 'grade') {
    payload = checkGrade(input);
    const [h] = await db().select('hypotheses', { where: { id: payload.id } });
    if (!h) throw new RecordError(`There is no hypothesis #${payload.id}.`);
    context = h;
  } else throw new RecordError(`unknown record kind ${kind}`);
  const ex = currentExecution();
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const proposal = { kind, payload, context, asked_by: ex?.actor || null, words: ex?.words || null };
  await setState(`record_proposal/${id}`, proposal);
  const r = await post(`To record: ${kind}`, recordCardBlocks({ id, ...proposal }));
  return { ok: true, posted: true, proposal_id: id, ts: r.ts, note: 'Nothing is recorded yet. The card is posted; it is recorded only when an operator taps Record. Tell the person that, in one line.' };
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
