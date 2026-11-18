import test from 'node:test';
import assert from 'node:assert/strict';
import { moveEffects, effectsText } from '../src/review.mjs';
import { daysAgo } from '../src/clock.mjs';
import { setup } from './helpers.mjs';

test('the weekly review shows what each applied move did', async () => {
  const applied = `${daysAgo(8)}T10:00:00.000Z`;
  const perf = [];
  for (let k = 14; k >= 2; k--) {
    const date = daysAgo(k);
    const after = date > daysAgo(8);
    perf.push({ date, level: 'adset', entity_id: '20', spend: after ? 120 : 100, results: after ? 2 : 1 });
    if (!after) perf.push({ date, level: 'ad', entity_id: '30', spend: 60, results: 0 });
  }
  setup({}, { seed: {
    actions_log: [
      { run_date: daysAgo(8), action_type: 'scale_budget', target_level: 'adset', target_id: '20', target_name: 'Broad', applied: true, applied_at: applied, applied_by: 'UOPERATOR', disposition: 'applied_by_human' },
      { run_date: daysAgo(8), action_type: 'pause_ad', target_level: 'ad', target_id: '30', target_name: 'Loser', applied: true, applied_at: applied, applied_by: 'optimizer', disposition: 'auto_applied' },
      { run_date: daysAgo(8), action_type: 'pause_ad', target_level: 'ad', target_id: '31', applied: true, applied_at: applied, undone_at: applied, disposition: 'auto_applied' },
    ],
    performance_daily: perf,
  } });
  const fx = await moveEffects();
  assert.equal(fx.length, 2, 'undone moves are left out');
  const scale = fx.find((e) => e.action_type === 'scale_budget');
  assert.deepEqual([scale.before.cost, scale.after.cost, scale.before.perDay, scale.after.perDay], [100, 60, 1, 2]);
  const text = effectsText(fx);
  assert.match(text, /Raise budget \*Broad\*.*test rides a day 1 to 2, cost each \$100 to \$60/);
  assert.match(text, /Pause ad \*Loser\*.*automatic.*after, \$0 a day/);
});
