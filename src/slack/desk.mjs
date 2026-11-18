// The desk: one pinned message a day in the channel. Everything the agent posts on its own goes
// in that message's thread, so the channel stays readable; critical items are also shown in the
// channel. The desk line itself updates in place.
import { rt, db } from '../runtime.mjs';
import { getConfig } from '../config.mjs';
import { today } from '../clock.mjs';
import { getState, setState, openIncidents } from '../jobs.mjs';

async function counts() {
  const [open, incidents] = await Promise.all([
    db().select('actions_log', { where: { disposition: { in: ['proposed', 'escalated'] } } }).catch(() => []),
    openIncidents(),
  ]);
  return { approvals: open.length, incidents: incidents.length };
}

function deskText(day, c) {
  const parts = [`:clipboard: *Desk, ${day}*`, `${c.approvals} waiting for approval`, `${c.incidents} open issue${c.incidents === 1 ? '' : 's'}`];
  return `${parts.join(' · ')}\n_Today's reports, cards and alerts are in this thread._`;
}

// Today's desk message, created on first use.
export async function getDesk(client = rt.slack) {
  const channel = getConfig().SLACK_CHANNEL;
  const day = today();
  const saved = await getState(`desk/${day}`);
  if (saved?.ts) return { channel: saved.channel || channel, ts: saved.ts };
  const c = await counts();
  const msg = await client.chat.postMessage({ channel, text: deskText(day, c) });
  await setState(`desk/${day}`, { ts: msg.ts, channel: msg.channel || channel });
  await client.pins.add({ channel: msg.channel || channel, timestamp: msg.ts }).catch(() => {});
  const prev = await getState('desk/last');
  if (prev?.ts && prev.ts !== msg.ts) await client.pins.remove({ channel: prev.channel || channel, timestamp: prev.ts }).catch(() => {});
  await setState('desk/last', { ts: msg.ts, channel: msg.channel || channel });
  return { channel: msg.channel || channel, ts: msg.ts };
}

export async function updateDesk(client = rt.slack) {
  const saved = await getState(`desk/${today()}`);
  if (!saved?.ts) return;
  await client.chat.update({ channel: saved.channel, ts: saved.ts, text: deskText(today(), await counts()) }).catch(() => {});
}

// Post under today's desk. broadcast:true also shows it in the channel.
export async function postToDesk(payload, { broadcast = false, client = rt.slack } = {}) {
  const desk = await getDesk(client);
  return client.chat.postMessage({ channel: desk.channel, thread_ts: desk.ts, ...(broadcast ? { reply_broadcast: true } : {}), ...payload });
}
