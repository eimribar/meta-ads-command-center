// Amounts in the ad account currency, and budgets converted the way Meta stores them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.mjs';
import { money, setCurrency, fromMinor, toMinor, parseAmount, offset } from '../src/money.mjs';
import { setup, BASE_ENV, fakeGraph } from './helpers.mjs';

test('amounts are written in the ad account currency', () => {
  setCurrency('USD'); assert.equal(money(1250), '$1,250'); assert.equal(money(12.5), '$12.50');
  setCurrency('EUR'); assert.equal(money(480), '€480');
  setCurrency('GBP'); assert.equal(money(99.9), '£99.90');
  setCurrency('JPY'); assert.equal(money(5000), '¥5,000'); assert.equal(money(12.4), '¥12');
  setCurrency(null); assert.equal(money(1250), '1,250'); assert.equal(money(null), 'n/a');
  setCurrency('USD');
});

test('budgets convert with the currency offset Meta uses', () => {
  assert.equal(fromMinor('15000', 'USD'), 150);
  assert.equal(toMinor(150, 'USD'), '15000');
  assert.equal(offset('JPY'), 1);
  assert.equal(fromMinor('5000', 'JPY'), 5000);
  assert.equal(toMinor(5000, 'JPY'), '5000');
  assert.equal(fromMinor(null), null);
  assert.equal(parseAmount('£ 1,250'), 1250);
  assert.equal(parseAmount('€80'), 80);
  assert.equal(parseConfig({ ...BASE_ENV, TARGET_COST_PER_RESULT: '£75' }).config.TARGET_COST_PER_RESULT, 75);
});

test('a budget write is refused while the currency is unknown', async () => {
  setup();
  setCurrency(null);
  fakeGraph(() => ({ error: { code: 100, message: 'unreadable' } }));
  const { withExecution } = await import('../src/context.mjs');
  const { setBudget } = await import('../src/meta-write.mjs');
  await assert.rejects(() => withExecution({ actor: 'UOPERATOR', kind: 'order', key: 'cur1' }, () => setBudget('adset', '20', 120)), /currency could not be read/);
  setCurrency('USD');
});
