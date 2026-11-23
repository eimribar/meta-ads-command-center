// Operators are the Slack users in ADMIN_SLACK_USER_IDS. Anyone else in the channel can ask
// questions and gets only the read tools; buttons and modals refuse them.
import { getConfig } from './config.mjs';
import { rt } from './runtime.mjs';

// The person at the terminal running `npm run cmd`. It is an operator only inside that command's
// own process (rt.localOperator); no Slack user id can look like it.
export const LOCAL_OPERATOR = 'local terminal';

export function operators() { return getConfig().ADMIN_SLACK_USER_IDS || []; }
export function isOperator(userId) {
  if (rt.localOperator && userId === LOCAL_OPERATOR) return true;
  return Boolean(userId) && operators().includes(String(userId));
}

// Chat tools anyone may use. Everything else needs an operator.
export const READ_ONLY_TOOLS = new Set([
  'account_overview', 'campaign_detail', 'adset_detail', 'ad_performance', 'breakdown', 'spend_by_time',
  'recent_changes', 'run_insights', 'graph_query', 'ad_creative', 'video_retention', 'audiences', 'lead_forms', 'pixel_health', 'page_overview',
  'instagram_overview', 'recent_comments', 'inbox', 'query_history', 'creative_scoreboard', 'result_view', 'web_search',
]);

export function toolsForActor(tools, userId) {
  if (isOperator(userId)) return tools;
  return tools.filter((t) => READ_ONLY_TOOLS.has(t.name) || t.type?.startsWith?.('web_search'));
}

// Bolt middleware: button taps and modal submits from non-operators are acknowledged and dropped.
export function operatorOnlyMiddleware() {
  return async ({ body, ack, next, client }) => {
    const type = body?.type;
    if (type !== 'block_actions' && type !== 'view_submission') return next();
    const user = body.user?.id;
    if (isOperator(user)) return next();
    if (ack) await ack();
    const channel = body.channel?.id || body.container?.channel_id;
    if (client && channel && user) {
      await client.chat.postEphemeral({ channel, user, text: 'Only operators can approve or change things. To become one, ask whoever set up the agent to add you as an operator.' }).catch(() => {});
    }
  };
}
