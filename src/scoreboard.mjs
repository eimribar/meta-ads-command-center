// The creative scoreboard: every ad that spent in the window, ranked, with a plain verdict.
import { adPerformance } from './meta-read.mjs';
import { probBeatsBar } from './optimizer/stats.mjs';
import { policy, refreshPolicy } from './optimizer/policy.mjs';
import { metricSpec } from './metrics.mjs';
import { money } from './money.mjs';

export function verdict(ad, target, priorResults = 3) {
  if (!target) return { prob: null, word: 'no target set', icon: '' };
  const prob = probBeatsBar({ spend: ad.spend, results: ad.results, priorCost: target, priorResults }, target);
  if (ad.results === 0 && ad.spend >= 3 * target) return { prob, word: 'losing', icon: ':red_circle:' };
  if (ad.spend < target) return { prob, word: 'too early', icon: ':white_circle:' };
  if (prob >= 0.9) return { prob, word: 'winning', icon: ':large_green_circle:' };
  if (prob >= 0.5) return { prob, word: 'on track', icon: ':large_yellow_circle:' };
  return { prob, word: 'behind', icon: ':large_orange_circle:' };
}

export async function buildScoreboard({ days = 7, limit = 15 } = {}) {
  await refreshPolicy().catch(() => {});
  const { target, t } = policy();
  const { ads } = await adPerformance(null, days);
  const spec = metricSpec();
  const spent = ads.filter((a) => a.spend > 0).map((a) => ({ ...a, v: verdict(a, target, t.winner.priorResults) }));
  spent.sort((a, b) => (b.v.prob ?? 0) - (a.v.prob ?? 0) || b.results - a.results);
  return { days, target, label: spec.result.label, ads: spent.slice(0, limit), total: spent.length };
}

export function scoreboardText(sb) {
  if (!sb.ads.length) return `No ad spent in the last ${sb.days} days.`;
  const lines = sb.ads.map((a) => `${a.v.icon || ''} *${a.name}*: ${money(a.spend)}, ${a.results} ${sb.label}${a.cost_per_result ? ` at ${money(a.cost_per_result)}` : ''}${a.status !== 'ACTIVE' ? ` _(${String(a.status).toLowerCase()})_` : ''} · ${a.v.word}`);
  return `*Creative scoreboard, last ${sb.days} days* (target ${sb.target ? money(sb.target) : 'not set'} per ${sb.label})\n${lines.join('\n')}${sb.total > sb.ads.length ? `\n_${sb.total - sb.ads.length} more not shown_` : ''}`;
}
