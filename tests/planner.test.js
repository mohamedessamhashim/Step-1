import test from 'node:test';
import assert from 'node:assert/strict';

import { SEED } from '../data/seed.js';
import { addDays, dow, range } from '../js/dates.js';
import { applyChange, createState, replan, setBlockDone, setBlockPct, setScore, toggleTask, updateChapter, updateSetting } from '../js/model.js';
import { chapterRanges, earliestExamDate, generatePlan, weakChapters } from '../js/planner.js';
import { BEFORE_START, checkInvariants, dayByDate, fresh, plannedBySystem, plannedUnused, qbankBlocks, sum, unusedBlocks } from './helpers.js';

const NOW = 1;
const types = (state, type) => state.plan.days.filter((d) => d.type === type).map((d) => d.date);
const sizes = (day) => qbankBlocks(day).map((b) => b.count);
const faTask = (day) => day.tasks.find((t) => t.kind === 'fa');
const chapterOf = Object.fromEntries(SEED.qbank.systems.map((s) => [s.id, s.chapter]));
const generalChapters = new Set(SEED.firstAid.chapters.filter((c) => c.section === 'general').map((c) => c.id));

/** Logs every question block of a day as fully done. */
function doDay(state, date) {
  let next = state;
  for (const b of qbankBlocks(dayByDate(state, date))) next = setBlockDone(next, date, b.id, b.count, NOW);
  return next;
}

/** Does every day's questions and First Aid from the start through `last`, then opens the app on `today`. */
function workThrough(last, today) {
  let { state } = fresh('2026-10-11');
  for (const date of range('2026-10-11', last)) {
    ({ state } = replan(state, date));
    state = doDay(state, date);
    if (faTask(dayByDate(state, date))) state = toggleTask(state, date, 'fa', true, NOW);
  }
  return replan(state, today).state;
}

test('seed data adds up', () => {
  const { qbank } = SEED;
  assert.equal(sum(qbank.systems.map((s) => s.unused)), 3255);
  assert.equal(sum(qbank.subjects.map((s) => s.unused)), 3255);
  assert.equal(qbank.totals.unused, 3255);
  assert.equal(qbank.totals.used + qbank.totals.unused, qbank.totals.all);
  assert.equal(qbank.totals.correct + qbank.totals.incorrect + qbank.totals.omitted, qbank.totals.used);
  assert.equal(qbank.systems.length, 26);
  assert.equal(SEED.assessments.items.length, 10);
  assert.deepEqual([...SEED.assessments.order].sort(), SEED.assessments.items.map((a) => a.id).sort());
  for (const s of qbank.systems) if (s.chapter) assert.ok(SEED.firstAid.chapters.some((c) => c.id === s.chapter), `${s.id} maps to a missing chapter`);
});

test('chapter page ranges come from the next start page', () => {
  const r = chapterRanges(SEED.firstAid);
  assert.deepEqual([r.approach.start, r.approach.end, r.approach.pages], [280, 282, 3]);
  assert.deepEqual([r.cardiovascular.start, r.cardiovascular.end], [283, 328]);
  assert.deepEqual([r.neuro.start, r.neuro.end, r.neuro.pages], [499, 568, 70]);
  assert.deepEqual([r.reproductive.start, r.reproductive.end], [629, 676]);
  assert.equal(r.respiratory.pages, null, 'Respiratory has no end page yet');
  assert.equal(r.biochemistry.pages, null);
});

test('default plan: phases, capacity and day types', () => {
  const { state, summary } = fresh();
  const days = state.plan.days;
  assert.equal(days.length, 79);
  assert.equal(days[0].date, '2026-10-11');
  assert.equal(days.at(-1).date, '2026-12-28');
  assert.equal(summary.dedicatedStart, '2026-12-14');
  assert.equal(summary.restDay, '2026-12-27');

  assert.equal(dayByDate(state, '2026-10-11').capacity, 40, 'Sun Oct 11 is a 40 day');
  assert.equal(dayByDate(state, '2026-10-11').type, 'weekend');
  assert.equal(dayByDate(state, '2026-10-12').capacity, 40);
  assert.equal(dayByDate(state, '2026-10-17').capacity, 80, 'weekends are 80 from Sat Oct 17');
  assert.equal(dayByDate(state, '2026-10-18').capacity, 80);
  assert.equal(dayByDate(state, '2026-12-15').capacity, 100);

  assert.deepEqual(types(state, 'exam'), ['2026-12-28']);
  assert.deepEqual(types(state, 'rest'), ['2026-12-27']);
  for (const d of range('2026-12-14', '2026-12-27')) assert.equal(dayByDate(state, d).phase, 'dedicated');
  assert.equal(dayByDate(state, '2026-12-13').phase, 'working');

  // weekday = 1 block, weekend day = 2 blocks, dedicated = 40/40/20
  assert.deepEqual(sizes(dayByDate(state, '2026-10-12')), [40]);
  assert.deepEqual(sizes(dayByDate(state, '2026-10-17')), [40, 40]);
  assert.deepEqual(sizes(dayByDate(state, '2026-12-15')), [40, 40, 20]);
  checkInvariants(state, summary, BEFORE_START);
});

test('self-assessments: five Saturdays from the 40% mark, five in dedicated, in order', () => {
  const { state, summary } = fresh();
  assert.deepEqual(
    summary.sa.map((s) => s.date),
    ['2026-11-07', '2026-11-14', '2026-11-21', '2026-11-28', '2026-12-05', '2026-12-14', '2026-12-17', '2026-12-20', '2026-12-23', '2026-12-26'],
  );
  assert.deepEqual(summary.sa.map((s) => s.id), SEED.assessments.order);
  assert.deepEqual(summary.saUnplaced, []);
  for (const { date, phase } of summary.sa.slice(0, 5)) {
    assert.equal(dow(date), 6);
    assert.equal(phase, 'working');
  }
  for (const { date } of summary.sa) {
    const day = dayByDate(state, date);
    assert.equal(day.type, 'sa');
    assert.equal(qbankBlocks(day).length, 0, 'no qbank blocks on a self-assessment day');
    assert.ok(day.tasks.some((t) => t.kind === 'sareview'));
  }
  // 1,320 of 3,255 (40.6%) are done before the first one.
  const before = plannedUnused(state.plan.days.filter((d) => d.date < '2026-11-07'));
  assert.equal(before, 1320);
});

test('totals are conserved and the finish date is flagged', () => {
  const { state, summary } = fresh();
  assert.equal(plannedUnused(state.plan.days), 3255);
  assert.equal(summary.unscheduled, 0);
  const bySystem = plannedBySystem(state.plan.days);
  for (const s of SEED.qbank.systems) assert.equal(bySystem[s.id] ?? 0, s.unused, s.name);

  const working = state.plan.days.filter((d) => d.phase === 'working');
  assert.equal(plannedUnused(working), 2880);
  assert.equal(summary.leftAtDedicated, 375);
  assert.equal(summary.qbankFinish, '2026-12-19');
  assert.equal(summary.finishInDedicated, true);
});

test('dedicated: random unused first, then incorrects', () => {
  const { state } = fresh();
  const d19 = dayByDate(state, '2026-12-19');
  assert.deepEqual(
    qbankBlocks(d19).map((b) => [b.source, b.count]),
    [['unused', 40], ['unused', 35], ['incorrect', 25]],
  );
  for (const d of ['2026-12-15', '2026-12-16', '2026-12-18']) {
    assert.ok(qbankBlocks(dayByDate(state, d)).every((b) => b.mode === 'random' && b.source === 'unused'));
  }
  const d21 = dayByDate(state, '2026-12-21');
  assert.deepEqual(qbankBlocks(d21).map((b) => [b.mode, b.count]), [['incorrect', 40], ['incorrect', 40], ['incorrect', 20]]);
  assert.equal(faTask(d21).mode, 'review');
  assert.equal(faTask(d21).chapters.length, 2);
});

test('blocks follow the First Aid chapter, then General Principles, then go random after self-assessment #1', () => {
  const { state } = fresh();
  const before = state.plan.days.filter((d) => d.date < '2026-11-07');
  for (const day of before) {
    const chapter = faTask(day).chapterId;
    for (const b of unusedBlocks(day)) {
      assert.equal(b.mode, 'systems', `${day.date} should be a system block`);
      for (const sys of b.systems) {
        const mapped = chapterOf[sys];
        if (b.fallback) assert.ok(generalChapters.has(mapped), `${day.date}: fallback ${sys} is not General Principles`);
        else assert.equal(mapped, chapter, `${day.date}: ${sys} does not belong to ${chapter}`);
      }
    }
  }
  assert.deepEqual(unusedBlocks(dayByDate(state, '2026-10-12'))[0].systems, ['cardiovascular']);

  // Neuro has only Ophthalmology + ENT left (71), so its days fall back to General Principles.
  const neuroDays = before.filter((d) => faTask(d).chapterId === 'neuro');
  assert.equal(neuroDays.length, 6);
  const neuroBlocks = neuroDays.flatMap(unusedBlocks);
  assert.equal(sum(neuroBlocks.filter((b) => !b.fallback).map((b) => b.count)), 71);
  assert.ok(neuroBlocks.some((b) => b.fallback && b.systems.includes('biochemistry-gp')));

  const after = state.plan.days.filter((d) => d.date > '2026-11-07');
  assert.ok(after.flatMap(unusedBlocks).every((b) => b.mode === 'random'));

  const all = state.plan.days.flatMap(unusedBlocks);
  assert.ok(all.every((b) => !('nervous' in b.alloc)), 'Nervous System has nothing left to draw');
  assert.ok(all.filter((b) => 'multisystem' in b.alloc).every((b) => b.mode === 'random'), 'Multisystem only in random blocks');
});

test('with the random toggle off, blocks stay on systems after self-assessment #1', () => {
  const { state, summary } = fresh(BEFORE_START, (s) => {
    s.settings.randomAfterSa1 = false;
  });
  const nov9 = dayByDate(state, '2026-11-09');
  assert.equal(faTask(nov9).chapterId, 'renal');
  assert.deepEqual(unusedBlocks(nov9).map((b) => [b.mode, b.systems]), [['systems', ['renal']]]);
  assert.equal(plannedUnused(state.plan.days), 3255);
  checkInvariants(state, summary, BEFORE_START);
});

test('First Aid: derived pace finishes every chapter before dedicated', () => {
  const { state, summary } = fresh();
  assert.equal(summary.pagesPerHour, 13);
  assert.equal(summary.pagesAuto, true);
  assert.equal(summary.faFits, true);
  assert.ok(summary.faFinish < summary.dedicatedStart);

  // Every page of every paged chapter is read exactly once, in order.
  const ranges = chapterRanges(state.firstAid);
  const read = {};
  const sessions = {};
  for (const day of state.plan.days.filter((d) => d.phase === 'working')) {
    const fa = faTask(day);
    assert.ok(fa, `${day.date}: First Aid every working day`);
    if (fa.mode === 'read') {
      assert.ok(fa.pages <= 13);
      for (const p of fa.parts) for (let n = p.from; n <= p.to; n++) (read[p.chapterId] ??= []).push(n);
    } else if (fa.mode === 'time') sessions[fa.chapterId] = (sessions[fa.chapterId] ?? 0) + 1;
  }
  for (const c of state.firstAid.chapters) {
    const r = ranges[c.id];
    if (r.pages != null) assert.deepEqual(read[c.id], Array.from({ length: r.pages }, (_, i) => r.start + i), c.name);
    else assert.equal(sessions[c.id], c.estHours, `${c.name} is scheduled by time`);
  }

  // The 3-page intro is read with the first Cardiovascular chunk.
  const first = faTask(state.plan.days[0]);
  assert.equal(first.chapterId, 'cardiovascular');
  assert.deepEqual(first.parts, [
    { chapterId: 'approach', from: 280, to: 282 },
    { chapterId: 'cardiovascular', from: 283, to: 292 },
  ]);
  // Walk order: organ systems in book order, then General Principles.
  const order = [...new Set(state.plan.days.map(faTask).filter((t) => t && t.mode !== 'review').map((t) => t.chapterId))];
  assert.deepEqual(order, SEED.firstAid.order.filter((id) => id !== 'approach'));
});

test('First Aid: entering pages switches a chapter from time to page ranges', () => {
  const base = createState(SEED);
  const withPages = updateChapter(updateChapter(base, 'immunology', { start: 93, end: 120 }, NOW), 'respiratory', { end: 708 }, NOW);
  const { state } = replan(withPages, BEFORE_START);
  const tasks = state.plan.days.map(faTask).filter(Boolean);
  const immuno = tasks.filter((t) => t.chapterId === 'immunology');
  assert.ok(immuno.length > 0 && immuno.every((t) => t.mode === 'read'));
  assert.equal(immuno[0].parts[0].from, 93);
  assert.equal(immuno.at(-1).parts.at(-1).to, 120);
  assert.ok(tasks.filter((t) => t.chapterId === 'respiratory').every((t) => t.mode === 'read'));
  assert.ok(tasks.filter((t) => t.chapterId === 'microbiology').every((t) => t.mode === 'time'));
});

test('First Aid: skipping it on self-assessment days raises the pace', () => {
  const { state, summary } = fresh(BEFORE_START, (s) => {
    s.settings.fa.onSaDays = false;
  });
  assert.equal(summary.pagesPerHour, 16);
  assert.equal(faTask(dayByDate(state, '2026-11-07')), undefined);
  assert.ok(summary.faFinish < summary.dedicatedStart);
});

test('First Aid: a pace that is too slow is reported, not hidden', () => {
  const { summary } = fresh(BEFORE_START, (s) => {
    s.settings.fa.pagesPerHour = 5;
  });
  assert.equal(summary.pagesPerHour, 5);
  assert.equal(summary.pagesAuto, false);
  assert.equal(summary.faFits, false);
  assert.ok(summary.faOverflow > 0);
  assert.equal(summary.faFinish, null);
});

test('a day off carries no work and moves the finish date', () => {
  const { state, summary } = fresh(BEFORE_START, (s) => {
    s.settings.daysOff['2026-11-26'] = 'Thanksgiving';
  });
  const off = dayByDate(state, '2026-11-26');
  assert.equal(off.type, 'off');
  assert.equal(off.offLabel, 'Thanksgiving');
  assert.deepEqual(off.tasks, []);
  assert.equal(summary.qbankFinish, '2026-12-21');
  assert.equal(plannedUnused(state.plan.days), 3255);
  checkInvariants(state, summary, BEFORE_START);
});

test('feasibility: earliest exam date at the current pace', () => {
  const base = createState(SEED);
  const earliest = earliestExamDate(base, BEFORE_START);
  assert.equal(earliest, '2026-12-21');
  const at = generatePlan({ ...base, settings: { ...base.settings, examDate: earliest } }, BEFORE_START).summary;
  assert.equal(at.unscheduled, 0);
  const dayEarlier = generatePlan({ ...base, settings: { ...base.settings, examDate: addDays(earliest, -1) } }, BEFORE_START).summary;
  assert.ok(dayEarlier.unscheduled > 0 || dayEarlier.saUnplaced.length > 0);
});

test('an exam that is too close reports what does not fit', () => {
  const { state, summary } = fresh(BEFORE_START, (s) => {
    s.settings.examDate = '2026-11-20';
  });
  assert.ok(summary.unscheduled > 0);
  assert.equal(plannedUnused(state.plan.days) + summary.unscheduled, 3255);
  checkInvariants(state, summary, BEFORE_START);
});

test('frozen past: earlier days never change', () => {
  let { state } = fresh('2026-10-11');
  state = doDay(state, '2026-10-11');
  ({ state } = replan(state, '2026-10-12'));
  state = setBlockDone(state, '2026-10-12', 'b0', 25, NOW); // partial day
  ({ state } = replan(state, '2026-10-13'));
  const snapshot = structuredClone(state.plan.days.filter((d) => d.date < '2026-10-14'));

  // Skip ahead two days, then change nearly everything that shapes the plan.
  let later = replan(state, '2026-10-16').state;
  later = updateSetting(later, 'pace.weekday', 60, SEED.settings, 'pace', NOW);
  later = updateSetting(later, 'randomAfterSa1', false, SEED.settings, 'toggle', NOW);
  later = applyChange(later, { kind: 'exam', label: 'push', patch: { examDate: '2027-01-11', daysOff: { '2026-11-26': 'Thanksgiving' }, extras: { '2026-10-20': 20 } } }, NOW);
  later = setBlockDone(later, '2026-10-13', 'b0', 10, NOW); // late entry for a past day
  const result = replan(later, '2026-10-16');

  assert.deepEqual(result.state.plan.days.filter((d) => d.date < '2026-10-14'), snapshot);
  // The days skipped in between were frozen as they stood when last planned.
  assert.deepEqual(
    result.state.plan.days.filter((d) => d.date >= '2026-10-14' && d.date < '2026-10-16'),
    state.plan.days.filter((d) => d.date >= '2026-10-14' && d.date < '2026-10-16'),
  );
  checkInvariants(result.state, result.summary, '2026-10-16');
});

test('today stays fixed while it is being logged; the shortfall returns the next day', () => {
  let { state, summary } = fresh('2026-10-12');
  const todayBefore = structuredClone(dayByDate(state, '2026-10-12'));
  state = setBlockDone(state, '2026-10-12', 'b0', 25, NOW);
  state = toggleTask(state, '2026-10-12', 'fa', true, NOW);
  ({ state, summary } = replan(state, '2026-10-12'));
  assert.deepEqual(dayByDate(state, '2026-10-12'), todayBefore, 'ticking must not reshuffle today');
  assert.equal(plannedUnused(state.plan.days.filter((d) => d.date >= '2026-10-12')), 3255);

  ({ state, summary } = replan(state, '2026-10-13'));
  assert.equal(summary.remainingAtStart, 3255 - 25);
  assert.equal(plannedUnused(state.plan.days.filter((d) => d.date >= '2026-10-13')), 3230);
  // First Aid moves on because the chunk was ticked.
  assert.equal(faTask(dayByDate(state, '2026-10-13')).parts[0].from, faTask(todayBefore).parts.at(-1).to + 1);
  checkInvariants(state, summary, '2026-10-13');
});

test('an unticked First Aid chunk is planned again the next day', () => {
  let { state } = fresh('2026-10-12');
  const from = faTask(dayByDate(state, '2026-10-12')).parts[0].from;
  ({ state } = replan(state, '2026-10-13'));
  assert.equal(faTask(dayByDate(state, '2026-10-13')).parts[0].from, from);
});

test('self-assessment #1 keeps its Saturday after a small slip and moves a week after a big one', () => {
  // Miss one weekday (40 questions): still Nov 7.
  let { state } = fresh('2026-10-11');
  for (const date of range('2026-10-11', '2026-10-25')) {
    ({ state } = replan(state, date));
    if (date !== '2026-10-20') state = doDay(state, date);
  }
  let result = replan(state, '2026-10-26');
  assert.equal(result.summary.sa[0].date, '2026-11-07');
  checkInvariants(result.state, result.summary, '2026-10-26');

  // Miss a whole week: it moves to Nov 14, and all five still land on Saturdays.
  ({ state } = fresh('2026-10-11'));
  for (const date of range('2026-10-11', '2026-10-25')) {
    ({ state } = replan(state, date));
    if (date < '2026-10-12' || date > '2026-10-18') state = doDay(state, date);
  }
  result = replan(state, '2026-10-26');
  assert.deepEqual(
    result.summary.sa.slice(0, 5).map((s) => s.date),
    ['2026-11-14', '2026-11-21', '2026-11-28', '2026-12-05', '2026-12-12'],
  );
  assert.deepEqual(result.summary.saUnplaced, []);
  checkInvariants(result.state, result.summary, '2026-10-26');
});

test('a self-assessment that was not taken moves to the next slot; a taken one leaves the queue', () => {
  const atNov7 = workThrough('2026-11-06', '2026-11-07');
  assert.equal(dayByDate(atNov7, '2026-11-07').tasks.find((t) => t.kind === 'sa').assessment, 'nbme28');

  // Not taken: on Nov 8 it is queued for the next Saturday.
  let { state, summary } = replan(atNov7, '2026-11-08');
  assert.deepEqual(summary.sa[0], { id: 'nbme28', date: '2026-11-14', phase: 'working' });
  assert.equal(summary.sa.length, 10);
  assert.deepEqual(summary.saUnplaced, []);
  checkInvariants(state, summary, '2026-11-08');

  // Taken on its day: the next Saturday gets the next one.
  state = toggleTask(atNov7, '2026-11-07', 'sa', true, NOW);
  assert.equal(state.scores.nbme28.date, '2026-11-07');
  ({ state, summary } = replan(state, '2026-11-07'));
  assert.equal(dayByDate(state, '2026-11-07').type, 'sa', 'still shown today after ticking');
  ({ state, summary } = replan(state, '2026-11-08'));
  assert.deepEqual(summary.sa[0], { id: 'nbme29', date: '2026-11-14', phase: 'working' });
  assert.equal(summary.sa.length, 9);
  checkInvariants(state, summary, '2026-11-08');
});

test('dedicated self-assessments re-space when one is missed', () => {
  // The five working-phase ones are done; five are owed in dedicated.
  let state = createState(SEED);
  SEED.assessments.order.slice(0, 5).forEach((id, i) => {
    state = setScore(state, id, { date: addDays('2026-11-07', 7 * i), pct: 60 }, NOW);
  });
  let summary;
  ({ state, summary } = replan(state, '2026-12-14'));
  assert.deepEqual(summary.sa.map((s) => s.date), ['2026-12-14', '2026-12-17', '2026-12-20', '2026-12-23', '2026-12-26']);

  // Dec 14's is skipped. The five are squeezed into the days left, last one still two days before the exam.
  ({ state, summary } = replan(state, '2026-12-15'));
  assert.deepEqual(summary.sa.map((s) => s.date), ['2026-12-18', '2026-12-20', '2026-12-22', '2026-12-24', '2026-12-26']);
  assert.deepEqual(summary.sa.map((s) => s.id), SEED.assessments.order.slice(5));
  assert.deepEqual(summary.saUnplaced, []);
  checkInvariants(state, summary, '2026-12-15');

  // Taking them on schedule keeps the remaining dates where they were.
  ({ state, summary } = replan(state, '2026-12-18'));
  state = toggleTask(state, '2026-12-18', 'sa', true, NOW);
  ({ state, summary } = replan(state, '2026-12-19'));
  assert.deepEqual(summary.sa.map((s) => s.date), ['2026-12-20', '2026-12-22', '2026-12-24', '2026-12-26']);
});

test('first run after the start date still shows the days already gone', () => {
  const state = createState(SEED);
  const result = replan(state, '2026-10-14');
  assert.equal(result.state.plan.days.length, 79);
  assert.equal(result.state.plan.days[0].date, '2026-10-11');
  assert.equal(qbankBlocks(result.state.plan.days[1])[0].count, 40);
  // Nothing was logged, so everything is still to do from today.
  assert.equal(plannedUnused(result.state.plan.days.filter((d) => d.date >= '2026-10-14')), 3255);
  checkInvariants(result.state, result.summary, '2026-10-14');
});

test('rapid review follows weak areas and block scores', () => {
  let { state } = fresh('2026-10-11');
  // Score Cardiovascular badly and Endocrine well.
  for (const date of range('2026-10-11', '2026-10-16')) {
    ({ state } = replan(state, date));
    state = toggleTask(doDay(state, date), date, 'fa', true, NOW);
    for (const b of qbankBlocks(dayByDate(state, date))) {
      state = setBlockPct(state, date, b.id, b.systems.includes('cardiovascular') ? 35 : 90, NOW);
    }
  }
  const ranked = weakChapters(state);
  assert.equal(ranked[0], 'cardiovascular');
  assert.equal(ranked.at(-1), 'endocrine', 'the strong chapter comes last');
  assert.ok(ranked.indexOf('endocrine') > ranked.indexOf('gastrointestinal'), 'unscored chapters rank ahead of strong ones');

  // Weak areas picked on a self-assessment outrank block scores.
  state = setScore(state, 'nbme28', { date: '2026-10-16', pct: 58, weak: ['renal'] }, NOW);
  assert.deepEqual(weakChapters(state).slice(0, 2), ['renal', 'cardiovascular']);
  const plan = replan(state, '2026-10-17');
  const reviews = plan.state.plan.days.map(faTask).filter((t) => t?.mode === 'review');
  assert.deepEqual(reviews.flatMap((t) => t.chapters).slice(0, 2), ['renal', 'cardiovascular'], 'review slots start with the weakest');
  assert.ok(reviews.every((t) => t.chapters.length >= 1 && t.hours >= 1));
});

test('Anki reviews come first on every study day, and only on study days', () => {
  const { state } = fresh(BEFORE_START, (s) => {
    s.settings.daysOff['2026-11-26'] = 'Thanksgiving';
  });
  for (const day of state.plan.days) {
    const anki = day.tasks.filter((t) => t.kind === 'anki');
    if (['workday', 'weekend', 'sa', 'dedicated'].includes(day.type)) {
      assert.deepEqual(day.tasks[0], { id: 'anki', kind: 'anki', optional: true }, `${day.date}: Anki must be the first task`);
      assert.equal(anki.length, 1);
    } else assert.equal(anki.length, 0, `${day.date} (${day.type}) should have no Anki task`);
  }
  // Order on an ordinary day and on a self-assessment day.
  assert.deepEqual(dayByDate(state, '2026-10-12').tasks.map((t) => t.kind), ['anki', 'qbank', 'review', 'fa']);
  assert.deepEqual(dayByDate(state, '2026-11-07').tasks.map((t) => t.kind), ['anki', 'sa', 'sareview', 'fa']);
  assert.deepEqual(dayByDate(state, '2026-12-15').tasks.map((t) => t.kind), ['anki', 'qbank', 'qbank', 'qbank', 'review', 'fa']);

  // It can be switched off, and it has no effect on the questions.
  const off = fresh(BEFORE_START, (s) => {
    s.settings.anki = false;
  });
  assert.ok(off.state.plan.days.every((d) => d.tasks.every((t) => t.kind !== 'anki')));
  assert.equal(plannedUnused(off.state.plan.days), 3255);
  assert.equal(off.summary.qbankFinish, '2026-12-19');
});

test('reviewing the blocks comes right after them, before First Aid, and takes hours', () => {
  const { state } = fresh();
  for (const day of state.plan.days) {
    const kinds = day.tasks.map((t) => t.kind);
    const review = kinds.indexOf('review');
    if (!kinds.includes('qbank')) {
      assert.equal(review, -1, `${day.date}: nothing to review without blocks`);
      continue;
    }
    assert.equal(review, kinds.lastIndexOf('qbank') + 1, `${day.date}: review must follow the last block`);
    if (kinds.includes('fa')) assert.ok(review < kinds.indexOf('fa'), `${day.date}: review must come before First Aid`);
    assert.deepEqual(day.tasks[review], { id: 'rev', kind: 'review', hours: [2, 4] });
  }
  const custom = fresh(BEFORE_START, (s) => {
    s.settings.reviewHours = { from: 3, to: 5 };
  });
  assert.deepEqual(dayByDate(custom.state, '2026-10-12').tasks.find((t) => t.kind === 'review').hours, [3, 5]);
});

test('the planner never mutates its input', () => {
  const state = createState(SEED);
  const copy = structuredClone(state);
  generatePlan(state, BEFORE_START);
  earliestExamDate(state, BEFORE_START);
  assert.deepEqual(state, copy);
});
