import test from 'node:test';
import assert from 'node:assert/strict';
import { actionTypesFor, countEvent, metricSpec, resultsOf, secondaryOf, actionTypesSeen } from '../src/metrics.mjs';
import { setup } from './helpers.mjs';

test('standard events map to their Insights action types in one place', () => {
  assert.deepEqual(actionTypesFor('Schedule'), ['schedule_website', 'offsite_conversion.fb_pixel_schedule', 'schedule_total']);
  assert.equal(actionTypesFor('Lead')[0], 'offsite_conversion.fb_pixel_lead');
  assert.equal(actionTypesFor('complete registration')[0], 'offsite_conversion.fb_pixel_complete_registration');
  assert.deepEqual(actionTypesFor('1234567'), ['offsite_conversion.custom.1234567']);
  assert.deepEqual(actionTypesFor('anything', 'a.b, c.d'), ['a.b', 'c.d']);
});

test('a row counts the first matching type only, from actions or conversions', () => {
  const row = { actions: [{ action_type: 'offsite_conversion.fb_pixel_lead', value: '4' }, { action_type: 'lead', value: '6' }], conversions: [{ action_type: 'schedule_website', value: '2' }, { action_type: 'schedule_total', value: '3' }] };
  assert.equal(countEvent(row, actionTypesFor('Schedule')), 2);
  assert.equal(countEvent(row, actionTypesFor('Lead')), 4);
  assert.equal(countEvent({}, actionTypesFor('Lead')), 0);
});

test('the result and secondary event come from settings, with labels', () => {
  setup();
  const spec = metricSpec();
  assert.equal(spec.result.label, 'test rides');
  assert.equal(spec.secondary.label, 'leads');
  const row = { conversions: [{ action_type: 'schedule_total', value: '5' }], actions: [{ action_type: 'offsite_conversion.fb_pixel_lead', value: '9' }] };
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
