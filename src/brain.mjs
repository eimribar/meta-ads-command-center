// The brain: what the agent knows about the business, written by the team from Slack.
// Rows are section/name -> content (stored as scope and key). Every prompt reads its business facts from here, and every
// change is kept in brain_history. See docs/PLAYBOOK.md for what to write on day one.
import { rt, db } from './runtime.mjs';
import { checkBrainRow, thresholdName, parseThresholds, BrainRowError } from './brain-rules.mjs';
import { DEFAULTS } from './optimizer/defaults.mjs';

export { BrainRowError };

const TTL_MS = 60_000;
let cache = null;

export async function brainRows({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.rows;
  const rows = await db().select('brain', { order: ['scope', 'key'] });
  cache = { rows, at: Date.now() };
  return rows;
}
export function clearBrainCache() { cache = null; }

// Section and name are matched in any case; new rows are stored in lower case.
const norm = (x) => String(x ?? '').trim().toLowerCase();
const same = (r, scope, key) => norm(r.scope) === norm(scope) && norm(r.key) === norm(key);

export async function getBrain(scope, key) {
  if (!rt.db) return null;
  const rows = await brainRows();
  return rows.find((r) => same(r, scope, key))?.content ?? null;
}

export async function listBrain() { return brainRows({ force: true }); }

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
export function checkName(scope, key) {
  if (!NAME.test(scope || '') || !NAME.test(key || '')) throw new BrainRowError('A brain row is named section/name, like business/company: letters, numbers, dots, dashes or underscores. Nothing was saved.');
}

// Text that looks like JSON is stored as JSON; anything else as text.
// Slack turns typed quotes into curly ones and escapes &, < and >; undo that before parsing.
export function parseContent(text) {
  const s = String(text ?? '').trim().replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  if (/^[[{]/.test(s) || /^-?\d+(\.\d+)?$/.test(s)) {
    const plain = s.replace(/[\u201C\u201D\u201E\u201F]/g, '"').replace(/[\u2018\u2019]/g, "'");
    try { return JSON.parse(plain); } catch { /* text */ }
  }
  return s;
}

// Rows the code reads as data are checked first (see brain-rules.mjs): a row that would be
// ignored throws a BrainRowError and nothing is written.
export async function setBrain(scope, key, content, by) {
  checkName(scope, key);
  scope = norm(scope); key = norm(key);
  content = checkBrainRow(scope, key, content);
  const at = rt.now().toISOString();
  // A row written with capitals before names were stored in lower case is replaced, not doubled.
  for (const r of (await brainRows({ force: true })).filter((r) => same(r, scope, key) && (r.scope !== scope || r.key !== key))) {
    await db().remove('brain', { scope: r.scope, key: r.key });
  }
  await db().upsert('brain', [{ scope, key, content, updated_by: by || null, updated_at: at }], ['scope', 'key']);
  await db().insert('brain_history', [{ scope, key, content, action: 'set', changed_by: by || null, changed_at: at }]);
  clearBrainCache();
  return { ok: true, scope, key, content };
}

export async function rmBrain(scope, key, by) {
  checkName(scope, key);
  const rows = (await brainRows({ force: true })).filter((r) => same(r, scope, key));
  if (!rows.length) return { ok: false, error: `There is no brain row ${norm(scope)}/${norm(key)}. Send \`brain\` to see every row.` };
  for (const r of rows) {
    await db().remove('brain', { scope: r.scope, key: r.key });
    await db().insert('brain_history', [{ scope: norm(scope), key: norm(key), content: r.content, action: 'rm', changed_by: by || null, changed_at: rt.now().toISOString() }]);
  }
  clearBrainCache();
  return { ok: true, scope: norm(scope), key: norm(key) };
}

const show = (c) => (typeof c === 'string' ? c : JSON.stringify(c));

// One threshold, by its dotted name: `threshold pause.zeroResultSpend 4`, or `default` to go back
// to the default. Kept in the policy/thresholds row with the others.
export async function setThreshold(name, value, by) {
  const { group, key } = thresholdName(name);
  const current = parseThresholds((await brainRows({ force: true })).find((r) => same(r, 'policy', 'thresholds'))?.content ?? {}).value || {};
  const next = structuredClone(current);
  if (/^default$/i.test(String(value).trim())) {
    if (next[group]) delete next[group][key];
    if (next[group] && !Object.keys(next[group]).length) delete next[group];
  } else {
    (next[group] ||= {})[key] = String(value).trim();
  }
  if (!Object.keys(next).length) {
    const r = await rmBrain('policy', 'thresholds', by);
    return { ok: true, group, key, value: DEFAULTS[group][key], isDefault: true, removed: r.ok };
  }
  await setBrain('policy', 'thresholds', next, by);
  const stored = parseThresholds((await brainRows({ force: true })).find((r) => same(r, 'policy', 'thresholds'))?.content).value || {};
  const v = stored[group]?.[key];
  return { ok: true, group, key, value: v ?? DEFAULTS[group][key], isDefault: v === undefined };
}

// The brain as prompt text. Scopes listed first come first; the rest follow.
export async function brainBlock({ scopes = null, maxChars = 12_000 } = {}) {
  let rows = [];
  try { rows = await brainRows(); } catch { return '# BUSINESS CONTEXT\n(The brain could not be read this turn.)'; }
  if (scopes) rows = rows.filter((r) => scopes.includes(r.scope));
  if (!rows.length) {
    return '# BUSINESS CONTEXT\nThe brain is empty. You know nothing about this business beyond the ad account itself. '
      + 'Do not guess the product, the buyer or the offer; ask the team to fill the brain (see the playbook: `brain set business/company ...`).';
  }
  const lines = rows.map((r) => `- ${r.scope}/${r.key}: ${show(r.content)}`);
  let text = lines.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n(more rows not shown)`;
  return `# BUSINESS CONTEXT (the brain: written by the team, the only source of business facts)\n${text}`;
}
