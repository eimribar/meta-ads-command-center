import test from 'node:test';
import assert from 'node:assert/strict';
import { costPosterior, probBeatsBar, isProvenWinner, matureRows } from '../src/optimizer/stats.mjs';

test('the posterior mean moves from the prior toward the data', () => {
  const none = costPosterior({ spend: 0, results: 0, priorCost: 150, priorResults: 3 });
  assert.equal(none.meanCost, 150);
  const data = costPosterior({ spend: 1000, results: 10, priorCost: 150, priorResults: 3 });
  assert.equal(data.meanCost, Math.round(((3 * 150 + 1000) / 13) * 100) / 100);
  assert.ok(data.lo90 < data.meanCost && data.meanCost < data.hi90);
});

test('more data makes the interval narrower', () => {
  const small = costPosterior({ spend: 500, results: 5, priorCost: 100 });
  const big = costPosterior({ spend: 5000, results: 50, priorCost: 100 });
  assert.ok(big.hi90 - big.lo90 < small.hi90 - small.lo90);
});

test('probability of beating the bar is sensible at the edges', () => {
  assert.equal(probBeatsBar({ spend: 100, results: 1 }, 0), 0);
  const cheap = probBeatsBar({ spend: 1000, results: 30, priorResults: 3 }, 150);
  const pricey = probBeatsBar({ spend: 3000, results: 5, priorResults: 3 }, 150);
  assert.ok(cheap > 0.99, `cheap ${cheap}`);
  assert.ok(pricey < 0.05, `pricey ${pricey}`);
  const even = probBeatsBar({ spend: 0, results: 0, priorResults: 3 }, 150);
  assert.ok(even > 0.3 && even < 0.7, `prior alone ${even}`);
});

test('a winner needs both the probability and the mature days', () => {
  const stat = { spend: 1000, results: 20, priorResults: 3 };
  assert.equal(isProvenWinner(stat, { bar: 150, matureDays: 5 }).proven, true);
  const early = isProvenWinner(stat, { bar: 150, matureDays: 2 });
  assert.equal(early.proven, false);
  assert.match(early.reason, /only 2 of 4 mature days/);
  assert.equal(isProvenWinner({ spend: 1000, results: 6 }, { bar: 150, matureDays: 6 }).proven, false);
});

test('only days older than the lag count', () => {
  const rows = [{ date: '2026-11-10' }, { date: '2026-11-16' }, { date: '2026-11-17' }, { date: '2026-11-18' }];
  assert.deepEqual(matureRows(rows, { asOf: '2026-11-18', lagDays: 2 }).map((r) => r.date), ['2026-11-10', '2026-11-16']);
  assert.deepEqual(matureRows(null), []);
});
