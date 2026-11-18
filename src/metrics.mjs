// What counts as a result. RESULT_EVENT (and the optional SECONDARY_EVENT) name a pixel event the
// way Events Manager shows it: a standard event like Schedule or Lead, a custom event name, or a
// custom conversion id. This file is the one place that turns that name into the action types
// Meta's Insights API reports, and the one place that counts them.
import { getConfig } from './config.mjs';

// Standard events Meta reports in the `actions` field.
const PIXEL_ACTIONS = {
  Lead: 'lead',
  CompleteRegistration: 'complete_registration',
  Purchase: 'purchase',
  InitiateCheckout: 'initiate_checkout',
  AddToCart: 'add_to_cart',
  AddPaymentInfo: 'add_payment_info',
  AddToWishlist: 'add_to_wishlist',
  ViewContent: 'view_content',
  Search: 'search',
};
// Standard events Meta reports in the `conversions` field (website first, then all channels).
const CONVERSION_EVENTS = {
  Schedule: 'schedule',
  Contact: 'contact',
  SubmitApplication: 'submit_application',
  StartTrial: 'start_trial',
  Subscribe: 'subscribe',
  FindLocation: 'find_location',
  CustomizeProduct: 'customize_product',
  Donate: 'donate',
};

const norm = (s) => String(s || '').replace(/[\s_-]/g, '').toLowerCase();
const lookup = (table, name) => Object.entries(table).find(([k]) => norm(k) === norm(name))?.[1];

// The action types that count for one event, best match first. Only the first one a row carries
// is counted, so an event reported under two names is never counted twice.
export function actionTypesFor(event, override = null) {
  if (override) return override.split(',').map((s) => s.trim()).filter(Boolean);
  const e = String(event || '').trim();
  if (!e) return [];
  if (/^\d+$/.test(e)) return [`offsite_conversion.custom.${e}`];       // a custom conversion id
  if (e.includes('.')) return [e];                                     // already an action type
  const pixel = lookup(PIXEL_ACTIONS, e);
  if (pixel) return [`offsite_conversion.fb_pixel_${pixel}`, ...(pixel === 'lead' ? ['lead', 'onsite_conversion.lead_grouped'] : [])];
  const conv = lookup(CONVERSION_EVENTS, e);
  if (conv) return [`${conv}_website`, `offsite_conversion.fb_pixel_${conv}`, `${conv}_total`];
  return [`offsite_conversion.fb_pixel_custom.${e}`, `offsite_conversion.custom.${e}`];  // a custom event name
}

const listOf = (row) => [...(row?.actions || []), ...(row?.conversions || [])];

// Count one event in one Insights row.
export function countEvent(row, types) {
  const items = listOf(row);
  for (const t of types) {
    const hit = items.find((a) => a.action_type === t);
    if (hit) return Number(hit.value) || 0;
  }
  return 0;
}

export function metricSpec(cfg = getConfig()) {
  const result = {
    event: cfg.RESULT_EVENT,
    label: cfg.RESULT_LABEL || cfg.RESULT_EVENT,
    types: actionTypesFor(cfg.RESULT_EVENT, cfg.RESULT_ACTION_TYPE),
  };
  const secondary = cfg.SECONDARY_EVENT ? {
    event: cfg.SECONDARY_EVENT,
    label: cfg.SECONDARY_LABEL || cfg.SECONDARY_EVENT,
    types: actionTypesFor(cfg.SECONDARY_EVENT, cfg.SECONDARY_ACTION_TYPE),
  } : null;
  return { result, secondary };
}

export const resultsOf = (row, spec = metricSpec()) => countEvent(row, spec.result.types);
export const secondaryOf = (row, spec = metricSpec()) => (spec.secondary ? countEvent(row, spec.secondary.types) : 0);

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
