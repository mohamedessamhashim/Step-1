import test from 'node:test';
import assert from 'node:assert/strict';

import { SEED } from '../data/seed.js';
import {
  clearScore,
  createState,
  dayProgress,
  firstAidRead,
  isMissedDay,
  moveInOrder,
  normalizeSettings,
  questionsDone,
  remainingBySystem,
  replan,
  setBlockDone,
  setBlockPct,
  setScore,
  toggleTask,
  undoLast,
  updateAssessment,
  updateChapter,
  updateSetting,
  updateSystem,
} from '../js/model.js';
import { progress } from '../js/planner.js';
import { missedDays } from '../js/rebalance.js';
import { dayByDate, fresh, sum } from './helpers.js';

const NOW = 1234;
const faTask = (day) => day.tasks.find((t) => t.kind === 'fa');

test('a new state starts from the seed and counts as never edited', () => {
  const state = createState(SEED);
  assert.equal(state.updatedAt, 0);
  assert.equal(state.qbank.baselineUnused, 3255);
  assert.equal(state.qbank.systems.find((s) => s.id === 'cardiovascular').start, 418);
  assert.deepEqual(state.log, {});
  assert.deepEqual(state.history, []);
  // The seed itself is not shared with the state.
  state.settings.pace.weekday = 999;
  assert.equal(SEED.settings.pace.weekday, 40);
});

test('logging a block: clamped, split by system, clearable', () => {
  let { state } = fresh('2026-10-24'); // a Saturday: two blocks
  const date = '2026-10-24';
  const block = dayByDate(state, date).tasks.find((t) => t.id === 'b0');

  state = setBlockDone(state, date, 'b0', 25, NOW);
  const entry = state.log[date].blocks.b0;
  assert.equal(entry.done, 25);
  assert.equal(entry.planned, 40);
  assert.equal(sum(Object.values(entry.alloc)), 25, 'the per-system split adds up to what was done');
  assert.equal(entry.source, 'unused');
  assert.equal(state.updatedAt, NOW);

  assert.equal(setBlockDone(state, date, 'b0', 999, NOW).log[date].blocks.b0.done, block.count, 'cannot exceed the block');
  assert.equal(setBlockDone(state, date, 'b0', -5, NOW).log[date].blocks.b0.done, 0);
  assert.equal(setBlockDone(state, date, 'b0', '', NOW).log[date], undefined, 'clearing removes the entry');
  assert.equal(setBlockDone(state, date, 'nope', 10, NOW), state, 'unknown block is ignored');
  assert.equal(questionsDone(state.log[date]), 25);
});

test('% correct needs a logged block and stays within 0 to 100', () => {
  let { state } = fresh('2026-10-12');
  assert.equal(setBlockPct(state, '2026-10-12', 'b0', 70, NOW), state);
  state = setBlockDone(state, '2026-10-12', 'b0', 40, NOW);
  state = setBlockPct(state, '2026-10-12', 'b0', 62.4, NOW);
  assert.equal(state.log['2026-10-12'].blocks.b0.pct, 62);
  assert.equal(setBlockPct(state, '2026-10-12', 'b0', 140, NOW).log['2026-10-12'].blocks.b0.pct, 100);
  assert.equal(setBlockPct(state, '2026-10-12', 'b0', '', NOW).log['2026-10-12'].blocks.b0.pct, null);
  // Re-entering the count keeps the score.
  assert.equal(setBlockDone(state, '2026-10-12', 'b0', 30, NOW).log['2026-10-12'].blocks.b0.pct, 62);
  assert.equal(progress(state).pct, 62);
});

test('ticking tasks and the completion ring', () => {
  let { state } = fresh('2026-10-12');
  const date = '2026-10-12';
  const day = dayByDate(state, date);
  assert.deepEqual(day.tasks.map((t) => t.id), ['anki', 'b0', 'rev', 'fa']);
  assert.equal(dayProgress(day, state.log[date]).fraction, 0);

  state = toggleTask(state, date, 'b0', true, NOW);
  assert.equal(state.log[date].blocks.b0.done, 40, 'ticking a block means all of it');
  state = toggleTask(state, date, 'fa', true, NOW);
  assert.deepEqual(state.log[date].fa.parts, faTask(day).parts);
  assert.ok(Math.abs(dayProgress(day, state.log[date]).fraction - 2 / 3) < 1e-9);

  state = toggleTask(state, date, 'rev', true, NOW);
  assert.equal(dayProgress(day, state.log[date]).complete, true, 'the day is complete without Anki');

  // A partly done block gives partial credit.
  state = setBlockDone(state, date, 'b0', 10, NOW);
  assert.ok(Math.abs(dayProgress(day, state.log[date]).done - 2.25) < 1e-9);

  state = toggleTask(state, date, 'b0', false, NOW);
  state = toggleTask(state, date, 'fa', false, NOW);
  state = toggleTask(state, date, 'rev', false, NOW);
  assert.equal(state.log[date], undefined, 'an empty day leaves no entry behind');
  assert.equal(toggleTask(state, date, 'missing', true, NOW), state);
});

test('Anki is optional: it counts when ticked and never holds a day back', () => {
  let { state } = fresh('2026-10-12');
  const date = '2026-10-12';
  const day = dayByDate(state, date);
  const fraction = () => dayProgress(day, state.log[date]).fraction;

  // Ticking it always moves the ring forward.
  state = toggleTask(state, date, 'anki', true, NOW);
  assert.equal(state.log[date].tasks.anki, true);
  assert.equal(fraction(), 1 / 4);
  state = toggleTask(state, date, 'b0', true, NOW);
  assert.equal(fraction(), 2 / 4);
  state = toggleTask(state, date, 'anki', false, NOW);
  assert.equal(fraction(), 1 / 3, 'unticked, it simply drops out');

  // Everything else done: complete with or without it.
  state = toggleTask(toggleTask(state, date, 'fa', true, NOW), date, 'rev', true, NOW);
  assert.equal(dayProgress(day, state.log[date]).complete, true);
  state = toggleTask(state, date, 'anki', true, NOW);
  assert.deepEqual((({ total, done, complete }) => [total, done, complete])(dayProgress(day, state.log[date])), [4, 4, true]);

  // A day with only Anki done is not hatched as missed, but its questions are still owed.
  let only = toggleTask(fresh(date).state, date, 'anki', true, NOW);
  only = replan(only, '2026-10-13').state;
  assert.equal(isMissedDay(dayByDate(only, date), only.log[date], '2026-10-13'), false);
  const owed = (st) => missedDays(st, '2026-10-13').filter((m) => m.date === date).map((m) => m.shortfall);
  assert.deepEqual(owed(only), [40]);

  // A day with everything but Anki is neither missed nor owed anything.
  let rest = fresh(date).state;
  for (const id of ['b0', 'fa', 'rev']) rest = toggleTask(rest, date, id, true, NOW);
  rest = replan(rest, '2026-10-13').state;
  assert.equal(isMissedDay(dayByDate(rest, date), rest.log[date], '2026-10-13'), false);
  assert.deepEqual(owed(rest), []);

  // Nothing at all done: missed.
  const none = replan(fresh(date).state, '2026-10-13').state;
  assert.equal(isMissedDay(dayByDate(none, date), none.log[date], '2026-10-13'), true);
});

test('rapid review does not move the First Aid position', () => {
  let { state } = fresh('2026-12-15');
  const fa = faTask(dayByDate(state, '2026-12-15'));
  assert.equal(fa.mode, 'review');
  state = toggleTask(state, '2026-12-15', 'fa', true, NOW);
  assert.deepEqual(state.log['2026-12-15'].fa, { done: true, parts: [] });
  assert.equal(firstAidRead(state).cardiovascular.pages, 0);
});

test('self-assessment scores tick the task and can be moved or cleared', () => {
  let { state } = fresh('2026-10-10');
  // Nov 7 is NBME 28 in the default plan.
  state = setScore(state, 'nbme28', { date: '2026-11-07', pct: 61.26, weak: ['renal', 'renal', 'neuro'] }, NOW);
  assert.deepEqual(state.scores.nbme28, { date: '2026-11-07', pct: 61.3, weak: ['renal', 'neuro'] });
  assert.equal(state.log['2026-11-07'].tasks.sa, true);

  // Taken a day late instead.
  state = setScore(state, 'nbme28', { date: '2026-11-08' }, NOW);
  assert.equal(state.log['2026-11-07'], undefined);
  assert.equal(state.scores.nbme28.pct, 61.3);

  assert.equal(setScore(state, 'nbme29', { pct: 70 }, NOW), state, 'a score needs a date');
  state = clearScore(state, 'nbme28', NOW);
  assert.equal(state.scores.nbme28, undefined);
  assert.equal(clearScore(state, 'nbme28', NOW), state);

  // Ticking the task on its day records the date; unticking removes it.
  state = toggleTask(state, '2026-11-07', 'sa', true, NOW);
  assert.equal(state.scores.nbme28.date, '2026-11-07');
  state = toggleTask(state, '2026-11-07', 'sa', false, NOW);
  assert.equal(state.scores.nbme28, undefined);
});

test('settings are kept inside sane bounds', () => {
  const d = SEED.settings;
  const s = normalizeSettings(
    {
      ...d,
      examDate: '2026-09-01', // before the start
      startDate: 'nonsense',
      dedicatedDays: 500,
      pace: { weekday: -10, weekend: 'abc', blockMax: 75, dedicated: 120.6 },
      caps: { weekday: 60 },
      fa: { pagesPerHour: '', onSaDays: false },
      goalPct: '65',
      daysOff: { '2026-11-26': 'Thanksgiving', 'not-a-date': 'x', '2026-02-30': 'x' },
      extras: { '2026-10-20': '20', junk: 5 },
    },
    d,
  );
  assert.equal(s.startDate, d.startDate);
  assert.equal(s.examDate, d.examDate, 'the exam must be after the start');
  assert.equal(s.dedicatedDays, 60);
  assert.equal(s.pace.weekday, 0);
  assert.equal(s.pace.weekend, 80);
  assert.equal(s.pace.blockMax, 40, 'the qbank allows 40 per block at most');
  assert.equal(s.pace.dedicated, 121);
  assert.equal(s.caps.weekend, 100);
  assert.equal(s.fa.pagesPerHour, null);
  assert.equal(s.fa.onSaDays, false);
  assert.equal(s.goalPct, 65);
  assert.deepEqual(s.reviewHours, { from: 2, to: 4 }, 'missing review time falls back to 2 to 4 hours');
  assert.deepEqual(normalizeSettings({ ...d, reviewHours: { from: 5, to: 3 } }, d).reviewHours, { from: 5, to: 5 }, '"to" is never below "from"');
  assert.deepEqual(normalizeSettings({ ...d, reviewHours: { from: 1, to: 99 } }, d).reviewHours, { from: 1, to: 12 });
  assert.deepEqual(s.daysOff, { '2026-11-26': 'Thanksgiving' });
  assert.deepEqual(s.extras, { '2026-10-20': 20 });
  assert.deepEqual(normalizeSettings(d, d), createState(SEED).settings);
});

test('changing a setting records it; a no-op changes nothing', () => {
  const state = createState(SEED);
  assert.equal(updateSetting(state, 'pace.weekday', 40, SEED.settings, 'x', NOW), state);
  const next = updateSetting(state, 'pace.weekday', 50, SEED.settings, 'Weekday pace 40 → 50', NOW);
  assert.equal(next.settings.pace.weekday, 50);
  assert.equal(next.settings.pace.weekend, 80);
  assert.deepEqual(next.history.map((h) => [h.kind, h.label]), [['settings', 'Weekday pace 40 → 50']]);
  assert.equal(next.updatedAt, NOW);
  assert.equal(undoLast(next, NOW), next, 'plain settings changes are not rebalances');
  assert.equal(updateSetting(state, 'pace.blockMax', 60, SEED.settings, '', NOW).settings.pace.blockMax, 40);
});

test('First Aid position can be corrected by hand', () => {
  let { state } = fresh('2026-10-12');
  state = toggleTask(state, '2026-10-12', 'fa', true, NOW); // 280–292, of which 10 are Cardiovascular
  assert.equal(firstAidRead(state).cardiovascular.pages, 10);
  state = updateChapter(state, 'cardiovascular', { pagesRead: 30 }, NOW);
  assert.equal(firstAidRead(state).cardiovascular.pages, 30);
  ({ state } = replan(state, '2026-10-13'));
  const next = faTask(dayByDate(state, '2026-10-13'));
  assert.equal(next.chapterId, 'cardiovascular');
  assert.equal(next.parts[0].from, 283 + 30);

  // Time-based chapters count sessions.
  state = updateChapter(state, 'microbiology', { sessionsDone: 5, estHours: 8 }, NOW);
  ({ state } = replan(state, '2026-10-13'));
  const micro = state.plan.days.map(faTask).filter((t) => t?.chapterId === 'microbiology');
  assert.equal(micro.length, 3);
  assert.deepEqual([micro[0].session, micro[0].of], [6, 8]);
});

test('chapter pages, order, mapping and assessment details are editable', () => {
  let state = createState(SEED);
  state = updateChapter(state, 'respiratory', { end: 708, name: '  Respiratory system ' }, NOW);
  const resp = state.firstAid.chapters.find((c) => c.id === 'respiratory');
  assert.deepEqual([resp.end, resp.name], [708, 'Respiratory system']);
  assert.equal(updateChapter(state, 'respiratory', { end: '' }, NOW).firstAid.chapters.find((c) => c.id === 'respiratory').end, null);

  state = moveInOrder(state, 'firstAid', 'endocrine', -1, NOW);
  assert.deepEqual(state.firstAid.order.slice(0, 3), ['approach', 'endocrine', 'cardiovascular']);
  assert.equal(moveInOrder(state, 'firstAid', 'approach', -1, NOW), state, 'already first');
  state = moveInOrder(state, 'assessments', 'uwsa1', -1, NOW);
  assert.deepEqual(state.assessments.order.slice(3, 5), ['uwsa1', 'nbme31']);

  state = updateSystem(state, 'multisystem', { chapter: 'pathology' }, NOW);
  assert.equal(state.qbank.systems.find((s) => s.id === 'multisystem').chapter, 'pathology');
  state = updateAssessment(state, 'uwsa1', { questions: 180, name: 'UWSA 1 (new)' }, NOW);
  assert.deepEqual(
    (({ name, questions }) => [name, questions])(state.assessments.items.find((a) => a.id === 'uwsa1')),
    ['UWSA 1 (new)', 180],
  );

  // The reordered walk shows up in the plan.
  const { state: planned } = replan(state, '2026-10-10');
  assert.equal(faTask(planned.plan.days[0]).chapterId, 'endocrine');
});

test('remaining per system is the starting count minus everything logged', () => {
  let { state } = fresh('2026-10-12');
  state = setBlockDone(state, '2026-10-12', 'b0', 40, NOW);
  const left = remainingBySystem(state);
  assert.equal(left.cardiovascular, 378);
  assert.equal(left.nervous, 0);
  assert.equal(sum(Object.values(left)), 3215);
  const p = progress(state);
  assert.equal(p.done, 40);
  assert.equal(p.left, 3215);
  assert.deepEqual(p.byDate['2026-10-12'], { questions: 40, pct: null });
  assert.equal(Math.round(p.usedPct), Math.round(((3654 - 3215) / 3654) * 100));
});
