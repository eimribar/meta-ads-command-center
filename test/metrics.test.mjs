import test from 'node:test';
import assert from 'node:assert/strict';
import { actionTypeFor, countEvent, metricSpec, resultsOf, secondaryOf, actionTypesSeen } from '../src/metrics.mjs';
import { eventProblem, PIXEL_ACTIONS, CONVERSION_EVENTS } from '../src/events.mjs';
import { parseConfig } from '../src/config.mjs';
import { setup, BASE_ENV } from './helpers.mjs';

test('each event is counted as exactly one action type, the same for the whole install', () => {
  assert.equal(actionTypeFor('Schedule'), 'schedule_website');
  assert.equal(actionTypeFor('Lead'), 'lead', 'Lead counts website and instant form leads');
  assert.equal(actionTypeFor('complete registration'), 'offsite_conversion.fb_pixel_complete_registration');
  assert.equal(actionTypeFor('Purchase'), 'offsite_conversion.fb_pixel_purchase');
  assert.equal(actionTypeFor('1234567'), 'offsite_conversion.custom.1234567');
  assert.equal(actionTypeFor('offsite_conversion.custom.99'), 'offsite_conversion.custom.99');
  assert.equal(actionTypeFor('anything', 'offsite_conversion.custom.42'), 'offsite_conversion.custom.42');
  assert.equal(actionTypeFor('BookedCall'), null, 'a custom event name has no default');
  for (const t of [...Object.values(PIXEL_ACTIONS), ...Object.values(CONVERSION_EVENTS)]) assert.ok(!/fb_pixel_schedule|_total$/.test(t), t);
});

test('a custom event without RESULT_ACTION_TYPE is a settings problem with the fix', () => {
  assert.match(eventProblem('BookedCall', null, 'RESULT'), /custom conversion[\s\S]*RESULT_ACTION_TYPE=offsite_conversion\.custom\.<its id>/);
  assert.equal(eventProblem('BookedCall', 'offsite_conversion.custom.5', 'RESULT'), null);
  assert.equal(eventProblem('Lead', null, 'RESULT'), null);
  const { problems } = parseConfig({ ...BASE_ENV, RESULT_EVENT: 'BookedCall', RESULT_ACTION_TYPE: '' }, { dotenv: false });
  assert.ok(problems.some((p) => p.key === 'RESULT_ACTION_TYPE'), JSON.stringify(problems));
  const two = parseConfig({ ...BASE_ENV, RESULT_ACTION_TYPE: 'a.b, c.d' }, { dotenv: false });
  assert.ok(two.problems.some((p) => p.key === 'RESULT_ACTION_TYPE' && /one only/.test(p.message)), 'one type only');
});

test('a row counts only its one type, from actions or conversions', () => {
  const row = { actions: [{ action_type: 'offsite_conversion.fb_pixel_lead', value: '4' }, { action_type: 'lead', value: '6' }], conversions: [{ action_type: 'schedule_website', value: '2' }, { action_type: 'schedule_total', value: '3' }] };
  assert.equal(countEvent(row, actionTypeFor('Schedule')), 2);
  assert.equal(countEvent(row, actionTypeFor('Lead')), 6);
  assert.equal(countEvent({}, actionTypeFor('Lead')), 0);
  assert.equal(countEvent(row, null), 0);
});

test('the result and secondary event come from settings, with labels', () => {
  setup();
  const spec = metricSpec();
  assert.equal(spec.result.label, 'test rides');
  assert.equal(spec.secondary.label, 'leads');
  const row = { conversions: [{ action_type: 'schedule_website', value: '5' }, { action_type: 'schedule_total', value: '8' }], actions: [{ action_type: 'lead', value: '9' }] };
  assert.equal(resultsOf(row), 5);
  assert.equal(secondaryOf(row), 9);
  setup({ SECONDARY_EVENT: '', SECONDARY_LABEL: '' });
  assert.equal(metricSpec().secondary, null);
  assert.equal(secondaryOf(row), 0);
});

test('an override action type wins over the mapping', () => {
  setup({ RESULT_EVENT: 'Schedule', RESULT_ACTION_TYPE: 'offsite_conversion.custom.42' });
  assert.equal(resultsOf({ actions: [{ action_type: 'offsite_conversion.custom.42', value: '7' }], conversions: [{ action_type: 'schedule_website', value: '1' }] }), 7);
});

test('actionTypesSeen totals every type across rows, biggest first', () => {
  const seen = actionTypesSeen([{ actions: [{ action_type: 'link_click', value: '10' }] }, { conversions: [{ action_type: 'schedule_website', value: '3' }], actions: [{ action_type: 'link_click', value: '5' }] }]);
  assert.deepEqual(seen, [{ type: 'link_click', total: 15 }, { type: 'schedule_website', total: 3 }]);
});
