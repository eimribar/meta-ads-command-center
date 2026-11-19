// What a Slack failure at start means, in one plain line with the fix.
//   kind: bot (the bot token check), app (the app level token check), connect (Socket Mode)
const NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

export function isNetworkError(e) {
  if (e?.code === 'slack_webapi_request_error') return true;               // @slack/web-api: no answer from Slack
  const codes = [e?.code, e?.original?.code, e?.cause?.code, e?.original?.cause?.code].filter(Boolean);
  return codes.some((c) => NETWORK_CODES.has(c)) || /getaddrinfo|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|socket hang up|fetch failed/i.test(String(e?.message || ''));
}

export function slackStartProblem(e, kind) {
  const err = e?.data?.error;
  if (!err && isNetworkError(e)) {
    return '[slack] Slack could not be reached (no answer from slack.com). Check this machine\'s internet access, DNS and any proxy, then start again; the tokens were not checked.';
  }
  const why = err || String(e?.message || e).split('\n')[0].slice(0, 200);
  if (kind === 'bot') return `[slack] Slack refused the bot token (${why}). Check SLACK_BOT_TOKEN: the Bot User OAuth Token (xoxb-) from OAuth & Permissions.`;
  if (kind === 'app') return `[slack] Slack refused the app level token (${why}). Check SLACK_APP_TOKEN: an App-Level Token (xapp-) with connections:write, and Socket Mode turned on.`;
  return `[slack] could not connect: ${why}.`;
}

// Errors @slack/socket-mode raises while it replaces its connection. The client reconnects on its
// own, so they are noise, not a reason to stop.
export const RECONNECT_CODES = new Set([
  'slack_socket_mode_send_while_disconnected_error', 'slack_socket_mode_send_while_not_ready_error',
  'slack_socket_mode_no_reply_received_error', 'slack_socket_mode_connect_aborted_error',
]);
export const isReconnectNoise = (e) => RECONNECT_CODES.has(e?.code);
