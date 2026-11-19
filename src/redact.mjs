// Secrets never reach a log line, a Slack message or Claude. Every tool result, every error text
// and every Meta error message goes through redact() first.
//   Meta tokens (user, system user and Page tokens start with EAA), access_token= in a URL,
//   Slack tokens (xoxb-, xoxp-, xoxe-, xapp-), Anthropic keys (sk-ant-) and other sk- keys, and
//   Postgres connection strings (they carry the password).
const PATTERNS = [
  [/access_token=[^&\s"']+/gi, 'access_token=[hidden]'],
  [/\bEAA[A-Za-z0-9]{20,}/g, '[hidden token]'],
  [/\bxox[abpe](?:\.[A-Za-z0-9_-]+)?-[A-Za-z0-9-]+/g, '[hidden token]'],
  [/\bxapp-[A-Za-z0-9-]+/g, '[hidden token]'],
  [/\bsk-ant-[A-Za-z0-9_-]+/g, '[hidden key]'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[hidden key]'],
  [/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[connection string]'],
];

export function redact(text) {
  let s = String(text ?? '');
  for (const [re, to] of PATTERNS) s = s.replace(re, to);
  return s;
}

// Any value (a tool result): strings are redacted wherever they sit.
export function redactValue(v) {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(redactValue);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactValue(x)]));
  return v;
}
