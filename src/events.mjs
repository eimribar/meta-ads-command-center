// What a result event is counted as. RESULT_EVENT (and SECONDARY_EVENT) name an event the way
// Events Manager shows it; each one is counted as exactly one Meta action type for the whole
// install, so every row, every day and every report counts the same thing.
//   RESULT_ACTION_TYPE set           that action type
//   a number                         a custom conversion id: offsite_conversion.custom.<id>
//   a name with a dot                already an action type
//   a standard event                 the action type in the tables below
//   any other name (a custom event)  no default: Meta reports a custom event only through a
//                                    custom conversion, so RESULT_ACTION_TYPE must name it
// Action types: developers.facebook.com/docs/marketing-api/reference/ads-action-stats/ (read 2026-11-19).

// Standard events reported in the Insights `actions` field. Lead counts every lead (website and
// instant forms); the others count the website pixel.
export const PIXEL_ACTIONS = {
  Lead: 'lead',
  CompleteRegistration: 'offsite_conversion.fb_pixel_complete_registration',
  Purchase: 'offsite_conversion.fb_pixel_purchase',
  InitiateCheckout: 'offsite_conversion.fb_pixel_initiate_checkout',
  AddToCart: 'offsite_conversion.fb_pixel_add_to_cart',
  AddPaymentInfo: 'offsite_conversion.fb_pixel_add_payment_info',
  AddToWishlist: 'offsite_conversion.fb_pixel_add_to_wishlist',
  ViewContent: 'offsite_conversion.fb_pixel_view_content',
  Search: 'offsite_conversion.fb_pixel_search',
};
// Standard events reported in the Insights `conversions` field, counted from the website pixel.
export const CONVERSION_EVENTS = {
  Schedule: 'schedule_website',
  Contact: 'contact_website',
  SubmitApplication: 'submit_application_website',
  StartTrial: 'start_trial_website',
  Subscribe: 'subscribe_website',
  FindLocation: 'find_location_website',
  CustomizeProduct: 'customize_product_website',
  Donate: 'donate_website',
};

const norm = (s) => String(s || '').replace(/[\s_-]/g, '').toLowerCase();
const lookup = (table, name) => Object.entries(table).find(([k]) => norm(k) === norm(name))?.[1];

export const ACTION_TYPE_SHAPE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;

// The one action type an event is counted as, or null for a custom event name with no override.
export function actionTypeFor(event, override = null) {
  if (override) return String(override).trim();
  const e = String(event || '').trim();
  if (!e) return null;
  if (/^\d+$/.test(e)) return `offsite_conversion.custom.${e}`;
  if (e.includes('.')) return e;
  return lookup(PIXEL_ACTIONS, e) || lookup(CONVERSION_EVENTS, e) || null;
}

const knownEvent = (s) => Boolean(lookup(PIXEL_ACTIONS, s) || lookup(CONVERSION_EVENTS, s));
// "Purchase,Lead", "Schedule and Lead", "Purchase Lead": a list where one event goes.
export function severalEvents(event) {
  const e = String(event || '').trim();
  if (!e || /^\d+$/.test(e) || knownEvent(e)) return null;
  const parts = e.split(/\s*(?:[,;|+&/]|\s(?:and|or)\s)\s*/i).filter(Boolean);
  const words = e.split(/\s+/).filter(Boolean);
  if (parts.length > 1 || words.filter(knownEvent).length >= 2) return parts.length > 1 ? parts : words;
  return null;
}
export function severalEventsProblem(event, which = 'RESULT') {
  const list = severalEvents(event);
  if (!list) return null;
  const second = which === 'RESULT' ? ', and a second one can go in SECONDARY_EVENT' : '';
  return `names more than one event (${list.join(', ')}); it takes one event only. Pick one, for example Schedule, Lead, Purchase or CompleteRegistration (the full list is in docs/SETTINGS.md)${second}`;
}

// Why an event cannot be counted as given, or null. `which` is RESULT or SECONDARY.
export function eventProblem(event, override, which = 'RESULT') {
  if (!event || override) return null;
  if (actionTypeFor(event)) return null;
  return `is not set, and ${which}_EVENT names a custom event. Meta reports a custom event only through a custom conversion: create one for this event in Events Manager (Custom conversions), then set ${which}_ACTION_TYPE=offsite_conversion.custom.<its id>, or put the id itself in ${which}_EVENT`;
}
