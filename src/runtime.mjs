// Shared handles for the running process: the database, the Slack client, the Anthropic client,
// fetch, the clock and waiting. Real ones are wired at boot; tests swap in fakes with setRuntime().
export const rt = {
  db: null,
  slack: null,
  anthropic: null,
  fetch: (...args) => globalThis.fetch(...args),
  now: () => new Date(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  localOperator: false,   // true only inside `npm run cmd` (see auth.mjs)
};

export function setRuntime(parts) { Object.assign(rt, parts); return rt; }

export function db() {
  if (!rt.db) throw new Error('Database is not connected (DATABASE_URL)');
  return rt.db;
}
