// Brain rows the code reads: checked when written, refused with the reason, shown in status.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCommand } from '../src/slack/commands.mjs';
import { setup } from './helpers.mjs';
import { getBrain, setBrain, BrainRowError } from '../src/brain.mjs';
import { checkBrainRow, parseThresholds } from '../src/brain-rules.mjs';
import { proposeBrainUpdate } from '../src/agentic.mjs';
import { policy, refreshPolicy } from '../src/optimizer/policy.mjs';

const noJobs = { report: async () => {}, optimize: async () => {}, moderation: async () => {} };

const say = () => { const out = []; return { out, reply: async (p) => { out.push(typeof p === 'string' ? p : p.text); return { ts: '1', channel: 'C' }; } }; };

const cmd = async (text, user = 'UOPERATOR') => { const s = say(); await handleCommand({ text, user, reply: s.reply, jobs: noJobs }); return s.out.join('\n'); };

test('policy/target in words is refused and nothing is saved; a plain number is saved as a number', async () => {
  setup();
  assert.match(await cmd('brain set policy/target about 150 dollars'), /must be a plain number[\s\S]*Nothing was saved/);
  assert.equal(await getBrain('policy', 'target'), null);
  assert.match(await cmd('brain set policy/target 1,250'), /Saved `policy\/target`\. The target is now/);
  assert.equal(await getBrain('policy', 'target'), 1250);
});

test('policy/thresholds the shell mangled, misspelled or out of range is refused with the way through', async () => {
  setup();
  // zsh strips the quotes: {"pause":{"zeroResultSpend":4}} arrives as {pause:{zeroResultSpend:4}}
  const mangled = await cmd('brain set policy/thresholds {pause:{zeroResultSpend:4}}');
  assert.match(mangled, /not JSON/);
  assert.match(mangled, /single quotes/);
  assert.match(mangled, /threshold pause\.zeroResultSpend 4/);
  assert.match(await cmd('brain set policy/thresholds {"pause":{"zeroResultSpnd":4}}'), /"pause" has no "zeroResultSpnd" \(it has zeroResultSpend/);
  assert.match(await cmd('brain set policy/thresholds {"scale":{"stepPct":500}}'), /scale\.stepPct must be from 1 to 100/);
  assert.match(await cmd('brain set policy/thresholds {"speed":{"x":1}}'), /there is no group "speed"/);
  assert.equal(await getBrain('policy', 'thresholds'), null, 'nothing was saved');
  // phones type curly quotes
  assert.match(await cmd('brain set policy/thresholds {“pause”:{“zeroResultSpend”:4}}'), /Saved/);
  assert.deepEqual(await getBrain('policy', 'thresholds'), { pause: { zeroResultSpend: 4 } });
  await refreshPolicy();
  assert.equal(policy().t.pause.zeroResultSpend, 4);
});

test('a policy row nothing reads is refused, and post ids are checked', async () => {
  setup();
  assert.match(await cmd('brain set policy/budget 500'), /reads only two policy rows/);
  assert.match(await cmd('brain set moderation/extra_posts the spring post'), /post ids separated by commas/);
  assert.match(await cmd('brain set moderation/extra_posts 111_222, 333'), /2 posts added/);
  assert.deepEqual(await getBrain('moderation', 'extra_posts'), ['111_222', '333']);
  assert.match(await cmd('brain set business/voice Plain and practical.'), /Saved/);
});

test('every write path checks the row: setBrain, a brain card, the agent proposing one', async () => {
  setup();
  await assert.rejects(setBrain('policy', 'target', 'soon', 'UOPERATOR'), BrainRowError);
  await assert.rejects(proposeBrainUpdate({ scope: 'policy', key: 'thresholds', content: 'tighter', why: 'x' }), /not JSON/);
  assert.throws(() => checkBrainRow('policy', 'target', 'abc'), BrainRowError);
  assert.deepEqual(parseThresholds({ pause: { minDays: '4' } }), { value: { pause: { minDays: 4 } }, problems: [] });
});

test('threshold sets one number, default puts it back, and only an operator can change it', async () => {
  setup();
  assert.match(await cmd('threshold pause.zeroResultSpend 4'), /`pause\.zeroResultSpend` is now 4 \(default 3, allowed 0\.5 to 50\)/);
  assert.match(await cmd('threshold scale.stepPct 15'), /is now 15/);
  assert.deepEqual(await getBrain('policy', 'thresholds'), { pause: { zeroResultSpend: 4 }, scale: { stepPct: 15 } });
  assert.match(await cmd('thresholds', 'USOMEONE'), /`pause\.zeroResultSpend` 4 \(default 3\)/);
  assert.match(await cmd('threshold pause.zeroResultSpnd 4'), /no threshold "pause\.zeroResultSpnd"/);
  assert.match(await cmd('threshold pause.zeroResultSpend lots'), /must be a number/);
  assert.match(await cmd('threshold scale.stepPct 15', 'USOMEONE'), /needs an operator/);
  assert.match(await cmd('threshold pause.zeroResultSpend default'), /is now 3 \(the default\)/);
  assert.match(await cmd('threshold scale.stepPct default'), /the default/);
  assert.equal(await getBrain('policy', 'thresholds'), null, 'the row goes when nothing differs from the defaults');
});

test('status says where the target comes from, which thresholds changed, and which rows are ignored', async () => {
  setup({}, { seed: { brain: [
    { scope: 'policy', key: 'target', content: 180 },
    { scope: 'policy', key: 'thresholds', content: { pause: { zeroResultSpend: 4, zeroResultSpnd: 9 } } },
  ] } });
  const out = await cmd('status', 'USOMEONE');
  assert.match(out, /Target: \$180, from the brain \(policy\/target\); it overrides TARGET_COST_PER_RESULT, \$150\b/);
  assert.match(out, /Thresholds: 1 changed in the brain: pause\.zeroResultSpend 4 \(default 3\)/);
  assert.match(out, /Ignored brain rows: policy\/thresholds: "pause" has no "zeroResultSpnd"/);
  assert.match(out, /Result: test rides \(the Schedule event\)/);
  assert.ok(!/offsite_conversion|schedule_website/.test(out), 'no action type jargon');
  assert.match(await cmd('brain rm policy/target'), /Removed/);
  assert.match(await cmd('status'), /Target: \$150, from TARGET_COST_PER_RESULT/);
});

test('a half written brain set saves nothing and says how to write it', async () => {
  const { db } = setup();
  assert.match(await cmd('brain set company We sell bikes'), /Write it as `brain set <section>\/<name> <text>`[\s\S]*Nothing was saved/);
  assert.match(await cmd('brain set business/company'), /There is no text after `business\/company`[\s\S]*Nothing was saved/);
  assert.match(await cmd('brain set business/company   '), /There is no text after/);
  assert.match(await cmd('brain rm company'), /Write it as `brain rm <section>\/<name>`/);
  assert.match(await cmd('brain show me'), /The brain commands are/);
  assert.equal(db.tables.brain?.length || 0, 0);
  assert.match(await cmd('brain', 'USOMEONE'), /The brain is empty/);
});

test('brain names match in any case and are stored in lower case', async () => {
  const { db } = setup({}, { seed: { brain: [{ scope: 'Business', key: 'Company', content: 'old text' }] } });
  assert.equal(await getBrain('business', 'company'), 'old text', 'an older mixed case row still matches');
  assert.match(await cmd('brain set Business/Company Northfield Bikes sells city e-bikes.'), /Saved `business\/company`/);
  assert.deepEqual(db.tables.brain.map((r) => [r.scope, r.key, r.content]), [['business', 'company', 'Northfield Bikes sells city e-bikes.']], 'replaced, not doubled');
  assert.match(await cmd('brain set POLICY/Target 45'), /Saved `policy\/target`/);
  await refreshPolicy();
  assert.equal(policy().target, 45);
  assert.match(await cmd('brain rm BUSINESS/company'), /Removed `business\/company`/);
  assert.match(await cmd('brain rm business/company'), /There is no brain row business\/company/);
});

test('help names a brain row by its section and name', async () => {
  setup();
  assert.match(await cmd('help', 'USOMEONE'), /`brain rm business\/company` \(a row is named section\/name\)/);
});
