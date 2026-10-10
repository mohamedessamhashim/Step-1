// Planning engine. Pure functions only: no DOM, no storage, no clock.
//
// generatePlan() turns settings + data + the daily log into one entry per day
// from the start date to the exam. Days already in the past are copied from the
// previously saved plan and never recomputed; everything from "today" on is
// rebuilt from what the log says is still left to do.

import { addDays, diffDays, dow, range } from './dates.js';

/** Fastest First Aid pace the planner will pick on its own. */
export const AUTO_PAGES_MAX = 30;

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj ?? {}, key);
const isWeekendDay = (d) => dow(d) === 0 || dow(d) === 6;

export function timeline(settings) {
  const start = settings.startDate;
  const exam = settings.examDate;
  const dedicatedDays = Math.max(0, settings.dedicatedDays ?? 0);
  const ded = addDays(exam, -dedicatedDays);
  const dedicatedStart = ded < start ? start : ded;
  const dayBefore = addDays(exam, -1);
  const restDay = dedicatedDays >= 1 && dayBefore >= dedicatedStart ? dayBefore : null;
  return { start, exam, dedicatedStart, restDay, totalDays: Math.max(0, diffDays(start, exam) + 1) };
}

/** The first day that is still open to replanning: today, or tomorrow once today is marked sick. */
export function firstOpenDate(input, today) {
  const start = input.settings.startDate;
  const first = today < start ? start : today;
  return first === today && input.log?.[today]?.sick ? addDays(today, 1) : first;
}

/** Page range per chapter. `pages` is null while a chapter has no usable range. */
export function chapterRanges(firstAid) {
  const starts = firstAid.chapters
    .map((c) => c.start)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const out = {};
  for (const c of firstAid.chapters) {
    const start = Number.isFinite(c.start) ? c.start : null;
    const ownEnd = start != null && Number.isFinite(c.end) && c.end >= start;
    let end = ownEnd ? c.end : null;
    if (start != null && !ownEnd) {
      const next = starts.find((s) => s > start);
      if (next != null) end = next - 1;
    }
    out[c.id] = { start, end, pages: start != null && end != null ? end - start + 1 : null, derivedEnd: !ownEnd && end != null };
  }
  return out;
}

function unionSize(spans) {
  const sorted = spans.slice().sort((a, b) => a[0] - b[0]);
  let total = 0;
  let reach = -Infinity;
  for (const [from, to] of sorted) {
    if (to <= reach) continue;
    total += to - Math.max(from, reach + 1) + 1;
    reach = to;
  }
  return total;
}

/**
 * Everything the log says was done before `before` (all of it when null):
 * unused questions per system, First Aid pages and time-based sessions per chapter.
 */
export function ledger(log, before = null) {
  const q = {};
  let qTotal = 0;
  const spans = {};
  const sessions = {};
  for (const date of Object.keys(log ?? {})) {
    if (before && date >= before) continue;
    const entry = log[date];
    if (!entry) continue;
    for (const b of Object.values(entry.blocks ?? {})) {
      if (!b || b.source !== 'unused' || !(b.done > 0)) continue;
      for (const [sys, n] of Object.entries(b.alloc ?? {})) {
        q[sys] = (q[sys] ?? 0) + n;
        qTotal += n;
      }
    }
    if (entry.fa?.done) {
      for (const p of entry.fa.parts ?? []) {
        if (p.from != null) (spans[p.chapterId] ??= []).push([p.from, p.to]);
        else sessions[p.chapterId] = (sessions[p.chapterId] ?? 0) + 1;
      }
    }
  }
  const pages = {};
  for (const [id, list] of Object.entries(spans)) pages[id] = unionSize(list);
  return { q, qTotal, pages, sessions };
}

/**
 * Takes up to n from the pools named in ids, in proportion to what each has
 * left (largest-remainder rounding, integer maths). Mutates `pool`.
 */
function take(pool, ids, n) {
  const live = ids.filter((id) => pool[id] > 0);
  const total = sum(live.map((id) => pool[id]));
  const want = Math.min(n, total);
  const alloc = {};
  if (want <= 0) return { alloc, count: 0 };
  let given = 0;
  const parts = live.map((id, i) => {
    const scaled = want * pool[id];
    const base = Math.floor(scaled / total);
    given += base;
    return { id, base, rem: scaled % total, i };
  });
  parts
    .slice()
    .sort((a, b) => b.rem - a.rem || a.i - b.i)
    .slice(0, want - given)
    .forEach((p) => {
      p.base += 1;
    });
  for (const p of parts) {
    if (p.base > 0) {
      alloc[p.id] = p.base;
      pool[p.id] -= p.base;
    }
  }
  return { alloc, count: want };
}

/** Scales a block's per-system split down to n questions. */
export function splitProportional(counts, n) {
  return take({ ...counts }, Object.keys(counts ?? {}), Math.max(0, Math.round(n))).alloc;
}

/** Chapters ranked weakest first, from self-assessment weak areas and per-system block scores. */
export function weakChapters(input, before = null) {
  const { firstAid, qbank } = input;
  const chapterOf = Object.fromEntries(qbank.systems.map((s) => [s.id, s.chapter]));
  const mapped = new Set(qbank.systems.map((s) => s.chapter).filter(Boolean));

  // The three most recent self-assessments count 3, 2 and 1.
  const flags = {};
  Object.values(input.scores ?? {})
    .filter((s) => s && Array.isArray(s.weak) && (!before || (s.date ?? '') < before))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
    .slice(0, 3)
    .forEach((s, i) => {
      for (const id of s.weak) flags[id] = (flags[id] ?? 0) + (3 - i);
    });

  const acc = {};
  for (const [date, entry] of Object.entries(input.log ?? {})) {
    if (before && date >= before) continue;
    for (const b of Object.values(entry?.blocks ?? {})) {
      if (!b || b.mode !== 'systems' || b.pct == null || !(b.done > 0)) continue;
      for (const [sys, n] of Object.entries(b.alloc ?? {})) {
        const ch = chapterOf[sys];
        if (!ch) continue;
        const a = (acc[ch] ??= { n: 0, correct: 0 });
        a.n += n;
        a.correct += (n * b.pct) / 100;
      }
    }
  }
  // A chapter with too few scored questions counts as average: after the weak ones, before the strong ones.
  const scored = Object.values(acc).filter((a) => a.n >= 20);
  const average = scored.length ? sum(scored.map((a) => a.correct)) / sum(scored.map((a) => a.n)) : 0.5;
  const pct = (id) => (acc[id] && acc[id].n >= 20 ? acc[id].correct / acc[id].n : average);

  return firstAid.order
    .filter((id) => mapped.has(id))
    .map((id, i) => ({ id, i, flag: flags[id] ?? 0, pct: pct(id) }))
    .sort((a, b) => b.flag - a.flag || a.pct - b.pct || a.i - b.i)
    .map((x) => x.id);
}

/** What is left to read per chapter, in walk order. */
function firstAidWork(firstAid, qbank, led) {
  const ranges = chapterRanges(firstAid);
  const byId = Object.fromEntries(firstAid.chapters.map((c) => [c.id, c]));
  const mapped = new Set(qbank.systems.map((s) => s.chapter).filter(Boolean));
  const items = [];
  for (const id of firstAid.order) {
    const ch = byId[id];
    if (!ch) continue;
    const r = ranges[id];
    if (r.pages != null) {
      // readPages is a manual correction on top of the ticked chunks; it can be negative.
      const read = Math.min(r.pages, Math.max(0, (ch.readPages ?? 0) + (led.pages[id] ?? 0)));
      if (r.pages - read > 0) items.push({ id, kind: 'pages', from: r.start + read, to: r.end, left: r.pages - read, hasSystems: mapped.has(id) });
    } else {
      const total = Math.max(0, Math.round(ch.estHours ?? 1));
      const done = Math.min(total, Math.max(0, (ch.readSessions ?? 0) + (led.sessions[id] ?? 0)));
      if (total - done > 0) items.push({ id, kind: 'time', left: total - done, total, hasSystems: mapped.has(id) });
    }
  }
  return items;
}

/** Cuts the remaining reading into one-hour chunks at p pages per hour. */
function firstAidChunks(items, p) {
  const chunks = [];
  let carry = null; // a tiny chapter with no questions of its own, read with the next one
  const flush = () => {
    if (!carry) return;
    chunks.push({ mode: 'read', chapterId: carry.id, parts: [{ chapterId: carry.id, from: carry.from, to: carry.to }], pages: carry.left });
    carry = null;
  };
  items.forEach((it, i) => {
    if (it.kind === 'time') {
      flush();
      for (let k = 0; k < it.left; k++) {
        chunks.push({ mode: 'time', chapterId: it.id, parts: [{ chapterId: it.id }], session: it.total - it.left + k + 1, of: it.total });
      }
      return;
    }
    const next = items[i + 1];
    if (!carry && !it.hasSystems && it.left <= p / 2 && next && next.kind === 'pages') {
      carry = it;
      return;
    }
    const segments = carry ? [carry, it] : [it];
    carry = null;
    const total = sum(segments.map((s) => s.left));
    const n = Math.ceil(total / p);
    let seg = 0;
    let pos = segments[0].from;
    for (let k = 0; k < n; k++) {
      let size = Math.floor(total / n) + (k < total % n ? 1 : 0);
      const parts = [];
      while (size > 0) {
        const s = segments[seg];
        const takeN = Math.min(size, s.to - pos + 1);
        parts.push({ chapterId: s.id, from: pos, to: pos + takeN - 1 });
        size -= takeN;
        pos += takeN;
        if (pos > s.to && seg < segments.length - 1) {
          seg += 1;
          pos = segments[seg].from;
        }
      }
      chunks.push({ mode: 'read', chapterId: it.id, parts, pages: sum(parts.map((x) => x.to - x.from + 1)) });
    }
  });
  flush();
  return chunks;
}

/** Picks the pace: the override if set, else the slowest that still fits the days available. */
function paceFirstAid(items, daysAvailable, override) {
  const paged = items.some((it) => it.kind === 'pages');
  if (Number.isFinite(override) && override > 0) {
    return { pagesPerHour: paged ? override : null, auto: false, chunks: firstAidChunks(items, override) };
  }
  if (!paged) return { pagesPerHour: null, auto: true, chunks: firstAidChunks(items, 1) };
  for (let p = 1; p <= AUTO_PAGES_MAX; p++) {
    const chunks = firstAidChunks(items, p);
    if (chunks.length <= daysAvailable) return { pagesPerHour: p, auto: true, chunks };
  }
  return { pagesPerHour: AUTO_PAGES_MAX, auto: true, chunks: firstAidChunks(items, AUTO_PAGES_MAX) };
}

/** Dedicated self-assessment dates: the last one `lastGap` days before the exam, the others every `spacing` days back. */
function placeDedicated({ count, from, tl, settings, isOff }) {
  if (count <= 0 || tl.totalDays === 0) return [];
  let last = addDays(tl.exam, -Math.max(1, settings.sa.lastGap));
  if (last === tl.restDay) last = addDays(last, -1);
  if (last < from) return [];
  let spacing = Math.max(1, settings.sa.spacing);
  while (spacing > 1 && (count - 1) * spacing > diffDays(from, last)) spacing -= 1;
  const used = new Set();
  const free = (d) => d >= from && d <= last && !isOff(d) && !used.has(d);
  let cursor = last;
  for (let i = 0; i < count; i++) {
    let d = cursor;
    while (d >= from && !free(d)) d = addDays(d, -1);
    if (d < from) {
      // Nothing earlier: take the latest free day anywhere in the window.
      d = last;
      while (d >= from && !free(d)) d = addDays(d, -1);
      if (d < from) break;
    }
    used.add(d);
    cursor = addDays(d, -spacing);
  }
  return [...used].sort();
}

export function generatePlan(input, today) {
  const { settings, qbank, firstAid, assessments } = input;
  const log = input.log ?? {};
  const scores = input.scores ?? {};
  const tl = timeline(settings);
  const dates = tl.totalDays > 0 ? range(tl.start, tl.exam) : [];
  const firstOpen = firstOpenDate(input, today);

  // 1. The past is frozen: reuse the saved entries untouched.
  const saved = new Map((input.plan?.days ?? []).map((d) => [d.date, d]));
  let asPlannedAtStart = null;
  const frozen = dates
    .filter((d) => d < firstOpen)
    .map((date) => {
      if (saved.has(date)) return saved.get(date);
      // No record of this day (first run after the start date): use what the plan would have said.
      asPlannedAtStart ??= new Map(generatePlan({ ...input, log: {}, scores: {}, plan: null }, tl.start).days.map((d) => [d.date, d]));
      return asPlannedAtStart.get(date);
    });

  const open = dates.filter((d) => d >= firstOpen);
  const led = ledger(log, firstOpen);
  const pool = {};
  for (const s of qbank.systems) pool[s.id] = Math.max(0, Math.round(s.start ?? 0) - (led.q[s.id] ?? 0));
  const remainingAtStart = sum(Object.values(pool));
  let remaining = remainingAtStart;
  const baseline = qbank.baselineUnused > 0 ? qbank.baselineUnused : remainingAtStart + led.qTotal;

  // Self-assessments still to take, in order.
  const queue = assessments.order.filter((id) => !(scores[id] && (scores[id].date ?? '') < firstOpen));
  const takenCount = assessments.order.length - queue.length;
  const workingQuota = Math.min(queue.length, Math.max(0, settings.sa.workingCount - takenCount));

  const isOff = (d) => has(settings.daysOff, d);
  const phaseOf = (d) => (d === tl.exam ? 'exam' : d >= tl.dedicatedStart ? 'dedicated' : 'working');
  const capacityOf = (d, phase) => {
    if (phase === 'dedicated') return { capacity: settings.pace.dedicated, maxCap: settings.pace.dedicated };
    const weekend = isWeekendDay(d);
    const base = weekend && d >= settings.pace.weekendFrom ? settings.pace.weekend : settings.pace.weekday;
    const maxCap = Math.max(base, weekend ? settings.caps.weekend : settings.caps.weekday);
    return { capacity: Math.min(maxCap, base + Math.max(0, settings.extras?.[d] ?? 0)), maxCap };
  };

  // 2. Day types, capacity and self-assessment dates, in one forward pass.
  let queuePos = 0;
  let placedWorking = 0;
  let started = takenCount > 0;
  let dedicatedSa = null; // date → assessment id
  const threshold = settings.sa.startFraction * baseline;

  const saturdayIsSa = (date) => {
    const left = workingQuota - placedWorking;
    if (left <= 0) return false;
    if (started) return true;
    const done = baseline - remaining;
    if (done >= threshold) return true;
    let saturdays = 0;
    for (let x = date; x < tl.dedicatedStart; x = addDays(x, 7)) if (!isOff(x)) saturdays += 1;
    if (saturdays <= left) return true;
    // Not there yet. Start anyway if next Saturday would be further past the mark than this one is short of it.
    let projected = done;
    let pot = remaining;
    for (let i = 0, x = date; i < 7 && x < tl.dedicatedStart; i++, x = addDays(x, 1)) {
      const c = isOff(x) ? 0 : Math.min(capacityOf(x, 'working').capacity, pot);
      projected += c;
      pot -= c;
    }
    return projected >= threshold && threshold - done < projected - threshold;
  };

  const rows = [];
  for (const date of open) {
    const phase = phaseOf(date);
    if (phase !== 'working' && dedicatedSa === null) {
      const slots = placeDedicated({ count: queue.length - queuePos, from: date, tl, settings, isOff });
      dedicatedSa = new Map(slots.map((d, i) => [d, queue[queuePos + i]]));
    }
    const row = { date, phase, type: null, sa: null, capacity: 0, maxCap: 0 };
    if (phase === 'exam') row.type = 'exam';
    else if (date === tl.restDay) row.type = 'rest';
    else if (isOff(date)) row.type = 'off';
    else if (phase === 'dedicated' && dedicatedSa.has(date)) {
      row.type = 'sa';
      row.sa = dedicatedSa.get(date);
    } else if (phase === 'working' && dow(date) === 6 && saturdayIsSa(date)) {
      row.type = 'sa';
      row.sa = queue[queuePos++];
      placedWorking += 1;
      started = true;
    } else {
      row.type = phase === 'dedicated' ? 'dedicated' : isWeekendDay(date) ? 'weekend' : 'workday';
      Object.assign(row, capacityOf(date, phase));
    }
    row.unused = Math.min(row.capacity, remaining);
    remaining -= row.unused;
    // Once nothing is unused, the day's questions become a review of incorrects.
    row.incorrect = row.capacity > 0 && remaining === 0 ? row.capacity - row.unused : 0;
    rows.push(row);
  }
  const unscheduled = remaining;
  const saUnplaced = queue.slice(queuePos + (dedicatedSa?.size ?? 0));

  // 3. First Aid: the chapter walk in the working phase, rapid review afterwards.
  const readsFirstAid = (r) => r.type === 'workday' || r.type === 'weekend' || (r.type === 'sa' && settings.fa.onSaDays);
  const faDays = rows.filter((r) => r.phase === 'working' && readsFirstAid(r));
  const fa = paceFirstAid(firstAidWork(firstAid, qbank, led), faDays.length, settings.fa.pagesPerHour);
  const weak = weakChapters(input, firstOpen);
  let weakPos = 0;
  const nextWeak = (n) => {
    const out = [];
    for (let i = 0; i < Math.min(n, weak.length); i++) out.push(weak[weakPos++ % weak.length]);
    return out;
  };
  faDays.forEach((r, i) => {
    r.fa = i < fa.chunks.length ? fa.chunks[i] : { mode: 'review', chapters: nextWeak(1), hours: 1 };
  });
  for (const r of rows) {
    if (r.phase !== 'dedicated') continue;
    if (r.type === 'dedicated') r.fa = { mode: 'review', chapters: nextWeak(2), hours: 2 };
    else if (r.type === 'sa' && settings.fa.onSaDays) r.fa = { mode: 'review', chapters: nextWeak(1), hours: 1 };
  }

  // 4. Question blocks. Every unused question is handed out exactly once.
  const blockMax = Math.max(1, settings.pace.blockMax);
  const allIds = qbank.systems.map((s) => s.id);
  const systemsOf = {};
  for (const s of qbank.systems) if (s.chapter) (systemsOf[s.chapter] ??= []).push(s.id);
  const chapterById = Object.fromEntries(firstAid.chapters.map((c) => [c.id, c]));
  const generalOrder = firstAid.order.filter((id) => chapterById[id]?.section === 'general');
  let saSeen = takenCount;

  const days = rows.map((r) => {
    const blocks = [];
    let need = r.unused;
    const cut = (ids, n, mode, extra) => {
      while (n > 0) {
        const { alloc, count } = take(pool, ids, Math.min(blockMax, n));
        if (count === 0) return;
        blocks.push({ kind: 'qbank', source: 'unused', mode, systems: Object.keys(alloc), count, alloc, ...extra });
        n -= count;
        need -= count;
      }
    };
    const random = r.phase === 'dedicated' || (settings.randomAfterSa1 && saSeen >= 1);
    if (need > 0 && !random) {
      const chapterId = r.fa && r.fa.mode !== 'review' ? r.fa.chapterId : null;
      const groups = [];
      if (chapterId && systemsOf[chapterId]) groups.push({ ids: systemsOf[chapterId] });
      // That chapter's pool is finished: General Principles, one chapter at a time.
      for (const id of generalOrder) if (id !== chapterId && systemsOf[id]) groups.push({ ids: systemsOf[id], fallback: true });
      for (const g of groups) {
        const available = sum(g.ids.map((id) => pool[id]));
        if (need > 0 && available > 0) cut(g.ids, Math.min(need, available), 'systems', g.fallback ? { fallback: true } : {});
      }
    }
    if (need > 0) cut(allIds, need, 'random', {});
    for (let n = r.incorrect; n > 0; n -= blockMax) {
      blocks.push({ kind: 'qbank', source: 'incorrect', mode: 'incorrect', systems: [], count: Math.min(blockMax, n) });
    }

    const tasks = [];
    // Anki comes first every study day. It is optional: skipping it never counts against the day.
    const studyDay = r.type === 'workday' || r.type === 'weekend' || r.type === 'sa' || r.type === 'dedicated';
    if (studyDay && settings.anki !== false) tasks.push({ id: 'anki', kind: 'anki', optional: true });
    if (r.type === 'sa') {
      tasks.push({ id: 'sa', kind: 'sa', assessment: r.sa }, { id: 'sarev', kind: 'sareview', assessment: r.sa });
      saSeen += 1;
    }
    blocks.forEach((b, i) => tasks.push({ id: `b${i}`, ...b }));
    if (r.fa) tasks.push({ id: 'fa', kind: 'fa', ...r.fa });
    if (blocks.length) tasks.push({ id: 'rev', kind: 'review', minutes: settings.reviewMinutes });

    const day = { date: r.date, type: r.type, phase: r.phase, capacity: r.capacity, maxCap: r.maxCap, tasks };
    if (r.type === 'off') day.offLabel = settings.daysOff[r.date] || '';
    return day;
  });

  // 5. Summary.
  const withUnused = rows.filter((r) => r.unused > 0);
  const qbankFinish = withUnused.length ? withUnused[withUnused.length - 1].date : null;
  const leftAtDedicated = unscheduled + sum(rows.filter((r) => r.phase === 'dedicated').map((r) => r.unused));
  const faFits = fa.chunks.length <= faDays.length;
  const summary = {
    today,
    firstOpen,
    start: tl.start,
    exam: tl.exam,
    dedicatedStart: tl.dedicatedStart,
    restDay: tl.restDay,
    totalDays: tl.totalDays,
    remainingAtStart,
    scheduled: remainingAtStart - unscheduled,
    unscheduled,
    qbankFinish,
    finishInDedicated: unscheduled > 0 || (qbankFinish != null && qbankFinish >= tl.dedicatedStart),
    leftAtDedicated,
    pagesPerHour: fa.pagesPerHour,
    pagesAuto: fa.auto,
    faFits,
    faOverflow: Math.max(0, fa.chunks.length - faDays.length),
    faFinish: faFits && fa.chunks.length ? faDays[fa.chunks.length - 1].date : null,
    sa: rows.filter((r) => r.sa).map((r) => ({ id: r.sa, date: r.date, phase: r.phase })),
    saUnplaced,
  };
  return { days: [...frozen, ...days], summary };
}

/** Earliest exam date on which every unused question and every self-assessment still fits. */
export function earliestExamDate(input, today, maxDays = 400) {
  const from = addDays(today < input.settings.startDate ? input.settings.startDate : today, 1);
  for (let i = 0; i <= maxDays; i++) {
    const examDate = addDays(from, i);
    const { summary } = generatePlan({ ...input, settings: { ...input.settings, examDate } }, today);
    if (summary.unscheduled === 0 && summary.saUnplaced.length === 0) return examDate;
  }
  return null;
}

/** Planned question counts for one plan day. */
export function dayTotals(day) {
  let unused = 0;
  let incorrect = 0;
  for (const t of day.tasks) {
    if (t.kind !== 'qbank') continue;
    if (t.source === 'unused') unused += t.count;
    else incorrect += t.count;
  }
  return { unused, incorrect, total: unused + incorrect };
}

/** Totals for the progress panel: per system, overall, and per day. */
export function progress(input) {
  const led = ledger(input.log, null);
  const systems = input.qbank.systems.map((s) => {
    const start = Math.max(0, Math.round(s.start ?? 0));
    const done = Math.min(start, led.q[s.id] ?? 0);
    return { id: s.id, name: s.name, short: s.short, chapter: s.chapter, start, done, left: start - done };
  });
  const byDate = {};
  let answered = 0;
  let scored = 0;
  let correct = 0;
  for (const [date, entry] of Object.entries(input.log ?? {})) {
    let q = 0;
    let n = 0;
    let c = 0;
    for (const b of Object.values(entry?.blocks ?? {})) {
      if (!b || !(b.done > 0)) continue;
      q += b.done;
      if (b.pct != null) {
        n += b.done;
        c += (b.done * b.pct) / 100;
      }
    }
    if (q > 0) byDate[date] = { questions: q, pct: n ? (c / n) * 100 : null };
    answered += q;
    scored += n;
    correct += c;
  }
  const left = sum(systems.map((s) => s.left));
  const all = input.qbank.totals?.all ?? 0;
  return {
    systems,
    byDate,
    done: sum(systems.map((s) => s.done)),
    answered,
    left,
    pct: scored ? (correct / scored) * 100 : null,
    usedPct: all > 0 ? Math.min(100, Math.max(0, ((all - left) / all) * 100)) : null,
  };
}
