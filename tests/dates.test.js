import test from 'node:test';
import assert from 'node:assert/strict';

import { addDays, addMonths, daysInMonth, diffDays, dow, fmt, isDate, isWeekend, monthStart, range, todayLocal } from '../js/dates.js';

test('the plan dates fall on the expected weekdays', () => {
  assert.equal(dow('2026-10-10'), 6, 'Sat Oct 10');
  assert.equal(dow('2026-10-11'), 0, 'Sun Oct 11');
  assert.equal(dow('2026-10-17'), 6, 'Sat Oct 17');
  assert.equal(dow('2026-11-26'), 4, 'Thanksgiving is a Thursday');
  assert.equal(dow('2026-12-28'), 1, 'Mon Dec 28');
  assert.equal(diffDays('2026-10-11', '2026-12-28'), 78);
  assert.equal(range('2026-10-11', '2026-12-28').length, 79);
  assert.equal(isWeekend('2026-10-11'), true);
  assert.equal(isWeekend('2026-10-12'), false);
});

test('day arithmetic is exact across clock changes, months and years', () => {
  // US clocks go back on Nov 1, 2026 and forward on Mar 14, 2027.
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-11-01', 1), '2026-11-02');
  assert.equal(diffDays('2026-10-25', '2026-11-08'), 14);
  assert.equal(addDays('2027-03-13', 2), '2027-03-15');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-12-28', -14), '2026-12-14');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29', 'leap year');
  assert.equal(diffDays('2026-12-28', '2026-10-11'), -78);
  const days = range('2026-10-25', '2026-11-08');
  assert.equal(new Set(days).size, 15, 'no day repeated or skipped around the clock change');
});

test('today comes from the local calendar date, not UTC', () => {
  assert.equal(todayLocal(new Date(2026, 9, 10, 23, 59)), '2026-10-10');
  assert.equal(todayLocal(new Date(2026, 9, 11, 0, 1)), '2026-10-11');
  assert.equal(todayLocal(new Date(2027, 0, 5, 12)), '2027-01-05');
});

test('date validation', () => {
  assert.equal(isDate('2026-12-28'), true);
  assert.equal(isDate('2026-02-30'), false);
  assert.equal(isDate('2026-13-01'), false);
  assert.equal(isDate('12/28/2026'), false);
  assert.equal(isDate(''), false);
  assert.equal(isDate(null), false);
});

test('months and formatting', () => {
  assert.equal(monthStart('2026-10-17'), '2026-10-01');
  assert.equal(addMonths('2026-10-17', 1), '2026-11-01');
  assert.equal(addMonths('2026-12-01', 1), '2027-01-01');
  assert.equal(addMonths('2027-01-15', -1), '2026-12-01');
  assert.equal(daysInMonth('2026-11-05'), 30);
  assert.equal(daysInMonth('2028-02-01'), 29);
  assert.equal(fmt('2026-10-11', 'long'), 'Sunday, October 11');
  assert.equal(fmt('2026-12-28', 'short'), 'Mon Dec 28');
  assert.equal(fmt('2026-12-28', 'full'), 'Mon Dec 28, 2026');
  assert.equal(fmt('2026-12-28', 'md'), 'Dec 28');
  assert.equal(fmt('2026-10-11', 'monthYear'), 'October 2026');
  assert.equal(fmt('2026-10-11', 'weekday'), 'Sunday');
  assert.equal(fmt('2026-10-11', 'monthDay'), 'October 11');
});
