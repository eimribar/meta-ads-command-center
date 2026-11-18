import test from 'node:test';
import assert from 'node:assert/strict';
import { nextDaily, nextWeekly, passedToday, dayOf, zonedTime, setTimezone, daysAgo } from '../src/clock.mjs';
import { setRuntime } from '../src/runtime.mjs';

test('a daily time in a zone maps to the right UTC moment, across daylight saving', () => {
  // New York: EDT (UTC-4) until the first Sunday of November, EST (UTC-5) after
  assert.equal(zonedTime(2026, 10, 30, 9, 0, 'America/New_York').toISOString(), '2026-10-30T13:00:00.000Z');
  assert.equal(zonedTime(2026, 11, 2, 9, 0, 'America/New_York').toISOString(), '2026-11-02T14:00:00.000Z');
  // London: BST (UTC+1) until the last Sunday of October, GMT after
  assert.equal(zonedTime(2026, 10, 20, 9, 0, 'Europe/London').toISOString(), '2026-10-20T08:00:00.000Z');
  assert.equal(zonedTime(2026, 11, 18, 9, 0, 'Europe/London').toISOString(), '2026-11-18T09:00:00.000Z');
});

test('next daily run is strictly after now', () => {
  const tz = 'America/New_York';
  const before = new Date('2026-11-18T13:00:00Z'); // 08:00 New York
  assert.equal(nextDaily({ h: 9, m: 0 }, before, tz).toISOString(), '2026-11-18T14:00:00.000Z');
  const after = new Date('2026-11-18T15:00:00Z');
  assert.equal(nextDaily({ h: 9, m: 0 }, after, tz).toISOString(), '2026-11-19T14:00:00.000Z');
  assert.equal(passedToday({ h: 9, m: 0 }, before, tz), null);
  assert.ok(passedToday({ h: 9, m: 0 }, after, tz));
});

test('next weekly run lands on the weekday', () => {
  const at = nextWeekly('monday', { h: 9, m: 0 }, new Date('2026-11-18T12:00:00Z'), 'UTC');
  assert.equal(at.toISOString(), '2026-11-23T09:00:00.000Z');
});

test('days are counted in the zone', () => {
  const late = new Date('2026-11-18T23:30:00Z');
  assert.equal(dayOf(late, 'UTC'), '2026-11-18');
  assert.equal(dayOf(late, 'Asia/Tokyo'), '2026-11-19');
  setTimezone('Asia/Tokyo');
  setRuntime({ now: () => late });
  assert.equal(daysAgo(1), '2026-11-18');
  setTimezone('UTC');
  assert.throws(() => setTimezone('Mars/Olympus'), /not a known time zone/);
});
