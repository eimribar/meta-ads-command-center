// The team's record: decisions with their reasons, hypotheses graded against the numbers, and the
// team's own result views. Recorded from Slack by an operator, or from a card the agent posts and
// an operator taps; read by the chat agent, the optimizer and the daily report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleCommand } from '../src/slack/commands.mjs';
import { setup, fakeClaude, toolUse, text, fakeSlack, fakeApp, fakePg, BASE_ENV } from './helpers.mjs';
import { setRuntime } from '../src/runtime.mjs';
import { ask } from '../src/agent.mjs';
import { registerApprovals } from '../src/slack/approvals.mjs';
import { fakeAccount } from './account-fake.mjs';
import { setBrain, getBrain } from '../src/brain.mjs';
import { checkBrainRow } from '../src/brain-rules.mjs';
import { recordBlock, resultViewsBlock, resetViewState, recordDecision } from '../src/record.mjs';
import { TABLES } from '../src/schema.mjs';
import { runOptimizer } from '../src/optimizer/optimizer.mjs';
import { buildDailyReport } from '../src/report.mjs';
import { runCheck } from '../src/check.mjs';

const noJobs = { report: async () => {}, optimize: async () => {}, moderation: async () => {} };
const cmd = async (words, user = 'UOPERATOR') => {
  const out = [];
  await handleCommand({ text: words, user, reply: async (p) => { out.push(typeof p === 'string' ? p : p.text); return { ts: '1', channel: 'C' }; }, jobs: noJobs });
  return out.join('\n');
};

test('the two tables ship with the schema, safe to run twice', () => {
  const sql = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
  assert.ok(TABLES.includes('decisions') && TABLES.includes('hypotheses'));
  for (const t of ['decisions', 'hypotheses']) assert.match(sql, new RegExp(`create table if not exists ${t} \\(`));
  for (const col of ['decided_at', 'topic', 'decision', 'why', 'decided_by', 'source', 'replaces', 'brain_key', 'status']) assert.match(sql, new RegExp(`\\n  ${col} `));
  for (const col of ['claim', 'kind', 'labels', 'started', 'ended', 'evidence', 'verdict', 'graded_at', 'created_by', 'created_at']) assert.match(sql, new RegExp(`\\n  ${col} `));
  assert.match(sql, /check \(status in \('active', 'replaced', 'reversed'\)\)/);
  assert.match(sql, /check \(verdict in \('pending', 'confirmed', 'refuted'\)\)/);
  assert.match(sql, /check \(kind in \('hypothesis', 'test'\)\)/);
});

test('an operator records a decision with its reason; it names who decided, and one without a reason is refused', async () => {
  const { db } = setup();
  assert.match(await cmd('decision pause the night ads'), /kept with its reason[\s\S]*Nothing was saved/);
  assert.match(await cmd('decision budget: no budget changes during the spring launch because we need one clean week to compare', 'UOTHER'), /needs an operator/);
  assert.equal(db.tables.decisions?.length || 0, 0);
  const out = await cmd('decision budget: no budget changes during the spring launch because we need one clean week to compare');
  assert.match(out, /Decision \*#1\* recorded by <@UOPERATOR>/);
  const [d] = db.tables.decisions;
  assert.deepEqual([d.topic, d.decision, d.why, d.decided_by, d.status, d.source], ['budget', 'no budget changes during the spring launch', 'we need one clean week to compare', 'UOPERATOR', 'active', 'Slack command']);
  assert.ok(db.tables.timeline.some((e) => e.event === 'decision' && e.detail.by === 'UOPERATOR'));
  assert.match(await cmd('decisions', 'UOTHER'), /Active decisions[\s\S]*#1 .*\[budget\] no budget changes during the spring launch Why: we need one clean week to compare \(<@UOPERATOR>\)/);
});

test('a decision that replaces another closes the old one as replaced; a reversal keeps the reason', async () => {
  const { db } = setup();
  await cmd('decision targeting: only commuters for now because the theft angle tested best with them');
  const out = await cmd('decision targeting: commuters and students because students matched in week two (replaces 1)');
  assert.match(out, /#2\* recorded[\s\S]*#1 is now replaced/);
  const [one, two] = db.tables.decisions;
  assert.equal(one.status, 'replaced');
  assert.equal(one.close_note, 'replaced by #2');
  assert.equal(two.replaces, 2 - 1);
  assert.match(await cmd('decision new thing because x (replaces 1)'), /already replaced[\s\S]*Nothing was saved/);
  assert.match(await cmd('decision 2 reversed'), /needs the reason/);
  assert.match(await cmd('decision 2 reversed because the season ended'), /Decision #2 reversed by <@UOPERATOR>/);
  assert.equal(db.tables.decisions[1].status, 'reversed');
  assert.equal(db.tables.decisions[1].close_note, 'the season ended');
  assert.match(await cmd('decisions'), /No active decisions/);
  assert.match(await cmd('decisions all'), /#2 .*_reversed: the season ended_[\s\S]*#1 .*_replaced: replaced by #2_/);
});

test('hypotheses are recorded with labels for any segment, graded with the numbers, and listed', async () => {
  const { db } = setup();
  assert.match(await cmd('hypothesis Theft angle brings cheaper test rides [audience=commuters, angle=theft]'), /Hypothesis \*#1\* recorded by <@UOPERATOR>/);
  assert.match(await cmd('hypothesis test Night ads cost more per ride [daypart=night]'), /Test \*#2\* recorded/);
  const [h1, h2] = db.tables.hypotheses;
  assert.deepEqual(h1.labels, { audience: 'commuters', angle: 'theft' });
  assert.equal(h1.kind, 'hypothesis');
  assert.equal(h1.verdict, 'pending');
  assert.equal(h2.kind, 'test');
  assert.match(String(h2.started), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(await cmd('hypothesis Bad label [Audience Type=x]'), /one word in lower case[\s\S]*Nothing was saved/);
  assert.match(await cmd('hypothesis 1 confirmed'), /needs the reason/);
  assert.match(await cmd('hypothesis 1 confirmed because $92 per ride against $150 over 14 days'), /Hypothesis #1 graded \*confirmed\* by <@UOPERATOR>/);
  assert.equal(db.tables.hypotheses[0].verdict, 'confirmed');
  assert.equal(db.tables.hypotheses[0].graded_by, 'UOPERATOR');
  assert.match(await cmd('hypothesis 2 refuted because the same cost per ride as daytime'), /refuted/);
  assert.ok(db.tables.hypotheses[1].ended, 'a graded test gets its end date');
  assert.match(await cmd('hypothesis 1 refuted because it slipped to $170 in week three'), /\(it was confirmed\)/);
  assert.match(await cmd('hypotheses'), /No open hypotheses/);
  assert.match(await cmd('hypotheses all'), /\[audience=commuters, angle=theft\] Theft angle brings cheaper test rides \*refuted\*: it slipped/);
  assert.match(await cmd('hypothesis 9 confirmed because x'), /no hypothesis #9/);
});

test('the chat agent, the optimizer and the report get the active decisions and the open hypotheses', async () => {
  setup();
  fakeAccount();
  await recordDecision({ decision: 'Keep the spring offer until April', why: 'the shop has stock until then', topic: 'offer' }, 'UOPERATOR');
  await cmd('hypothesis Theft angle brings cheaper test rides [angle=theft]');
  const block = await recordBlock();
  assert.match(block, /# DECISIONS[\s\S]*#1 \d{4}-\d{2}-\d{2} \[offer\] Keep the spring offer until April Why: the shop has stock until then/);
  assert.match(block, /# OPEN HYPOTHESES[\s\S]*#1 \[angle=theft\] Theft angle brings cheaper test rides/);
  setRuntime({ slack: fakeSlack() });
  const requests = fakeClaude([text('Noted.')]);
  await ask([{ role: 'user', content: 'what did we decide about the offer?' }], { actor: 'UOPERATOR', key: 'chat:t:1', thread: { channel: 'CTEST', thread_ts: '1' } });
  const system = requests[0].system.map((s) => s.text).join('\n');
  assert.match(system, /# DECISIONS[\s\S]*Keep the spring offer until April/);
  assert.match(system, /# OPEN HYPOTHESES/);
  assert.equal(requests[0].system[0].cache_control?.type, 'ephemeral', 'the rules stay the cached part');
  assert.ok(!requests[0].system[0].text.includes('Keep the spring offer'), 'the record is not in the cached rules');
  // the optimizer works within the same record
  const opt = fakeClaude([toolUse('o1', 'propose_actions', { summary: 'nothing to do', actions: [] }), text('done')]);
  await runOptimizer({ cadence: 'daily', dryRun: true });
  const optSystem = opt[0].system.map((s) => s.text).join('\n');
  assert.match(optSystem, /# DECISIONS[\s\S]*Keep the spring offer until April[\s\S]*# OPEN HYPOTHESES/);
  assert.ok(!opt[0].system[0].text.includes('Keep the spring offer'));
  // and so does the daily report's short read
  const rep = fakeClaude([text('A quiet day.')]);
  await buildDailyReport();
  assert.match(rep[0].system.map((s) => s.text).join('\n'), /# DECISIONS[\s\S]*Keep the spring offer until April/);
});

test('the agent proposes a decision from the conversation; it is recorded only when an operator taps Record', async () => {
  const { db } = setup({ ADMIN_SLACK_USER_IDS: 'UOPERATOR,ULEAD' });
  fakeAccount();
  const slack = fakeSlack();
  setRuntime({ slack });
  fakeClaude([toolUse('p1', 'propose_decision', { decision: 'No new ad sets before the spring launch', why: 'we need a clean read on the current ones', topic: 'structure' }), text('The card is up.')]);
  const out = await ask([{ role: 'user', content: 'lets not add ad sets before spring, we need a clean read' }], { actor: 'ULEAD', key: 'chat:t:2', thread: { channel: 'CTEST', thread_ts: '1' } });
  assert.equal(db.tables.decisions?.length || 0, 0, 'the message alone records nothing');
  assert.match(out.text, /posted a card to record a decision/);
  const card = slack.calls.find((c) => c.name === 'chat.postMessage' && c.args.blocks?.some((b) => b.type === 'actions'));
  assert.match(JSON.stringify(card.args.blocks), /Decision to record[\s\S]*No new ad sets before the spring launch[\s\S]*we need a clean read/);
  assert.match(JSON.stringify(card.args.blocks), /From <@ULEAD>'s message/);
  const app = fakeApp();
  registerApprovals(app);
  const button = (id) => card.args.blocks.find((b) => b.type === 'actions').elements.find((e) => e.action_id === id);
  const tap = (id, user = 'UOPERATOR') => app.actions[id]({ ack: async () => {}, body: { type: 'block_actions', user: { id: user }, channel: { id: 'CTEST' }, message: { ts: '1001' } }, action: button(id), client: slack });
  await tap('record_apply');
  assert.equal(db.tables.decisions.length, 1);
  assert.equal(db.tables.decisions[0].decided_by, 'UOPERATOR', 'the operator who tapped is the one who decided');
  assert.match(db.tables.decisions[0].source, /from <@ULEAD>'s message/);
  assert.match(JSON.stringify(slack.calls.at(-1).args.blocks), /Recorded as decision \*#1\* by <@UOPERATOR>/);
  await tap('record_apply');
  assert.equal(db.tables.decisions.length, 1, 'a second tap records nothing');
  // like a brain update, a proposal is an operator's tool; anyone can read the record
  const member = fakeClaude([text('Only an operator can put that on a card.')]);
  await ask([{ role: 'user', content: 'record that' }], { actor: 'UMEMBER', key: 'chat:t:2b', thread: { channel: 'CTEST', thread_ts: '1' } });
  const names = member[0].tools.map((t) => t.name);
  assert.ok(!names.includes('propose_decision') && names.includes('result_view') && names.includes('query_history'));
});

test('a proposed grade and a proposed hypothesis go through the same card; a decision without a reason never reaches one', async () => {
  const { db } = setup();
  fakeAccount();
  const slack = fakeSlack();
  setRuntime({ slack });
  fakeClaude([toolUse('p1', 'propose_hypothesis', { claim: 'Short videos beat stills for test rides', kind: 'test', labels: { format: 'video' } }), text('Card up.')]);
  await ask([{ role: 'user', content: 'I think short videos beat stills' }], { actor: 'UOPERATOR', key: 'chat:t:3', thread: { channel: 'CTEST', thread_ts: '1' } });
  const cards = () => slack.calls.filter((c) => c.name === 'chat.postMessage' && c.args.blocks?.some((b) => b.type === 'actions'));
  const app = fakeApp();
  registerApprovals(app);
  const tapLast = (id) => { const card = cards().at(-1); const action = card.args.blocks.find((b) => b.type === 'actions').elements.find((e) => e.action_id === id); return app.actions[id]({ ack: async () => {}, body: { type: 'block_actions', user: { id: 'UOPERATOR' }, channel: { id: 'CTEST' }, message: { ts: '1001' } }, action, client: slack }); };
  await tapLast('record_apply');
  assert.deepEqual([db.tables.hypotheses[0].kind, db.tables.hypotheses[0].labels], ['test', { format: 'video' }]);
  fakeClaude([toolUse('p2', 'propose_grade', { id: 1, verdict: 'confirmed', why: '$88 per ride on video against $140 on stills, 12 days' }), text('Card up.')]);
  await ask([{ role: 'user', content: 'did videos win?' }], { actor: 'UOPERATOR', key: 'chat:t:4', thread: { channel: 'CTEST', thread_ts: '1' } });
  assert.match(JSON.stringify(cards().at(-1).args.blocks), /Grade hypothesis #1: confirmed/);
  await tapLast('record_dismiss');
  assert.equal(db.tables.hypotheses[0].verdict, 'pending', 'dismissed: nothing recorded');
  fakeClaude([toolUse('p3', 'propose_decision', { decision: 'Stop stills', why: '   ' }), text('ok')]);
  const n = cards().length;
  await ask([{ role: 'user', content: 'stop stills' }], { actor: 'UOPERATOR', key: 'chat:t:5', thread: { channel: 'CTEST', thread_ts: '1' } });
  assert.equal(cards().length, n, 'no card without the reason');
});

test('result views: the brain row is checked, the views are read every turn, and a missing one is skipped and reported', async () => {
  const { db } = setup();
  resetViewState();
  assert.throws(() => checkBrainRow('context', 'result_views', '[{"name":"Daily-Results"}]'), /not a table or view name/);
  assert.throws(() => checkBrainRow('context', 'result_views', '[{"name":"x","days":400}]'), /days must be a whole number from 1 to 90/);
  assert.deepEqual(checkBrainRow('context', 'result_views', 'angle_results, channel_results'), [
    { name: 'angle_results', days: 14, rows: 50, chars: 6000 }, { name: 'channel_results', days: 14, rows: 50, chars: 6000 }]);
  await setBrain('context', 'result_views', [{ name: 'angle_results', date_column: 'day', days: 14 }, { name: 'missing_view', date_column: 'day' }], 'UOPERATOR');
  const today = new Date().toISOString().slice(0, 10);
  db.tables.angle_results = [{ day: today, angle: 'theft', test_rides: 9, spend: 810 }, { day: '2001-01-01', angle: 'old', test_rides: 1, spend: 1 }];
  const realSelect = db.select;
  db.select = async (table, opts) => {
    if (table === 'missing_view') throw Object.assign(new Error('relation "missing_view" does not exist'), { code: '42P01' });
    return realSelect(table, opts);
  };
  const block = await resultViewsBlock();
  assert.match(block, /# TEAM RESULTS[\s\S]*## angle_results \(since \d{4}-\d{2}-\d{2}, 1 row\)\ncolumns: day \| angle \| test_rides \| spend\n\[".*","theft",9,810\]/);
  assert.ok(!block.includes('"old"'), 'rows outside the window are left out');
  assert.match(block, /## missing_view\n\(not available: there is no table or view named missing_view in this database\)/);
  assert.equal(db.tables.incidents.filter((i) => i.key === 'result_view:missing_view' && !i.resolved_at).length, 1);
  await resultViewsBlock();
  assert.equal(db.tables.incidents.filter((i) => i.key === 'result_view:missing_view').length, 1, 'one issue, not one per turn');
  // a chat turn still answers, with the views in the live part of the turn
  fakeAccount();
  setRuntime({ slack: fakeSlack() });
  const requests = fakeClaude([text('Theft leads.')]);
  const out = await ask([{ role: 'user', content: 'which angle leads?' }], { actor: 'UOPERATOR', key: 'chat:t:6', thread: { channel: 'CTEST', thread_ts: '1' } });
  assert.match(out.text, /Theft leads/);
  assert.match(requests[0].messages[0].content[0].text, /# TEAM RESULTS[\s\S]*angle_results/);
  assert.ok(!requests[0].system.some((s) => s.text.includes('# TEAM RESULTS')), 'live numbers ride in the turn, not the system prompt');
  // status names the view that is not set up
  assert.match(await cmd('status'), /Record: 0 active decisions, 0 open hypotheses · result views: angle_results ok, missing_view not set up \(there is no table or view named missing_view/);
  // the view is created: the issue closes on the next read
  db.select = realSelect;
  await resultViewsBlock();
  assert.ok(db.tables.incidents.find((i) => i.key === 'result_view:missing_view').resolved_at);
  assert.deepEqual((await getBrain('context', 'result_views'))[0].name, 'angle_results');
});

test('the result_view tool reads a configured view over another window, and nothing else', async () => {
  const { db } = setup();
  resetViewState();
  fakeAccount();
  setRuntime({ slack: fakeSlack() });
  await setBrain('context', 'result_views', 'channel_results', 'UOPERATOR');
  db.tables.channel_results = [{ channel: 'meta', test_rides: 4 }];
  const requests = fakeClaude([toolUse('r1', 'result_view', { name: 'channel_results', days: 30, rows: 10 }), toolUse('r2', 'result_view', { name: 'brain', days: null, rows: 10 }), text('Done.')]);
  await ask([{ role: 'user', content: 'channel numbers?' }], { actor: 'UMEMBER', key: 'chat:t:7', thread: { channel: 'CTEST', thread_ts: '1' } });
  const results = requests.flatMap((r) => r.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))).filter((c) => c.type === 'tool_result');
  assert.match(JSON.stringify(results[0]), /\\"test_rides\\":4/);
  assert.match(JSON.stringify(results.at(-1)), /not one of the team's result views: channel_results/);
});

test('the check names a result view that is not set up, and one this user may not read', async () => {
  const env = { ...BASE_ENV, META_ACCESS_TOKEN: '', META_AD_ACCOUNT_ID: '', SLACK_BOT_TOKEN: '', SLACK_APP_TOKEN: '', ANTHROPIC_API_KEY: '', DATABASE_URL: 'postgres://agent:pw@db.example.com:5432/agent' };
  let r = await runCheck(env, { pg: async () => fakePg({ resultViews: [{ name: 'angle_results' }, { name: 'channel_results' }], relations: ['angle_results'], unreadable: [] }) });
  assert.match(r.text, /WARN  result views: channel_results not set up \(no table or view by that name\)/);
  r = await runCheck(env, { pg: async () => fakePg({ resultViews: 'angle_results', relations: [], unreadable: ['angle_results'] }) });
  assert.match(r.text, /WARN  result views: this user may not read angle_results[\s\S]*GRANT SELECT ON angle_results/);
  r = await runCheck(env, { pg: async () => fakePg({ resultViews: 'angle_results', relations: ['angle_results'] }) });
  assert.match(r.text, /OK    result views: angle_results/);
  r = await runCheck(env, { pg: async () => fakePg() });
  assert.ok(!/result views/.test(r.text), 'no row, no line');
});
