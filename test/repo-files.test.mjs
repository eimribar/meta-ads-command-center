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
  assert.match(read('docs/INSTALL.md'), /git clone <this repository> meta-ads-command-center/);
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
