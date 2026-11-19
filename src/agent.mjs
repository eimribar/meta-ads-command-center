// One chat turn: the rules, the business context and live grounding, the tools this person may
// use, the tool loop, and the receipt footer built from what the tools actually did.
import { runTools, textOf } from './reasoning.mjs';
import { OPERATING_RULES, CHAT_RULES } from './prompts.mjs';
import { brainBlock } from './brain.mjs';
import { allTools } from './tools.mjs';
import { toolsForActor, isOperator, LOCAL_OPERATOR } from './auth.mjs';
import { withExecution, withEffects, buildReceiptFooter } from './context.mjs';
import { metricSpec } from './metrics.mjs';
import { policy, refreshPolicy } from './optimizer/policy.mjs';
import { today, timezone } from './clock.mjs';
import { db } from './runtime.mjs';
import { money, currency } from './money.mjs';

async function grounding({ actor }) {
  await refreshPolicy().catch(() => {});
  const spec = metricSpec();
  const p = policy();
  const open = await db().select('actions_log', { where: { disposition: { in: ['proposed', 'escalated'] } }, limit: 50 }).catch(() => []);
  const facts = [
    `Today is ${today()} (${timezone()}).`,
    `Result event: ${spec.result.label}${spec.secondary ? `; secondary event: ${spec.secondary.label}` : ''}.`,
    `Currency: ${currency() || 'unknown'} (every amount is in the ad account's currency).`,
    `Target cost per ${spec.result.label}: ${p.target ? money(p.target) : 'not set'}. Daily budget ceiling: ${p.maxDailyBudget ? money(p.maxDailyBudget) : 'not set (budget changes are off)'}.`,
    `Open approval cards: ${open.length}.`,
    `The person asking ${isOperator(actor) ? 'is an operator' : 'is not an operator (read only)'}.`,
  ];
  return `# NOW\n${facts.join('\n')}`;
}

// Who wrote a message, for the model: several people share a thread, and only an operator's
// words can lead to a change (and even then only through a card an operator taps).
export function authored(m) {
  if (m.role !== 'user') return String(m.content);
  if (m.author === null) return `From someone with read only access: ${m.content}`;
  if (!m.author) return `From a teammate (who is not recorded): ${m.content}`;
  const who = m.author === LOCAL_OPERATOR ? 'the operator at the terminal' : `<@${m.author}>`;
  return `From ${who} (${m.operator ? 'an operator' : 'not an operator'}): ${m.content}`;
}

// history: [{role, content, author?, operator?}] ending with the new user message.
export async function ask(history, { extra = '', actor = null, thread = null, key = null } = {}) {
  const effects = [];
  const tools = toolsForActor(allTools(), actor);
  const [business, now] = await Promise.all([brainBlock(), grounding({ actor })]);
  // Live context rides in the first block of the last user message, so the system prompt stays
  // byte identical and cached.
  const given = history.map((m, i) => (i === history.length - 1 && m.role === 'user' && m.author === undefined ? { ...m, author: actor, operator: isOperator(actor) } : m));
  const msgs = given.map((m) => ({ role: m.role, content: authored(m) }));
  const last = msgs[msgs.length - 1];
  const words = String(given[given.length - 1].content);
  last.content = [{ type: 'text', text: [now, extra].filter(Boolean).join('\n\n') }, { type: 'text', text: last.content }];
  // `words` is the person's own message, kept with any order it leads to.
  const { message } = await withExecution({ actor, kind: 'chat', thread, key: key || `chat:${Date.now()}`, words: words.slice(0, 500) }, () => withEffects(effects, () => runTools({
    system: [`${OPERATING_RULES}\n\n${CHAT_RULES}`, business],
    messages: msgs,
    tools,
  })));
  const answer = textOf(message) || 'I could not finish an answer for that. Try asking again, maybe more narrowly.';
  return { text: `${answer.replace(/~(?=[\p{Sc}\d])/gu, 'about ')}\n\n${buildReceiptFooter(effects)}`, answer, effects };
}
