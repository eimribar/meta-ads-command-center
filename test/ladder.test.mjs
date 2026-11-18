// The ladder: which moves wait for a person, in the words the docs use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCommand } from '../src/slack/commands.mjs';
import { setup } from './helpers.mjs';
import { actionTypeFrom, ladderModeFrom } from '../src/optimizer/policy.mjs';
import { ladder } from '../src/optimizer/executor.mjs';
import { buildHome } from '../src/slack/home.mjs';

const noJobs = { report: async () => {}, optimize: async () => {}, moderation: async () => {} };

const say = () => { const out = []; return { out, reply: async (p) => { out.push(typeof p === 'string' ? p : p.text); return { ts: '1', channel: 'C' }; } }; };

const cmd = async (text, user = 'UOPERATOR') => { const s = say(); await handleCommand({ text, user, reply: s.reply, jobs: noJobs }); return s.out.join('\n'); };

test('the ladder takes the words the docs use and answers in them', async () => {
  setup();
  assert.equal(actionTypeFrom('raise'), 'scale_budget');
  assert.equal(actionTypeFrom('Turn back on'), 'unpause_ad');
  assert.equal(actionTypeFrom('trim budget'), 'descale_budget');
  assert.equal(actionTypeFrom('pause_ad'), 'pause_ad');
  assert.equal(ladderModeFrom('ask'), 'propose');
  assert.match(await cmd('ladder set pause auto'), /pause an ad: now \*happens on its own\*/);
  assert.equal((await ladder()).find((l) => l.action_type === 'pause_ad').mode, 'auto');
  assert.match(await cmd('ladder set pause ask'), /pause an ad: now \*waits for a person\*/);
  assert.match(await cmd('ladder set raise auto'), /raise a budget always waits for a person/);
  assert.match(await cmd('ladder set turn back on auto'), /turn an ad back on always waits for a person/);
  assert.match(await cmd('ladder set raise_budget auto'), /raise a budget always waits/);
  assert.match(await cmd('ladder set spend more auto'), /is not a kind of move\. The kinds: pause, turn back on, raise, trim/);
  assert.match(await cmd('ladder set pause sometimes'), /`auto`.*or `ask`/);
  const list = await cmd('ladder', 'USOMEONE');
  assert.match(list, /pause an ad \(`pause`\): \*waits for a person\*/);
  assert.ok(!/scale_budget|unpause_ad|propose/.test(list), 'no internal names in the reply');
  const home = JSON.stringify(await buildHome('USOMEONE'));
  assert.match(home, /Ads Command Center/);
  assert.match(home, /raise a budget: \*waits for a person\* \(always\)/);
});
