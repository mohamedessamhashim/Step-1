// Saving and loading. Everything lives in localStorage on this device; the
// functions take the storage object as an argument so they can be tested.

import { isDate } from './dates.js';
import { createState, normalizeSettings, VERSION } from './model.js';

export const KEYS = {
  state: 'step1.state',
  backup: 'step1.backup', // the copy that lost the last sync or import, kept just in case
  corrupt: 'step1.corrupt',
  theme: 'step1.theme', // per device, never synced
  lock: 'step1.lock', // per device, never synced
  sync: 'step1.sync', // per device: GitHub token and gist id. Never exported.
  tab: 'step1.tab',
};

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const num = (v, fallback = 0) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : fallback);
const str = (v, fallback = '', max = 120) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : fallback);
const numOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(+v) ? null : +v);

function cleanLog(raw) {
  const log = {};
  for (const [date, e] of Object.entries(isObject(raw) ? raw : {})) {
    if (!isDate(date) || !isObject(e)) continue;
    const entry = {};
    const blocks = {};
    for (const [id, b] of Object.entries(isObject(e.blocks) ? e.blocks : {})) {
      if (!isObject(b)) continue;
      const alloc = {};
      for (const [sys, n] of Object.entries(isObject(b.alloc) ? b.alloc : {})) if (num(n) > 0) alloc[sys] = Math.round(num(n));
      blocks[id] = {
        done: Math.max(0, Math.round(num(b.done))),
        pct: numOrNull(b.pct),
        planned: Math.max(0, Math.round(num(b.planned))),
        mode: str(b.mode, 'systems', 20),
        source: b.source === 'incorrect' ? 'incorrect' : 'unused',
        alloc,
      };
    }
    if (Object.keys(blocks).length) entry.blocks = blocks;
    if (isObject(e.fa) && e.fa.done) {
      entry.fa = {
        done: true,
        parts: (Array.isArray(e.fa.parts) ? e.fa.parts : [])
          .filter((p) => isObject(p) && typeof p.chapterId === 'string')
          .map((p) => (numOrNull(p.from) === null ? { chapterId: p.chapterId } : { chapterId: p.chapterId, from: num(p.from), to: num(p.to) })),
      };
    }
    const tasks = {};
    for (const [id, on] of Object.entries(isObject(e.tasks) ? e.tasks : {})) if (on) tasks[id] = true;
    if (Object.keys(tasks).length) entry.tasks = tasks;
    if (e.sick) entry.sick = true;
    if (e.resolved) entry.resolved = true;
    if (Object.keys(entry).length) log[date] = entry;
  }
  return log;
}

/**
 * Builds a complete, valid state from whatever was stored or imported, filling
 * anything missing from the seed. Throws if it is not a planner state at all.
 */
export function migrate(raw, seed) {
  if (!isObject(raw) || !isObject(raw.settings) || !isObject(raw.qbank)) throw new Error('This is not a Step 1 planner file.');
  const base = createState(seed);

  const systems = (Array.isArray(raw.qbank.systems) ? raw.qbank.systems : [])
    .filter((s) => isObject(s) && typeof s.id === 'string')
    .map((s) => ({
      id: s.id,
      name: str(s.name, s.id),
      short: str(s.short, str(s.name, s.id), 40),
      start: Math.max(0, Math.round(num(s.start))),
      chapter: typeof s.chapter === 'string' && s.chapter ? s.chapter : null,
    }));
  const subjects = (Array.isArray(raw.qbank.subjects) ? raw.qbank.subjects : [])
    .filter((s) => isObject(s) && typeof s.name === 'string')
    .map((s) => ({ name: str(s.name, 'Subject'), unused: Math.max(0, Math.round(num(s.unused))) }));
  const totals = { ...base.qbank.totals };
  for (const key of Object.keys(totals)) totals[key] = Math.max(0, Math.round(num(raw.qbank.totals?.[key], totals[key])));

  const chapters = (Array.isArray(raw.firstAid?.chapters) ? raw.firstAid.chapters : [])
    .filter((c) => isObject(c) && typeof c.id === 'string')
    .map((c) => ({
      id: c.id,
      name: str(c.name, c.id),
      short: str(c.short, str(c.name, c.id), 40),
      section: c.section === 'general' ? 'general' : 'organ',
      start: numOrNull(c.start),
      end: numOrNull(c.end),
      estHours: Math.max(0, Math.round(num(c.estHours, 1))),
      readPages: Math.round(num(c.readPages)),
      readSessions: Math.round(num(c.readSessions)),
    }));
  const firstAid = chapters.length ? { chapters, order: [] } : base.firstAid;
  if (chapters.length) {
    const ids = new Set(chapters.map((c) => c.id));
    const order = (Array.isArray(raw.firstAid.order) ? raw.firstAid.order : []).filter((id) => ids.has(id));
    firstAid.order = [...new Set([...order, ...ids])];
  }

  const items = (Array.isArray(raw.assessments?.items) ? raw.assessments.items : [])
    .filter((a) => isObject(a) && typeof a.id === 'string')
    .map((a) => ({
      id: a.id,
      name: str(a.name, a.id, 40),
      questions: Math.max(1, Math.round(num(a.questions, 200))),
      parts: Math.max(1, Math.round(num(a.parts, 4))),
      per: Math.max(1, Math.round(num(a.per, 50))),
      partName: str(a.partName, 'blocks', 20),
    }));
  const assessments = items.length ? { items, order: [] } : base.assessments;
  if (items.length) {
    const ids = new Set(items.map((a) => a.id));
    const order = (Array.isArray(raw.assessments.order) ? raw.assessments.order : []).filter((id) => ids.has(id));
    assessments.order = [...new Set([...order, ...ids])];
  }

  const scores = {};
  for (const [id, s] of Object.entries(isObject(raw.scores) ? raw.scores : {})) {
    if (!isObject(s) || !isDate(s.date)) continue;
    scores[id] = { date: s.date, pct: numOrNull(s.pct), weak: Array.isArray(s.weak) ? s.weak.filter((w) => typeof w === 'string') : [] };
  }

  const qbankSystems = systems.length ? systems : base.qbank.systems;
  return {
    version: VERSION,
    updatedAt: Math.max(0, num(raw.updatedAt)),
    settings: normalizeSettings(raw.settings, base.settings),
    qbank: {
      totals,
      baselineUnused: Math.max(0, Math.round(num(raw.qbank.baselineUnused, qbankSystems.reduce((a, s) => a + s.start, 0)))),
      systems: qbankSystems,
      subjects: subjects.length ? subjects : base.qbank.subjects,
    },
    firstAid,
    assessments,
    log: cleanLog(raw.log),
    scores,
    plan: { days: (Array.isArray(raw.plan?.days) ? raw.plan.days : []).filter((d) => isObject(d) && isDate(d.date) && Array.isArray(d.tasks)) },
    history: (Array.isArray(raw.history) ? raw.history : [])
      .filter((h) => isObject(h) && typeof h.label === 'string')
      .slice(-100)
      .map((h) => ({ at: num(h.at), kind: str(h.kind, 'change', 20), label: h.label.slice(0, 200), ...(isObject(h.before) ? { before: h.before } : {}), ...(h.undone ? { undone: true } : {}) })),
  };
}

/** The saved state, or null when there is none. A copy that cannot be read is set aside, not overwritten. */
export function loadState(storage, seed) {
  let text = null;
  try {
    text = storage.getItem(KEYS.state);
    if (!text) return null;
    return migrate(JSON.parse(text), seed);
  } catch {
    try {
      if (text) storage.setItem(KEYS.corrupt, text);
    } catch {
      /* nothing more to do */
    }
    return null;
  }
}

export function saveState(storage, state) {
  try {
    storage.setItem(KEYS.state, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function readJson(storage, key, fallback = null) {
  try {
    const text = storage.getItem(key);
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(storage, key, value) {
  try {
    if (value === null || value === undefined) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Keeps the state that is about to be replaced (by a sync pull or an import). */
export function saveBackup(storage, state, reason, now) {
  return writeJson(storage, KEYS.backup, { at: now, reason, state });
}

export function loadBackup(storage, seed) {
  const b = readJson(storage, KEYS.backup);
  if (!b?.state) return null;
  try {
    return { at: b.at, reason: b.reason, state: migrate(b.state, seed) };
  } catch {
    return null;
  }
}

/** The backup file. The GitHub token, passcode and theme are not part of the state, so they are never in it. */
export function exportJson(state, now = new Date()) {
  return JSON.stringify({ app: 'step1-planner', exported: now.toISOString(), state }, null, 2);
}

export function importJson(text, seed) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  return migrate(isObject(parsed?.state) ? parsed.state : parsed, seed);
}
