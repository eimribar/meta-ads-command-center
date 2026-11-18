import test from 'node:test';
import assert from 'node:assert/strict';
import { journalWrite, unresolvedWrites, recoverWrites, clearWrite } from '../src/write-journal.mjs';
import { withExecution } from '../src/context.mjs';
import { setup } from './helpers.mjs';

const op = (node, body) => ({ operations: [{ node, body }], dispatch: async () => ({ success: true }) });
const as = (key, fn) => withExecution({ actor: 'UOPERATOR', kind: 'order', key }, fn);

test('a write needs an attributable source', async () => {
  setup();
  await assert.rejects(() => journalWrite(op('1', { status: 'PAUSED' })), /attributable source/);
});

test('an applied write is recorded and replays instead of sending twice', async () => {
  const { db } = setup();
  let sent = 0;
  const w = { operations: [{ node: '1', body: { status: 'PAUSED' } }], dispatch: async () => { sent++; return { success: true }; } };
  const a = await as('order:1', () => journalWrite(w));
  const b = await as('order:1', () => journalWrite(w));
  assert.equal(sent, 1);
  assert.equal(b.replay, true);
  assert.equal(db.tables.write_journal[0].state, 'applied');
  assert.equal(a.journalId, b.journalId);
});

test('a refusal from Meta is not_applied and holds nothing', async () => {
  const { db } = setup();
  await assert.rejects(() => as('order:2', () => journalWrite({ operations: [{ node: '2', body: { status: 'PAUSED' } }], dispatch: async () => { throw new Error('100: Invalid parameter'); } })), /Invalid parameter/);
  assert.equal(db.tables.write_journal[0].state, 'not_applied');
  assert.deepEqual(await unresolvedWrites(), []);
});

test('no answer means unknown, and every later write is held until it is cleared', async () => {
  const { db } = setup();
  const net = Object.assign(new Error('Meta POST failed: socket hang up'), { network: true });
  await assert.rejects(() => as('order:3', () => journalWrite({ operations: [{ node: '3', body: { status: 'PAUSED' } }], dispatch: async () => { throw net; } })), /unknown outcome/);
  assert.equal(db.tables.write_journal[0].state, 'unknown');
  await assert.rejects(() => as('order:4', () => journalWrite(op('4', { status: 'PAUSED' }))), /on hold/);
  const r = await clearWrite(1, 'UOPERATOR');
  assert.equal(r.ok, true);
  await as('order:4', () => journalWrite(op('4', { status: 'PAUSED' })));
  assert.equal(db.tables.write_journal.at(-1).state, 'applied');
});

test('preflight refusal never dispatches', async () => {
  const { db } = setup();
  let sent = false;
  await assert.rejects(() => as('order:5', () => journalWrite({ operations: [{ node: '5', body: {} }], validate: async () => { throw new Error('REFUSED: ceiling'); }, dispatch: async () => { sent = true; } })), /REFUSED/);
  assert.equal(sent, false);
  assert.equal(db.tables.write_journal[0].receipt.stage, 'preflight');
});

test('recovery reads the account back and settles what it can', async () => {
  setup({}, { seed: { write_journal: [
    { write_key: 'a', source: { key: 'x' }, operations: [{ node: '7', body: { status: 'PAUSED' } }], state: 'unknown', updated_at: new Date().toISOString() },
    { write_key: 'b', source: { key: 'y' }, operations: [{ node: '8', body: { daily_budget: '5000' } }], state: 'dispatching', updated_at: new Date().toISOString() },
  ] } });
  const graph = async (node) => (node === '7' ? { configured_status: 'PAUSED' } : { daily_budget: '4000' });
  const out = await recoverWrites({ graph });
  assert.deepEqual(out.map((o) => [o.id, o.resolved]), [[1, true], [2, false]]);
  assert.equal((await unresolvedWrites()).length, 1);
});
