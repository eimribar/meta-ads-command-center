// The command line: Slack commands from the terminal, usage, and terminal output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { toTerminal } from '../src/cli.mjs';
import { handleCommand } from '../src/slack/commands.mjs';
import { LOCAL_OPERATOR, isOperator } from '../src/auth.mjs';
import { rt } from '../src/runtime.mjs';
import { setup } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const cli = (...argv) => spawnSync(process.execPath, [join(root, 'src', 'cli.mjs'), ...argv], { env: { PATH: process.env.PATH, SKIP_DOTENV: '1' }, encoding: 'utf8', timeout: 20_000 });

test('ask with no question prints how to use it and exits with an error', () => {
  const r = cli('ask');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Ask a question, for example/);
});

test('a brain command from the terminal needs only the database settings', () => {
  const r = cli('cmd', 'brain', 'set', 'business/company', 'x');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /DATABASE_URL is not set/);
  assert.ok(!/META_|SLACK_|RESULT_EVENT|ANTHROPIC/.test(r.stderr), r.stderr);
});

test('an unknown terminal command lists the commands without asking for settings', () => {
  const r = cli('cmd', 'pause', 'everything');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not a command/);
  assert.ok(!/is not set/.test(r.stderr));
});

test('the terminal is an operator only inside its own command', async () => {
  setup();
  assert.equal(isOperator(LOCAL_OPERATOR), false);
  const out = [];
  const reply = async (p) => { out.push(toTerminal(p)); };
  await handleCommand({ text: 'brain set business/company A shop for trail shoes', user: LOCAL_OPERATOR, reply, jobs: {} });
  assert.match(out[0], /needs an operator/);
  rt.localOperator = true;
  try {
    await handleCommand({ text: 'brain set business/company A shop for trail shoes', user: LOCAL_OPERATOR, reply, jobs: {} });
    assert.match(out[1], /Saved `business\/company`/);
    assert.ok(!out[1].includes(':brain:'));
  } finally { rt.localOperator = false; }
});

test('Slack text reads cleanly in a terminal', () => {
  assert.equal(toTerminal(':white_check_mark: Done by <@U123>.'), 'Done by @U123.');
  assert.equal(toTerminal({ text: 'x', blocks: [{ type: 'section', text: { text: '*Pause ad*' } }, { type: 'context', elements: [{ text: '#14' }] }] }), '*Pause ad*\n#14');
});

test('typed or piped lines run one command each, with no quoting, and skip blanks and comments', async () => {
  const { db } = setup();
  const { Readable } = await import('node:stream');
  const { runCommandLines } = await import('../src/cli.mjs');
  const lines = [
    '# the voice and the moderation scope',
    "brain set moderation/scope Remove comments that share someone's personal details.",
    '',
    'brain set business/voice Plain and practical. We say "e-bike", never {electric bicycle}.',
    'brain set company We sell bikes',
    'exit',
    'brain set business/after the exit line',
  ];
  const out = [], err = [];
  const log = console.log, error = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try {
    const code = await runCommandLines(Readable.from(lines.map((l) => `${l}\n`)));
    assert.equal(code, 0, 'a refused line is answered, not a crash');
  } finally { console.log = log; console.error = error; rt.localOperator = false; }
  const rows = Object.fromEntries(db.tables.brain.map((r) => [`${r.scope}/${r.key}`, r.content]));
  assert.equal(rows['moderation/scope'], "Remove comments that share someone's personal details.");
  assert.equal(rows['business/voice'], 'Plain and practical. We say "e-bike", never {electric bicycle}.');
  assert.ok(!('business/after' in rows), 'nothing after exit runs');
  assert.match(out.join('\n'), /Write it as `brain set <section>\/<name> <text>`/);
});

test('npm run cmd with nothing typed or piped prints how to use it', () => {
  const r = spawnSync(process.execPath, [join(root, 'src', 'cli.mjs'), 'cmd'], { env: { PATH: process.env.PATH, SKIP_DOTENV: '1' }, input: '', encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /npm run cmd {2,}the same commands, one per line/);
  const piped = spawnSync(process.execPath, [join(root, 'src', 'cli.mjs'), 'cmd'], { env: { PATH: process.env.PATH, SKIP_DOTENV: '1' }, input: 'brain\n', encoding: 'utf8', timeout: 20_000 });
  assert.equal(piped.status, 1);
  assert.match(piped.stderr, /DATABASE_URL is not set/);
});
