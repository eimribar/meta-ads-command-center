// Calls to Claude. One request shape for every caller: adaptive thinking at the configured
// effort, a cached system prompt, and a tool loop that runs the agent's own tools locally.
import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from './config.mjs';
import { rt } from './runtime.mjs';
import { redact } from './redact.mjs';

const MIN_MAX_TOKENS = 32_000;   // adaptive thinking shares this budget with the answer
const RETRY_MAX_TOKENS = 64_000; // one retry when a tool call was cut off at the limit

function client() {
  if (!rt.anthropic) rt.anthropic = new Anthropic({ apiKey: getConfig().ANTHROPIC_API_KEY, maxRetries: 3 });
  return rt.anthropic;
}

const isLocal = (t) => !t.type || t.type === 'custom';

// system: string or list of strings. The first part is cached; later parts (live context) are not.
export function requestBody({ system, messages, tools = [], maxTokens = 0, outputConfig = null, mustCall = null }) {
  const cfg = getConfig();
  const parts = (Array.isArray(system) ? system : [system]).filter(Boolean);
  const must = mustCall ? `\n\nFinish by calling the ${mustCall} tool. Do not answer in plain text.` : '';
  const sys = parts.map((text, i) => ({ type: 'text', text: i === 0 ? text + must : text, ...(i === 0 ? { cache_control: { type: 'ephemeral' } } : {}) }));
  return {
    model: cfg.MODEL,
    max_tokens: Math.max(MIN_MAX_TOKENS, maxTokens),
    thinking: { type: 'adaptive' },
    output_config: { ...(outputConfig || {}), effort: cfg.MODEL_EFFORT },
    system: sys,
    messages,
    ...(tools.length ? {
      tools: tools.map((t) => (isLocal(t) ? { name: t.name, description: t.description || '', input_schema: t.input_schema || { type: 'object' } } : t)),
    } : {}),
  };
}

async function call(body) {
  const msg = await client().messages.stream(body).finalMessage();
  const u = msg.usage || {};
  console.log(`[claude] ${msg.model} in=${u.input_tokens || 0} cached=${u.cache_read_input_tokens || 0} out=${u.output_tokens || 0} stop=${msg.stop_reason}`);
  // A refusal is an answer, not a failure: the caller says plainly that the request was declined.
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('Claude declined this request'), { declined: true });
  return msg;
}

export const textOf = (msg) => (msg?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

// One call, no local tools run. Returns the message.
export async function complete({ system, messages, maxTokens, outputConfig }) {
  return call(requestBody({ system, messages, maxTokens, outputConfig }));
}

// The tool loop. The assistant turn (thinking blocks included) goes back unchanged, followed by
// the tool results. Tool errors go back to Claude as { ok:false, error } so it can recover.
// `done()` ends the loop early (the optimizer stops once its proposal tool was called).
// Web search can be turned off for an Anthropic organization in the Claude Console. Then a request
// that offers it fails; the agent drops it for the rest of the process and says so once.
let webSearchRefused = false;
const isWebSearch = (t) => String(t?.type || '').startsWith('web_search');

export async function runTools({ system, messages, tools: given = [], maxIterations = 24, maxTokens, mustCall = null, done = () => false }) {
  let tools = webSearchRefused ? given.filter((t) => !isWebSearch(t)) : given;
  const local = new Map(tools.filter(isLocal).map((t) => [t.name, t]));
  const state = structuredClone(messages);
  const seen = new Set();
  let last = null, nudged = false, budget = maxTokens, grown = false;
  const ask = async () => {
    try { return await call(requestBody({ system, messages: state, tools, maxTokens: budget, mustCall })); }
    catch (e) {
      if (e?.status !== 400 || !/web.?search/i.test(String(e?.message)) || !tools.some(isWebSearch)) throw e;
      webSearchRefused = true;
      tools = tools.filter((t) => !isWebSearch(t));
      console.warn('[claude] web search is turned off for this Anthropic organization; answering without it (set WEB_RESEARCH_ENABLED=false to stop offering it)');
      return call(requestBody({ system, messages: state, tools, maxTokens: budget, mustCall }));
    }
  };
  for (let n = 0; n < maxIterations; n++) {
    last = await ask();
    // A tool call cut off at the token limit has incomplete input: it is never run. One retry
    // with more room; if that is cut off too, the turn fails with a plain reason.
    if (last.stop_reason === 'max_tokens' && last.content?.some((b) => b.type === 'tool_use')) {
      if (grown) throw new Error('Claude ran out of room before it finished a tool call; ask for less at once');
      grown = true;
      budget = Math.max(RETRY_MAX_TOKENS, maxTokens || 0);
      last = await ask();
      if (last.stop_reason === 'max_tokens' && last.content?.some((b) => b.type === 'tool_use')) throw new Error('Claude ran out of room before it finished a tool call; ask for less at once');
    }
    state.push({ role: 'assistant', content: last.content });
    if (last.stop_reason === 'pause_turn') continue;        // a server tool (web search) wants another turn
    const calls = last.content.filter((b) => b.type === 'tool_use');
    if (!calls.length) {
      if (mustCall && !done() && !nudged) { nudged = true; state.push({ role: 'user', content: `Call the ${mustCall} tool now.` }); continue; }
      return { message: last, messages: state };
    }
    const results = [];
    for (const c of calls) {
      if (seen.has(c.id)) throw new Error('Repeated tool call id; refused');
      seen.add(c.id);
      let result;
      try {
        const t = local.get(c.name);
        if (!t) throw new Error(`unknown tool ${c.name}`);
        if (n === maxIterations - 1) throw new Error('tool budget used up; not run');
        result = await t.run(t.parse ? t.parse(c.input) : c.input);
      } catch (e) {
        result = { ok: false, error: String(e?.message || e).slice(0, 400) };
      }
      // Whatever a tool returned, tokens and keys never reach Claude (or, through it, Slack).
      results.push({ type: 'tool_result', tool_use_id: c.id, content: redact(typeof result === 'string' ? result : JSON.stringify(result ?? null)) });
    }
    state.push({ role: 'user', content: results });
    if (done()) return { message: last, messages: state };
  }
  return { message: last, messages: state, exhausted: true };
}
