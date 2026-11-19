// What counts as a result. RESULT_EVENT (and the optional SECONDARY_EVENT) name a pixel event the
// way Events Manager shows it; events.mjs turns each into the one Meta action type it is counted
// as. This file counts that type in Insights rows.
import { getConfig } from './config.mjs';
import { actionTypeFor } from './events.mjs';

export { actionTypeFor };

const listOf = (row) => [...(row?.actions || []), ...(row?.conversions || [])];

// Count one action type in one Insights row.
export function countEvent(row, type) {
  if (!type) return 0;
  const hit = listOf(row).find((a) => a.action_type === type);
  return hit ? Number(hit.value) || 0 : 0;
}

export function metricSpec(cfg = getConfig()) {
  const result = {
    event: cfg.RESULT_EVENT,
    label: cfg.RESULT_LABEL || cfg.RESULT_EVENT,
    type: actionTypeFor(cfg.RESULT_EVENT, cfg.RESULT_ACTION_TYPE),
  };
  const secondary = cfg.SECONDARY_EVENT ? {
    event: cfg.SECONDARY_EVENT,
    label: cfg.SECONDARY_LABEL || cfg.SECONDARY_EVENT,
    type: actionTypeFor(cfg.SECONDARY_EVENT, cfg.SECONDARY_ACTION_TYPE),
  } : null;
  return { result, secondary };
}

export const resultsOf = (row, spec = metricSpec()) => countEvent(row, spec.result.type);
export const secondaryOf = (row, spec = metricSpec()) => (spec.secondary ? countEvent(row, spec.secondary.type) : 0);

// Insights fields every pull asks for, so both counters always have what they need.
export const INSIGHT_FIELDS = 'spend,impressions,clicks,actions,conversions';

// Every action type a set of rows reported, with totals. The first-run check prints this so the
// installer can confirm which name their result event arrives under.
export function actionTypesSeen(rows) {
  const totals = {};
  for (const r of rows || []) for (const a of listOf(r)) totals[a.action_type] = (totals[a.action_type] || 0) + (Number(a.value) || 0);
  return Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([type, total]) => ({ type, total }));
}

export const round2 = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);
export const costPer = (spend, n) => (n > 0 ? round2(spend / n) : null);
