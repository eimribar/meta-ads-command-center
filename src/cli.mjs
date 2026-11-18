// Command line. Every scheduled job can run from here, so any scheduler (cron, a cloud scheduler,
// a CI schedule) can drive the agent instead of the internal timers. The Slack commands run
// here too, as a local operator, so the brain can be filled before Slack is set up.
//
//   node src/cli.mjs check                  first-run check, one line per piece
//   node src/cli.mjs db-setup               create the tables (safe to run again)
//   node src/cli.mjs run <job> [--dry-run]  report | optimizer | optimizer-check | moderation | weekly
//   node src/cli.mjs cmd <command>          a Slack command, for example: brain set business/company ...
//   node src/cli.mjs cmd                    the same, one command per line from the terminal or a pipe
//   node src/cli.mjs ask "question"         one read only chat answer, printed
//   node src/cli.mjs jobs                   list the jobs
import { pathToFileURL } from 'node:url';
import { getConfig, REQUIRED, keysExcept } from './config.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (f) => rest.includes(f);
const args = rest.filter((a) => !a.startsWith('--'));

const USAGE = `usage:
  npm run check                          check every setting and connection
  npm run db:setup                       create the tables (safe to run again)
  npm run job -- <job> [--dry-run] [--force]
                                         run a job: report, optimizer, optimizer-check, moderation, weekly
  npm run cmd -- <command>               a Slack command from the terminal, for example:
                                           npm run cmd -- brain
                                           npm run cmd -- brain set business/company 'One paragraph about the company.'
                                           npm run cmd -- threshold pause.zeroResultSpend 4
                                           npm run cmd -- help
                                         wrap text in single quotes, so the shell keeps quotes, braces and #
  npm run cmd                            the same commands, one per line, typed or piped in (no quotes needed,
                                         so text with an apostrophe goes in as typed); exit or Ctrl+D ends
  npm run ask -- "<question>"            one read only answer, printed`;

// Settings each kind of command needs. Problems with any other setting do not stop it.
const DB_KEYS = ['DATABASE_URL', 'DATABASE_SSL', 'DATABASE_SSL_CA', 'TIMEZONE'];
const NO_SLACK = keysExcept('SLACK_', 'ADMIN_SLACK_');
const REQUIRED_NO_SLACK = REQUIRED.filter((k) => !k.startsWith('SLACK_'));
// Slack commands that only read or write the database.
const DB_ONLY = /^(help|commands|\?|brain|ladder|thresholds?|freeze|unfreeze|journal|pending|desk)\b/i;
// Every Slack command (the same words commands.mjs answers).
const KNOWN = /^(help|commands|\?|report|daily report|scoreboard|pending|desk|optimi[sz]e|propose|run the optimi[sz]er|scan comments|ladder|thresholds?|undo|freeze|unfreeze|brain|journal|status)\b/i;

// Slack text for a terminal: no emoji codes, blocks as their text.
export function toTerminal(payload) {
  const p = typeof payload === 'string' ? { text: payload } : payload || {};
  const parts = p.blocks?.length
    ? p.blocks.flatMap((b) => [b.text?.text, ...(b.elements || []).map((e) => e.text?.text || e.text).filter((t) => typeof t === 'string')]).filter(Boolean)
    : [p.text || ''];
  return parts.join('\n').replace(/:[a-z0-9_+-]+:\s?/g, '').replace(/<@([A-Z0-9]+)>/g, '@$1');
}

// A Meta or database failure, with the next step.
function hintFor(msg) {
  if (/\b190\b/.test(msg) && /token/i.test(msg)) return 'The Meta token is invalid or has expired: generate a new system user token and put it in META_ACCESS_TOKEN (docs/INSTALL.md, step 3).';
  if (/invalid x-api-key|authentication_error/i.test(msg)) return 'Anthropic refused the key: check ANTHROPIC_API_KEY (npm run check).';
  if (/credit balance|billing/i.test(msg)) return 'The Anthropic organization has no credit: buy credits in the Claude Console, Settings > Billing (docs/INSTALL.md, step 5).';
  if (/invalid_auth|not_authed|token_revoked/i.test(msg)) return 'Slack refused a token: check SLACK_BOT_TOKEN and SLACK_APP_TOKEN (npm run check).';
  return 'Run `npm run check` to see what needs attention.';
}

async function main() {
  if (cmd === 'check') {
    const { runCheck, realDeps } = await import('./check.mjs');
    const r = await runCheck(process.env, await realDeps());
    console.log(r.text);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'db-setup') {
    const cfg = getConfig({ require: ['DATABASE_URL'], only: DB_KEYS });
    const { createPgDb } = await import('./db.mjs');
    const { applySchema, tableStatus, describeTables, explainDbError, upgradeFix, plural, TABLES } = await import('./schema.mjs');
    const { dbUser } = await import('./config.mjs');
    let d, s;
    try {
      d = await createPgDb(cfg.DATABASE_URL, { ssl: cfg.DATABASE_SSL, ca: cfg.DATABASE_SSL_CA });
      s = await tableStatus(d);
      const line = describeTables(s);
      // Tables this user cannot use, cannot create, or that only their owner may change: say so, change nothing.
      if (s.noAccess.length || (s.missing.length && !s.canCreate)) { console.error(`Could not set up the tables: ${line.what}.\nFix: ${line.fix}`); return 1; }
      if (!s.missing.length && s.ownedByOthers) {
        const owner = s.owners.find((o) => o !== s.user);
        console.log(`All ${TABLES.length} tables are there and this user can use them; nothing changed (SSL: ${d.sslMode}).\n`
          + `They belong to ${owner}: ${upgradeFix(owner)}`);
        return 0;
      }
      await applySchema(d);
      console.log(s.missing.length ? `Created ${plural(s.missing.length, 'table')}; all ${TABLES.length} are ready (SSL: ${d.sslMode}).` : `All ${TABLES.length} tables were already there; nothing changed (SSL: ${d.sslMode}).`);
      return 0;
    } catch (e) {
      console.error(`Could not set up the tables: ${explainDbError(e, { user: s?.user || dbUser(cfg.DATABASE_URL), owner: s?.owners?.find((o) => o !== s?.user) })}`);
      return 1;
    } finally { await d?.close?.().catch?.(() => {}); }
  }
  if (cmd === 'jobs') {
    const { JOBS } = await import('./scheduled.mjs');
    console.log(Object.keys(JOBS).join('\n'));
    return 0;
  }
  if (cmd === 'run') {
    const name = args[0];
    const { JOBS } = await import('./scheduled.mjs');
    if (!JOBS[name]) { console.error(`${name ? `There is no job "${name}". ` : ''}Jobs: ${Object.keys(JOBS).join(', ')}\n\n${USAGE}`); return 1; }
    const dryRun = flag('--dry-run') || flag('--dry');
    getConfig(dryRun ? { require: REQUIRED_NO_SLACK, only: NO_SLACK } : {});
    const { boot } = await import('./boot.mjs');
    await boot({ slack: !dryRun });
    const { runNamedJob } = await import('./scheduled.mjs');
    const r = await runNamedJob(name, { dryRun, force: flag('--force') });
    if (r?.off) { console.error(r.summary); return 1; }
    console.log(r?.jobSkipped ? `${name}: already ${r.status} for this slot (use --force to run again)` : `${name}: ${r?.summary || 'done'}`);
    return 0;
  }
  if (cmd === 'cmd') {
    const text = rest.join(' ').trim();
    if (text) return runCommandLine(text, { single: true });
    return runCommandLines();
  }
  if (cmd === 'ask') {
    const question = rest.join(' ').trim();
    if (!question) { console.error(`Ask a question, for example: npm run ask -- "how did we do yesterday?"\n\n${USAGE}`); return 1; }
    getConfig({ require: REQUIRED_NO_SLACK, only: NO_SLACK });
    const { boot } = await import('./boot.mjs');
    await boot();
    const { ask } = await import('./agent.mjs');
    const out = await ask([{ role: 'user', content: question }], { actor: null });
    console.log(toTerminal(out.text));
    return 0;
  }
  if (cmd && !['help', '--help', '-h'].includes(cmd)) { console.error(`Unknown command "${cmd}".\n\n${USAGE}`); return 1; }
  console.log(USAGE);
  return 0;
}

// ── Slack commands from the terminal ──────────────────────────────────────
let ready = null;          // 'db' once the database is up, 'meta' once the ad account was read too
async function prepareFor(text, { single }) {
  const dbOnly = DB_ONLY.test(text);
  if (!ready) {
    // One command needs only its own settings. Typed lines start with the database alone and
    // read the ad account the first time a line needs it.
    getConfig(dbOnly || !single ? { require: ['DATABASE_URL'], only: DB_KEYS } : { require: REQUIRED_NO_SLACK, only: NO_SLACK });
    const { rt } = await import('./runtime.mjs');
    rt.localOperator = true;                      // this terminal is an operator (see auth.mjs)
  }
  const { boot } = await import('./boot.mjs');
  if (!ready) { await boot({ meta: !dbOnly }); ready = dbOnly ? 'db' : 'meta'; }
  else if (!dbOnly && ready === 'db') { await boot({ meta: true }); ready = 'meta'; }
}

// One command. Returns the exit code.
async function runCommandLine(text, { single = false } = {}) {
  if (!KNOWN.test(text)) {
    const { HELP } = await import('./slack/commands.mjs');
    console.error(`"${text.split(/\s+/)[0]}" is not a command. Anything that is not a command is a question: npm run ask -- "<question>".\n\n${toTerminal(HELP)}`);
    return 1;
  }
  await prepareFor(text, { single });
  const { handleCommand, HELP } = await import('./slack/commands.mjs');
  const { LOCAL_OPERATOR } = await import('./auth.mjs');
  const { runNamedJob } = await import('./scheduled.mjs');
  const reply = async (payload) => { console.log(toTerminal(payload)); return null; };
  // From the terminal the jobs print what they would post, and post nothing.
  const dry = (name) => async () => { const r = await runNamedJob(name, { dryRun: true }); if (r?.off) { console.log(r.summary); return; } console.log(`(${name}, printed here only; \`npm run job -- ${name}\` runs it for real)${r?.summary ? `: ${r.summary}` : ''}`); };
  const handled = await handleCommand({ text, user: LOCAL_OPERATOR, reply, jobs: { report: dry('report'), optimize: dry('optimizer-check'), moderation: dry('moderation') } });
  if (!handled) { console.error(`That is not a command in this form. Commands:\n\n${toTerminal(HELP)}`); return 1; }
  return 0;
}

// Commands one per line, typed or piped in. Blank lines and lines starting with # are skipped;
// exit, quit or the end of the input stops. A line that fails is reported and the next one runs.
export async function runCommandLines(input = process.stdin) {
  const readline = await import('node:readline');
  const tty = Boolean(input.isTTY);
  if (tty) console.log('One command per line, as in Slack, with no quotes needed. exit or Ctrl+D ends.');
  const rl = readline.createInterface({ input, output: tty ? process.stdout : undefined, terminal: tty });
  if (tty) { rl.setPrompt('> '); rl.prompt(); }
  let code = 0, count = 0;
  for await (const raw of rl) {
    const line = raw.trim();
    if (/^(exit|quit)$/i.test(line)) break;
    if (line && !line.startsWith('#')) {
      count += 1;
      try { if (await runCommandLine(line)) code = 1; }
      catch (e) { const msg = String(e?.message || e); console.error(msg); console.error(hintFor(msg)); code = 1; if (!ready) break; }
    }
    if (tty) rl.prompt();
  }
  rl.close();
  if (!count) { console.error(USAGE); return 1; }
  return code;
}

async function shutdown() {
  const { rt } = await import('./runtime.mjs');
  await rt.db?.close?.().catch?.(() => {});
}

// Only when run as a command (the tests import toTerminal).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(async (code) => { await shutdown(); process.exit(code); })
    .catch(async (e) => {
      const msg = String(e?.message || e);
      console.error(msg);
      console.error(hintFor(msg));
      if (process.env.DEBUG) console.error(e);
      await shutdown().catch(() => {});
      process.exit(1);
    });
}
