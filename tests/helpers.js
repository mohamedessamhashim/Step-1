// Shared helpers for the tests. Not a test file itself.

import assert from 'node:assert/strict';
import { SEED } from '../data/seed.js';

/**
 * The scenario most tests are written against: the original pace (40 / 80 / 100)
 * and a Dec 28 exam. Kept fixed here so the tests do not move when the seed's
 * defaults are changed.
 */
export const CLASSIC = {
  ...SEED,
  settings: { ...SEED.settings, examDate: '2026-12-28', pace: { ...SEED.settings.pace, weekday: 40, weekend: 80, dedicated: 100 } },
};
import { addDays, dow } from '../js/dates.js';
import { createState, replan } from '../js/model.js';
import { firstOpenDate } from '../js/planner.js';

export const BEFORE_START = '2026-10-10';

/** A fresh state with its plan generated as of `today`. */
export function fresh(today = BEFORE_START, mutate) {
  const state = createState(CLASSIC);
  mutate?.(state);
  return replan(state, today);
}

export const sum = (xs) => xs.reduce((a, b) => a + b, 0);
export const qbankBlocks = (day) => day.tasks.filter((t) => t.kind === 'qbank');
export const unusedBlocks = (day) => qbankBlocks(day).filter((t) => t.source === 'unused');
export const dayByDate = (state, date) => state.plan.days.find((d) => d.date === date);
export const plannedUnused = (days) => sum(days.flatMap(unusedBlocks).map((b) => b.count));

export function plannedBySystem(days) {
  const out = {};
  for (const b of days.flatMap(unusedBlocks)) for (const [sys, n] of Object.entries(b.alloc)) out[sys] = (out[sys] ?? 0) + n;
  return out;
}

/** Unused questions left before `date`, worked out from the raw log without using the planner's own ledger. */
export function remainingBefore(state, date) {
  const left = Object.fromEntries(state.qbank.systems.map((s) => [s.id, s.start]));
  for (const [d, entry] of Object.entries(state.log)) {
    if (d >= date) continue;
    for (const b of Object.values(entry.blocks ?? {})) {
      if (b.source !== 'unused') continue;
      for (const [sys, n] of Object.entries(b.alloc)) left[sys] -= n;
    }
  }
  return left;
}

/** Every rule the plan must satisfy, checked against one state. */
export function checkInvariants(state, summary, today) {
  const { settings } = state;
  const open = firstOpenDate(state, today);
  const future = state.plan.days.filter((d) => d.date >= open);

  for (const day of state.plan.days) {
    const blocks = qbankBlocks(day);
    for (const b of blocks) {
      assert.ok(b.count >= 1 && b.count <= 40, `${day.date}: block of ${b.count}`);
      if (b.source === 'unused') assert.equal(sum(Object.values(b.alloc)), b.count, `${day.date}: block split does not add up`);
    }
  }

  for (const day of future) {
    const blocks = qbankBlocks(day);
    const total = sum(blocks.map((b) => b.count));
    const weekend = dow(day.date) === 0 || dow(day.date) === 6;

    // The cap is worked out again here from the settings, not read from the plan.
    let cap = 0;
    if (day.type === 'dedicated') cap = settings.pace.dedicated;
    else if (day.type === 'workday' || day.type === 'weekend') {
      const base = weekend && day.date >= settings.pace.weekendFrom ? settings.pace.weekend : settings.pace.weekday;
      const max = Math.max(base, weekend ? settings.caps.weekend : settings.caps.weekday);
      cap = Math.min(max, base + (settings.extras[day.date] ?? 0));
    }
    assert.ok(total <= cap, `${day.date} (${day.type}): ${total} questions over the cap of ${cap}`);
    assert.equal(day.capacity, cap, `${day.date}: capacity`);

    if (day.type === 'sa') {
      assert.equal(blocks.length, 0, `${day.date}: qbank blocks on a self-assessment day`);
      assert.ok(day.tasks.some((t) => t.kind === 'sa'), `${day.date}: no self-assessment task`);
      assert.ok(day.tasks.some((t) => t.kind === 'sareview'), `${day.date}: no review task`);
    }
    if (day.type === 'off' || day.type === 'rest' || day.type === 'exam') {
      assert.equal(day.tasks.length, 0, `${day.date}: work scheduled on a ${day.type} day`);
    }
    if (Object.hasOwn(settings.daysOff, day.date) && day.type !== 'exam' && day.type !== 'rest') {
      assert.equal(day.type, 'off', `${day.date}: day off not honoured`);
    }
  }

  // Totals: every unused question is planned exactly once.
  const left = remainingBefore(state, open);
  const leftTotal = sum(Object.values(left));
  assert.equal(plannedUnused(future) + summary.unscheduled, leftTotal, 'planned unused + unscheduled must equal remaining unused');
  const bySystem = plannedBySystem(future);
  for (const [sys, n] of Object.entries(bySystem)) assert.ok(n <= left[sys], `${sys}: planned ${n} of ${left[sys]}`);
  if (summary.unscheduled === 0) {
    for (const [sys, n] of Object.entries(left)) assert.equal(bySystem[sys] ?? 0, n, `${sys}: planned ${bySystem[sys] ?? 0}, remaining ${n}`);
  }

  // Each self-assessment at most once.
  const ids = future.flatMap((d) => d.tasks.filter((t) => t.kind === 'sa').map((t) => t.assessment));
  assert.equal(new Set(ids).size, ids.length, 'a self-assessment is scheduled twice');
}

/** Small seeded random generator so the randomised test is repeatable. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export { addDays };
