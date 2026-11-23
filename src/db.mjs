// The data module. One small interface over any Postgres reached through DATABASE_URL, plus an
// in-memory version with the same interface for tests and dry runs.
//
//   select(table, { where, order, limit, columns })   -> rows
//   insert(table, rows)                               -> inserted rows
//   insertIgnore(table, row, conflict)                -> inserted row, or null when it already existed
//                                                        (conflict null: any unique index)
//   upsert(table, rows, conflict)                     -> rows (only the given columns are updated)
//   update(table, where, patch)                       -> updated rows
//   remove(table, where)                              -> removed rows
//
// `where` maps a column to a value (equality) or to one operator object:
//   { in: [...] } { gte } { gt } { lte } { lt } { ne } { isNull: true|false } { prefix: 'text' }
// `order` is 'column' or 'column desc', or a list of them.

// Tables whose rows get a numeric `id` from the database.
export const ID_TABLES = new Set(['actions_log', 'brain_history', 'learnings', 'timeline', 'write_journal', 'moderation_log', 'decisions', 'hypotheses']);

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(name) {
  if (!IDENT.test(String(name))) throw new Error(`bad identifier: ${name}`);
  return `"${name}"`;
}
const OPS = { gte: '>=', gt: '>', lte: '<=', lt: '<', ne: '<>' };

// jsonb columns get JSON text (a plain string, number or array is valid JSON too); other values
// pass as they are.
export const JSON_COLUMNS = {
  brain: ['content'], brain_history: ['content'], conversations: ['messages'],
  actions_log: ['before', 'after', 'guardrail_checks', 'evidence'], timeline: ['detail'],
  write_journal: ['source', 'operations', 'metadata', 'receipt'], state: ['value'],
  hypotheses: ['labels', 'evidence'],
};
const toParam = (table, col, v) => {
  if (v === undefined || v === null) return null;
  if (JSON_COLUMNS[table]?.includes(col)) return JSON.stringify(v);
  return typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v;
};

function whereSql(where = {}, params = []) {
  const parts = [];
  for (const [col, cond] of Object.entries(where || {})) {
    const c = ident(col);
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      if ('in' in cond) { params.push(cond.in); parts.push(`${c} = any($${params.length})`); continue; }
      if ('isNull' in cond) { parts.push(`${c} is ${cond.isNull ? '' : 'not '}null`); continue; }
      if ('prefix' in cond) { params.push(`${String(cond.prefix).replace(/[\\%_]/g, (m) => `\\${m}`)}%`); parts.push(`${c} like $${params.length}`); continue; }
      const [op, val] = Object.entries(cond)[0] || [];
      if (!OPS[op]) throw new Error(`bad operator for ${col}`);
      params.push(val); parts.push(`${c} ${OPS[op]} $${params.length}`);
    } else if (cond === null) {
      parts.push(`${c} is null`);
    } else {
      params.push(cond); parts.push(`${c} = $${params.length}`);
    }
  }
  return parts.length ? ` where ${parts.join(' and ')}` : '';
}

function orderSql(order) {
  if (!order) return '';
  const list = Array.isArray(order) ? order : [order];
  return ' order by ' + list.map((o) => {
    const [col, dir] = String(o).trim().split(/\s+/);
    return `${ident(col)} ${dir && dir.toLowerCase() === 'desc' ? 'desc' : 'asc'}`;
  }).join(', ');
}

// SQL builders, exported so tests can check the exact statements without a database.
export function buildSelect(table, { where, order, limit, columns } = {}) {
  const params = [];
  const cols = columns ? columns.map(ident).join(', ') : '*';
  let sql = `select ${cols} from ${ident(table)}${whereSql(where, params)}${orderSql(order)}`;
  if (limit != null) { params.push(Number(limit)); sql += ` limit $${params.length}`; }
  return { sql, params };
}

export function buildInsert(table, rows, { conflict = null, mode = 'error' } = {}) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (!list.length) return null;
  const cols = [...new Set(list.flatMap((r) => Object.keys(r)))];
  const params = [];
  const values = list.map((r) => `(${cols.map((c) => {
    if (!(c in r)) return 'default';
    params.push(toParam(table, c, r[c])); return `$${params.length}`;
  }).join(', ')})`).join(', ');
  let sql = `insert into ${ident(table)} (${cols.map(ident).join(', ')}) values ${values}`;
  if (mode === 'ignore') sql += ` on conflict${conflict ? ` (${conflict.map(ident).join(', ')})` : ''} do nothing`;
  if (mode === 'upsert') {
    const updates = cols.filter((c) => !conflict.includes(c));
    sql += ` on conflict (${conflict.map(ident).join(', ')}) do ${updates.length
      ? `update set ${updates.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(', ')}` : 'nothing'}`;
  }
  return { sql: `${sql} returning *`, params };
}

export function buildUpdate(table, where, patch) {
  const params = [];
  const sets = Object.entries(patch).map(([c, v]) => { params.push(toParam(table, c, v)); return `${ident(c)} = $${params.length}`; });
  if (!sets.length) throw new Error('empty update');
  const w = whereSql(where, params);
  if (!w) throw new Error('update without a filter is refused');
  return { sql: `update ${ident(table)} set ${sets.join(', ')}${w} returning *`, params };
}

export function buildDelete(table, where) {
  const params = [];
  const w = whereSql(where, params);
  if (!w) throw new Error('delete without a filter is refused');
  return { sql: `delete from ${ident(table)}${w} returning *`, params };
}

// ── Postgres ────────────────────────────────────────────────────────────────
// Hosts that are this machine or a container next to it: no SSL in auto mode.
export const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'postgres', 'db', 'host.docker.internal']);
const URL_SSL_PARAMS = ['sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert', 'sslnegotiation', 'uselibpqcompat'];
const FROM_SSLMODE = { disable: 'disable', allow: 'require', prefer: 'require', require: 'require', 'no-verify': 'require', 'verify-ca': 'verify', 'verify-full': 'verify' };

// How the connection uses SSL. DATABASE_SSL decides when it is set to anything but auto; in auto,
// an sslmode in the URL decides, and without one SSL is on for every host but a local one.
//   disable  no encryption
//   require  encrypted; the server's certificate is not checked
//   verify   encrypted; the certificate must be signed by a trusted CA (the system's, or the
//            file in DATABASE_SSL_CA) and match the host name
// The ssl settings are taken out of the URL, because the pg driver would let them override these.
export function sslPlan(url, mode = 'auto', caPath = null) {
  const u = new URL(url);
  const fromUrl = FROM_SSLMODE[String(u.searchParams.get('sslmode') || '').toLowerCase()] || null;
  const rootCert = u.searchParams.get('sslrootcert');
  for (const k of URL_SSL_PARAMS) u.searchParams.delete(k);
  let effective = mode;
  if (mode === 'auto') effective = fromUrl || (LOCAL_HOSTS.has(u.hostname.toLowerCase()) ? 'disable' : 'require');
  const ca = caPath || rootCert || null;
  let ssl = false;
  if (effective === 'require') ssl = { rejectUnauthorized: false };
  if (effective === 'verify') ssl = { rejectUnauthorized: true, ...(ca ? { caFile: ca } : {}) };
  return { url: u.toString(), mode: effective, ssl };
}

export async function createPgDb(url, { ssl = 'auto', ca = null } = {}) {
  const pg = (await import('pg')).default;
  // numbers come back as numbers, dates as YYYY-MM-DD, timestamps as ISO strings
  pg.types.setTypeParser(20, (v) => Number(v));
  pg.types.setTypeParser(1700, (v) => Number(v));
  pg.types.setTypeParser(1082, (v) => v);
  pg.types.setTypeParser(1184, (v) => new Date(v).toISOString());
  const plan = sslPlan(url, ssl, ca);
  let sslConfig = plan.ssl;
  if (sslConfig?.caFile) {
    const { readFileSync } = await import('node:fs');
    const { caFile, ...rest } = sslConfig;
    sslConfig = { ...rest, ca: readFileSync(caFile, 'utf8') };
  }
  const pool = new pg.Pool({
    connectionString: plan.url, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, ssl: sslConfig,
  });
  pool.on('error', (e) => console.error('[db] idle client error:', String(e?.message || e).slice(0, 160)));
  const run = async (built) => (built ? (await pool.query(built.sql, built.params)).rows : []);
  return {
    kind: 'postgres',
    sslMode: plan.mode,
    query: async (sql, params = []) => (await pool.query(sql, params)).rows,
    select: (table, opts) => run(buildSelect(table, opts)),
    insert: (table, rows) => run(buildInsert(table, rows)),
    insertIgnore: async (table, row, conflict) => (await run(buildInsert(table, [row], { conflict, mode: 'ignore' })))[0] || null,
    upsert: (table, rows, conflict) => run(buildInsert(table, rows, { conflict, mode: 'upsert' })),
    update: (table, where, patch) => run(buildUpdate(table, where, patch)),
    remove: (table, where) => run(buildDelete(table, where)),
    close: () => pool.end(),
  };
}

// ── In memory ───────────────────────────────────────────────────────────────
function matches(row, where = {}) {
  for (const [col, cond] of Object.entries(where || {})) {
    const v = row[col];
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      if ('in' in cond) { if (!cond.in.map(String).includes(String(v))) return false; continue; }
      if ('isNull' in cond) { if ((v == null) !== Boolean(cond.isNull)) return false; continue; }
      if ('prefix' in cond) { if (!String(v ?? '').startsWith(String(cond.prefix))) return false; continue; }
      const [op, val] = Object.entries(cond)[0];
      if (v == null) return false;
      if (op === 'gte' && !(v >= val)) return false;
      if (op === 'gt' && !(v > val)) return false;
      if (op === 'lte' && !(v <= val)) return false;
      if (op === 'lt' && !(v < val)) return false;
      if (op === 'ne' && String(v) === String(val)) return false;
    } else if (cond === null) { if (v != null) return false; }
    else if (String(v) !== String(cond)) return false;
  }
  return true;
}

// The partial unique indexes in db/schema.sql, for the in-memory database: one open card per
// decision key.
const PARTIAL_UNIQUE = {
  actions_log: [{ columns: ['decision_key'], when: (r) => ['proposed', 'escalated'].includes(r.disposition) && r.decision_key != null }],
};

export function createMemoryDb(seed = {}) {
  const tables = {};
  const ids = {};
  const t = (name) => { ident(name); return (tables[name] ||= []); };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const stamp = (table, row) => {
    const r = { ...row };
    if (ID_TABLES.has(table) && r.id == null) r.id = (ids[table] = (ids[table] || 0) + 1);
    if (r.created_at === undefined && ['actions_log', 'write_journal', 'learnings'].includes(table)) r.created_at = new Date().toISOString();
    return r;
  };
  const sameKey = (a, b, conflict) => conflict.every((c) => String(a[c]) === String(b[c]));
  const violates = (table, row) => (PARTIAL_UNIQUE[table] || []).some((u) => u.when(row) && t(table).some((r) => u.when(r) && sameKey(r, row, u.columns)));
  const uniqueError = (table) => Object.assign(new Error(`duplicate key value violates unique constraint on ${table}`), { code: '23505' });
  for (const [name, rows] of Object.entries(seed)) for (const r of rows) t(name).push(stamp(name, r));
  return {
    kind: 'memory',
    tables,
    query: async () => { throw new Error('raw SQL is not available on the in-memory database'); },
    select: async (table, { where, order, limit, columns } = {}) => {
      let rows = t(table).filter((r) => matches(r, where));
      if (order) {
        const list = (Array.isArray(order) ? order : [order]).map((o) => String(o).trim().split(/\s+/));
        rows = [...rows].sort((a, b) => {
          for (const [col, dir] of list) {
            const d = dir === 'desc' ? -1 : 1;
            if (a[col] == null && b[col] != null) return 1;
            if (b[col] == null && a[col] != null) return -1;
            if (a[col] < b[col]) return -d;
            if (a[col] > b[col]) return d;
          }
          return 0;
        });
      }
      if (limit != null) rows = rows.slice(0, Number(limit));
      rows = clone(rows);
      return columns ? rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c]]))) : rows;
    },
    insert: async (table, rows) => {
      const out = [];
      for (const r of Array.isArray(rows) ? rows : [rows]) {
        if (violates(table, r)) throw uniqueError(table);
        const row = stamp(table, r);
        t(table).push(row);
        out.push(row);
      }
      return clone(out);
    },
    insertIgnore: async (table, row, conflict) => {
      if (conflict ? t(table).some((r) => sameKey(r, row, conflict)) : violates(table, row)) return null;
      const r = stamp(table, row);
      t(table).push(r);
      return clone(r);
    },
    upsert: async (table, rows, conflict) => {
      const out = [];
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        const i = t(table).findIndex((r) => sameKey(r, row, conflict));
        if (i >= 0) { t(table)[i] = { ...t(table)[i], ...row }; out.push(t(table)[i]); }
        else { const r = stamp(table, row); t(table).push(r); out.push(r); }
      }
      return clone(out);
    },
    update: async (table, where, patch) => {
      if (!Object.keys(where || {}).length) throw new Error('update without a filter is refused');
      const out = [];
      for (const r of t(table)) if (matches(r, where)) { Object.assign(r, patch); out.push(r); }
      return clone(out);
    },
    remove: async (table, where) => {
      if (!Object.keys(where || {}).length) throw new Error('delete without a filter is refused');
      const keep = [], gone = [];
      for (const r of t(table)) (matches(r, where) ? gone : keep).push(r);
      tables[table] = keep;
      return clone(gone);
    },
    close: async () => {},
  };
}
