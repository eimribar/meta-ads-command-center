import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCommand } from '../src/slack/commands.mjs';
import { registerApprovals, postCards } from '../src/slack/approvals.mjs';
import { setRuntime } from '../src/runtime.mjs';
import { getBrain } from '../src/brain.mjs';
import { setup, fakeSlack, fakeApp } from './helpers.mjs';
import { fakeAccount } from './account-fake.mjs';

const say = () => { const out = []; return { out, reply: async (p) => { out.push(typeof p === 'string' ? p : p.text); return { ts: '1', channel: 'C' }; } }; };
const noJobs = { report: async () => {}, optimize: async () => {}, moderation: async () => {} };

test('commands: help for anyone, changes for operators only', async () => {
  setup();
  let s = say();
  assert.equal(await handleCommand({ text: 'help', user: 'USOMEONE', reply: s.reply, jobs: noJobs }), true);
  assert.match(s.out[0], /Commands/);
  s = say();
  await handleCommand({ text: 'freeze testing', user: 'USOMEONE', reply: s.reply, jobs: noJobs });
  assert.match(s.out[0], /needs an operator/);
  s = say();
  await handleCommand({ text: 'ladder set scale_budget auto', user: 'UOPERATOR', reply: s.reply, jobs: noJobs });
  assert.match(s.out[0], /always waits for a person/);
  s = say();
  await handleCommand({ text: 'brain set business/company Northfield Bikes sells city e-bikes online and from two showrooms.', user: 'UOPERATOR', reply: s.reply, jobs: noJobs });
  assert.match(s.out[0], /Saved/);
  assert.equal(await getBrain('business', 'company'), 'Northfield Bikes sells city e-bikes online and from two showrooms.');
  s = say();
  await handleCommand({ text: 'brain set policy/target 180', user: 'UOPERATOR', reply: s.reply, jobs: noJobs });
  assert.equal(await getBrain('policy', 'target'), 180);
  assert.equal(await handleCommand({ text: 'how did we do yesterday?', user: 'UOPERATOR', reply: s.reply, jobs: noJobs }), false);
});

test('a card goes from posted to approved and applied, with the modal in between', async () => {
  const { db } = setup({}, { seed: { actions_log: [{ run_date: new Date().toISOString().slice(0, 10), action_type: 'pause_ad', target_level: 'ad', target_id: '30', target_name: 'Loser', decision_key: 'pause:30', disposition: 'proposed', applied: false, before: { status: 'ACTIVE' }, after: { status: 'PAUSED' }, explain: '$480 spent with no test rides.' }] } });
  const acct = fakeAccount();
  const slack = fakeSlack();
  setRuntime({ slack });
  await postCards(db.tables.actions_log, null, { header: '1 decision for you' });
  const card = slack.calls.find((c) => c.name === 'chat.postMessage' && c.args.blocks?.some((b) => b.type === 'actions'));
  assert.ok(card, 'the card was posted');
  assert.ok(db.tables.actions_log[0].card_ts, 'the card position is stored');
  assert.equal(db.tables.actions_log[0].card_channel, 'CTEST');

  const app = fakeApp();
  registerApprovals(app);
  const button = card.args.blocks.find((b) => b.type === 'actions').elements.find((e) => e.action_id === 'opt_approve');
  await app.actions.opt_approve({ ack: async () => {}, body: { user: { id: 'UOPERATOR' }, channel: { id: 'CTEST' }, message: { ts: '1002' }, trigger_id: 't' }, action: button, client: slack });
  const modal = slack.calls.find((c) => c.name === 'views.open').args.view;
  assert.equal(modal.callback_id, 'opt_decision');

  await app.views.opt_decision({ ack: async () => {}, body: { user: { id: 'UOPERATOR' } }, view: { private_metadata: modal.private_metadata, state: { values: { why: { note: { value: 'agreed' } } } } }, client: slack });
  assert.deepEqual(acct.writes().map((w) => [w.path, w.params.status]), [['30', 'PAUSED']]);
  assert.equal(db.tables.actions_log[0].disposition, 'applied_by_human');
  assert.equal(db.tables.actions_log[0].decision_note, 'agreed');
  const done = slack.calls.filter((c) => c.name === 'chat.update').map((c) => JSON.stringify(c.args.blocks || '')).join(' ');
  assert.match(done, /Approved/);
});

test('a card that changed after the modal opened is not applied', async () => {
  const { db } = setup({}, { seed: { actions_log: [{ run_date: '2026-11-18', action_type: 'scale_budget', target_level: 'adset', target_id: '20', decision_key: 'budget:20|up', disposition: 'escalated', applied: false, before: { dailyBudget: 100 }, after: { dailyBudget: 120 } }] } });
  const acct = fakeAccount();
  const slack = fakeSlack();
  setRuntime({ slack });
  const app = fakeApp();
  registerApprovals(app);
  const meta = JSON.stringify({ decision: 'approve', id: 1, channel: 'CTEST', messageTs: '1', check: ['scale_budget', '20', { dailyBudget: 140 }] });
  await app.views.opt_decision({ ack: async () => {}, body: { user: { id: 'UOPERATOR' } }, view: { private_metadata: meta, state: { values: {} } }, client: slack });
  assert.equal(acct.writes().length, 0);
  assert.equal(db.tables.actions_log[0].disposition, 'escalated');
  assert.match(slack.calls.at(-1).args.text, /changed after it was opened/);
});

test('JSON typed in Slack parses even with curly quotes', async () => {
  const { parseContent } = await import('../src/brain.mjs');
  assert.deepEqual(parseContent('{“pause”:{“zeroResultSpend”:4}}'), { pause: { zeroResultSpend: 4 } });
  assert.equal(parseContent('180'), 180);
  assert.equal(parseContent('We sell &amp; ship'), 'We sell & ship');
});

test('a card approved from the Home tab updates the channel card and the Home tab', async () => {
  const { db } = setup({}, { seed: { actions_log: [{ run_date: '2026-11-18', action_type: 'pause_ad', target_level: 'ad', target_id: '30', target_name: 'Loser', decision_key: 'pause:30', disposition: 'proposed', applied: false, before: { status: 'ACTIVE' }, after: { status: 'PAUSED' }, card_ts: '555', card_channel: 'CTEST' }] } });
  const acct = fakeAccount();
  const slack = fakeSlack();
  setRuntime({ slack });
  const { buildHome } = await import('../src/slack/home.mjs');
  const home = await buildHome('UOPERATOR');
  const button = home.blocks.find((b) => b.type === 'actions').elements.find((e) => e.action_id === 'opt_approve');
  const guest = await buildHome('USOMEONE');
  assert.ok(!guest.blocks.some((b) => b.type === 'actions'), 'no buttons for non-operators');
  const app = fakeApp();
  registerApprovals(app);
  await app.actions.opt_approve({ ack: async () => {}, body: { type: 'block_actions', user: { id: 'UOPERATOR' }, view: { type: 'home' }, trigger_id: 't' }, action: button, client: slack });
  const modal = slack.calls.find((c) => c.name === 'views.open').args.view;
  assert.equal(JSON.parse(modal.private_metadata).messageTs, '555');
  await app.views.opt_decision({ ack: async () => {}, body: { user: { id: 'UOPERATOR' } }, view: { private_metadata: modal.private_metadata, state: { values: {} } }, client: slack });
  assert.equal(acct.writes().length, 1);
  assert.equal(db.tables.actions_log[0].disposition, 'applied_by_human');
  assert.ok(slack.calls.some((c) => c.name === 'chat.update' && c.args.ts === '555'));
  assert.ok(slack.calls.some((c) => c.name === 'views.publish' && c.args.user_id === 'UOPERATOR'));
});

test('a question for the team is asked once', async () => {
  setup();
  const slack = fakeSlack();
  setRuntime({ slack });
  const { askTeam } = await import('../src/agentic.mjs');
  assert.equal((await askTeam({ question: 'Is the spring offer still on?', key: 'spring_offer', options: ['Yes', 'No'] })).posted, true);
  assert.equal((await askTeam({ question: 'Is the spring offer still on?', key: 'spring_offer', options: ['Yes', 'No'] })).posted, false);
  const { setBrain } = await import('../src/brain.mjs');
  await setBrain('answers', 'spring_offer', 'No', 'UOPERATOR');
  const r = await askTeam({ question: 'again?', key: 'spring_offer' });
  assert.equal(r.answer, 'No');
  assert.equal(slack.calls.filter((c) => c.name === 'chat.postMessage').length, 1);
});
