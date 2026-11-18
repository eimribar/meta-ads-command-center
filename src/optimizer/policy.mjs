// The numbers every decision is judged by. One target cost per result; every guardrail is a
// multiple of it, so the same defaults fit a cheap signup and an expensive booked visit.
// Defaults are tuned for an expensive result on a small budget and are listed in docs/SETTINGS.md.
// The team can change them from Slack:
//   brain set policy/target 180
//   brain set policy/thresholds {"pause":{"zeroResultSpend":4}}
//   threshold pause.zeroResultSpend 4
import { getConfig } from '../config.mjs';
import { getBrain } from '../brain.mjs';
import { parseTarget, parseThresholds } from '../brain-rules.mjs';

export { DEFAULTS } from './defaults.mjs';
import { DEFAULTS } from './defaults.mjs';

function merge(base, over) {
  const out = structuredClone(base);
  for (const [group, vals] of Object.entries(over || {})) for (const [k, v] of Object.entries(vals)) out[group][k] = v;
  return out;
}

let current = null;

// Re-read the brain overrides. Call before any judgment. A brain row that cannot be read as a
// number (written before rows were checked, or straight into the database) is ignored and named
// in `ignored`, so `status` can say so.
export async function refreshPolicy() {
  const cfg = getConfig();
  const fromSettings = cfg.TARGET_COST_PER_RESULT ?? null;
  let target = fromSettings;
  let source = target ? 'TARGET_COST_PER_RESULT' : null;
  let overrides = {};
  const ignored = [];
  try {
    const rawTarget = await getBrain('policy', 'target');
    if (rawTarget != null) {
      const t = parseTarget(rawTarget);
      if (t) { target = t; source = 'brain policy/target'; } else ignored.push('policy/target is not a number');
    }
    const rawTh = await getBrain('policy', 'thresholds');
    if (rawTh != null) {
      const { value, problems } = parseThresholds(rawTh);
      overrides = value || {};
      if (problems.length) ignored.push(`policy/thresholds: ${problems.join('; ')}`);
    }
  } catch { /* brain unavailable: settings only */ }
  current = { target, targetSource: source, settingsTarget: fromSettings, maxDailyBudget: cfg.MAX_DAILY_BUDGET ?? null, t: merge(DEFAULTS, overrides), overrides, ignored };
  return current;
}

export function policy() {
  if (current) return current;
  const cfg = getConfig();
  return { target: cfg.TARGET_COST_PER_RESULT ?? null, targetSource: 'TARGET_COST_PER_RESULT', settingsTarget: cfg.TARGET_COST_PER_RESULT ?? null, maxDailyBudget: cfg.MAX_DAILY_BUDGET ?? null, t: DEFAULTS, overrides: {}, ignored: [] };
}
export function setPolicy(p) { current = p ? { t: DEFAULTS, overrides: {}, ignored: [], ...p } : null; }

// Action types the optimizer can propose.
export const ACTION_TYPES = ['pause_ad', 'unpause_ad', 'scale_budget', 'descale_budget'];
// These can never be switched to auto: budget moves, and turning spend back on.
export const NEVER_AUTO = new Set(['scale_budget', 'descale_budget', 'unpause_ad']);

// The words people use for each kind of move. `ladder set` takes any of them.
export const ACTION_WORDS = Object.freeze({ pause_ad: 'pause', unpause_ad: 'turn back on', scale_budget: 'raise', descale_budget: 'trim' });
export const ACTION_PHRASES = Object.freeze({ pause_ad: 'pause an ad', unpause_ad: 'turn an ad back on', scale_budget: 'raise a budget', descale_budget: 'trim a budget' });
const ALIASES = {
  pause_ad: ['pause', 'pauses', 'pause ad', 'pause ads', 'pause an ad', 'pause_ad'],
  unpause_ad: ['turn back on', 'turn on', 'turn an ad back on', 'turn ads back on', 'unpause', 'unpause_ad', 'reactivate', 're-activate', 'activate'],
  scale_budget: ['raise', 'raises', 'raise budget', 'raise a budget', 'raise budgets', 'raise_budget', 'scale', 'scale up', 'scale_budget'],
  descale_budget: ['trim', 'trims', 'trim budget', 'trim a budget', 'trim budgets', 'trim_budget', 'descale', 'scale down', 'descale_budget'],
};
// The action type for words like "raise" or "turn back on"; null when they name none.
export function actionTypeFrom(words) {
  const w = String(words || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return Object.keys(ALIASES).find((t) => ALIASES[t].includes(w)) || null;
}
// auto: happens on its own. propose: waits for a person.
export function ladderModeFrom(words) {
  const w = String(words || '').trim().toLowerCase();
  if (['auto', 'automatic', 'on its own'].includes(w)) return 'auto';
  if (['propose', 'ask', 'wait', 'manual'].includes(w)) return 'propose';
  return null;
}
export const MODE_WORDS = Object.freeze({ auto: 'happens on its own', propose: 'waits for a person' });
export const BUDGET_TYPES = new Set(['scale_budget', 'descale_budget']);
