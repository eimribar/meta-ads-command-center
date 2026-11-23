// The tables, and plain words for the database errors people hit when they set the database up.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ENCODE_HINT } from './config.mjs';
import { plural } from './words.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const TABLES = ['brain', 'brain_history', 'conversations', 'actions_log', 'autonomy_policy', 'performance_daily', 'learnings',
  'timeline', 'job_runs', 'loop_health', 'write_journal', 'incidents', 'state', 'moderation_log', 'decisions', 'hypotheses'];

export const schemaSql = () => readFile(join(root, 'db', 'schema.sql'), 'utf8');

// Columns and indexes added after the first release. When one is missing, the schema file is
// applied again (npm run db:setup, or npm start when this user owns the tables).
export const UPGRADES = { columns: [['actions_log', 'journal_id']], indexes: ['actions_log_one_open'] };

// Which tables exist, who owns them and whether this user can use them. Read from pg_class,
// which lists every table, so a table this user has no rights on is not taken for missing.
//   { user, canCreate, missing: [names], noAccess: [{ name, owner }], owners: [names], ownedByOthers: bool,
//     upgrade: [what an upgrade adds that is not there yet] }
export async function tableStatus(d) {
  const [who] = await d.query("select current_user as me, has_schema_privilege(coalesce(current_schema(), 'public'), 'CREATE') as can_create");
  const user = who?.me || null;
  const rows = await d.query(`select c.relname as name, pg_get_userbyid(c.relowner) as owner,
      (has_table_privilege(c.oid, 'select') and has_table_privilege(c.oid, 'insert')
       and has_table_privilege(c.oid, 'update') and has_table_privilege(c.oid, 'delete')) as can_use
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = current_schema() and c.relkind in ('r', 'p') and c.relname = any($1)`, [TABLES]);
  const present = new Map(rows.map((r) => [r.name, r]));
  const missing = TABLES.filter((t) => !present.has(t));
  const noAccess = rows.filter((r) => !r.can_use).map((r) => ({ name: r.name, owner: r.owner }));
  const owners = [...new Set(rows.map((r) => r.owner))];
  const upgrade = [];
  const tablesWithUpgrades = [...new Set(UPGRADES.columns.map(([t]) => t))].filter((t) => present.has(t));
  if (tablesWithUpgrades.length) {
    const cols = await d.query(`select table_name, column_name from information_schema.columns
      where table_schema = current_schema() and table_name = any($1)`, [tablesWithUpgrades]);
    const have = new Set(cols.map((c) => `${c.table_name}.${c.column_name}`));
    for (const [t, c] of UPGRADES.columns) if (present.has(t) && !have.has(`${t}.${c}`)) upgrade.push(`the column ${t}.${c}`);
    const idx = await d.query('select indexname from pg_indexes where schemaname = current_schema() and indexname = any($1)', [UPGRADES.indexes]);
    const haveIdx = new Set(idx.map((i) => i.indexname));
    for (const i of UPGRADES.indexes) if (!haveIdx.has(i)) upgrade.push(`the index ${i}`);
  }
  return { user, canCreate: who?.can_create !== false, missing, noAccess, owners, ownedByOthers: rows.some((r) => r.owner !== user), upgrade };
}

export async function missingTables(d) { return (await tableStatus(d)).missing; }

// Create every table and index that is not there yet. Safe to run again: nothing is dropped.
export async function applySchema(d) {
  await d.query(await schemaSql());
}

const q = (name) => (/^[a-z_][a-z0-9_]*$|^</.test(String(name)) ? String(name) : `"${String(name).replace(/"/g, '""')}"`);
export { plural };

// The SQL that lets this user use tables another database user owns, now and after upgrades.
// The default privileges cover the tables an upgrade adds later, as long as the same owner
// creates them.
export function grantSql(owner, user) {
  const o = q(owner || '<owner>'), u = q(user || '<this user>');
  return [
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${u};`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${u};`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${o} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${u};`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${o} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${u};`,
  ];
}
// The other way: hand the app's own tables to this user. Touches nothing else in the database.
export function ownerSql(user, tables = TABLES) {
  const u = q(user || '<this user>');
  return tables.map((t) => `ALTER TABLE ${t} OWNER TO ${u};`);
}

// The fix when the tables belong to another database user. Several lines: the SQL to run.
export function ownerFix(owner, user, tables = TABLES) {
  const o = owner || '<owner>';
  return [`connected as ${o} (or a database admin), run this in this database:`,
    ...grantSql(owner, user).map((l) => `  ${l}`),
    'The two ALTER DEFAULT PRIVILEGES lines make tables a later upgrade adds usable too.',
    `Or a superuser hands the tables to ${user || 'this user'} instead, so upgrades need nobody else:`,
    ...ownerSql(user, tables).map((l) => `  ${l}`)].join('\n');
}

// After an upgrade, when the tables belong to another user: the owner runs the schema file.
export function upgradeFix(owner) {
  return `after an upgrade, ${owner} (or a database admin connected as ${owner}) runs db/schema.sql in this database, `
    + `for example psql -d <database> -f db/schema.sql, because only the owner can add tables, columns and indexes. `
    + 'With the default privileges from docs/INSTALL.md, step 2, this user can use the new tables right away.';
}

// No right to create tables: the schema owner grants it, or the user gets a database of its own.
export function createFix(user) {
  const u = q(user || '<this user>');
  return `this database user (${user || 'the one in DATABASE_URL'}) is not allowed to create tables. The schema owner (on Postgres 15 and newer, the database owner) runs `
    + `\`GRANT CREATE ON SCHEMA public TO ${u};\`, or you give this user a database of its own (CREATE DATABASE <name> OWNER ${u};). `
    + 'Or a database admin creates the tables (db/schema.sql) and grants this user access (docs/INSTALL.md, step 2)';
}

// One line on the tables, for the check and for npm run db:setup.
//   { level: 'ok' | 'warn' | 'bad', what, fix }
// Tables (or upgrade columns) this user can create are a warning: npm start or npm run db:setup
// adds them. What only another database user can add is a problem to fix first.
export function describeTables(s) {
  if (s.noAccess.length) {
    const owner = s.noAccess[0].owner;
    const n = s.noAccess.length;
    return { level: 'bad', what: `${n} of the tables ${n === 1 ? 'exists but belongs' : 'exist but belong'} to the database user ${owner}, and this user (${s.user}) cannot read and write ${n === 1 ? 'it' : 'them'}`, fix: ownerFix(owner, s.user, s.noAccess.map((t) => t.name)) };
  }
  const setupFix = 'npm start creates them, or run npm run db:setup';
  const others = s.owners.filter((o) => o !== s.user);
  const some = (list) => `${list.slice(0, 5).join(', ')}${list.length > 5 ? ', ...' : ''}`;
  if (s.missing.length && !s.canCreate) {
    const what = s.missing.length === TABLES.length ? 'the tables are not there yet, and this user cannot create them'
      : `${s.missing.length} of the ${TABLES.length} tables ${s.missing.length === 1 ? 'is' : 'are'} missing (${some(s.missing)}), and this user cannot create ${s.missing.length === 1 ? 'it' : 'them'}`;
    return { level: 'bad', what, fix: others.length ? upgradeFix(others[0]) : createFix(s.user) };
  }
  if (s.missing.length === TABLES.length) return { level: 'warn', what: 'the tables are not there yet', fix: setupFix };
  if (s.missing.length) return { level: 'warn', what: `${s.missing.length} of the ${TABLES.length} tables ${s.missing.length === 1 ? 'is' : 'are'} missing (${some(s.missing)})`, fix: setupFix };
  const upgrade = s.upgrade || [];
  if (upgrade.length && s.ownedByOthers) return { level: 'bad', what: `the tables need an upgrade (${some(upgrade)}), and only their owner, ${others[0]}, can add it`, fix: upgradeFix(others[0]) };
  if (upgrade.length) return { level: 'warn', what: `the tables need an upgrade (${some(upgrade)})`, fix: 'npm start adds it, or run npm run db:setup' };
  if (s.ownedByOthers) {
    return { level: 'warn', what: `every table exists and this user can use them; they belong to ${others.join(', ')}`, fix: upgradeFix(others[0]) };
  }
  return { level: 'ok', what: 'every table exists and this user can use them' };
}

// Create the missing tables and add what an upgrade added, if anything. Returns { created: [...],
// upgraded: [...] }; throws with the fix when this database user cannot create or use them.
export async function ensureTables(d, { user } = {}) {
  const s = await tableStatus(d);
  const line = describeTables(s);
  if (line.level === 'bad') throw new Error(`${line.what}. Fix: ${line.fix}`);
  const upgrade = s.upgrade || [];
  if (!s.missing.length && !upgrade.length) return { created: [], upgraded: [] };
  try { await applySchema(d); }
  catch (e) {
    const what = s.missing.length ? `${plural(s.missing.length, 'table')} ${s.missing.length === 1 ? 'is' : 'are'} missing and could not be created` : 'the tables need an upgrade that could not be applied';
    throw new Error(`${what}: ${explainDbError(e, { user: s.user || user, owner: s.owners.find((o) => o !== s.user) })}`);
  }
  return { created: s.missing, upgraded: upgrade };
}

// One plain sentence on what went wrong and what to do. Never includes the connection string.
// ctx: { user, owner } names the database users in the fix when they are known.
export function explainDbError(e, { user = null, owner = null } = {}) {
  const msg = String(e?.message || e || '');
  const code = e?.code;
  const has = (re) => re.test(msg);
  if (has(/must be owner of/i)) {
    return `the tables already exist but belong to another database user${owner ? ` (${owner})` : ''}. Fix: ${ownerFix(owner, user)}`;
  }
  if (has(/permission denied for schema/i)) return createFix(user);
  if (has(/permission denied for (table|relation|sequence)/i)) {
    return `this database user (${user || 'the one in DATABASE_URL'}) cannot read or write the tables. Fix: ${ownerFix(owner, user)}`;
  }
  if (code === '28P01' || has(/password authentication failed/i)) return `the user name or password was refused. Check them in DATABASE_URL, and ${ENCODE_HINT}`;
  if (code === '3D000' || has(/database .* does not exist/i)) return 'the database named at the end of DATABASE_URL does not exist. Create it (CREATE DATABASE <name>;), or fix the name';
  if (has(/does not support SSL/i)) return 'this server has no SSL. Set DATABASE_SSL=disable (fine on the same machine or a private network)';
  if (has(/no encryption|SSL (connection )?(is )?required|SSL off/i)) return 'this server only accepts SSL connections. Set DATABASE_SSL=require, or verify to also check its certificate';
  if (has(/self[- ]signed certificate|unable to verify the first certificate|unable to get local issuer certificate|SELF_SIGNED_CERT/i)) {
    return 'the server\'s certificate is not signed by a CA this machine trusts. Download your provider\'s CA certificate and put its path in DATABASE_SSL_CA, '
      + 'or set DATABASE_SSL=require (still encrypted, but the certificate is not checked)';
  }
  if (has(/does not match certificate|ERR_TLS_CERT_ALTNAME_INVALID|altnames/i)) return 'the server\'s certificate is for a different host name. Use the host name your provider gives in DATABASE_URL, or DATABASE_SSL=require';
  if (code === 'ENOENT' && has(/open/)) return 'the file in DATABASE_SSL_CA (or sslrootcert in the URL) was not found';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || has(/getaddrinfo/i)) {
    return 'the host name in DATABASE_URL was not found. Check the host; when the password has a special character that is not URL-encoded, '
      + `part of the password is read as the host, so ${ENCODE_HINT}`;
  }
  if (code === 'ECONNREFUSED' || has(/ECONNREFUSED/)) {
    return 'nothing answered at that host and port. Check that Postgres is running and the port is right. '
      + 'Inside a container, localhost is the container itself: use the database\'s real host name (host.docker.internal reaches the host on Docker Desktop)';
  }
  if (code === 'ETIMEDOUT' || has(/timeout|timed out/i)) return 'the connection timed out. Check the host and port, and that the database accepts connections from this machine (firewall, allowed IP addresses)';
  if (has(/URI malformed|Invalid URL/i)) return `DATABASE_URL could not be read. ${ENCODE_HINT}`;
  return msg.replace(/postgres(ql)?:\/\/\S+/gi, '[connection string]').slice(0, 200);
}
