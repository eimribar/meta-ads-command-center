import test from 'node:test';
import assert from 'node:assert/strict';
import { runTools, requestBody } from '../src/reasoning.mjs';
import { tool, z } from '../src/tool.mjs';
import { setup, fakeClaude, text, toolUse } from './helpers.mjs';

test('the request uses the configured model, adaptive thinking and a cached system block', () => {
  setup();
  const b = requestBody({ system: ['rules', 'live context'], messages: [{ role: 'user', content: 'hi' }], mustCall: 'done_tool' });
  assert.equal(b.model, 'claude-opus-5-5');
  assert.deepEqual(b.thinking, { type: 'adaptive' });
  assert.equal(b.output_config.effort, 'high');
  assert.ok(b.max_tokens >= 32000);
  assert.deepEqual(b.system[0].cache_control, { type: 'ephemeral' });
  assert.match(b.system[0].text, /Finish by calling the done_tool tool/);
  assert.equal(b.system[1].cache_control, undefined);
});

test('tools run locally; errors go back to Claude with keys hidden', async () => {
  setup();
  const seen = [];
  const echo = tool({ name: 'echo', description: 'echo', input: z.object({ x: z.number() }), run: async ({ x }) => { seen.push(x); return { doubled: x * 2 }; } });
  const boom = tool({ name: 'boom', description: 'fails', input: z.object({}), run: async () => { throw new Error(`bad key ${['sk', 'ant', 'abc123XYZ'].join('-')}`); } });
  const requests = fakeClaude([
    toolUse('t1', 'echo', { x: 2 }),
    toolUse('t2', 'boom', {}),
    toolUse('t3', 'echo', { x: 'not a number' }),
    text('done'),
  ]);
  const r = await runTools({ system: 's', messages: [{ role: 'user', content: 'go' }], tools: [echo, boom] });
  assert.deepEqual(seen, [2]);
  assert.equal(r.message.content[0].text, 'done');
  const results = requests.slice(1).map((q) => q.messages.at(-1).content[0].content);
  assert.deepEqual(JSON.parse(results[0]), { doubled: 4 });
  assert.match(results[1], /\[hidden key\]/);
  assert.ok(!results[1].includes('sk-ant'));
  assert.match(results[2], /"ok":false/);
});

test('the assistant turn goes back unchanged, thinking included', async () => {
  setup();
  const thinking = { type: 'thinking', thinking: 'plan', signature: 'sig' };
  const noop = tool({ name: 'noop', description: '', input: z.object({}), run: async () => 'ok' });
  const requests = fakeClaude([toolUse('t1', 'noop', {}, [thinking]), text('fine')]);
  await runTools({ system: 's', messages: [{ role: 'user', content: 'go' }], tools: [noop] });
  assert.deepEqual(requests[1].messages[1].content[0], thinking);
});

test('a required tool gets one nudge, and done() ends the loop', async () => {
  setup();
  let captured = null;
  const fin = tool({ name: 'finish', description: '', input: z.object({ v: z.string() }), run: async ({ v }) => { captured = v; return 'ok'; } });
  const requests = fakeClaude([text('I think...'), toolUse('t1', 'finish', { v: 'yes' }), text('never reached')]);
  await runTools({ system: 's', messages: [{ role: 'user', content: 'go' }], tools: [fin], mustCall: 'finish', done: () => captured !== null });
  assert.equal(captured, 'yes');
  assert.equal(requests.length, 2);
  assert.match(requests[1].messages.at(-1).content, /Call the finish tool now/);
});

test('pause_turn from a server tool continues the loop', async () => {
  setup();
  const requests = fakeClaude([{ content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: {} }], stop_reason: 'pause_turn' }, text('answer')]);
  const r = await runTools({ system: 's', messages: [{ role: 'user', content: 'go' }], tools: [{ type: 'web_search_20260209', name: 'web_search' }] });
  assert.equal(requests.length, 2);
  assert.equal(r.message.content[0].text, 'answer');
});

test('a token in any tool result is hidden before it reaches Claude', async () => {
  setup();
  const meta = 'EAA' + 'B'.repeat(40);
  const leaky = tool({ name: 'leaky', description: '', input: z.object({}), run: async () => ({ data: [{ id: '1', access_token: meta, note: `${['xoxb', '123', 'abc'].join('-')} and postgres://u:pw@h/db` }] }) });
  const requests = fakeClaude([toolUse('t1', 'leaky', {}), text('ok')]);
  await runTools({ system: 's', messages: [{ role: 'user', content: 'go' }], tools: [leaky] });
  const sent = requests[1].messages.at(-1).content[0].content;
  assert.ok(!sent.includes(meta) && !sent.includes('xoxb-123') && !sent.includes('pw@h'), sent);
  assert.match(sent, /\[hidden token\][\s\S]*\[connection string\]/);
});

test('a refusal is a plain decline, not an error', async () => {
  setup();
  fakeClaude([{ content: [], stop_reason: 'refusal' }]);
  await assert.rejects(() => runTools({ system: 's', messages: [{ role: 'user', content: 'go' }], tools: [] }), (e) => e.declined === true);
});

test('a tool call cut off at the token limit is never run; one retry with more room', async () => {
  setup();
  const ran = [];
  const act = tool({ name: 'act', description: '', input: z.object({ x: z.number() }), run: async ({ x }) => { ran.push(x); return 'ok'; } });
  const cut = { content: [{ type: 'tool_use', id: 't1', name: 'act', input: { x: 1 } }], stop_reason: 'max_tokens' };
  let requests = fakeClaude([cut, toolUse('t2', 'act', { x: 2 }), text('done')]);
  await runTools({ system: 's', messages: [{ role: 'user', content: 'go' }], tools: [act] });
  assert.deepEqual(ran, [2], 'the cut-off call never ran');
  assert.ok(requests[1].max_tokens > requests[0].max_tokens, 'the retry has more room');
  requests = fakeClaude([cut, cut]);
  await assert.rejects(() => runTools({ system: 's', messages: [{ role: 'user', content: 'go' }], tools: [act] }), /ran out of room/);
  assert.deepEqual(ran, [2]);
});
