// Files people read side by side agree: one app name, the lockfile, every setting in .env.example.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const read = (p) => readFileSync(join(root, p), 'utf8');

test('the app has one name in the manifest, the docs and the Home tab', () => {
  const manifest = read('slack-app-manifest.yaml');
  const name = manifest.match(/^\s+name: (.+)$/m)[1].trim();
  assert.equal(name, 'Ads Command Center');
  assert.equal(manifest.match(/display_name: (.+)$/m)[1].trim(), name);
  for (const doc of ['README.md', 'docs/USING.md', 'docs/PLAYBOOK.md', 'docs/INSTALL.md']) {
    const t = read(doc);
    assert.match(t, new RegExp(`@${name}`), `${doc} says @${name}`);
  }
  assert.equal(JSON.parse(read('package.json')).name, 'meta-ads-command-center');
  const repo = JSON.parse(read('package.json')).repository.url.replace(/^git\+/, '');
  assert.equal(repo, 'https://github.com/eimribar/meta-ads-command-center.git');
  for (const doc of ['README.md', 'docs/INSTALL.md']) assert.ok(read(doc).includes(`git clone ${repo}`), `${doc} clones the repository`);
  assert.match(read('README.md'), /^# Meta Ads Command Center/);
});

test('the lockfile asks for the same Node as package.json', () => {
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.packages[''].engines.node, JSON.parse(read('package.json')).engines.node);
});

test('the docs use the one made up example company', () => {
  for (const doc of ['docs/PLAYBOOK.md', 'docs/USING.md', 'docs/INSTALL.md']) assert.match(read(doc), /Northfield Bikes|test rides?/i, doc);
});

test('.env.example lists every setting the agent reads', async () => {
  const { KEYS } = await import('../src/config.mjs');
  const example = read('.env.example');
  for (const k of KEYS) assert.match(example, new RegExp(`^(# )?${k}=`, 'm'), k);
});

test('one copy of the Slack Web API, under Bolt 5', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.dependencies['@slack/bolt'], /^\^5\./);
  const lock = JSON.parse(read('package-lock.json'));
  const copies = Object.keys(lock.packages).filter((p) => p.endsWith('node_modules/@slack/web-api'));
  assert.deepEqual(copies, ['node_modules/@slack/web-api']);
});

test('the docs name the Graph API version the code uses, and the compose file keeps ports local', async () => {
  const { DEFAULT_META_API_VERSION } = await import('../src/config.mjs');
  assert.ok(read('docs/SETTINGS.md').includes(`| \`${DEFAULT_META_API_VERSION}\` |`));
  assert.ok(read('.env.example').includes(`# META_API_VERSION=${DEFAULT_META_API_VERSION}`));
  const compose = read('docker-compose.yml');
  for (const m of compose.matchAll(/^\s+- "([^"]+:[^"]+)"$/gm)) assert.match(m[1], /^127\.0\.0\.1:/, m[1]);
  assert.match(read('Dockerfile'), /^HEALTHCHECK /m);
});

test('no em or en dashes in the docs', () => {
  for (const doc of ['README.md', 'SECURITY.md', 'docs/INSTALL.md', 'docs/SETTINGS.md', 'docs/USING.md', 'docs/PLAYBOOK.md', '.env.example']) {
    assert.ok(!/[\u2013\u2014]/.test(read(doc)), doc);
  }
});
