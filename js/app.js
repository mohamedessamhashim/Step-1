// Start-up and wiring: the store, the three areas of the page, theme, sync,
// and the actions the UI modules call.

import { SEED } from '../data/seed.js';
import { diffDays, fmt, todayLocal } from './dates.js';
import { applyChange, createState, replan, undoLast } from './model.js';
import { dayTotals, earliestExamDate, progress } from './planner.js';
import { displacedBy, missedDays } from './rebalance.js';
import { exportJson, importJson, KEYS, loadBackup, loadState, migrate, readJson, saveBackup, saveState, writeJson } from './storage.js';
import { createGistClient, syncOnce } from './sync.js';
import { createCalendarPanel } from './ui/calendar.js';
import { createCarousel } from './ui/carousel.js';
import { createDayCards } from './ui/daycard.js';
import { anySheetOpen, clear, h, icon, plural, toast } from './ui/dom.js';
import { createProgressPanel } from './ui/heatmap.js';
import { unlock } from './ui/lock.js';
import { openExamSheet, openRebalance } from './ui/rebalance.js';
import { openSettings } from './ui/settings.js';
import { createTrend } from './ui/trend.js';

const $ = (id) => document.getElementById(id);

// ---------- store ----------

function createStore({ onEdit }) {
  let today = todayLocal();
  let state = loadState(localStorage, SEED) ?? createState(SEED);
  let summary = null;
  let cache = {};
  let saveTimer = 0;
  let warned = false;
  let earliest = { key: '', date: null };
  const listeners = new Set();

  const commit = (next) => {
    const r = replan(next, today);
    state = r.state;
    summary = r.summary;
    cache = {};
  };
  const flush = () => {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (!saveState(localStorage, state) && !warned) {
      warned = true;
      toast('This browser would not save your data (storage is full or blocked). Export a backup from Settings.', { ms: 9000 });
    }
  };
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 120);
  };
  const emit = () => listeners.forEach((fn) => fn());
  // Edit times only ever go forward, so an edit made on top of a synced copy is
  // always newer than that copy, even if this device's clock is a little behind.
  const stamp = () => Math.max(Date.now(), state.updatedAt + 1);

  commit(state);
  save();

  return {
    selectedDate: null,
    get state() {
      return state;
    },
    get summary() {
      return summary;
    },
    get today() {
      return today;
    },
    get stats() {
      return (cache.stats ??= progress(state));
    },
    /** Earliest exam date that still fits everything. Worked out again only when something it depends on changes. */
    get earliest() {
      const key = JSON.stringify([state.settings, summary.firstOpen, summary.remainingAtStart, summary.sa.length, summary.saUnplaced.length]);
      if (key !== earliest.key) earliest = { key, date: earliestExamDate(state, today) };
      return earliest.date;
    },
    get missed() {
      return (cache.missed ??= missedDays(state, today));
    },
    /** Changes when any name shown on a card changes, so cards know to rebuild. */
    get namesKey() {
      return (cache.names ??= JSON.stringify([state.qbank.systems.map((s) => s.name), state.firstAid.chapters.map((c) => [c.name, c.short]), state.assessments.items]));
    },
    /** Runs a model function as (state, ...args, now) and re-renders if anything changed. */
    act(change, ...args) {
      const next = change(state, ...args, stamp());
      if (next === state) return false;
      const edited = next.updatedAt !== state.updatedAt;
      commit(next);
      save();
      emit();
      if (edited) onEdit?.();
      return true;
    },
    /** Swaps in a whole state (sync pull, import, restore). `asEdit` stamps it as this device's newest edit. */
    replace(next, { asEdit = false } = {}) {
      commit(asEdit ? { ...next, updatedAt: stamp() } : next);
      save();
      emit();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Moves to the real current date when the day has changed. Past days freeze as they stand. */
    rollover() {
      const now = todayLocal();
      if (now === today) return false;
      today = now;
      commit(state);
      save();
      emit();
      return true;
    },
    flush,
  };
}

// ---------- theme ----------

function createTheme(button) {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const get = () => {
    const t = readJson(localStorage, KEYS.theme, 'auto');
    return t === 'light' || t === 'dark' ? t : 'auto';
  };
  const effective = () => (get() === 'auto' ? (media.matches ? 'dark' : 'light') : get());
  const apply = () => {
    const t = get();
    if (t === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    const dark = effective() === 'dark';
    document.querySelector('meta[name="theme-color"]').setAttribute('content', dark ? '#1b1815' : '#f2ece1');
    clear(button).append(icon(dark ? 'sun' : 'moon'));
    button.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    button.setAttribute('aria-pressed', String(dark));
  };
  const set = (value) => {
    writeJson(localStorage, KEYS.theme, value);
    apply();
  };
  media.addEventListener('change', apply);
  button.addEventListener('click', () => set(effective() === 'dark' ? 'light' : 'dark'));
  apply();
  return { get, set };
}

// ---------- sync ----------

function createSyncController({ getStore, button, onChange }) {
  let config = readJson(localStorage, KEYS.sync, null); // { token, gistId }
  let status = config?.token ? 'idle' : 'off';
  let message = '';
  let lastAt = 0;
  let running = false;
  let again = false;
  let timer = 0;

  const text = () => {
    if (status === 'syncing') return 'Syncing…';
    if (status === 'error' || status === 'offline') return message;
    if (lastAt) return `Synced ${new Date(lastAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}. Changes are sent a few seconds after you make them.`;
    return 'Connected. Waiting for the first sync.';
  };
  const paint = () => {
    button.hidden = !config?.token;
    button.dataset.state = status;
    const short = { syncing: 'Syncing', error: 'Sync problem', offline: 'Offline', idle: 'Synced', ok: 'Synced' }[status] ?? '';
    clear(button).append(icon('cloud'), h('span', { class: 'sync-text', text: short }));
    button.setAttribute('aria-label', `Sync: ${text()}`);
    button.title = text();
    onChange?.();
  };

  async function run() {
    if (!config?.token) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    status = 'syncing';
    paint();
    const store = getStore();
    const local = store.state;
    try {
      const client = createGistClient({ fetch: window.fetch.bind(window), token: config.token });
      const result = await syncOnce({ client, gistId: config.gistId, local, accept: (raw) => migrate(raw, SEED) });
      if (result.gistId !== config.gistId) {
        config = { ...config, gistId: result.gistId };
        writeJson(localStorage, KEYS.sync, config);
      }
      if (result.action === 'pulled') {
        if (store.state.updatedAt > result.state.updatedAt) again = true; // edited while the request was in flight
        else {
          if (store.state.updatedAt > 0) saveBackup(localStorage, store.state, 'Replaced by a newer synced copy', Date.now());
          store.replace(result.state);
          toast('Loaded newer data from another device.');
        }
      } else if (store.state.updatedAt !== local.updatedAt) again = true;
      status = 'ok';
      lastAt = Date.now();
      message = '';
    } catch (err) {
      status = err.kind === 'network' ? 'offline' : 'error';
      message = err.message || 'Sync failed.';
    } finally {
      running = false;
      paint();
      if (again) {
        again = false;
        schedule(1500);
      }
    }
  }

  function schedule(ms = 3000) {
    if (!config?.token) return;
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  }

  button.addEventListener('click', () => {
    run();
    toast(status === 'error' || status === 'offline' ? message : 'Syncing with your gist…', { ms: 2500 });
  });
  document.addEventListener('visibilitychange', () => {
    if (!config?.token) return;
    if (document.visibilityState === 'visible') {
      if (Date.now() - lastAt > 30000) run();
    } else if (timer) {
      clearTimeout(timer);
      timer = 0;
      run(); // leaving the page with a change still waiting
    }
  });
  window.addEventListener('online', () => schedule(500));
  paint();

  return {
    run,
    schedule,
    info: () => ({ connected: !!config?.token, status, text: text() }),
    now: run,
    async connect(token) {
      if (!token) {
        toast('Paste a token first.');
        return;
      }
      config = { token, gistId: null };
      writeJson(localStorage, KEYS.sync, config);
      await run();
      toast(status === 'ok' ? 'Sync is on for this device.' : message, { ms: 6000 });
    },
    disconnect() {
      clearTimeout(timer);
      config = null;
      writeJson(localStorage, KEYS.sync, null);
      status = 'off';
      lastAt = 0;
      paint();
      toast('Sync is off on this device. The gist itself was not deleted.');
    },
  };
}

// ---------- main ----------

async function main() {
  await unlock($('lock'), localStorage);

  let sync = null;
  let settings = null;
  const store = createStore({ onEdit: () => sync?.schedule() });
  $('app').hidden = false;

  const days = () => store.state.plan.days;
  const indexOf = (date) => days().findIndex((d) => d.date === date);
  const homeDate = () => {
    const { start, exam } = store.summary;
    return store.today < start ? start : store.today > exam ? exam : store.today;
  };

  // ----- actions -----

  const withUndo = (text) => toast(text, { action: 'Undo', onAction: () => store.act(undoLast) });

  function openDay(date) {
    const i = indexOf(date);
    if (i < 0) return;
    carousel.go(i);
    const top = $('stage').getBoundingClientRect().top;
    if (top < 0 || top > window.innerHeight * 0.6) $('stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function catchUp() {
    const missed = store.missed;
    if (!missed.length) return;
    const total = missed.reduce((a, m) => a + m.shortfall, 0);
    const intro =
      total > 0
        ? `${plural(total, 'question')} from ${missed.length === 1 ? 'one earlier day' : `${missed.length} earlier days`} were not done. They are still in the plan, at the end. You can move them earlier, move the exam, or leave them.`
        : 'A self-assessment was not taken on its day. It has moved to the next free slot.';
    openRebalance(store, { title: 'Catch up', intro, days: missed, missed: total, onOpenDay: openDay });
  }

  function markSick(date) {
    const day = days()[indexOf(date)];
    const entry = store.state.log[date];
    const planned = dayTotals(day).unused;
    const done = day.tasks.filter((t) => t.kind === 'qbank' && t.source === 'unused').reduce((a, t) => a + Math.min(t.count, entry?.blocks?.[t.id]?.done ?? 0), 0);
    const shortfall = planned - done;
    const sa = day.tasks.find((t) => t.kind === 'sa' && !store.state.scores[t.assessment])?.assessment ?? null;
    openRebalance(store, {
      title: 'Missed today',
      intro: shortfall > 0 ? `Today will be closed. Its ${plural(shortfall, 'unfinished question')} go back into the plan, and First Aid picks up where you left off.` : 'Today will be closed. Nothing is lost: unfinished tasks are planned again.',
      days: shortfall > 0 || sa ? [{ date, planned, done, shortfall, sa }] : [],
      missed: shortfall,
      sick: date,
      kind: 'sick',
      context: `Missed ${fmt(date, 'md')}`,
    });
  }

  function addDaysOff(dates, label = '') {
    const { exam, restDay } = store.summary;
    const usable = dates.filter((d) => d >= store.today && d < exam && d !== restDay && indexOf(d) >= 0 && !(d in store.state.settings.daysOff));
    if (!usable.length) {
      toast('Those days are already off, in the past, or outside the plan.');
      return;
    }
    const text = usable.length === 1 ? fmt(usable[0], 'short') : `${fmt(usable[0], 'md')} to ${fmt(usable[usable.length - 1], 'md')}`;
    const basePatch = { daysOff: Object.fromEntries(usable.map((d) => [d, label])) };
    const displaced = displacedBy(store.state.plan, usable);
    if (displaced === 0) {
      store.act(applyChange, { kind: 'dayoff', label: `${text} marked off`, patch: basePatch });
      withUndo(`${text} is off. The plan works around it.`);
      return;
    }
    openRebalance(store, {
      title: usable.length === 1 ? 'Day off' : 'Days off',
      intro: `${text} will be off. ${plural(displaced, 'question')} were planned then. Choose where they go.`,
      missed: displaced,
      basePatch,
      kind: 'dayoff',
      context: `${text} off`,
    });
  }

  function removeDayOff(date) {
    store.act(applyChange, { kind: 'dayoff', label: `${fmt(date, 'short')} is no longer a day off`, patch: { removeDaysOff: [date] } });
    withUndo(`${fmt(date, 'short')} is back in the plan.`);
  }

  const app = {
    openExamSheet: () => openExamSheet(store),
    addDaysOff,
    removeDayOff,
    theme: null,
    sync: null,
    backupInfo: () => {
      const b = readJson(localStorage, KEYS.backup);
      return b?.state ? { at: b.at, reason: b.reason } : null;
    },
    exportFile() {
      const blob = new Blob([exportJson(store.state)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: `step1-planner-${store.today}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    },
    async importFile(file) {
      try {
        const imported = importJson(await file.text(), SEED);
        saveBackup(localStorage, store.state, 'Replaced by an imported file', Date.now());
        store.replace(imported, { asEdit: true });
        sync?.schedule();
        toast('Imported. The previous copy can be restored from Settings.');
      } catch (err) {
        toast(err.message || 'That file could not be imported.', { ms: 7000 });
      }
    },
    restoreBackup() {
      const b = loadBackup(localStorage, SEED);
      if (!b) return;
      saveBackup(localStorage, store.state, 'Replaced by a restored copy', Date.now());
      store.replace(b.state, { asEdit: true });
      sync?.schedule();
      toast('Restored the previous copy.');
    },
    reset() {
      const synced = sync?.info().connected;
      if (!window.confirm(`Reset the planner to its starting data? The log, scores and settings on this device are cleared.${synced ? ' Because sync is on, your other devices will be reset too.' : ''}`)) return;
      saveBackup(localStorage, store.state, 'Replaced by a reset', Date.now());
      store.replace(createState(SEED), { asEdit: true });
      sync?.schedule();
      toast('Reset to the starting data.');
    },
  };

  // ----- page pieces -----

  const cards = createDayCards(store, { markSick, markOff: (date) => addDaysOff([date]), removeOff: removeDayOff });
  const progressPanel = createProgressPanel($('panel-progress'), store, { onOpenDay: openDay });
  const calendar = createCalendarPanel($('panel-calendar'), store, { onOpenDay: openDay, onChangeExam: app.openExamSheet });
  const trend = createTrend($('panel-calendar'), store, { onOpenDay: openDay });

  const prevBtn = $('prev-btn');
  const nextBtn = $('next-btn');
  const todayBtn = $('today-btn');
  prevBtn.append(icon('left'));
  nextBtn.append(icon('right'));

  function updateNav() {
    const i = carousel.index;
    prevBtn.disabled = i <= 0;
    nextBtn.disabled = i >= days().length - 1;
    const home = homeDate();
    todayBtn.classList.toggle('is-here', days()[i]?.date === home);
    todayBtn.textContent = store.today < store.summary.start ? 'First day' : store.today > store.summary.exam ? 'Exam day' : 'Today';
  }

  const carousel = createCarousel($('stage'), {
    count: days().length,
    render: cards.render,
    update: cards.update,
    onChange: (i) => {
      const date = days()[i]?.date;
      if (!date) return;
      store.selectedDate = date;
      progressPanel.select(date);
      calendar.select(date);
      updateNav();
      $('announce').textContent = fmt(date, 'long');
    },
  });
  prevBtn.addEventListener('click', () => carousel.prev());
  nextBtn.addEventListener('click', () => carousel.next());
  todayBtn.addEventListener('click', () => openDay(homeDate()));

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || anySheetOpen()) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key === 'ArrowLeft') carousel.prev();
    else if (e.key === 'ArrowRight') carousel.next();
    else if (e.key === 't' || e.key === 'T') openDay(homeDate());
    else return;
    e.preventDefault();
  });

  function renderHeader() {
    const { today } = store;
    const { start, exam } = store.summary;
    const toExam = diffDays(today, exam);
    let text;
    let extra = '';
    if (today < start) {
      text = `Starts ${diffDays(today, start) === 1 ? 'tomorrow' : fmt(start, 'short')}`;
      extra = ` · exam in ${toExam} days`;
    } else if (toExam > 1) {
      text = `Exam in ${toExam} days`;
      extra = ` · ${fmt(exam, 'short')}`;
    } else if (toExam === 1) text = 'Exam tomorrow';
    else if (toExam === 0) text = 'Exam day';
    else text = `Exam was ${fmt(exam, 'short')}`;
    // The second half is dropped on narrow screens.
    clear($('countdown')).append(text, h('span', { class: 'brand-extra', text: extra }));
  }

  function renderStatus() {
    const s = store.summary;
    const lines = [];
    const line = (flag, ...parts) => lines.push(h('div', { class: `status-line${flag ? ' is-flag' : ''}` }, icon(flag ? 'flag' : 'info', 18), h('div', null, parts)));
    const b = (text) => h('b', { text });

    if (s.unscheduled > 0) line(true, b(plural(s.unscheduled, 'question')), ' do not fit before the exam at this pace.');
    else if (!s.qbankFinish) line(false, 'Every unused question is done.');
    else if (s.finishInDedicated) {
      const started = s.firstOpen >= s.dedicatedStart;
      const tail = started ? `${plural(s.remainingAtStart, 'unused question')} to go.` : `${plural(s.leftAtDedicated, 'question')} carry into it.`;
      line(true, 'Qbank finishes ', b(fmt(s.qbankFinish, 'short')), `, day ${diffDays(s.dedicatedStart, s.qbankFinish) + 1} of dedicated. ${tail}`);
    }
    else {
      const spare = diffDays(s.qbankFinish, s.dedicatedStart) - 1;
      line(false, 'Qbank finishes ', b(fmt(s.qbankFinish, 'short')), spare > 0 ? `, ${plural(spare, 'day')} before dedicated starts.` : ', the day before dedicated starts.');
    }

    const earliest = store.earliest;
    if (store.today <= s.exam) {
      if (!earliest) line(true, 'At this pace no exam date in the next year fits everything.');
      else {
        const slack = diffDays(earliest, s.exam);
        if (slack > 0) line(false, 'Earliest possible exam at this pace: ', b(fmt(earliest, 'short')), `. Your target, ${fmt(s.exam, 'short')}, leaves ${plural(slack, 'day')} spare.`);
        else if (slack === 0) line(false, 'Your target, ', b(fmt(s.exam, 'short')), ', is the earliest date this pace allows.');
        else line(true, 'Earliest possible exam at this pace: ', b(fmt(earliest, 'short')), `. Your target, ${fmt(s.exam, 'short')}, is ${plural(-slack, 'day')} too early.`);
      }
    }

    if (!s.faFits) {
      const verb = s.faOverflow === 1 ? 'is' : 'are';
      if (s.firstOpen >= s.dedicatedStart) line(true, 'First Aid: ', b(plural(s.faOverflow, 'hour')), ` of chapter reading ${verb} still unread. Dedicated is rapid review only.`);
      else line(true, 'First Aid: ', b(plural(s.faOverflow, 'hour')), ` of reading ${s.faOverflow === 1 ? 'does' : 'do'} not fit before dedicated${s.pagesPerHour ? ` at ${s.pagesPerHour} pages an hour` : ''}.`);
    }
    else if (s.faFinish) line(false, `First Aid: ${s.pagesPerHour ? `${s.pagesPerHour} pages an hour finishes` : 'on track to finish'} every chapter by `, b(fmt(s.faFinish, 'short')), '.');
    if (s.saUnplaced.length) line(true, b(plural(s.saUnplaced.length, 'self-assessment')), ' could not be scheduled before the exam.');
    clear($('status')).append(...lines);
  }

  function renderBanner() {
    const missed = store.missed;
    const banner = $('banner');
    banner.hidden = missed.length === 0;
    if (!missed.length) return;
    const total = missed.reduce((a, m) => a + m.shortfall, 0);
    const what = total > 0 ? `${plural(total, 'question')} unfinished from ${missed.length === 1 ? fmt(missed[0].date, 'short') : `${missed.length} earlier days`}.` : 'A self-assessment was not taken on its day.';
    clear(banner).append(h('span', null, h('b', { text: 'Behind plan. ' }), what), h('button', { class: 'btn btn-small', type: 'button', text: 'Catch up', onClick: catchUp }));
  }

  function renderAll() {
    carousel.refresh(days().length);
    store.selectedDate = days()[carousel.index]?.date ?? null;
    renderHeader();
    renderStatus();
    renderBanner();
    progressPanel.render();
    calendar.render();
    trend.render();
    updateNav();
  }

  // ----- header buttons, tabs -----

  app.theme = createTheme($('theme-btn'));
  sync = createSyncController({ getStore: () => store, button: $('sync-btn'), onChange: () => settings?.refresh() });
  app.sync = sync;
  $('settings-btn').append(icon('sliders'));
  app.onSettingsClosed = () => {
    settings = null;
  };
  $('settings-btn').addEventListener('click', () => {
    settings = openSettings(store, app);
  });

  const layout = $('layout');
  const setTab = (tab) => {
    layout.dataset.tab = tab;
    for (const btn of document.querySelectorAll('.tab')) btn.setAttribute('aria-selected', String(btn.dataset.tab === tab));
    writeJson(localStorage, KEYS.tab, tab);
    if (tab === 'calendar') trend.render(); // it needs its real width, which a hidden panel does not have
  };
  for (const btn of document.querySelectorAll('.tab')) btn.addEventListener('click', () => setTab(btn.dataset.tab));
  setTab(readJson(localStorage, KEYS.tab, 'progress') === 'calendar' ? 'calendar' : 'progress');

  // ----- go -----

  store.subscribe(renderAll);
  store.selectedDate = homeDate();
  carousel.show(Math.max(0, indexOf(homeDate())));
  renderAll();
  document.documentElement.dataset.ready = '1';

  // Ask about unfinished past days once per visit (the banner stays until it is dealt with).
  const missedKey = store.missed.map((m) => m.date).join(',');
  let asked = '';
  try {
    asked = sessionStorage.getItem('step1.asked') ?? '';
  } catch {
    /* fine */
  }
  if (missedKey && missedKey !== asked) {
    try {
      sessionStorage.setItem('step1.asked', missedKey);
    } catch {
      /* fine */
    }
    catchUp();
  }

  // The date can change while the page stays open.
  const tick = () => {
    if (store.rollover()) openDay(homeDate());
  };
  setInterval(tick, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tick();
    else store.flush();
  });
  window.addEventListener('pagehide', () => store.flush());

  sync.run();
}

main().catch((err) => {
  console.error(err);
  const box = document.createElement('p');
  box.style.cssText = 'padding:24px;max-width:560px;margin:40px auto;font-family:system-ui,sans-serif;line-height:1.5';
  box.textContent = `The planner could not start: ${err.message}. Your saved data has not been changed. Try reloading; if this keeps happening, clear this site's data after exporting a backup.`;
  document.body.append(box);
});
