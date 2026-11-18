// The chat tools. Read tools are open to everyone in the channel; write tools only reach the
// model when an operator asks (see auth.mjs).
import { tool, z } from './tool.mjs';
import * as read from './meta-read.mjs';
import { graph, graphAll, pageToken } from './meta.mjs';
import { getConfig } from './config.mjs';
import { db } from './runtime.mjs';
import { reportEffect, reportBlocked, currentExecution, withExecution } from './context.mjs';
import { isOperator } from './auth.mjs';
import { commentAction, sendMessage, commentContext, logModeration } from './meta-actions.mjs';
import { runModeration, moderationSummary, surfaces } from './moderation.mjs';
import { buildScoreboard } from './scoreboard.mjs';
import { proposeBrainUpdate, askTeam } from './agentic.mjs';
import { ACTION_TYPES } from './optimizer/policy.mjs';
import { timeline } from './jobs.mjs';
import { money } from './money.mjs';

const days = (def, max = 30) => z.number().int().min(1).max(max).default(def);
const campaignArg = z.string().nullable().default(null).describe('a campaign name, part of a name, or id; null for everything in scope');

async function campaignId(text) {
  if (!text) return null;
  const c = await read.resolveCampaign(text);
  if (!c) throw new Error(`no campaign matched "${text}"`);
  return c.id;
}

// ── read tools ─────────────────────────────────────────────────────────────
const HISTORY_TABLES = ['actions_log', 'performance_daily', 'learnings', 'timeline', 'brain', 'brain_history', 'moderation_log', 'incidents', 'loop_health', 'job_runs', 'autonomy_policy'];

export function readTools() {
  const list = [
    tool({ name: 'account_overview', description: 'Spend, clicks and results per campaign per day for the last N days, with totals and cost per result. Use for "how are we doing".',
      input: z.object({ days: days(7) }), run: ({ days: d }) => read.accountOverview(d) }),
    tool({ name: 'campaign_detail', description: 'One campaign: settings (objective, budget, bid strategy, status) and per day numbers.',
      input: z.object({ campaign: z.string().describe('name, part of the name, or id'), days: days(14) }),
      run: async ({ campaign, days: d }) => read.campaignDetail(await campaignId(campaign), d) }),
    tool({ name: 'adset_detail', description: 'Ad sets with status, daily budget, optimization goal, targeting summary and their numbers over the window.',
      input: z.object({ campaign: campaignArg, days: days(14) }), run: async ({ campaign, days: d }) => read.adsetDetail(await campaignId(campaign), d) }),
    tool({ name: 'ad_performance', description: 'Per ad (per creative) numbers over the window, sorted by results. Use for "which ad is winning", "any ad not serving".',
      input: z.object({ campaign: campaignArg, days: days(14) }), run: async ({ campaign, days: d }) => read.adPerformance(await campaignId(campaign), d) }),
    tool({ name: 'breakdown', description: 'Numbers split by age, gender, publisher_platform, platform_position, region, country or impression_device.',
      input: z.object({ by: z.enum(read.BREAKDOWNS).default('publisher_platform'), campaign: campaignArg, days: days(14) }),
      run: async ({ by, campaign, days: d }) => read.breakdown(by, await campaignId(campaign), d) }),
    tool({ name: 'spend_by_time', description: 'Spend and results over time: per day across N days, or per hour for today. Use to see pacing or when something stopped serving.',
      input: z.object({ campaign: campaignArg, mode: z.enum(['daily', 'hourly']).default('daily'), days: days(7) }),
      run: async ({ campaign, mode, days: d }) => read.spendByTime(await campaignId(campaign), mode, d) }),
    tool({ name: 'recent_changes', description: 'What changed on the ad account in the last N days (budget, status, creative and targeting edits) and who changed it.',
      input: z.object({ days: days(3, 14) }), run: ({ days: d }) => read.recentChanges(d) }),
    tool({ name: 'run_insights', description: 'Any read only Insights pull the other tools do not cover: level, window, per day or aggregate, one breakdown, optional custom fields.',
      input: z.object({
        level: z.enum(['account', 'campaign', 'adset', 'ad']).default('campaign'), days: days(14),
        increment: z.union([z.literal(1), z.literal(7)]).nullable().default(null), breakdowns: z.string().nullable().default(null),
        campaign: campaignArg, fields: z.string().nullable().default(null),
      }), run: (args) => read.runInsights(args) }),
    tool({ name: 'graph_query', description: 'Read anything else in the Meta Graph API the token can reach: a node or edge, with fields and parameters. GET only.',
      input: z.object({ path: z.string().describe('for example "<ad_id>/insights" or "<page_id>/posts"'), fields: z.string().nullable().default(null), params: z.record(z.string(), z.any()).default({}), paginate: z.boolean().default(false) }),
      run: async ({ path, fields, params, paginate }) => {
        const p = String(path).replace(/^\/+/, '');
        if (/access_token|debug_token|oauth/i.test(p)) throw new Error('that path is not available');
        const q = { ...params, ...(fields ? { fields } : {}) };
        delete q.access_token;
        return paginate ? { data: await graphAll(p, q, 300) } : graph(p, q);
      } }),
    tool({ name: 'ad_creative', description: 'What an ad shows: its text, headline, call to action, link, image or video, post id, and a shareable preview link.',
      input: z.object({ ad_id: z.string() }), run: ({ ad_id }) => read.adCreative(ad_id) }),
    tool({ name: 'video_retention', description: 'For video ads: plays and how far people watch (25, 50, 75, 100 percent, ThruPlay) as a share of plays, and average watch time.',
      input: z.object({ campaign: campaignArg, days: days(14) }), run: async ({ campaign, days: d }) => read.videoRetention(await campaignId(campaign), d) }),
    tool({ name: 'audiences', description: 'The custom and lookalike audiences in the ad account, with size and delivery status.',
      input: z.object({}), run: () => read.audiences() }),
    tool({ name: 'lead_forms', description: 'The Page\'s instant forms (lead forms), their status and how many leads each collected.',
      input: z.object({}), run: () => read.leadForms() }),
    tool({ name: 'pixel_health', description: 'The dataset (pixel) status, the action types the result event maps to, and every action type the account reported in the last 30 days.',
      input: z.object({}), run: () => read.pixelHealth(30) }),
    tool({ name: 'page_overview', description: 'The Facebook Page: followers and recent posts with comments and reactions.', input: z.object({}), run: () => read.pageOverview() }),
    tool({ name: 'instagram_overview', description: 'The linked Instagram account: followers and recent posts.', input: z.object({}), run: () => read.instagramOverview() }),
    tool({ name: 'recent_comments', description: 'Recent comments on live ads and recent posts, with their ids (needed to reply to or hide one).',
      input: z.object({ limit: z.number().int().min(1).max(100).default(30) }),
      run: async ({ limit }) => {
        const out = [];
        for (const s of (await surfaces()).slice(0, 25)) {
          const edge = s.platform === 'instagram' ? { fields: 'id,text,username,timestamp,hidden' } : { fields: 'id,message,from,created_time,is_hidden' };
          const opts = s.platform === 'facebook' ? { token: await pageToken() } : {};
          const r = await graph(`${s.id}/comments`, { ...edge, limit: 10 }, opts).catch(() => ({ data: [] }));
          for (const c of r.data || []) out.push({ platform: s.platform, on: s.label, comment_id: c.id, by: c.username || c.from?.name, text: c.text || c.message, when: c.timestamp || c.created_time, hidden: c.hidden ?? c.is_hidden ?? false });
        }
        return out.sort((a, b) => String(b.when).localeCompare(String(a.when))).slice(0, limit);
      } }),
    tool({ name: 'inbox', description: 'The Page inbox (Messenger or Instagram): recent conversations, or one full conversation by id. Read a thread before replying to it.',
      input: z.object({ platform: z.enum(['facebook', 'instagram']).default('facebook'), conversation_id: z.string().nullable().default(null), limit: z.number().int().min(1).max(25).default(10) }),
      run: ({ platform, conversation_id, limit }) => (conversation_id ? read.conversation(conversation_id, limit) : read.inbox(platform, limit)) }),
    tool({ name: 'creative_scoreboard', description: 'Every ad that spent in the window ranked against the target with a verdict (winning, on track, behind, losing, too early).',
      input: z.object({ days: days(7) }), run: ({ days: d }) => buildScoreboard({ days: d, limit: 30 }) }),
    tool({ name: 'query_history', description: `The agent's own records (not live Meta): ${HISTORY_TABLES.join(', ')}. Past proposals and the team's decisions are in actions_log.`,
      input: z.object({ table: z.enum(HISTORY_TABLES), where: z.record(z.string(), z.any()).default({}).describe('column to value, or {"gte": value} style operators'), order: z.string().nullable().default(null), limit: z.number().int().min(1).max(200).default(25) }),
      run: ({ table, where, order, limit }) => db().select(table, { where, order: order || undefined, limit }) }),
  ];
  if (getConfig().WEB_RESEARCH_ENABLED) list.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 3 });
  return list;
}

// ── write tools (operators only) ───────────────────────────────────────────
export function writeTools() {
  return [
    tool({ name: 'execute_order', description: 'An operator\'s explicit order, done now: set_status (pause or activate a campaign, ad set or ad), set_budget (daily budget on a campaign or ad set, in the ad account currency), or duplicate_campaign (copied PAUSED; activate only if they said so). The daily budget ceiling applies to every order.',
      input: z.object({
        op: z.enum(['set_status', 'set_budget', 'duplicate_campaign']),
        level: z.enum(['campaign', 'adset', 'ad']).nullable().default(null),
        target_id: z.string().nullable().default(null),
        status: z.enum(['ACTIVE', 'PAUSED']).nullable().default(null),
        daily_budget: z.number().positive().nullable().default(null).describe('the daily budget in the ad account\'s currency, for example 150'),
        source_campaign_id: z.string().nullable().default(null),
        name_suffix: z.string().default('copy'),
        include_paused_ads: z.boolean().default(false),
        activate: z.boolean().default(false),
      }),
      run: async (o) => {
        const ex = currentExecution();
        if (!isOperator(ex?.actor)) { reportBlocked('execute_order', 'not an operator'); return { ok: false, refused: 'direct orders are for operators only; file a proposal instead' }; }
        const w = await import('./meta-write.mjs');
        try {
          const r = await withExecution({ kind: 'order', key: `order:${ex.key}:${JSON.stringify(o)}` }, async () => {
            // Each order is read back from Meta after the write and kept with the operator's words.
            const record = (result) => timeline('order', { op: o.op, level: o.level, target_id: o.target_id || o.source_campaign_id, words: ex.words || null, by: ex.actor, result });
            if (o.op === 'set_status') {
              if (!o.level || !o.target_id || !o.status) throw new Error('set_status needs level, target_id and status');
              const before = await w.currentState(o.level, o.target_id).catch(() => null);
              const res = await w.setStatus(o.level, o.target_id, o.status);
              const after = await w.currentState(o.level, o.target_id).catch(() => null);
              reportEffect('execute_order', [o.target_id], `${o.status === 'PAUSED' ? 'paused' : 'activated'} ${o.level} ${before?.name || o.target_id}`);
              await record({ before: before?.status ?? null, after: after?.status ?? null });
              return { ...res, before: before?.status ?? null, read_back: after ? { status: after.status, configured: after.configured } : 'could not read back' };
            }
            if (o.op === 'set_budget') {
              if (!o.level || !o.target_id || !o.daily_budget) throw new Error('set_budget needs level, target_id and daily_budget');
              const res = await w.setBudget(o.level, o.target_id, o.daily_budget);
              const after = await w.currentState(o.level, o.target_id).catch(() => null);
              reportEffect('execute_order', [o.target_id], `set the daily budget of ${o.level} ${after?.name || o.target_id} from ${res.before != null ? money(res.before) : '?'} to ${money(o.daily_budget)}`);
              await record({ before: res.before, after: after?.dailyBudget ?? null });
              return { ...res, read_back: after ? { daily_budget: after.dailyBudget } : 'could not read back' };
            }
            if (!o.source_campaign_id) throw new Error('duplicate_campaign needs source_campaign_id');
            const res = await w.duplicateCampaign(o);
            await record({ campaign_id: res.campaignId, adsets: res.adsets.length, activated: Boolean(res.activated), partial: Boolean(res.partial) });
            reportEffect('execute_order', [res.campaignId], `duplicated campaign ${o.source_campaign_id} as ${res.campaignId} (${res.activated ? 'active' : 'paused'}${res.partial ? ', INCOMPLETE' : ''})`);
            return res;
          });
          return { ok: true, ...r };
        } catch (e) {
          reportBlocked('execute_order', e.message);
          return { ok: false, error: String(e.message).slice(0, 300) };
        }
      } }),
    tool({ name: 'file_proposal', description: 'File your own recommended move as an approve or reject card. It runs the optimizer\'s gate and guardrails and posts the card itself. Moves: pause_ad, unpause_ad (ad ids), scale_budget, descale_budget (ad set or campaign ids).',
      input: z.object({ proposals: z.array(z.object({ action_type: z.enum(ACTION_TYPES), target_id: z.string(), reason: z.string() })).min(1).max(10) }),
      run: async ({ proposals }) => {
        const { fileProposals } = await import('./optimizer/optimizer.mjs');
        const { postCards } = await import('./slack/approvals.mjs');
        const results = await fileProposals(proposals, { cadence: 'chat' });
        const filed = results.filter((r) => r.ok).map((r) => r.row);
        const thread = currentExecution()?.thread;
        if (filed.length) await postCards(filed, thread);
        for (const r of filed) reportEffect('file_proposal', [r.id], `filed card #${r.id} (${r.action_type} ${r.target_name || r.target_id})`);
        for (const r of results.filter((x) => !x.ok)) reportBlocked('file_proposal', `${r.key || ''} ${r.blocked}: ${r.why || r.reason || r.detail || ''}`.trim());
        return results.map((r) => (r.ok ? { ok: true, action_id: r.row.id, disposition: r.row.disposition } : { ok: false, blocked: r.blocked, why: r.why || r.reason || r.detail, action_id: r.action_id || null }));
      } }),
    tool({ name: 'comment_action', description: 'Reply to, hide, unhide or delete a comment on the Page or Instagram. Public. Show the exact text or action first; set confirm:true only after a person approved it in this conversation.',
      input: z.object({ platform: z.enum(['facebook', 'instagram']).default('facebook'), comment_id: z.string(), action: z.enum(['reply', 'hide', 'unhide', 'delete']), message: z.string().nullable().default(null), confirm: z.boolean().default(false) }),
      run: async (args) => {
        const ctx = args.confirm ? await commentContext(args.platform, args.comment_id) : {};
        const r = await commentAction(args);
        if (r.ok) {
          reportEffect('comment_action', [args.comment_id], `${args.action} on comment ${args.comment_id}`);
          await logModeration({ platform: args.platform, comment_id: args.comment_id, author: ctx.user, text: ctx.text, action: args.action, outcome: 'done', source: `chat:${currentExecution()?.actor || ''}` });
        } else if (args.confirm) reportBlocked('comment_action', r.error);
        return r;
      } }),
    tool({ name: 'send_dm', description: 'Reply to a person who messaged the Page (Messenger or Instagram), within Meta\'s 24 hour window. Show the exact text first; set confirm:true only after a person approved it in this conversation.',
      input: z.object({ platform: z.enum(['facebook', 'instagram']).default('facebook'), recipient_id: z.string(), text: z.string(), confirm: z.boolean().default(false) }),
      run: async (args) => {
        const r = await sendMessage(args);
        if (r.ok) reportEffect('send_dm', [args.recipient_id], `sent a DM to ${args.recipient_id}`);
        else if (args.confirm) reportBlocked('send_dm', r.error);
        return r;
      } }),
    tool({ name: 'scan_comments', description: 'Run the comment sweep now. apply:false previews without acting.',
      input: z.object({ apply: z.boolean().default(false) }),
      run: async ({ apply }) => {
        const r = await runModeration({ act: apply });
        if (apply) reportEffect('scan_comments', [], `comment sweep: ${r.hidden.length} hidden, ${r.deleted.length} deleted, ${r.flagged.length} flagged`);
        return { summary: moderationSummary(r), scanned: r.scanned, hidden: r.hidden.length, deleted: r.deleted.length, flagged: r.flagged.length };
      } }),
    tool({ name: 'propose_brain_update', description: 'Propose adding or correcting a brain row (a business fact, policy or preference). Posts a card an operator applies.',
      input: z.object({ scope: z.string(), key: z.string(), content: z.any(), why: z.string() }),
      run: async (args) => { const r = await proposeBrainUpdate(args); reportEffect('propose_brain_update', [], `proposed brain row ${args.scope}/${args.key}`); return r; } }),
    tool({ name: 'ask_team', description: 'Ask the team a question only they can answer, with up to 4 answer buttons. The answer is saved to the brain under answers/<key>.',
      input: z.object({ question: z.string(), key: z.string(), options: z.array(z.string()).max(4).default([]) }),
      run: async (args) => { const r = await askTeam(args); reportEffect('ask_team', [], `asked the team: ${args.question.slice(0, 60)}`); return r; } }),
  ];
}

export function allTools() { return [...readTools(), ...writeTools()]; }
