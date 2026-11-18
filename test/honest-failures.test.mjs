// Jobs and tools that cannot read Meta or use a feature fail plainly, instead of looking healthy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runModeration } from '../src/moderation.mjs';
import { runOptimizer } from '../src/optimizer/optimizer.mjs';
import { runNamedJob } from '../src/scheduled.mjs';
import { setRuntime } from '../src/runtime.mjs';
import { setup, fakeGraph, fakeClaude, text } from './helpers.mjs';

const deadToken = () => fakeGraph(() => ({ error: { code: 190, message: 'Invalid OAuth access token' } }));

test('the comment sweep fails, instead of reporting a clean sweep, when Meta refuses the token', async () => {
  setup();
  deadToken();
  fakeClaude([text('{"verdicts":[]}')]);
  await assert.rejects(() => runModeration({ act: false }), /could not read the ads from Meta: 190/);
  await assert.rejects(() => runModeration({ given: [{ platform: 'facebook', id: '222_1', label: 'Page post' }] }), /could not read the comments on any of 1 post:/);
});

test('a sweep that could read some posts reports the ones it could not', async () => {
  setup();
  fakeGraph(({ path }) => {
    if (path === '222') return { access_token: 'page' };
    if (path === '222_1/comments') return { data: [] };
    return { error: { code: 10, message: 'no permission' } };
  });
  fakeClaude([text('{"verdicts":[]}')]);
  const r = await runModeration({ given: [{ platform: 'facebook', id: '222_1', label: 'Page post' }, { platform: 'instagram', id: '9', label: 'Instagram post' }] });
  assert.equal(r.readErrors.length, 1);
  assert.match(r.readErrors[0], /Instagram post/);
});

test('the optimizer fails, instead of freezing, when the numbers cannot be read; the job is recorded as failed', async () => {
  const { db } = setup();
  deadToken();
  fakeClaude([text('nothing')]);
  await assert.rejects(() => runOptimizer({ dryRun: true }), /could not read the numbers from Meta: 190/);
  await assert.rejects(() => runNamedJob('optimizer-check', { dryRun: true }), /190/);
  await assert.rejects(() => runNamedJob('moderation'), /190/);
  assert.equal(db.tables.job_runs.find((j) => j.name === 'moderation').status, 'failed');
  setRuntime({ fetch: () => { throw new Error('no network in tests'); } });
});

test('when web search is off for the Anthropic organization, the answer comes without it', async () => {
  setup();
  const { runTools, textOf } = await import('../src/reasoning.mjs');
  const asked = fakeClaude([
    () => { throw Object.assign(new Error('400 web search is not enabled for this organization'), { status: 400 }); },
    text('answered without the web'),
  ]);
  const { message } = await runTools({ system: 's', messages: [{ role: 'user', content: 'q' }], tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }] });
  assert.equal(textOf(message), 'answered without the web');
  assert.ok(!(asked.at(-1).tools || []).some((t) => String(t.type).startsWith('web_search')));
});
