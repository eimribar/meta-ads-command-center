import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSelect, buildInsert, buildUpdate, buildDelete, createMemoryDb, sslPlan } from '../src/db.mjs';
import { TABLES } from '../src/check.mjs';
import { explainDbError, tableStatus, describeTables, ensureTables } from '../src/schema.mjs';
import { fakePg } from './helpers.mjs';

test('select builds parameterized SQL with operators, order and limit', () => {
  const { sql, params } = buildSelect('actions_log', { where: { disposition: { in: ['proposed', 'escalated'] }, run_date: { gte: '2026-01-01' }, undone_at: { isNull: true }, target_id: '5' }, order: ['id desc', 'run_date'], limit: 10 });
  assert.equal(sql, 'select * from "actions_log" where "disposition" = any($1) and "run_date" >= $2 and "undone_at" is null and "target_id" = $3 order by "id" desc, "run_date" asc limit $4');
  assert.deepEqual(params, [['proposed', 'escalated'], '2026-01-01', '5', 10]);
});

test('jsonb columns are sent as JSON text, even plain strings and numbers', () => {
  const { sql, params } = buildInsert('brain', [{ scope: 'business', key: 'company', content: 'We sell things' }], { conflict: ['scope', 'key'], mode: 'upsert' });
  assert.match(sql, /on conflict \("scope", "key"\) do update set "content" = excluded\."content"/);
  assert.deepEqual(params, ['business', 'company', '"We sell things"']);
  assert.deepEqual(buildInsert('state', [{ key: 'k', value: [1, 2] }]).params, ['k', '[1,2]']);
});

test('insert ignore and multi-row defaults', () => {
  const { sql, params } = buildInsert('job_runs', [{ name: 'a', slot: '1' }, { name: 'b', slot: '2', status: 'ok' }], { conflict: ['name', 'slot'], mode: 'ignore' });
  assert.equal(sql, 'insert into "job_runs" ("name", "slot", "status") values ($1, $2, default), ($3, $4, $5) on conflict ("name", "slot") do nothing returning *');
  assert.deepEqual(params, ['a', '1', 'b', '2', 'ok']);
});

test('updates and deletes without a filter are refused; bad identifiers are refused', () => {
  assert.throws(() => buildUpdate('state', {}, { value: 1 }), /without a filter/);
  assert.throws(() => buildDelete('state', {}), /without a filter/);
  assert.throws(() => buildSelect('state; drop table x', {}), /bad identifier/);
  assert.throws(() => buildSelect('state', { where: { 'key"': 1 } }), /bad identifier/);
});

test('the in-memory database behaves like the Postgres one', async () => {
  const db = createMemoryDb();
  const [a] = await db.insert('actions_log', [{ run_date: '2026-11-01', action_type: 'pause_ad', target_id: '1', disposition: 'proposed' }]);
  const [b] = await db.insert('actions_log', [{ run_date: '2026-11-02', action_type: 'scale_budget', target_id: '2', disposition: 'escalated' }]);
  assert.equal(a.id, 1); assert.equal(b.id, 2);
  assert.equal((await db.select('actions_log', { where: { disposition: { in: ['proposed', 'escalated'] } } })).length, 2);
  assert.deepEqual((await db.select('actions_log', { order: 'id desc', limit: 1 })).map((r) => r.id), [2]);
  assert.equal(await db.insertIgnore('job_runs', { name: 'x', slot: '1', status: 'running' }, ['name', 'slot']) !== null, true);
  assert.equal(await db.insertIgnore('job_runs', { name: 'x', slot: '1', status: 'running' }, ['name', 'slot']), null);
  await db.upsert('performance_daily', [{ date: '2026-11-01', level: 'ad', entity_id: '9', spend: 5 }], ['date', 'level', 'entity_id']);
  await db.upsert('performance_daily', [{ date: '2026-11-01', level: 'ad', entity_id: '9', status: 'ACTIVE' }], ['date', 'level', 'entity_id']);
  const [row] = await db.select('performance_daily', {});
  assert.equal(row.spend, 5); assert.equal(row.status, 'ACTIVE');
  await db.update('actions_log', { id: 1 }, { disposition: 'skipped' });
  assert.equal((await db.select('actions_log', { where: { id: 1 } }))[0].disposition, 'skipped');
  assert.equal((await db.remove('actions_log', { id: 2 })).length, 1);
  assert.equal((await db.select('actions_log', {})).length, 1);
  await assert.rejects(() => db.update('actions_log', {}, { x: 1 }), /without a filter/);
});

test('sslmode in the URL is taken out and mapped; an explicit DATABASE_SSL wins', () => {
  const a = sslPlan('postgres://u:p@db.example.com:5432/x?sslmode=require&application_name=agent');
  assert.equal(a.mode, 'require');
  assert.deepEqual(a.ssl, { rejectUnauthorized: false });
  assert.ok(!a.url.includes('sslmode') && a.url.includes('application_name=agent'));
  assert.equal(sslPlan('postgres://u:p@db.example.com/x?sslmode=verify-full').mode, 'verify');
  assert.equal(sslPlan('postgres://u:p@db.example.com/x?sslmode=disable').mode, 'disable');
  assert.equal(sslPlan('postgres://u:p@db.example.com/x?sslmode=require', 'disable').mode, 'disable');
  assert.equal(sslPlan('postgres://u:p@localhost/x').mode, 'disable');
  assert.equal(sslPlan('postgres://u:p@host.docker.internal/x').mode, 'disable');
  assert.equal(sslPlan('postgres://u:p@db.example.com/x').mode, 'require');
  assert.deepEqual(sslPlan('postgres://u:p@db.example.com/x', 'verify', '/etc/ca.pem').ssl, { rejectUnauthorized: true, caFile: '/etc/ca.pem' });
});

test('database errors become the fix, never the connection string', () => {
  assert.match(explainDbError(new Error('The server does not support SSL connections')), /DATABASE_SSL=disable/);
  assert.match(explainDbError(new Error('no pg_hba.conf entry for host "1.2.3.4", user "a", database "b", no encryption')), /DATABASE_SSL=require/);
  assert.match(explainDbError(new Error('self-signed certificate in certificate chain')), /DATABASE_SSL_CA/);
  assert.match(explainDbError(Object.assign(new Error('must be owner of table brain'), { code: '42501' })), /belong to another database user/);
  assert.match(explainDbError(Object.assign(new Error('permission denied for schema public'), { code: '42501' })), /GRANT CREATE ON SCHEMA public/);
  assert.match(explainDbError(Object.assign(new Error('password authentication failed for user "a"'), { code: '28P01' })), /URL-encode/);
  assert.match(explainDbError(Object.assign(new Error('getaddrinfo ENOTFOUND word@db'), { code: 'ENOTFOUND' })), /host name/);
  assert.match(explainDbError(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })), /Inside a container, localhost/);
  assert.ok(!explainDbError(new Error('boom postgres://u:secret@h/d')).includes('secret'));
});

test('tables that exist but belong to another user are named as such, with the owner and the GRANT', async () => {
  const s = await tableStatus(fakePg({ owner: 'dbadmin', user: 'agent', canUse: false }));
  assert.equal(s.missing.length, 0, 'not taken for missing');
  const line = describeTables(s);
  assert.equal(line.level, 'bad');
  assert.match(line.what, /14 of the tables exist but belong to the database user dbadmin, and this user \(agent\) cannot read and write them/);
  assert.match(line.fix, /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO agent/);
  assert.ok(!/<this user>|<owner>/.test(line.fix));
  await assert.rejects(ensureTables(fakePg({ owner: 'dbadmin', user: 'agent', canUse: false })), /belong to the database user dbadmin/);
  assert.match(line.fix, /ALTER DEFAULT PRIVILEGES FOR ROLE dbadmin IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agent;/);
  assert.match(line.fix, /ALTER TABLE brain OWNER TO agent;[\s\S]*ALTER TABLE moderation_log OWNER TO agent;/);
  assert.ok(!/REASSIGN|DATABASE_URL|login/.test(line.fix), 'never REASSIGN, never the owner\'s login in the settings');
  const usable = describeTables(await tableStatus(fakePg({ owner: 'dbadmin', user: 'agent', canUse: true })));
  assert.equal(usable.level, 'warn');
  assert.match(usable.fix, /after an upgrade, dbadmin \(or a database admin connected as dbadmin\) runs db\/schema\.sql/);
  assert.ok(!/DATABASE_URL|login/.test(usable.fix));
  assert.equal(describeTables(await tableStatus(fakePg({ tables: [] }))).what, 'the tables are not there yet');
  assert.match(explainDbError(Object.assign(new Error('must be owner of table brain'), { code: '42501' }), { user: 'agent', owner: 'dbadmin' }), /\(dbadmin\)[\s\S]*TO agent/);
  assert.match(explainDbError(new Error('permission denied for schema public'), { user: 'agent' }), /GRANT CREATE ON SCHEMA public TO agent;/);
});

test('missing tables this user cannot create get the right fix, and nothing is tried', async () => {
  const { plural } = await import('../src/words.mjs');
  let applied = false;
  const none = describeTables(await tableStatus(fakePg({ tables: [], canCreate: false })));
  assert.equal(none.what, 'the tables are not there yet, and this user cannot create them');
  assert.match(none.fix, /GRANT CREATE ON SCHEMA public TO agent;/);
  await assert.rejects(ensureTables(fakePg({ tables: [], canCreate: false, onApply: () => { applied = true; return []; } })), /cannot create them\. Fix: this database user/);
  assert.equal(applied, false);
  // an upgrade added a table, and the tables belong to an admin: the owner runs the schema file
  const upgrade = describeTables(await tableStatus(fakePg({ tables: TABLES.slice(1), owner: 'postgres', user: 'agent', canCreate: false })));
  assert.match(upgrade.what, /^1 of the 14 tables is missing \(brain\), and this user cannot create it$/);
  assert.match(upgrade.fix, /^after an upgrade, postgres \(or a database admin connected as postgres\) runs db\/schema\.sql/);
  assert.equal(describeTables(await tableStatus(fakePg({ tables: TABLES.slice(2) }))).what.startsWith('2 of the 14 tables are missing'), true);
  assert.equal(plural(1, 'table'), '1 table');
  assert.equal(plural(14, 'table'), '14 tables');
  assert.equal(plural(1, 'missing table'), '1 missing table');
});

test('one table this user cannot use is named in the singular', async () => {
  const line = describeTables({ user: 'agent', canCreate: true, missing: [], noAccess: [{ name: 'brain', owner: 'postgres' }], owners: ['agent', 'postgres'], ownedByOthers: true });
  assert.match(line.what, /^1 of the tables exists but belongs to the database user postgres, and this user \(agent\) cannot read and write it$/);
  assert.match(line.fix, /ALTER TABLE brain OWNER TO agent;/);
  assert.ok(!/ALTER TABLE state OWNER/.test(line.fix), 'only the tables it cannot use');
});

test('a prefix filter is escaped LIKE in SQL and startsWith in memory', async () => {
  assert.deepEqual(buildSelect('state', { where: { key: { prefix: 'seen/a_b%' } } }), { sql: 'select * from "state" where "key" like $1', params: ['seen/a\\_b\\%%'] });
  const d = createMemoryDb({ state: [{ key: 'seen/x', value: 1 }, { key: 'order/y', value: 2 }] });
  assert.deepEqual((await d.select('state', { where: { key: { prefix: 'seen/' } } })).map((r) => r.key), ['seen/x']);
});

test('the in-memory database keeps one open card per move, like the unique index', async () => {
  const d = createMemoryDb();
  const card = { run_date: '2026-11-19', action_type: 'pause_ad', target_id: '30', decision_key: 'pause:30', disposition: 'proposed' };
  assert.ok(await d.insertIgnore('actions_log', card, null));
  assert.equal(await d.insertIgnore('actions_log', { ...card, disposition: 'escalated' }, null), null);
  await assert.rejects(() => d.insert('actions_log', [card]), (e) => e.code === '23505');
  assert.ok(await d.insertIgnore('actions_log', { ...card, disposition: 'auto_applied' }, null), 'closed rows are not limited');
  assert.equal(buildInsert('actions_log', [card], { mode: 'ignore' }).sql.includes('on conflict do nothing'), true);
});

test('tables from before an upgrade are upgraded by npm start or db:setup when this user owns them', async () => {
  let applied = 0;
  const pg = fakePg({ upgraded: false, onApply: () => { applied++; return []; } });
  const s = await tableStatus(pg);
  assert.deepEqual(s.upgrade, ['the column actions_log.journal_id', 'the index actions_log_one_open']);
  assert.equal(describeTables(s).level, 'warn');
  const r = await ensureTables(pg);
  assert.deepEqual(r, { created: [], upgraded: ['the column actions_log.journal_id', 'the index actions_log_one_open'] });
  assert.equal(applied, 1);
  assert.deepEqual(await ensureTables(fakePg()), { created: [], upgraded: [] }, 'nothing to do on a current database');
  await assert.rejects(() => ensureTables(fakePg({ upgraded: false, owner: 'dbadmin', user: 'agent' })), /only their owner, dbadmin, can add it/);
});

test('the schema upgrade runs only what is missing and closes older duplicate open cards first', async () => {
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
  assert.match(sql, /journal_id\s+bigint/);
  assert.match(sql, /if not exists \(select 1 from information_schema\.columns[\s\S]*alter table actions_log add column journal_id bigint/);
  assert.match(sql, /close_reason = 'duplicate'[\s\S]*create unique index actions_log_one_open on actions_log \(decision_key\)\s+where disposition in \('proposed', 'escalated'\)/);
});
