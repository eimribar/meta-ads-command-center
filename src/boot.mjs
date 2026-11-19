// Shared startup for the server and the command line: settings, database, tables, the ad
// account's currency and time zone, and scope.
import { getConfig, dbUser } from './config.mjs';
import { setRuntime, rt } from './runtime.mjs';
import { createPgDb } from './db.mjs';
import { setTimezone } from './clock.mjs';
import { loadScope } from './meta.mjs';
import { loadAccountBasics } from './account.mjs';
import { setAlerter } from './jobs.mjs';
import { ensureTables, explainDbError, plural } from './schema.mjs';

// meta: false skips the ad account read (commands that only touch the database).
export async function boot({ slack = false, meta = true } = {}) {
  const cfg = getConfig();
  if (!rt.db) {
    let d;
    try {
      d = await createPgDb(cfg.DATABASE_URL, { ssl: cfg.DATABASE_SSL, ca: cfg.DATABASE_SSL_CA });
      await d.query('select 1');
    } catch (e) {
      await d?.close?.().catch?.(() => {});
      throw new Error(`Cannot use the database: ${explainDbError(e, { user: dbUser(cfg.DATABASE_URL) })}`);
    }
    setRuntime({ db: d });
    let r;
    try { r = await ensureTables(d, { user: dbUser(cfg.DATABASE_URL) }); }
    catch (e) { throw new Error(`Database: ${e.message}`); }
    if (r.created.length) console.log(`[db] created ${plural(r.created.length, 'missing table')}`);
    if (r.upgraded?.length) console.log(`[db] upgraded the tables: added ${r.upgraded.join(', ')}`);
  }
  let tz = cfg.TIMEZONE;
  if (meta) {
    try {
      const a = await loadAccountBasics();
      tz ||= a.timezone;
    } catch (e) {
      console.warn(`[meta] could not read the ad account (${String(e?.message || e).slice(0, 120)}); amounts show without a currency and times use ${tz || 'UTC'} until it can be read`);
    }
  }
  setTimezone(tz || 'UTC');
  await loadScope();
  if (slack && !rt.slack) {
    const { WebClient } = await import('@slack/web-api');
    setRuntime({ slack: new WebClient(cfg.SLACK_BOT_TOKEN, { logLevel: 'error' }) });
  }
  setAlerter(async (text, { critical }) => {
    if (!rt.slack) { console.log(`[alert] ${text}`); return; }
    const { postToDesk } = await import('./slack/desk.mjs');
    await postToDesk({ text }, { broadcast: critical });
  });
  return cfg;
}
