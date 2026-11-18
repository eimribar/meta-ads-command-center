// Public actions on the Page and Instagram: comment reply, hide, unhide and delete, and DM
// replies. Each one needs confirm:true, which the chat sets only after a person in the thread
// approved the exact text or action. The moderation sweep passes confirm itself for hides.
// These are not ad account writes, so they are logged to moderation_log, not the write journal.
import { graphPostRaw, graphDeleteRaw, pageToken, instagramUserId, graph } from './meta.mjs';
import { getConfig } from './config.mjs';
import { db } from './runtime.mjs';

const need = (cond, msg) => { if (!cond) throw new Error(msg); };
const tokenFor = async (platform) => (platform === 'instagram' ? getConfig().META_ACCESS_TOKEN : (await pageToken()) || getConfig().META_ACCESS_TOKEN);

export async function commentAction({ platform = 'facebook', comment_id, action, message = null, confirm = false }) {
  try {
    need(comment_id, 'comment_id is required');
    need(['reply', 'hide', 'unhide', 'delete'].includes(action), 'action must be reply, hide, unhide or delete');
    if (action === 'reply') need(message && message.trim(), 'a reply needs its text');
    need(confirm === true, 'This is public. Show the exact action and text in the thread, and call again with confirm:true only after a person approves it.');
    const ig = platform === 'instagram';
    const token = await tokenFor(platform);
    let result;
    if (action === 'reply') result = await graphPostRaw(ig ? `${comment_id}/replies` : `${comment_id}/comments`, { message }, { token });
    else if (action === 'delete') result = await graphDeleteRaw(comment_id, {}, { token });
    else result = await graphPostRaw(comment_id, ig ? { hide: action === 'hide' } : { is_hidden: action === 'hide' }, { token });
    return { ok: true, platform, action, comment_id, result: { id: result?.id ?? null, success: result?.success ?? true } };
  } catch (e) { return { ok: false, error: String(e.message).slice(0, 300) }; }
}

// Reply to a person who messaged the Page (Messenger or Instagram). Meta only allows replies
// within 24 hours of their last message.
export async function sendMessage({ platform = 'facebook', recipient_id, text, confirm = false }) {
  try {
    need(recipient_id, 'recipient_id is required (the fromId in the conversation)');
    need(text && text.trim(), 'text is required');
    need(confirm === true, 'This message goes out to a person. Show the exact text in the thread, and call again with confirm:true only after a person approves it.');
    const pageId = getConfig().META_PAGE_ID;
    need(pageId, 'META_PAGE_ID is not set');
    const token = await pageToken();
    const node = platform === 'instagram' ? `${(await instagramUserId()) || pageId}/messages` : `${pageId}/messages`;
    const body = { recipient: { id: recipient_id }, message: { text }, messaging_type: 'RESPONSE' };
    const r = await graphPostRaw(node, body, { token });
    return { ok: true, platform, recipient_id, message_id: r.message_id ?? null };
  } catch (e) { return { ok: false, error: String(e.message).slice(0, 300), hint: 'Meta blocks replies more than 24 hours after the person\'s last message.' }; }
}

// What a comment says, read before acting (a delete removes it).
export async function commentContext(platform, commentId) {
  try {
    if (platform === 'instagram') {
      const c = await graph(commentId, { fields: 'text,username,timestamp' });
      return { text: c.text, user: c.username };
    }
    const c = await graph(commentId, { fields: 'message,from{name},permalink_url' }, { token: await pageToken() });
    return { text: c.message, user: c.from?.name, permalink: c.permalink_url };
  } catch { return {}; }
}

export async function logModeration(entry) {
  await db().upsert('moderation_log', [{ at: new Date().toISOString(), ...entry }], ['platform', 'comment_id', 'action']).catch(() => {});
}
