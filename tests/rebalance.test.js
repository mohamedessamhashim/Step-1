import test from 'node:test';
import assert from 'node:assert/strict';

import { SEED } from '../data/seed.js';
import { addDays, dow, range } from '../js/dates.js';
import { applyChange, replan, setBlockDone, toggleTask, undoLast, undoTarget, updateCounts, updateSetting } from '../js/model.js';
import { dayTotals, earliestExamDate } from '../js/planner.js';
import { displacedBy, missedDays, previewPatch, rebalanceOptions, STEP } from '../js/rebalance.js';
import { checkInvariants, dayByDate, fresh, mulberry32, plannedUnused, qbankBlocks, remainingBefore, sum } from './helpers.js';

const NOW = 1;
const planDay = (plan, date) => plan.days.find((d) => d.date === date);

function doDay(state, date, share = 1) {
  let next = state;
  for (const b of qbankBlocks(dayByDate(state, date))) next = setBlockDone(next, date, b.id, Math.round(b.count * share), NOW);
  if (dayByDate(state, date).tasks.some((t) => t.id === 'fa')) next = toggleTask(next, date, 'fa', true, NOW);
  return next;
}

/** Works Oct 11 to Oct 18 except the dates in `skip`, then opens the app on Oct 19. */
function afterMissing(skip, share = 0) {
  let { state } = fresh('2026-10-11');
  for (const date of range('2026-10-11', '2026-10-18')) {
    ({ state } = replan(state, date));
    state = doDay(state, date, skip.includes(date) ? share : 1);
  }
  return replan(state, '2026-10-19').state;
}

/** Asserts the plan an option previews is a complete, legal plan. */
function checkOption(state, option, today) {
  const applied = applyChange(state, { kind: option.kind, label: option.kind, patch: option.patch }, NOW);
  const { state: next, summary } = replan(applied, today);
  assert.deepEqual(next.plan.days, option.plan.days, `${option.kind}: the preview is the plan you get`);
  checkInvariants(next, summary, today);
  const left = sum(Object.values(remainingBefore(next, today)));
  assert.equal(plannedUnused(next.plan.days.filter((d) => d.date >= today)) + summary.unscheduled, left, `${option.kind}: totals conserved`);
  return { next, summary };
}

test('missed days are found, with their shortfall', () => {
  const state = afterMissing(['2026-10-14', '2026-10-17'], 0);
  assert.deepEqual(missedDays(state, '2026-10-19'), [
    { date: '2026-10-14', planned: 40, done: 0, shortfall: 40, sa: null, sick: false },
    { date: '2026-10-17', planned: 80, done: 0, shortfall: 80, sa: null, sick: false },
  ]);
  // A partly done day counts for what is left of it.
  const partial = afterMissing(['2026-10-14'], 0.625);
  assert.deepEqual(missedDays(partial, '2026-10-19').map((m) => [m.date, m.done, m.shortfall]), [['2026-10-14', 25, 15]]);
  // Nothing missed: nothing to ask about.
  assert.deepEqual(missedDays(afterMissing([]), '2026-10-19'), []);
});

test('without rebalancing, missed work slides to the end and nothing is lost', () => {
  const state = afterMissing(['2026-10-14']);
  const { summary } = replan(state, '2026-10-19');
  assert.equal(summary.remainingAtStart, 3255 - 400 + 40);
  assert.equal(summary.leftAtDedicated, 415);
  assert.equal(summary.unscheduled, 0);
});

test('every option conserves totals, respects the caps and matches its preview', () => {
  const today = '2026-10-19';
  const state = afterMissing(['2026-10-14', '2026-10-17']);
  const options = rebalanceOptions(state, today, 120);
  for (const kind of ['spread', 'push', 'weekends', 'keep']) {
    assert.ok(options[kind], `${kind} should be offered`);
    const { next } = checkOption(state, options[kind], today);
    for (const day of next.plan.days.filter((d) => d.date >= today && d.phase === 'working')) {
      const weekend = dow(day.date) === 0 || dow(day.date) === 6;
      assert.ok(dayTotals(day).total <= (weekend ? 100 : 60), `${kind}: ${day.date} has ${dayTotals(day).total}`);
    }
  }
});

test('(a) spread: equal steps of 5 on the nearest working days, inside the caps', () => {
  const today = '2026-10-19';
  const state = afterMissing(['2026-10-14']);
  const { spread, current } = rebalanceOptions(state, today, 40);
  assert.equal(spread.each, STEP);
  assert.equal(spread.uncovered, 0);
  assert.equal(sum(Object.values(spread.patch.extras)), 40);
  assert.deepEqual(Object.keys(spread.patch.extras), range('2026-10-19', '2026-10-26'));
  assert.ok(Object.values(spread.patch.extras).every((n) => n === 5));
  assert.equal(dayTotals(planDay(spread.plan, '2026-10-19')).total, 45);
  assert.equal(dayTotals(planDay(spread.plan, '2026-10-24')).total, 85);
  // The 40 are pulled back out of dedicated.
  assert.equal(spread.preview.leftAtDedicated, current.summary.leftAtDedicated - 40);
  assert.equal(spread.preview.examShift, 0);
  assert.equal(spread.preview.changedDays > 0, true);
});

test('(a) spread: a big backlog is limited by the caps and says what is left over', () => {
  const today = '2026-12-07';
  const { state } = fresh(today);
  // One working week left. Its Saturday is a self-assessment, so the room is
  // 5 weekdays and the Sunday at +20 each.
  const { spread } = rebalanceOptions(state, today, 400);
  assert.equal(planDay(spread.plan, '2026-12-12').type, 'sa');
  assert.equal(sum(Object.values(spread.patch.extras)), 120);
  assert.equal(spread.uncovered, 280);
  for (const day of spread.plan.days.filter((d) => d.date >= today && d.phase === 'working')) {
    assert.ok(dayTotals(day).total <= day.maxCap);
  }
});

test('(c) weekends: only Saturdays and Sundays, up to the weekend cap', () => {
  const today = '2026-10-19';
  const state = afterMissing(['2026-10-14', '2026-10-15']);
  const { weekends } = rebalanceOptions(state, today, 80);
  const dates = Object.keys(weekends.patch.extras);
  assert.deepEqual(dates, ['2026-10-24', '2026-10-25', '2026-10-31', '2026-11-01']);
  assert.ok(Object.values(weekends.patch.extras).every((n) => n === 20));
  assert.deepEqual(qbankBlocks(planDay(weekends.plan, '2026-10-24')).map((b) => b.count), [40, 40, 20]);
  assert.equal(weekends.uncovered, 0);
  // Self-assessment Saturdays are skipped.
  const big = rebalanceOptions(state, today, 400).weekends;
  assert.ok(!('2026-11-07' in big.patch.extras));
  assert.ok(Object.keys(big.patch.extras).every((d) => dow(d) === 0 || dow(d) === 6));
});

test('(b) push: the exam moves by N days and the pace stays', () => {
  const today = '2026-10-19';
  const state = afterMissing(['2026-10-14']);
  const { push, current } = rebalanceOptions(state, today, 40);
  assert.equal(push.days, 1, 'one extra weekday covers 40 questions');
  assert.equal(push.patch.examDate, '2026-12-29');
  assert.equal(push.preview.examShift, 1);
  assert.equal(push.preview.dedicatedStart, '2026-12-15');
  assert.equal(push.preview.leftAtDedicated, current.summary.leftAtDedicated - 40);
  assert.deepEqual(push.patch.extras, undefined);
  assert.equal(dayTotals(planDay(push.plan, '2026-10-19')).total, 40);

  // A missed weekend day (80) needs two weekdays.
  const state80 = afterMissing(['2026-10-17']);
  assert.equal(rebalanceOptions(state80, today, 80).push.days, 2);
  // The stepper overrides the default.
  assert.equal(rebalanceOptions(state, today, 40, { pushDays: 7 }).push.patch.examDate, '2027-01-04');
});

test('applying an option records history, and undo restores the plan exactly', () => {
  const today = '2026-10-19';
  const state = afterMissing(['2026-10-14']);
  const before = replan(state, today);
  const { spread, push } = rebalanceOptions(state, today, 40);

  let next = applyChange(state, { kind: 'spread', label: 'Spread 40 questions', patch: spread.patch, resolve: ['2026-10-14'] }, 100);
  next = replan(next, today).state;
  assert.equal(next.history.length, 1);
  assert.equal(next.updatedAt, 100);
  assert.equal(undoTarget(next).label, 'Spread 40 questions');
  assert.deepEqual(missedDays(next, today), [], 'the missed day is marked as dealt with');
  assert.notDeepEqual(next.plan.days, before.state.plan.days);

  // A second change stacks on top.
  next = applyChange(next, { kind: 'push', label: 'Pushed exam 1 day', patch: push.patch }, 200);
  next = replan(next, today).state;
  assert.equal(next.settings.examDate, '2026-12-29');
  assert.equal(next.plan.days.length, 80);

  // Undo peels them off one at a time.
  let undone = replan(undoLast(next, 300), today).state;
  assert.equal(undone.settings.examDate, '2026-12-28');
  assert.deepEqual(undone.settings.extras, spread.patch.extras);
  undone = replan(undoLast(undone, 400), today).state;
  assert.deepEqual(undone.settings.extras, {});
  assert.deepEqual(undone.plan.days, before.state.plan.days, 'back to the plan before any rebalance');
  assert.equal(missedDays(undone, today).length, 1, 'and the missed day is open again');
  assert.equal(undone.history.length, 2, 'history keeps both entries');
  assert.ok(undone.history.every((h) => h.undone));
  assert.equal(undoTarget(undone), null);
  assert.equal(undoLast(undone, 500), undone, 'nothing left to undo');
});

test('sick day: today is closed out and its questions are released', () => {
  const today = '2026-10-19';
  let state = afterMissing([]);
  state = setBlockDone(state, today, 'b0', 10, NOW);
  const frozenToday = structuredClone(dayByDate(state, today));
  state = applyChange(state, { kind: 'sick', label: 'Sick day', sick: today }, NOW);
  const { state: next, summary } = replan(state, today);
  assert.equal(summary.firstOpen, '2026-10-20');
  assert.deepEqual(dayByDate(next, today), frozenToday, 'the sick day keeps its plan');
  assert.deepEqual(missedDays(next, today).map((m) => [m.date, m.shortfall, m.sick]), [[today, 30, true]]);
  assert.equal(summary.remainingAtStart, 3255 - 400 - 10);
  checkInvariants(next, summary, today);
  // Undo reopens the day.
  const reopened = replan(undoLast(next, NOW), today);
  assert.equal(reopened.summary.firstOpen, today);
  assert.equal(reopened.state.log[today].sick, undefined);
});

test('days off: no work is scheduled on them under any option, and undo brings the day back', () => {
  const today = '2026-10-19';
  const state = afterMissing([]);
  const offDates = ['2026-11-25', '2026-11-26', '2026-11-27'];
  const base = replan(state, today);
  const displaced = displacedBy(base.state.plan, offDates);
  assert.equal(displaced, 120);

  const patch = { daysOff: Object.fromEntries(offDates.map((d) => [d, 'Thanksgiving'])) };
  const withOff = { ...state, settings: { ...state.settings, daysOff: patch.daysOff } };
  const options = rebalanceOptions(withOff, today, displaced);
  for (const kind of ['spread', 'push', 'weekends', 'keep']) {
    const option = options[kind];
    for (const d of offDates) {
      assert.deepEqual(planDay(option.plan, d).tasks, [], `${kind}: work on ${d}`);
      assert.ok(!(d in (option.patch.extras ?? {})), `${kind}: extra questions put on a day off`);
    }
    const applied = applyChange(state, { kind: 'dayoff', label: 'Days off', patch: { ...patch, ...option.patch } }, NOW);
    const result = replan(applied, today);
    checkInvariants(result.state, result.summary, today);
    for (const d of offDates) assert.equal(dayByDate(result.state, d).type, 'off');

    const undone = replan(undoLast(applied, NOW), today);
    assert.deepEqual(undone.state.settings.daysOff, {});
    assert.deepEqual(undone.state.plan.days, base.state.plan.days);
  }

  // Removing a day off goes through the same history.
  const applied = applyChange(state, { kind: 'dayoff', label: 'Days off', patch }, NOW);
  const removed = applyChange(applied, { kind: 'dayoff', label: 'Day back on', patch: { removeDaysOff: ['2026-11-26'] } }, NOW);
  assert.deepEqual(Object.keys(removed.settings.daysOff), ['2026-11-25', '2026-11-27']);
});

test('a day off on a self-assessment Saturday moves the assessment, not the questions', () => {
  const { state } = fresh();
  const withOff = { ...state, settings: { ...state.settings, daysOff: { '2026-11-14': 'Wedding' } } };
  const { state: next, summary } = replan(withOff, '2026-10-10');
  assert.equal(dayByDate(next, '2026-11-14').type, 'off');
  assert.deepEqual(summary.sa.slice(0, 5).map((s) => s.date), ['2026-11-07', '2026-11-21', '2026-11-28', '2026-12-05', '2026-12-12']);
  checkInvariants(next, summary, '2026-10-10');
});

test('changing the exam date previews the new plan', () => {
  const { state } = fresh();
  const { preview, plan } = previewPatch(state, '2026-10-10', { examDate: '2027-01-04' });
  assert.equal(preview.examShift, 7);
  assert.equal(preview.dedicatedStart, '2026-12-21');
  assert.equal(plan.days.length, 86);
  // One more working week holds 360 of the 375 that were spilling into dedicated.
  assert.equal(preview.leftAtDedicated, 15);
  assert.equal(preview.qbankFinish, '2026-12-22');
  assert.equal(plannedUnused(plan.days), 3255);
  assert.equal(previewPatch(state, '2026-10-10', { examDate: '2027-01-05' }).preview.finishInDedicated, false);
});

test('updating counts re-bases the pools and the plan follows', () => {
  const today = '2026-10-19';
  let state = afterMissing([]);
  // The dashboard says more Cardiovascular was done than was logged, and one system is untouched.
  state = updateCounts(state, { systems: { cardiovascular: 200, renal: 226 }, totals: { unused: 2800, used: 854 } }, today, NOW);
  const { state: next, summary } = replan(state, today);
  const left = remainingBefore(next, today);
  assert.equal(left.cardiovascular, 200);
  assert.equal(left.renal, 226);
  assert.equal(next.qbank.totals.unused, 2800);
  assert.equal(next.qbank.baselineUnused, 3255, 'the 40% mark keeps its original base once work is logged');
  assert.equal(plannedUnused(next.plan.days.filter((d) => d.date >= today)), sum(Object.values(left)));
  assert.match(next.history.at(-1).label, /Qbank counts updated \(2,855 → 2,797 unused\)/);
  checkInvariants(next, summary, today);
});

test('randomised run: every invariant holds day after day', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const rand = mulberry32(seed);
    const pick = (n) => Math.floor(rand() * n);
    let { state } = fresh('2026-10-10', (s) => {
      s.settings.pace.weekday = 20 + 10 * pick(5);
      s.settings.pace.weekend = 40 + 20 * pick(4);
      s.settings.caps.weekday = 60 + 10 * pick(3);
      s.settings.randomAfterSa1 = rand() < 0.5;
      s.settings.fa.onSaDays = rand() < 0.7;
      s.settings.examDate = addDays('2026-12-28', pick(22) - 7);
    });
    const exam0 = state.settings.examDate;
    let today = '2026-10-11';
    let summary;
    for (let step = 0; step < 95 && today <= state.settings.examDate; step++) {
      const savedBefore = state.plan.days;
      ({ state, summary } = replan(state, today));
      // Frozen: everything before today is exactly what was last saved.
      for (const day of state.plan.days) {
        if (day.date >= today) break;
        assert.deepEqual(day, savedBefore.find((d) => d.date === day.date), `seed ${seed}: ${day.date} changed after it had passed`);
      }
      checkInvariants(state, summary, today);

      // Log the day: full, partial or nothing.
      const mood = rand();
      const day = dayByDate(state, today);
      if (mood > 0.15) {
        for (const b of qbankBlocks(day)) {
          const done = mood > 0.4 ? b.count : pick(b.count + 1);
          state = setBlockDone(state, today, b.id, done, NOW);
        }
        for (const t of day.tasks) if (t.kind !== 'qbank' && rand() < 0.8) state = toggleTask(state, today, t.id, true, NOW);
      }

      // Now and then, change the plan.
      const roll = rand();
      if (roll < 0.08) {
        const off = addDays(today, 1 + pick(20));
        state = applyChange(state, { kind: 'dayoff', label: 'off', patch: { daysOff: { [off]: 'off' } } }, NOW);
      } else if (roll < 0.2) {
        const options = rebalanceOptions(state, today, 20 + 20 * pick(6));
        const option = [options.spread, options.push, options.weekends, options.keep].filter(Boolean)[pick(3)] ?? options.keep;
        const patched = replan(applyChange(state, { kind: option.kind, label: option.kind, patch: option.patch }, NOW), today);
        if (option.kind !== 'push' || !state.log[today]?.sick) assert.deepEqual(patched.state.plan.days, option.plan.days);
        state = patched.state;
      } else if (roll < 0.24) {
        state = applyChange(state, { kind: 'sick', label: 'sick', sick: today }, NOW);
      } else if (roll < 0.28) {
        state = undoLast(state, NOW);
      } else if (roll < 0.32) {
        state = updateSetting(state, 'pace.weekday', 20 + 10 * pick(5), SEED.settings, 'pace', NOW);
      } else if (roll < 0.35) {
        const left = remainingBefore(state, addDays(today, 1));
        const sys = state.qbank.systems[pick(state.qbank.systems.length)].id;
        state = updateCounts(state, { systems: { [sys]: Math.max(0, left[sys] - pick(30)) } }, today, NOW);
      }
      const check = replan(state, today);
      for (const d of check.state.plan.days) {
        if (d.date >= today) break;
        assert.deepEqual(d, state.plan.days.find((x) => x.date === d.date), `seed ${seed}: the past changed during ${today}`);
      }
      checkInvariants(check.state, check.summary, today);
      state = check.state;
      today = addDays(today, rand() < 0.9 ? 1 : 2 + pick(3)); // sometimes the app is not opened for a few days
    }
    assert.ok(state.settings.examDate >= exam0 || state.history.length > 0);
    assert.ok(earliestExamDate(state, state.settings.startDate) !== undefined);
  }
});
