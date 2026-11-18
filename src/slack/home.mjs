// The App Home tab: a small dashboard rebuilt every time someone opens it.
import { db } from '../runtime.mjs';
import { metricSpec } from '../metrics.mjs';
import { policy, refreshPolicy, ACTION_PHRASES, MODE_WORDS } from '../optimizer/policy.mjs';
import { ladder } from '../optimizer/executor.mjs';
import { loopHealth, openIncidents, getState } from '../jobs.mjs';
import { daysAgo } from '../clock.mjs';
import { isOperator } from '../auth.mjs';
import { approvalBlocks } from './cards.mjs';
import { money } from '../money.mjs';
import { getConfig } from '../config.mjs';
import { plural } from '../words.mjs';

const optimizerOff = () => { try { return getConfig().OPTIMIZER_ENABLED === false; } catch { return false; } };

const fmt = money;

export async function buildHome(userId) {
  await refreshPolicy().catch(() => {});
  const p = policy();
  const spec = metricSpec();
  const since = daysAgo(7);
  const [rows, open, health, incidents, lad, freeze] = await Promise.all([
    db().select('performance_daily', { where: { level: 'campaign', date: { gte: since } } }).catch(() => []),
    db().select('actions_log', { where: { disposition: { in: ['proposed', 'escalated'] } }, order: 'id desc', limit: 10 }).catch(() => []),
    loopHealth(), openIncidents(), ladder().catch(() => []), getState('optimizer/freeze').catch(() => null),
  ]);
  const spend = rows.reduce((s, r) => s + Number(r.spend || 0), 0);
  const results = rows.reduce((s, r) => s + Number(r.results || 0), 0);
  const sec = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Ads Command Center' } },
    sec(`*Last 7 days (stored)*: ${fmt(spend)} spent · ${results} ${spec.result.label}${results ? ` at ${fmt(spend / results)} each` : ''}\n*Target*: ${p.target ? fmt(p.target) : 'not set'} per ${spec.result.label} · *Daily ceiling*: ${p.maxDailyBudget ? fmt(p.maxDailyBudget) : 'not set'}`),
    sec(optimizerOff() ? ':no_entry: *Optimizer off* (OPTIMIZER_ENABLED=false in the settings)' : freeze?.on ? `:snowflake: *Optimizer frozen* by ${freeze.by || 'an operator'}${freeze.note ? `: "${freeze.note}"` : ''}` : ':white_check_mark: Optimizer on'),
    { type: 'divider' },
    sec(`*Waiting for approval (${open.length})*${open.length ? '' : '\n_nothing_'}`),
    ...(isOperator(userId) ? open.flatMap((a) => approvalBlocks(a)) : open.map((a) => sec(`• #${a.id} ${ACTION_PHRASES[a.action_type] || a.action_type.replace(/_/g, ' ')}: ${a.target_name || a.target_id}`))),
    sec(`*Open issues (${incidents.length})*\n${incidents.slice(0, 5).map((i) => `• ${i.text.slice(0, 150)}`).join('\n') || '_none_'}`),
    sec(`*Which moves wait for a person*\n${lad.map((l) => `• ${ACTION_PHRASES[l.action_type] || l.action_type}: *${MODE_WORDS[l.mode] || l.mode}*${l.locked ? ' (always)' : ''}`).join('\n')}`),
    sec(`*Jobs*\n${health.map((h) => `• ${h.loop}: ${h.consecutive_failures ? `:warning: ${plural(h.consecutive_failures, 'failure')}` : 'ok'}${h.last_ok_at ? `, last ok ${h.last_ok_at.slice(0, 16).replace('T', ' ')} UTC` : ''}`).join('\n') || '_no runs yet_'}`),
    { type: 'context', elements: [{ type: 'mrkdwn', text: isOperator(userId) ? 'You are an operator. Mention me in the channel or DM me; send "help" for commands.' : 'You can ask me anything about the account. Changes need an operator.' }] },
  ];
  return { type: 'home', blocks };
}

export async function publishHome(client, userId) {
  await client.views.publish({ user_id: userId, view: await buildHome(userId) });
}
