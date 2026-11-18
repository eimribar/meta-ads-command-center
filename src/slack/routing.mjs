// Which Slack messages the agent answers.
//   - a mention of the app, anywhere it is a member (the app_mention event)
//   - a direct message to the app
//   - a reply in a channel thread the app started, was mentioned in or answered in, without a
//     new mention. A reply that mentions someone else (and not the app) is left alone: it is
//     meant for that person.

const mentions = (text, id) => new RegExp(`<@${id}(\\|[^>]*)?>`).test(String(text || ''));

// What to do with one `message` event. Returns 'dm', 'thread' (answer it if the thread is the
// app's, see threadIsOurs) or 'ignore'.
export function classifyMessage(m, { botUserId, botId } = {}) {
  if (!m || (m.subtype && m.subtype !== 'thread_broadcast') || m.bot_id) return 'ignore';
  if (botUserId && m.user === botUserId) return 'ignore';
  if (m.channel_type === 'im') return 'dm';
  if (!['channel', 'group'].includes(m.channel_type)) return 'ignore';
  if (!m.thread_ts || m.thread_ts === m.ts) return 'ignore';           // not a thread reply
  const text = String(m.text || '');
  if (botUserId && mentions(text, botUserId)) return 'ignore';          // app_mention answers it
  if (/<@[UW][A-Z0-9]+(\|[^>]*)?>/.test(text)) return 'ignore';         // meant for someone else
  return 'thread';
}

// True when the thread was started by the app, mentions it, or has a reply from it.
// `messages` is conversations.replies for the thread (the parent first).
export function threadIsOurs(messages, { botUserId, botId } = {}) {
  return (messages || []).some((m) => (botUserId && m.user === botUserId) || (botId && m.bot_id === botId)
    || (botUserId && mentions(m.text, botUserId)));
}

// A small memory of thread answers, so a busy thread costs one lookup, not one per message.
export function threadCache({ ttlMs = 10 * 60_000, max = 500 } = {}) {
  const m = new Map();
  return {
    get(key) { const v = m.get(key); if (!v || Date.now() - v.at > ttlMs) return undefined; return v.ours; },
    set(key, ours) { if (m.size >= max) m.delete(m.keys().next().value); m.set(key, { ours, at: Date.now() }); },
  };
}
