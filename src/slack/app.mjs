// The Slack app: Socket Mode (no public URL needed). Mentions, DMs and replies in the app's own
// threads go to the chat agent (see routing.mjs); commands skip it; buttons and modals are
// operator only.
import bolt from '@slack/bolt';
import { getConfig } from '../config.mjs';
import { rt, db } from '../runtime.mjs';
import { operatorOnlyMiddleware, isOperator } from '../auth.mjs';
import { ask } from '../agent.mjs';
import { handleCommand } from './commands.mjs';
import { registerApprovals } from './approvals.mjs';
import { publishHome } from './home.mjs';
import { runNamedJob } from '../scheduled.mjs';
import { classifyMessage, threadIsOurs, threadCache } from './routing.mjs';
import { firstTime } from '../jobs.mjs';
import { splitForSlack } from '../words.mjs';

const { App, LogLevel, SocketModeReceiver } = bolt;
const MAX_TURNS = 20;
const THINKING = '_checking the account..._';

async function loadHistory(key) {
  const [row] = await db().select('conversations', { where: { convo_key: key } }).catch(() => []);
  return Array.isArray(row?.messages) ? row.messages : [];
}
async function saveHistory(key, messages) {
  await db().upsert('conversations', [{ convo_key: key, messages: messages.slice(-MAX_TURNS), updated_at: new Date().toISOString() }], ['convo_key']).catch(() => {});
}

// Slack lines for the model, each with who wrote it: the agent, an operator or a teammate.
export const fmt = (msgs) => (msgs || [])
  .map((m) => ({ who: m.bot_id ? 'agent' : m.user ? `<@${m.user}>${isOperator(m.user) ? ', operator' : ''}` : 'teammate', t: String(m.text || '').replace(/<@[^>]+>/g, '').trim() }))
  .filter((m) => m.t && m.t !== THINKING)
  .map((m) => `[${m.who}] ${m.t.length > 600 ? `${m.t.slice(0, 600)}...` : m.t}`);

// Recent channel and thread messages, as evidence (not instructions).
async function slackContext(client, channel, threadTs) {
  const parts = [];
  try {
    const h = await client.conversations.history({ channel, limit: 20 });
    const lines = fmt((h.messages || []).slice().reverse());
    if (lines.length) parts.push(`# RECENT CHANNEL MESSAGES (context only)\n${lines.join('\n')}`);
  } catch (e) { console.error(`[chat] channel history unavailable (${e?.data?.error || e?.message})`); }
  if (threadTs) {
    try {
      const r = await client.conversations.replies({ channel, ts: threadTs, limit: 40 });
      const lines = fmt(r.messages || []);
      if (lines.length) parts.push(`# THIS THREAD (the question refers to it)\n${lines.join('\n')}`);
    } catch (e) { console.error(`[chat] thread unavailable (${e?.data?.error || e?.message})`); }
  }
  return parts.join('\n\n');
}

// Post an answer: the first part replaces the placeholder, the rest follow in the thread. The
// receipt footer is on the last part, so it always shows.
export async function postAnswer(client, { channel, ts, threadTs }, text) {
  const parts = splitForSlack(text);
  await client.chat.update({ channel, ts, text: parts[0] });
  for (const p of parts.slice(1)) await client.chat.postMessage({ channel, thread_ts: threadTs || ts, text: p });
  return parts.length;
}

// Returns { app, socket }: socket is the Socket Mode client, for its connection state.
export async function createSlackApp() {
  const cfg = getConfig();
  const receiver = new SocketModeReceiver({ appToken: cfg.SLACK_APP_TOKEN, logLevel: LogLevel.WARN });
  // Initialized here, not in the constructor, so a failure is an error this function throws.
  const app = new App({ token: cfg.SLACK_BOT_TOKEN, receiver, logLevel: LogLevel.WARN, deferInitialization: true });
  await app.init();
  app.use(operatorOnlyMiddleware());
  rt.slack = app.client;
  const me = await app.client.auth.test();
  const ids = { botUserId: me.user_id, botId: me.bot_id };
  const ours = threadCache();

  // msgTs is the person's own message: the key every write in this turn is journaled under, so a
  // redelivered event can never apply anything twice.
  async function respond(client, { channel, threadTs, user, convoKey, msgTs }, text) {
    if (!text?.trim()) return;
    const history = await loadHistory(convoKey);
    const said = { role: 'user', content: text, author: user || null, operator: isOperator(user) };
    let ph;
    try {
      const extra = await slackContext(client, channel, threadTs);
      ph = await client.chat.postMessage({ channel, thread_ts: threadTs, text: THINKING });
      const out = await ask([...history, said], { extra, actor: user, thread: { channel, thread_ts: threadTs || ph.ts }, key: `chat:${channel}:${msgTs || ph.ts}` });
      await postAnswer(client, { channel, ts: ph.ts, threadTs }, out.text);
      if (threadTs) ours.set(`${channel}:${threadTs}`, true);
      await saveHistory(convoKey, [...history, said, { role: 'assistant', content: out.answer }]);
    } catch (e) {
      console.error('[chat] error:', String(e?.message || e).slice(0, 300));
      const msg = e?.declined
        ? ':no_entry_sign: Claude declined that request, so I have no answer for it. Ask it another way, or ask something else.'
        : ':warning: I hit an error answering that. The details are in my logs; try again in a moment.';
      if (ph) await client.chat.update({ channel, ts: ph.ts, text: msg }).catch(() => {});
      else await client.chat.postMessage({ channel, thread_ts: threadTs, text: msg }).catch(() => {});
    }
  }

  async function onText(client, { channel, threadTs, user, text, convoKey, msgTs }) {
    // Slack can deliver the same event twice (a reconnect, a retry): answer it once.
    if (msgTs && !(await firstTime(`slack:${channel}:${msgTs}`).catch(() => true))) return;
    const reply = (payload) => client.chat.postMessage({ channel, thread_ts: threadTs, ...(typeof payload === 'string' ? { text: payload } : payload) });
    const jobs = {
      report: async () => { await reply('_Building the report..._'); const r = await runNamedJob('report', { force: true }); await reply(r?.summary ? `Posted under today's desk: ${r.summary}.` : 'Done.'); },
      optimize: async () => {
        await reply('_Running the optimizer..._');
        const r = await runNamedJob('optimizer-check', { force: true });
        if (r?.off || r?.held) { await reply(r.summary); return; }
        const auto = Number(r?.auto) || 0;
        await reply(`Optimizer: ${r?.summary || 'done'}. The cards are in today's desk thread${auto ? `, with the ${auto === 1 ? 'move that was' : `${auto} moves that were`} applied on their own (the ladder is on auto)` : ''}.`);
      },
      moderation: async () => { await reply('_Sweeping comments..._'); const r = await runNamedJob('moderation', { force: true }); await reply(`Comment sweep: ${r?.summary || 'done'}.`); },
    };
    try { if (await handleCommand({ text, user, reply, jobs })) return; }
    catch (e) { console.error('[command] failed:', String(e?.message || e).slice(0, 200)); await reply(`:warning: That command failed: ${String(e?.message || e).slice(0, 160)}`).catch(() => {}); return; }
    await respond(client, { channel, threadTs, user, convoKey, msgTs }, text);
  }

  app.event('app_mention', async ({ event, client }) => {
    const text = String(event.text || '').replace(/<@[^>]+>/g, '').trim();
    const threadTs = event.thread_ts || event.ts;
    ours.set(`${event.channel}:${threadTs}`, true);
    await onText(client, { channel: event.channel, threadTs, user: event.user, text, convoKey: `t:${event.channel}:${threadTs}`, msgTs: event.ts });
  });

  app.message(async ({ message, client }) => {
    const kind = classifyMessage(message, ids);
    if (kind === 'dm') {
      await onText(client, { channel: message.channel, threadTs: message.thread_ts, user: message.user, text: String(message.text || '').trim(), convoKey: `dm:${message.channel}`, msgTs: message.ts });
      return;
    }
    if (kind !== 'thread') return;
    // A reply in a channel thread, with no mention: answer it when the thread is the app's.
    const key = `${message.channel}:${message.thread_ts}`;
    let mine = ours.get(key);
    if (mine === undefined) {
      const r = await client.conversations.replies({ channel: message.channel, ts: message.thread_ts, limit: 100 }).catch(() => null);
      mine = threadIsOurs(r?.messages, ids);
      ours.set(key, mine);
    }
    if (!mine) return;
    await onText(client, { channel: message.channel, threadTs: message.thread_ts, user: message.user, text: String(message.text || '').trim(), convoKey: `t:${message.channel}:${message.thread_ts}`, msgTs: message.ts });
  });

  app.event('app_home_opened', async ({ event, client }) => {
    if (event.tab !== 'home') return;
    await publishHome(client, event.user).catch((e) => console.error('[home] publish failed:', String(e?.message || e).slice(0, 160)));
  });

  registerApprovals(app);
  app.error(async (e) => console.error('[slack] handler error:', String(e?.message || e).slice(0, 200)));
  return { app, socket: receiver.client };
}

export { isOperator };
