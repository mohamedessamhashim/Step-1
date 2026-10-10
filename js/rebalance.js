// Rebalancing after missed days, sick days and days off. Pure functions.
//
// Each option is a small patch to the settings (extra questions on some dates,
// or a later exam date). The preview is simply the plan regenerated with that
// patch, so what you see before applying is exactly what you get.

import { addDays, diffDays, dow } from './dates.js';
import { dayTotals, firstOpenDate, generatePlan } from './planner.js';

/** Extra questions are handed out in multiples of this. */
export const STEP = 5;
const MAX_PUSH = 90;

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/** Applies a patch ({ examDate, extras, daysOff, removeDaysOff }) to settings. Extras add up. */
export function patchSettings(settings, patch = {}) {
  const next = { ...settings };
  if (patch.examDate) next.examDate = patch.examDate;
  if (patch.extras) {
    next.extras = { ...settings.extras };
    for (const [date, n] of Object.entries(patch.extras)) next.extras[date] = (next.extras[date] ?? 0) + n;
  }
  if (patch.daysOff || patch.removeDaysOff) {
    next.daysOff = { ...settings.daysOff, ...patch.daysOff };
    for (const date of patch.removeDaysOff ?? []) delete next.daysOff[date];
  }
  return next;
}

const withPatch = (input, patch) => ({ ...input, settings: patchSettings(input.settings, patch) });

/** Past days whose planned unused questions were not all done, and that have not been dealt with yet. */
export function missedDays(input, today) {
  const cut = firstOpenDate(input, today);
  const out = [];
  for (const day of input.plan?.days ?? []) {
    if (day.date >= cut) break;
    const entry = input.log?.[day.date];
    if (entry?.resolved) continue;
    let planned = 0;
    let done = 0;
    for (const t of day.tasks) {
      if (t.kind !== 'qbank' || t.source !== 'unused') continue;
      planned += t.count;
      done += Math.min(t.count, entry?.blocks?.[t.id]?.done ?? 0);
    }
    const saTask = day.tasks.find((t) => t.kind === 'sa');
    const sa = saTask && !input.scores?.[saTask.assessment] ? saTask.assessment : null;
    if (planned > done || sa) out.push({ date: day.date, planned, done, shortfall: planned - done, sa, sick: !!entry?.sick });
  }
  return out;
}

/** Questions a set of future dates would have carried, used when they are marked off. */
export function displacedBy(plan, dates) {
  const wanted = new Set(dates);
  return sum(plan.days.filter((d) => wanted.has(d.date)).map((d) => dayTotals(d).unused));
}

function previewOf(current, next, input, patch) {
  const from = next.summary.firstOpen;
  const was = new Map(current.days.map((d) => [d.date, dayTotals(d).total]));
  const loads = next.days
    .filter((d) => d.date >= from)
    .map((d) => {
      const load = dayTotals(d).total;
      return { date: d.date, load, was: was.get(d.date) ?? 0, type: d.type, phase: d.phase };
    });
  const examDate = patch.examDate ?? input.settings.examDate;
  return {
    examDate,
    examShift: diffDays(input.settings.examDate, examDate),
    dedicatedStart: next.summary.dedicatedStart,
    qbankFinish: next.summary.qbankFinish,
    finishInDedicated: next.summary.finishInDedicated,
    leftAtDedicated: next.summary.leftAtDedicated,
    unscheduled: next.summary.unscheduled,
    pagesPerHour: next.summary.pagesPerHour,
    peak: loads.length ? Math.max(...loads.map((l) => l.load)) : 0,
    changedDays: loads.filter((l) => l.load !== l.was).length,
    loads,
  };
}

/** Smallest push that brings the questions carried into dedicated back to where they were before the miss. */
function defaultPush(input, today, missed, current) {
  const target = Math.max(0, current.summary.leftAtDedicated - missed);
  let firstFeasible = null;
  for (let n = 1; n <= MAX_PUSH; n++) {
    const { summary } = generatePlan(withPatch(input, { examDate: addDays(input.settings.examDate, n) }), today);
    if (summary.unscheduled > 0) continue;
    firstFeasible ??= n;
    if (summary.leftAtDedicated <= target) return n;
  }
  return firstFeasible ?? 1;
}

/**
 * The three options plus "keep as is", each with its patch, regenerated plan and preview.
 * `missed` is the number of questions to place. An option is null when it has nowhere to put them.
 */
export function rebalanceOptions(input, today, missed, { pushDays = null } = {}) {
  const current = generatePlan(input, today);
  const build = (kind, patch, extra = {}) => {
    const plan = generatePlan(withPatch(input, patch), today);
    return { kind, patch, plan, preview: previewOf(current, plan, input, patch), ...extra };
  };
  // Working-phase question days that still have room under their cap.
  const room = current.days.filter((d) => d.date >= current.summary.firstOpen && d.phase === 'working' && d.capacity > 0 && d.maxCap > d.capacity);

  const fill = (days, each) => {
    const extras = {};
    let left = missed;
    for (const d of days) {
      if (left <= 0) break;
      const add = Math.min(each ?? Infinity, d.maxCap - d.capacity, left);
      if (add > 0) {
        extras[d.date] = add;
        left -= add;
      }
    }
    return { extras, uncovered: left };
  };

  let spread = null;
  if (missed > 0 && room.length) {
    const each = Math.max(STEP, Math.ceil(missed / room.length / STEP) * STEP);
    const { extras, uncovered } = fill(room, each);
    spread = build('spread', { extras }, { each, uncovered });
  }

  let weekends = null;
  const weekendRoom = room.filter((d) => dow(d.date) === 0 || dow(d.date) === 6);
  if (missed > 0 && weekendRoom.length) {
    const { extras, uncovered } = fill(weekendRoom, null);
    weekends = build('weekends', { extras }, { uncovered });
  }

  const days = Math.max(1, Math.min(MAX_PUSH, Math.round(pushDays ?? defaultPush(input, today, missed, current))));
  const push = build('push', { examDate: addDays(input.settings.examDate, days) }, { days });

  const keep = { kind: 'keep', patch: {}, plan: current, preview: previewOf(current, current, input, {}) };
  return { missed, current, spread, push, weekends, keep };
}

/** Preview for a plain settings patch, such as a new exam date picked in the calendar. */
export function previewPatch(input, today, patch) {
  const current = generatePlan(input, today);
  const plan = generatePlan(withPatch(input, patch), today);
  return { current, plan, preview: previewOf(current, plan, input, patch) };
}
