// The planner's state and every change to it, as pure functions.
// Each function takes the current state and returns a new one; nothing here
// touches the DOM, storage or the clock (the caller passes `now`).

import { isDate } from './dates.js';
import { generatePlan, ledger, splitProportional } from './planner.js';
import { patchSettings } from './rebalance.js';

export const VERSION = 1;
const HISTORY_MAX = 100;

const clone = (x) => JSON.parse(JSON.stringify(x));
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const int = (v, lo, hi, fallback) => (Number.isFinite(+v) && v !== null && v !== '' ? clamp(Math.round(+v), lo, hi) : fallback);
const touch = (state, now) => ({ ...state, updatedAt: now });

export function createState(seed) {
  const s = clone(seed);
  const systems = s.qbank.systems.map(({ unused, ...rest }) => ({ ...rest, start: unused }));
  return {
    version: VERSION,
    updatedAt: 0, // 0 = never edited, so any synced copy is newer
    settings: normalizeSettings(s.settings, s.settings),
    qbank: {
      totals: s.qbank.totals,
      baselineUnused: sum(systems.map((x) => x.start)),
      systems,
      subjects: s.qbank.subjects,
    },
    firstAid: {
      order: s.firstAid.order,
      chapters: s.firstAid.chapters.map((c) => ({ ...c, readPages: 0, readSessions: 0 })),
    },
    assessments: s.assessments,
    log: {},
    scores: {},
    plan: { days: [] },
    history: [],
  };
}

/** Regenerates the plan from today on. Past days come back unchanged. */
export function replan(state, today) {
  const { days, summary } = generatePlan(state, today);
  return { state: { ...state, plan: { days } }, summary };
}

/** Keeps settings inside sane bounds whatever was typed or imported. */
export function normalizeSettings(input, defaults) {
  const d = defaults;
  const s = { ...d, ...input };
  const startDate = isDate(s.startDate) ? s.startDate : d.startDate;
  let examDate = isDate(s.examDate) ? s.examDate : d.examDate;
  if (examDate <= startDate) examDate = d.examDate > startDate ? d.examDate : startDate;
  const pace = { ...d.pace, ...s.pace };
  const caps = { ...d.caps, ...s.caps };
  const sa = { ...d.sa, ...s.sa };
  const fa = { ...d.fa, ...s.fa };
  const dateMap = (obj, value) =>
    Object.fromEntries(
      Object.entries(obj ?? {})
        .filter(([k]) => isDate(k))
        .map(([k, v]) => [k, value(v)])
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  return {
    startDate,
    examDate,
    dedicatedDays: int(s.dedicatedDays, 0, 60, d.dedicatedDays),
    pace: {
      weekday: int(pace.weekday, 0, 400, d.pace.weekday),
      weekend: int(pace.weekend, 0, 400, d.pace.weekend),
      weekendFrom: isDate(pace.weekendFrom) ? pace.weekendFrom : d.pace.weekendFrom,
      dedicated: int(pace.dedicated, 0, 400, d.pace.dedicated),
      blockMax: int(pace.blockMax, 1, 40, d.pace.blockMax),
    },
    caps: {
      weekday: int(caps.weekday, 0, 400, d.caps.weekday),
      weekend: int(caps.weekend, 0, 400, d.caps.weekend),
    },
    sa: {
      workingCount: int(sa.workingCount, 0, 50, d.sa.workingCount),
      startFraction: Number.isFinite(+sa.startFraction) ? clamp(+sa.startFraction, 0, 1) : d.sa.startFraction,
      spacing: int(sa.spacing, 1, 14, d.sa.spacing),
      lastGap: int(sa.lastGap, 1, 14, d.sa.lastGap),
    },
    fa: {
      pagesPerHour: int(fa.pagesPerHour, 1, 200, null),
      onSaDays: fa.onSaDays !== false,
    },
    randomAfterSa1: s.randomAfterSa1 !== false,
    anki: s.anki !== false,
    reviewMinutes: int(s.reviewMinutes, 0, 240, d.reviewMinutes),
    goalPct: int(s.goalPct, 1, 100, null),
    daysOff: dateMap(s.daysOff, (v) => String(v ?? '').slice(0, 60)),
    extras: dateMap(s.extras, (v) => int(v, 0, 400, 0)),
  };
}

// ---------- the daily log ----------

const findDay = (state, date) => state.plan.days.find((d) => d.date === date);
const findTask = (state, date, taskId) => findDay(state, date)?.tasks.find((t) => t.id === taskId);

function writeEntry(state, date, change) {
  const entry = { ...(state.log[date] ?? {}) };
  change(entry);
  for (const key of ['blocks', 'tasks']) if (entry[key] && !Object.keys(entry[key]).length) delete entry[key];
  for (const key of Object.keys(entry)) if (entry[key] === undefined || entry[key] === false) delete entry[key];
  const log = { ...state.log };
  if (Object.keys(entry).length) log[date] = entry;
  else delete log[date];
  return { ...state, log };
}

/** Records how many questions of a block were actually done. `null` clears the entry. */
export function setBlockDone(state, date, blockId, done, now) {
  const block = findTask(state, date, blockId);
  if (!block || block.kind !== 'qbank') return state;
  const n = done === null || done === '' || !Number.isFinite(+done) ? null : clamp(Math.round(+done), 0, block.count);
  const next = writeEntry(state, date, (entry) => {
    const blocks = { ...(entry.blocks ?? {}) };
    if (n === null) delete blocks[blockId];
    else {
      blocks[blockId] = {
        done: n,
        pct: blocks[blockId]?.pct ?? null,
        planned: block.count,
        mode: block.mode,
        source: block.source,
        // Kept with the entry so the pools can be rebuilt from the log alone.
        alloc: block.source === 'unused' ? splitProportional(block.alloc, n) : {},
      };
    }
    entry.blocks = blocks;
  });
  return touch(next, now);
}

export function setBlockPct(state, date, blockId, pct, now) {
  const existing = state.log[date]?.blocks?.[blockId];
  if (!existing) return state;
  const value = pct === null || pct === '' || !Number.isFinite(+pct) ? null : clamp(Math.round(+pct), 0, 100);
  const next = writeEntry(state, date, (entry) => {
    entry.blocks = { ...entry.blocks, [blockId]: { ...existing, pct: value } };
  });
  return touch(next, now);
}

const setTaskFlag = (state, date, taskId, on) =>
  writeEntry(state, date, (entry) => {
    const tasks = { ...(entry.tasks ?? {}) };
    if (on) tasks[taskId] = true;
    else delete tasks[taskId];
    entry.tasks = tasks;
  });

/** Ticks or unticks any task on a day. */
export function toggleTask(state, date, taskId, checked, now) {
  const task = findTask(state, date, taskId);
  if (!task) return state;
  if (task.kind === 'qbank') {
    const done = state.log[date]?.blocks?.[taskId]?.done;
    return setBlockDone(state, date, taskId, checked ? (done > 0 ? done : task.count) : null, now);
  }
  if (task.kind === 'sa') return checked ? setScore(state, task.assessment, { date }, now) : clearScore(state, task.assessment, now);
  if (task.kind === 'fa') {
    return touch(
      writeEntry(state, date, (entry) => {
        // Only chapter reading moves the First Aid position; rapid review does not.
        entry.fa = checked ? { done: true, parts: task.mode === 'review' ? [] : clone(task.parts ?? []) } : undefined;
      }),
      now,
    );
  }
  return touch(setTaskFlag(state, date, taskId, checked), now);
}

const plannedOn = (state, date, saId) => !!findDay(state, date)?.tasks.some((t) => t.kind === 'sa' && t.assessment === saId);

/** Records a self-assessment as taken. patch: { date, pct, weak }. A date is required. */
export function setScore(state, saId, patch, now) {
  const prev = state.scores[saId];
  const score = { ...prev, ...patch };
  if (!isDate(score.date)) return state;
  score.pct = score.pct === null || score.pct === undefined || score.pct === '' || !Number.isFinite(+score.pct) ? null : clamp(Math.round(+score.pct * 10) / 10, 0, 100);
  score.weak = Array.isArray(score.weak) ? [...new Set(score.weak)] : [];
  let next = { ...state, scores: { ...state.scores, [saId]: score } };
  if (prev?.date && prev.date !== score.date && plannedOn(state, prev.date, saId)) next = setTaskFlag(next, prev.date, 'sa', false);
  if (plannedOn(state, score.date, saId)) next = setTaskFlag(next, score.date, 'sa', true);
  return touch(next, now);
}

export function clearScore(state, saId, now) {
  const prev = state.scores[saId];
  if (!prev) return state;
  const scores = { ...state.scores };
  delete scores[saId];
  let next = { ...state, scores };
  if (prev.date && plannedOn(state, prev.date, saId)) next = setTaskFlag(next, prev.date, 'sa', false);
  return touch(next, now);
}

/**
 * How much of a day is done: blocks count by the share of questions answered.
 * An optional task (Anki) counts once it is ticked, and is left out while it is
 * not, so skipping it never keeps a day from being complete.
 */
export function dayProgress(day, entry) {
  let done = 0;
  let total = 0;
  for (const t of day.tasks) {
    let share;
    if (t.kind === 'qbank') share = Math.min(1, (entry?.blocks?.[t.id]?.done ?? 0) / t.count);
    else if (t.kind === 'fa') share = entry?.fa?.done ? 1 : 0;
    else share = entry?.tasks?.[t.id] ? 1 : 0;
    if (t.optional && share === 0) continue;
    total += 1;
    done += share;
  }
  return { total, done, fraction: total ? done / total : 0, complete: total > 0 && done >= total };
}

export const questionsDone = (entry) => sum(Object.values(entry?.blocks ?? {}).map((b) => b?.done ?? 0));

/** A day counts as missed when it had work, nothing at all was done, and it is over (or marked sick). */
export function isMissedDay(day, entry, today) {
  if (!day.tasks.length || dayProgress(day, entry).done > 0) return false;
  return day.date < today || !!entry?.sick;
}

// ---------- history, rebalancing and undo ----------

function snapshot(state) {
  const flags = {};
  for (const [date, entry] of Object.entries(state.log)) {
    if (entry.sick || entry.resolved) flags[date] = { sick: !!entry.sick, resolved: !!entry.resolved };
  }
  return clone({ examDate: state.settings.examDate, extras: state.settings.extras, daysOff: state.settings.daysOff, flags });
}

const pushHistory = (state, entry) => ({ ...state, history: [...state.history, entry].slice(-HISTORY_MAX) });

const setFlag = (state, date, flag, on) =>
  writeEntry(state, date, (entry) => {
    entry[flag] = on ? true : undefined;
  });

/** Adds a line to the change history without making it undoable. */
export function note(state, kind, label, now) {
  return pushHistory(state, { at: now, kind, label });
}

/**
 * Applies a plan-shaping change and records it so it can be undone.
 * change: { kind, label, patch: { examDate, extras, daysOff, removeDaysOff }, sick: date, resolve: [dates] }
 */
export function applyChange(state, change, now) {
  const before = snapshot(state);
  let next = { ...state, settings: patchSettings(state.settings, change.patch ?? {}) };
  if (change.sick) next = setFlag(next, change.sick, 'sick', true);
  for (const date of change.resolve ?? []) next = setFlag(next, date, 'resolved', true);
  return touch(pushHistory(next, { at: now, kind: change.kind, label: change.label, before }), now);
}

const lastUndoable = (state) => {
  for (let i = state.history.length - 1; i >= 0; i--) if (state.history[i].before && !state.history[i].undone) return i;
  return -1;
};

export const undoTarget = (state) => state.history[lastUndoable(state)] ?? null;

/** Reverts the most recent undoable change: exam date, extras, days off and sick/resolved marks. */
export function undoLast(state, now) {
  const i = lastUndoable(state);
  if (i < 0) return state;
  const { before } = state.history[i];
  const log = {};
  for (const date of new Set([...Object.keys(state.log), ...Object.keys(before.flags ?? {})])) {
    const { sick, resolved, ...rest } = state.log[date] ?? {};
    const flags = before.flags?.[date] ?? {};
    const restored = { ...rest, ...(flags.sick ? { sick: true } : {}), ...(flags.resolved ? { resolved: true } : {}) };
    if (Object.keys(restored).length) log[date] = restored;
  }
  const history = state.history.map((h, k) => (k === i ? { ...h, undone: true } : h));
  const settings = { ...state.settings, examDate: before.examDate, extras: clone(before.extras), daysOff: clone(before.daysOff) };
  return touch({ ...state, settings, log, history }, now);
}

// ---------- settings and data ----------

function setPath(obj, path, value) {
  const [head, ...rest] = path;
  return { ...obj, [head]: rest.length ? setPath(obj?.[head] ?? {}, rest, value) : value };
}

/** Changes one setting, e.g. updateSetting(state, 'pace.weekday', 45, defaults, 'Weekday pace 40 → 45', now). */
export function updateSetting(state, path, value, defaults, label, now) {
  const settings = normalizeSettings(setPath(state.settings, path.split('.'), value), defaults);
  if (JSON.stringify(settings) === JSON.stringify(state.settings)) return state;
  const next = { ...state, settings };
  return touch(label ? note(next, 'settings', label, now) : next, now);
}

/** Unused questions left per system right now (everything logged so far taken off). */
export function remainingBySystem(state) {
  const logged = ledger(state.log, null).q;
  return Object.fromEntries(state.qbank.systems.map((s) => [s.id, Math.max(0, s.start - (logged[s.id] ?? 0))]));
}

/**
 * Takes fresh counts from the qbank dashboard. counts: { systems: { id: unused }, subjects: { name: unused }, totals: {...} }.
 * The dashboard already includes everything logged so far, so each system is re-based against the log.
 */
export function updateCounts(state, counts, today, now) {
  const led = ledger(state.log, null);
  const before = sum(Object.values(remainingBySystem(state)));
  const systems = state.qbank.systems.map((s) => {
    const v = counts.systems?.[s.id];
    return Number.isFinite(+v) && v !== null && v !== '' ? { ...s, start: Math.max(0, Math.round(+v)) + (led.q[s.id] ?? 0) } : s;
  });
  const subjects = state.qbank.subjects.map((s) => {
    const v = counts.subjects?.[s.name];
    return Number.isFinite(+v) && v !== null && v !== '' ? { ...s, unused: Math.max(0, Math.round(+v)) } : s;
  });
  const totals = { ...state.qbank.totals };
  for (const [key, v] of Object.entries(counts.totals ?? {})) {
    if (key in totals && Number.isFinite(+v) && v !== null && v !== '') totals[key] = Math.max(0, Math.round(+v));
  }
  // The 40% mark is measured against the unused count at the start of the plan.
  const notStarted = led.qTotal === 0 || today < state.settings.startDate;
  const baselineUnused = notStarted ? sum(systems.map((s) => s.start)) : state.qbank.baselineUnused;
  const next = { ...state, qbank: { ...state.qbank, systems, subjects, totals, baselineUnused } };
  const after = sum(Object.values(remainingBySystem(next)));
  const fmtN = (n) => n.toLocaleString('en-US');
  const label = before === after ? 'Qbank counts updated' : `Qbank counts updated (${fmtN(before)} → ${fmtN(after)} unused)`;
  return touch(note(next, 'counts', label, now), now);
}

export function updateSystem(state, id, patch, now) {
  const systems = state.qbank.systems.map((s) => (s.id === id ? { ...s, ...patch } : s));
  return touch({ ...state, qbank: { ...state.qbank, systems } }, now);
}

/** First Aid position right now: pages read (or sessions done) per chapter, log included. */
export function firstAidRead(state) {
  const led = ledger(state.log, null);
  return Object.fromEntries(
    state.firstAid.chapters.map((c) => [
      c.id,
      { pages: Math.max(0, (c.readPages ?? 0) + (led.pages[c.id] ?? 0)), sessions: Math.max(0, (c.readSessions ?? 0) + (led.sessions[c.id] ?? 0)) },
    ]),
  );
}

/** patch may hold start, end, estHours, name, plus pagesRead / sessionsDone as totals "so far". */
export function updateChapter(state, id, patch, now) {
  const led = ledger(state.log, null);
  const page = (v) => (v === null || v === '' || v === undefined || !Number.isFinite(+v) ? null : clamp(Math.round(+v), 1, 5000));
  const chapters = state.firstAid.chapters.map((c) => {
    if (c.id !== id) return c;
    const next = { ...c };
    if ('start' in patch) next.start = page(patch.start);
    if ('end' in patch) next.end = page(patch.end);
    if ('estHours' in patch) next.estHours = int(patch.estHours, 0, 60, c.estHours);
    if ('name' in patch && String(patch.name).trim()) next.name = String(patch.name).trim().slice(0, 80);
    if ('pagesRead' in patch) next.readPages = int(patch.pagesRead, 0, 5000, 0) - (led.pages[id] ?? 0);
    if ('sessionsDone' in patch) next.readSessions = int(patch.sessionsDone, 0, 60, 0) - (led.sessions[id] ?? 0);
    return next;
  });
  return touch({ ...state, firstAid: { ...state.firstAid, chapters } }, now);
}

/** Moves an id up (-1) or down (+1) in firstAid.order or assessments.order. */
export function moveInOrder(state, list, id, dir, now) {
  const order = state[list].order.slice();
  const i = order.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return state;
  [order[i], order[j]] = [order[j], order[i]];
  return touch({ ...state, [list]: { ...state[list], order } }, now);
}

export function updateAssessment(state, id, patch, now) {
  const items = state.assessments.items.map((a) => {
    if (a.id !== id) return a;
    const next = { ...a };
    if ('name' in patch && String(patch.name).trim()) next.name = String(patch.name).trim().slice(0, 40);
    if ('questions' in patch) next.questions = int(patch.questions, 1, 1000, a.questions);
    if ('parts' in patch) next.parts = int(patch.parts, 1, 20, a.parts);
    if ('per' in patch) next.per = int(patch.per, 1, 400, a.per);
    return next;
  });
  return touch({ ...state, assessments: { ...state.assessments, items } }, now);
}
