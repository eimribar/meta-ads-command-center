// Who and what a piece of work is running for, carried through async calls.
//   execution: { actor, kind, key }  actor = Slack user id or null; kind = chat | approval | order |
//              scheduled | cli; key = a durable identity for the write journal.
//   effects:   the list of account actions a chat turn performed, for the receipt footer.
import { AsyncLocalStorage } from 'node:async_hooks';

const execution = new AsyncLocalStorage();
export const withExecution = (ctx, fn) => execution.run({ ...(execution.getStore() || {}), ...ctx }, fn);
export const currentExecution = () => execution.getStore() || null;

const effects = new AsyncLocalStorage();
export const withEffects = (list, fn) => effects.run(list, fn);
export function reportEffect(tool, ids, summary) {
  const sink = effects.getStore();
  if (Array.isArray(sink)) sink.push({ tool, ids, summary });
}
export function reportBlocked(tool, reason) {
  const sink = effects.getStore();
  if (Array.isArray(sink)) sink.push({ tool, blocked: String(reason).slice(0, 160) });
}

// The footer under every chat reply, built from what the tools actually did, never from the
// model's own words.
export function buildReceiptFooter(list = []) {
  const done = list.filter((e) => !e.blocked);
  const blocked = list.filter((e) => e.blocked);
  const lines = [];
  if (done.length) lines.push(`_Actions this turn: ${done.map((e) => e.summary).join('; ')}_`);
  if (blocked.length) lines.push(`_Not done: ${blocked.map((e) => `${e.tool} (${e.blocked})`).join('; ')}_`);
  if (!lines.length) lines.push('_No account changes this turn (read only)._');
  return lines.join('\n');
}
