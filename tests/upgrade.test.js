import test from 'node:test';
import assert from 'node:assert/strict';

import { SEED } from '../data/seed.js';
import { addDays, range } from '../js/dates.js';
import { createState, replan, setBlockDone, toggleTask, upgrade, VERSION } from '../js/model.js';
import { earliestExamDate, generatePlan } from '../js/planner.js';
import { migrate } from '../js/storage.js';
import { CLASSIC, checkInvariants, dayByDate, plannedUnused, qbankBlocks, sum } from './helpers.js';

const NOW = 5000;
const counts = (state, date) => qbankBlocks(dayByDate(state, date)).map((b) => b.count);

/** A copy as the previous version saved it: the original pace, every day done Oct 11 to 14. */
function savedByV1() {
  let state = createState(CLASSIC);
  for (const date of range('2026-10-11', '2026-10-14')) {
    ({ state } = replan(state, date));
    for (const t of dayByDate(state, date).tasks) state = t.kind === 'qbank' ? setBlockDone(state, date, t.id, t.count, 1) : toggleTask(state, date, t.id, true, 1);
  }
  return { ...state, version: 1, updatedAt: 1000 };
}

/** True when `examDate` is the earliest date at which every question and self-assessment fits. */
function isEarliest(state, today) {
  const at = (examDate) => generatePlan({ ...state, settings: { ...state.settings, examDate } }, today).summary;
  const day = at(state.settings.examDate);
  const before = at(addDays(state.settings.examDate, -1));
  return day.unscheduled === 0 && day.saUnplaced.length === 0 && (before.unscheduled > 0 || before.saUnplaced.length > 0);
}

test('the seed plans 20 on weekdays, 80 at weekends and 100 in dedicated', () => {
  const { state, summary } = replan(createState(SEED), '2026-10-15');
  const { weekday, weekend, dedicated } = state.settings.pace;
  assert.deepEqual([weekday, weekend, dedicated], [20, 80, 100]);
  assert.deepEqual(counts(state, '2026-10-16'), [20], 'Friday');
  assert.deepEqual(counts(state, '2026-10-17'), [40, 40], 'Saturday');
  for (const day of state.plan.days.filter((d) => d.type === 'dedicated')) {
    assert.equal(sum(qbankBlocks(day).map((b) => b.count)), 100);
    assert.ok(qbankBlocks(day).every((b) => b.count <= 40));
  }
  assert.equal(summary.unscheduled, 0);
  assert.equal(state.settings.examDate, earliestExamDate(createState(SEED), '2026-10-15'), 'the seed exam is the earliest date that fits');
  checkInvariants(state, summary, '2026-10-15');
});

test('a copy saved before the change: today keeps 40, the new pace starts tomorrow, the exam moves', () => {
  const v1 = savedByV1();
  const past = replan(v1, '2026-10-15').state.plan.days.filter((d) => d.date < '2026-10-15');
  const up = upgrade(v1, '2026-10-15', NOW);

  assert.equal(up.version, VERSION);
  assert.equal(up.updatedAt, NOW, 'counts as an edit, so it wins a sync against the old copy');
  const { weekday, weekend, dedicated } = up.settings.pace;
  assert.deepEqual([weekday, weekend, dedicated], [20, 80, 100]);
  assert.deepEqual(up.settings.extras, { '2026-10-15': 20 }, 'today keeps the 40 it already had');

  const { state, summary } = replan(up, '2026-10-15');
  assert.deepEqual(counts(state, '2026-10-15'), [40]);
  assert.deepEqual(counts(state, '2026-10-16'), [20]);
  assert.deepEqual(counts(state, '2026-10-17'), [40, 40]);
  assert.ok(state.settings.examDate > '2026-12-28');
  assert.ok(isEarliest(state, '2026-10-15'), `exam ${state.settings.examDate} should be the earliest date that fits`);
  assert.deepEqual(state.plan.days.filter((d) => d.date < '2026-10-15'), past, 'past days are untouched');
  assert.equal(plannedUnused(state.plan.days.filter((d) => d.date >= '2026-10-15')), 3255 - 160);
  checkInvariants(state, summary, '2026-10-15');

  const entry = state.history.at(-1);
  assert.equal(entry.kind, 'upgrade');
  assert.match(entry.label, /^Pace changed to 20 on weekdays, 80 at weekends and 100 in dedicated, from Fri Oct 16\. Exam moved from Mon Dec 28 to \w{3} \w{3} \d+ so every question fits$/);
  assert.equal(upgrade(up, '2026-10-15', NOW + 1), up, 'it happens only once');
});

test('opened for the first time after the change date, the new pace starts that day', () => {
  const up = upgrade(savedByV1(), '2026-10-17', NOW);
  assert.deepEqual(up.settings.extras, {});
  const { state, summary } = replan(up, '2026-10-17');
  assert.deepEqual(counts(state, '2026-10-17'), [40, 40]);
  assert.deepEqual(counts(state, '2026-10-19'), [20]);
  assert.match(state.history.at(-1).label, /from Sat Oct 17\./);
  assert.ok(isEarliest(state, '2026-10-17'));
  checkInvariants(state, summary, '2026-10-17');
});

test('loading keeps the saved version so the upgrade can run; new copies are already current', () => {
  const v1 = savedByV1();
  assert.equal(migrate(JSON.parse(JSON.stringify(v1)), SEED).version, 1);
  const { version, ...noVersion } = v1;
  assert.equal(migrate(noVersion, SEED).version, 1);
  assert.equal(migrate({ ...v1, version: 99 }, SEED).version, VERSION);
  const fresh = createState(SEED);
  assert.equal(fresh.version, VERSION);
  assert.equal(upgrade(fresh, '2026-10-15', NOW), fresh);
});
