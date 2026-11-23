// The brain rows the code reads as data, not as text: policy/target, policy/thresholds,
// moderation/extra_posts and context/result_views. Every write of one of them is checked here first (from Slack, the
// terminal, a brain card or an answer button), so a row that would be ignored is refused with
// what was wrong, never saved. Every other row is free text the prompts read as it is.
import { DEFAULTS, RANGES } from './optimizer/defaults.mjs';
import { parseAmountText, ambiguousAmount } from './money.mjs';

export class BrainRowError extends Error {}

const TERMINAL = 'From a terminal, wrap the text in single quotes: npm run cmd -- brain set policy/thresholds \'{"pause":{"zeroResultSpend":4}}\'.';
const ONE_AT_A_TIME = 'Or change one number at a time: threshold pause.zeroResultSpend 4 (send `thresholds` to see them all).';

// A target cost per result: a positive number. `1,250` and a currency symbol are accepted; a
// comma is only a thousands separator, so `12,5` is refused instead of read as 125.
export function parseTarget(v) {
  if (v == null) return null;
  if (typeof v === 'object' && !Array.isArray(v)) return parseTarget(v.value ?? v.target ?? v.amount);
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  return parseAmountText(v);
}

// Straight quotes for JSON typed on a phone or pasted from a document.
const straight = (s) => String(s).replace(/[“”„‟]/g, '"').replace(/[‘’]/g, "'");

// Threshold overrides: { group: { key: number } }, every group and key known, every number in
// range. Returns { value, problems }: value keeps only the valid numbers.
export function parseThresholds(raw) {
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(straight(v)); } catch { return { value: null, problems: ['it is not JSON'] }; }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { value: null, problems: ['it must be an object of groups, like {"pause":{"zeroResultSpend":4}}'] };
  const value = {};
  const problems = [];
  for (const [group, vals] of Object.entries(v)) {
    if (!DEFAULTS[group]) { problems.push(`there is no group "${group}" (groups: ${Object.keys(DEFAULTS).join(', ')})`); continue; }
    if (!vals || typeof vals !== 'object' || Array.isArray(vals)) { problems.push(`"${group}" must hold names and numbers, like {"${Object.keys(DEFAULTS[group])[0]}":${Object.values(DEFAULTS[group])[0]}}`); continue; }
    for (const [key, raw2] of Object.entries(vals)) {
      if (!(key in DEFAULTS[group])) { problems.push(`"${group}" has no "${key}" (it has ${Object.keys(DEFAULTS[group]).join(', ')})`); continue; }
      const n = typeof raw2 === 'number' ? raw2 : Number(String(raw2).trim());
      const [min, max] = RANGES[group][key];
      if (!Number.isFinite(n) || String(raw2).trim() === '') { problems.push(`${group}.${key} must be a number`); continue; }
      if (n < min || n > max) { problems.push(`${group}.${key} must be from ${min} to ${max}`); continue; }
      (value[group] ||= {})[key] = n;
    }
  }
  return { value, problems };
}

// Post ids for the comment sweep: Facebook post ids (digits_digits) or Instagram media ids.
export function parsePostIds(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,]+/);
  const ids = list.map((x) => String(x).trim()).filter(Boolean);
  const bad = ids.filter((x) => !/^\d+(_\d+)?$/.test(x));
  return { ids, bad };
}

// The team's own tables or views the agent reads every turn (context/result_views): a list of
// { name, date_column, days, rows, chars, order }. Only name is required; a plain name is enough.
export const RESULT_VIEW_LIMITS = { views: 6, days: [1, 90, 14], rows: [1, 200, 50], chars: [500, 20000, 6000] };
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const VIEW_KEYS = new Set(['name', 'date_column', 'days', 'rows', 'chars', 'order']);
export function parseResultViews(raw) {
  let v = raw;
  if (typeof v === 'string') {
    const t = straight(v).trim();
    if (/^[[{]/.test(t)) {
      try { v = JSON.parse(t); } catch { return { value: null, problems: ['it is not JSON'] }; }
    } else v = t.split(/[\s,]+/).filter(Boolean);
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) v = [v];
  if (!Array.isArray(v) || !v.length) return { value: null, problems: ['it must name at least one table or view'] };
  const problems = [];
  const value = [];
  if (v.length > RESULT_VIEW_LIMITS.views) problems.push(`at most ${RESULT_VIEW_LIMITS.views} views`);
  for (const item of v.slice(0, RESULT_VIEW_LIMITS.views)) {
    const e = typeof item === 'string' ? { name: item } : item;
    if (!e || typeof e !== 'object' || Array.isArray(e)) { problems.push('each entry is a name or an object like {"name":"daily_results","date_column":"day"}'); continue; }
    const name = String(e.name ?? '').trim();
    if (!IDENT.test(name)) { problems.push(`"${name}" is not a table or view name (lower case letters, digits and underscores)`); continue; }
    const out = { name };
    for (const k of Object.keys(e)) if (!VIEW_KEYS.has(k)) problems.push(`${name}: there is no "${k}" (use ${[...VIEW_KEYS].join(', ')})`);
    if (e.date_column != null && e.date_column !== '') {
      if (!IDENT.test(String(e.date_column))) problems.push(`${name}: date_column "${e.date_column}" is not a column name`);
      else out.date_column = String(e.date_column);
    }
    for (const k of ['days', 'rows', 'chars']) {
      const [min, max, def] = RESULT_VIEW_LIMITS[k];
      if (e[k] == null || e[k] === '') { out[k] = def; continue; }
      const n = Number(e[k]);
      if (!Number.isInteger(n) || n < min || n > max) { problems.push(`${name}: ${k} must be a whole number from ${min} to ${max}`); continue; }
      out[k] = n;
    }
    if (e.order != null && e.order !== '') {
      const [col, dir, extra] = String(e.order).trim().split(/\s+/);
      if (!IDENT.test(col || '') || extra !== undefined || (dir && !/^(asc|desc)$/i.test(dir))) problems.push(`${name}: order is a column name, optionally followed by asc or desc`);
      else out.order = dir ? `${col} ${dir.toLowerCase()}` : col;
    }
    if (value.some((x) => x.name === name)) { problems.push(`${name} is listed twice`); continue; }
    value.push(out);
  }
  return { value, problems };
}

// Check one row before it is written. Returns the content to store (normalized), or throws a
// BrainRowError with what was wrong and an example.
export function checkBrainRow(scope, key, content) {
  if (scope === 'policy') {
    if (key === 'target') {
      const twoWays = ambiguousAmount(typeof content === 'object' && content ? (content.value ?? content.target ?? content.amount) : content);
      if (twoWays) throw new BrainRowError(`policy/target was not saved: ${twoWays}. Nothing was saved.`);
      const n = parseTarget(content);
      if (!n) throw new BrainRowError('policy/target must be a plain number in the ad account\'s currency, for example `brain set policy/target 150` (a decimal point, not a comma: 12.50). Nothing was saved.');
      return n;
    }
    if (key === 'thresholds') {
      const { value, problems } = parseThresholds(content);
      if (problems.length) throw new BrainRowError(`policy/thresholds was not saved: ${problems.join('; ')}. Example: {"pause":{"zeroResultSpend":4},"scale":{"stepPct":15}}. ${ONE_AT_A_TIME} ${TERMINAL}`);
      return value;
    }
    throw new BrainRowError('The agent reads only two policy rows, policy/target and policy/thresholds, so this one would be ignored. Nothing was saved. Business facts go under business/, for example business/campaigns.');
  }
  if (scope === 'context' && key === 'result_views') {
    const { value, problems } = parseResultViews(content);
    if (problems.length) throw new BrainRowError(`context/result_views was not saved: ${problems.join('; ')}. Example: [{"name":"daily_results","date_column":"day","days":14}], or just the names: daily_results, weekly_funnel. ${TERMINAL.replace('policy/thresholds \'{"pause":{"zeroResultSpend":4}}\'', 'context/result_views \'[{"name":"daily_results","date_column":"day"}]\'')}`);
    return value;
  }
  if (scope === 'moderation' && key === 'extra_posts') {
    const { ids, bad } = parsePostIds(content);
    if (!ids.length || bad.length) throw new BrainRowError('moderation/extra_posts must be post ids separated by commas, like 123456789_987654321. To find them, ask me "list our recent Page posts with their ids". Nothing was saved.');
    return ids;
  }
  return content;
}

// One threshold by its dotted name (pause.zeroResultSpend). Returns { group, key } or throws.
export function thresholdName(name) {
  const [group, key, extra] = String(name || '').split('.');
  if (extra !== undefined || !DEFAULTS[group] || !(key in DEFAULTS[group])) {
    throw new BrainRowError(`There is no threshold "${name}". Send \`thresholds\` to see every name, like pause.zeroResultSpend.`);
  }
  return { group, key };
}
