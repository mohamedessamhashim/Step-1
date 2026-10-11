// One card per day: the date, where it sits in the plan, and the day's tasks.
// A card is rebuilt only when its plan changes; ticking and typing patch it in
// place so focus and animations survive.

import { diffDays, fmt } from '../dates.js';
import { dayProgress, setBlockDone, setBlockPct, setScore, toggleTask } from '../model.js';
import { h, icon, svg } from './dom.js';

const TYPE_LABEL = { workday: 'Workday', weekend: 'Weekend', sa: 'Self-assessment', dedicated: 'Dedicated', rest: 'Rest', exam: 'Exam', off: 'Day off' };
const RING_R = 22;
const RING_C = 2 * Math.PI * RING_R;

const joinNames = (names) => names.join(' + ');

/** "~2–4 hr" for the review task. Days planned before the change still carry minutes. */
function reviewTime(task) {
  if (Array.isArray(task.hours)) {
    const [from, to] = task.hours;
    if (!to) return null;
    return from === to ? `~${to} hr` : `~${from}–${to} hr`;
  }
  return task.minutes ? `~${task.minutes} min` : null;
}

function pageText(parts) {
  const ranges = [];
  for (const p of parts) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] + 1 === p.from) last[1] = p.to;
    else ranges.push([p.from, p.to]);
  }
  const text = ranges.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
  return `${ranges.length === 1 && ranges[0][0] === ranges[0][1] ? 'p.' : 'pp.'} ${text}`;
}

export function createDayCards(store, actions) {
  const refs = new WeakMap(); // card element → { sync }

  const names = () => {
    const s = store.state;
    return {
      system: Object.fromEntries(s.qbank.systems.map((x) => [x.id, x.name])),
      chapter: Object.fromEntries(s.firstAid.chapters.map((x) => [x.id, x.name])),
      chapterShort: Object.fromEntries(s.firstAid.chapters.map((x) => [x.id, x.short || x.name])),
      assessment: Object.fromEntries(s.assessments.items.map((x) => [x.id, x])),
    };
  };

  /** Everything a card's structure depends on. When this changes the card is rebuilt. */
  function signature(index) {
    const day = store.state.plan.days[index];
    const { today, summary } = store;
    const rel = day.date < today ? 'past' : day.date === today ? 'today' : 'future';
    return JSON.stringify([day, rel, summary.start, summary.exam, store.namesKey, !!store.state.log[day.date]?.sick]);
  }

  function checkbox(label, onChange, disabled) {
    const input = h('input', { type: 'checkbox', 'aria-label': label, disabled, onChange });
    const box = h('span', { class: 'box' }, svg('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 3.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, svg('path', { d: 'M5 12.5l4.5 4.5L19 7.5' })));
    const wrap = h('label', { class: 'check' }, input, box);
    input.addEventListener('change', () => {
      if (!input.checked) return;
      wrap.classList.remove('just-ticked');
      void wrap.offsetWidth; // restart the animation
      wrap.classList.add('just-ticked');
    });
    return { wrap, input };
  }

  const setValue = (input, value) => {
    if (document.activeElement !== input && input.value !== value) input.value = value;
  };

  function blockRow(day, task, n, locked, explain) {
    const { date } = day;
    const N = names();
    const mode =
      task.mode === 'incorrect'
        ? 'Timed · Incorrects'
        : task.mode === 'random'
          ? 'Random · Timed · Unused'
          : `Timed · Unused · ${joinNames(task.systems.map((id) => N.system[id] ?? id))}`;
    const cb = checkbox(`Block ${n} done`, (e) => store.act(toggleTask, date, task.id, e.target.checked), locked);
    const done = h('input', {
      class: 'field-num',
      type: 'text',
      inputMode: 'numeric',
      autocomplete: 'off',
      placeholder: '0',
      'aria-label': `Block ${n}: questions done out of ${task.count}`,
      disabled: locked,
      data: { key: `${date}-${task.id}-done` },
      onInput: (e) => {
        const digits = e.target.value.replace(/[^\d]/g, '');
        if (digits !== e.target.value) e.target.value = digits;
        store.act(setBlockDone, date, task.id, digits === '' ? null : Number(digits));
      },
      onBlur: (e) => {
        const entry = store.state.log[date]?.blocks?.[task.id];
        e.target.value = entry ? String(entry.done) : '';
      },
    });
    const pct = h('input', {
      class: 'field-num',
      type: 'text',
      inputMode: 'numeric',
      autocomplete: 'off',
      placeholder: '–',
      'aria-label': `Block ${n}: percent correct`,
      disabled: locked,
      data: { key: `${date}-${task.id}-pct` },
      onInput: (e) => {
        const digits = e.target.value.replace(/[^\d]/g, '').slice(0, 3);
        if (digits !== e.target.value) e.target.value = digits;
        store.act(setBlockPct, date, task.id, digits === '' ? null : Number(digits));
      },
      onBlur: (e) => {
        const v = store.state.log[date]?.blocks?.[task.id]?.pct;
        e.target.value = v == null ? '' : String(v);
      },
    });
    const more = h('div', { class: 'task-more', hidden: true }, h('label', { class: 'num' }, '% correct ', pct));
    const row = h(
      'li',
      { class: 'task', data: { task: task.id } },
      cb.wrap,
      h('div', { class: 'task-title', text: `Block ${n}` }),
      h('div', { class: 'task-side num' }, done, `/ ${task.count}`),
      h('div', { class: 'task-sub', text: mode }),
      explain ? h('div', { class: 'task-note', text: "Today's chapter has no questions left, so General Principles instead." }) : null,
      more,
    );
    return {
      row,
      sync(entry) {
        const b = entry?.blocks?.[task.id];
        const n = b?.done ?? 0;
        cb.input.checked = n > 0;
        row.classList.toggle('is-done', n >= task.count);
        row.classList.toggle('is-partial', n > 0 && n < task.count);
        setValue(done, b ? String(b.done) : '');
        more.hidden = !(n > 0);
        setValue(pct, b?.pct == null ? '' : String(b.pct));
      },
    };
  }

  function simpleRow(day, task, title, sub, locked, note) {
    const cb = checkbox(title, (e) => store.act(toggleTask, day.date, task.id, e.target.checked), locked);
    const row = h('li', { class: 'task', data: { task: task.id } }, cb.wrap, h('div', { class: 'task-title', text: title }), sub ? h('div', { class: 'task-sub', text: sub }) : null, note ? h('div', { class: 'task-note', text: note }) : null);
    return {
      row,
      sync(entry) {
        const on = task.kind === 'fa' ? !!entry?.fa?.done : !!entry?.tasks?.[task.id];
        cb.input.checked = on;
        row.classList.toggle('is-done', on);
      },
    };
  }

  function faRow(day, task, locked) {
    const N = names();
    if (task.mode === 'review') {
      const list = task.chapters.map((id) => N.chapter[id] ?? id);
      const what = list.length ? joinNames(list) : 'Weakest systems';
      return simpleRow(day, task, 'First Aid rapid review', `${what} · ~${task.hours} hr`, locked);
    }
    const title = `First Aid · ${N.chapter[task.chapterId] ?? task.chapterId}`;
    if (task.mode === 'time') return simpleRow(day, task, title, `~1 hr · session ${task.session} of ${task.of}`, locked);
    const others = task.parts.filter((p) => p.chapterId !== task.chapterId);
    const note = others.length ? `Starts with ${joinNames([...new Set(others.map((p) => N.chapter[p.chapterId] ?? p.chapterId))])} (${pageText(others)}).` : null;
    return simpleRow(day, task, title, `${pageText(task.parts)} · ${task.pages} ${task.pages === 1 ? 'page' : 'pages'} · ~1 hr`, locked, note);
  }

  function saRow(day, task, locked) {
    const { date } = day;
    const N = names();
    const a = N.assessment[task.assessment] ?? { name: task.assessment, questions: 0, parts: 0, per: 0, partName: 'blocks' };
    const cb = checkbox(`${a.name} taken`, (e) => store.act(toggleTask, date, 'sa', e.target.checked), locked);
    const current = () => store.state.scores[task.assessment];
    const score = h('input', {
      class: 'field-num is-wide',
      type: 'text',
      inputMode: 'decimal',
      autocomplete: 'off',
      placeholder: '–',
      'aria-label': `${a.name}: percent correct`,
      disabled: locked,
      data: { key: `${date}-sa-score` },
      onInput: (e) => {
        const clean = e.target.value.replace(/[^\d.]/g, '').slice(0, 5);
        if (clean !== e.target.value) e.target.value = clean;
        store.act(setScore, task.assessment, { date: current()?.date ?? date, pct: clean === '' ? null : Number(clean) });
      },
      onBlur: (e) => {
        const v = current()?.pct;
        e.target.value = v == null ? '' : String(v);
      },
    });
    const chips = h('div', { class: 'chips' });
    const chipFor = {};
    for (const c of store.state.firstAid.chapters) {
      if (!store.state.qbank.systems.some((s) => s.chapter === c.id)) continue;
      chipFor[c.id] = h('button', {
        class: 'chip',
        type: 'button',
        text: c.short || c.name,
        'aria-pressed': 'false',
        disabled: locked,
        onClick: () => {
          const weak = new Set(current()?.weak ?? []);
          if (weak.has(c.id)) weak.delete(c.id);
          else weak.add(c.id);
          store.act(setScore, task.assessment, { date: current()?.date ?? date, weak: [...weak] });
        },
      });
      chips.append(chipFor[c.id]);
    }
    const weakFold = h('details', { class: 'fold', style: { marginTop: '0', borderTop: '0', width: '100%' } }, h('summary', { text: 'Weak areas (for the rapid review)' }), chips);
    const more = h('div', { class: 'task-more' }, h('label', { class: 'num' }, 'Score ', score, ' % correct'), weakFold);
    const row = h(
      'li',
      { class: 'task', data: { task: 'sa' } },
      cb.wrap,
      h('div', { class: 'task-title', text: a.name }),
      h('div', { class: 'task-sub num', text: `${a.questions} questions · ${a.parts} ${a.partName} of ${a.per}` }),
      more,
    );
    return {
      row,
      sync() {
        const s = current();
        cb.input.checked = !!s;
        row.classList.toggle('is-done', !!s);
        setValue(score, s?.pct == null ? '' : String(s.pct));
        const weak = new Set(s?.weak ?? []);
        for (const [id, chip] of Object.entries(chipFor)) chip.setAttribute('aria-pressed', String(weak.has(id)));
        if (weak.size && !weakFold.dataset.touched) weakFold.open = true;
        weakFold.dataset.touched = '1';
      },
    };
  }

  function footer(day, rel) {
    const entry = store.state.log[day.date];
    const foot = h('div', { class: 'dc-foot' });
    if (day.type === 'exam' || day.type === 'rest') return foot;
    if (entry?.sick) {
      foot.append(h('span', { text: 'Marked as a missed / sick day' }));
      return foot;
    }
    if (day.type === 'off') {
      if (rel !== 'past') foot.append(h('span'), h('button', { class: 'link-btn', type: 'button', text: 'Remove day off', onClick: () => actions.removeOff(day.date) }));
      return foot;
    }
    if (rel === 'today') {
      foot.append(
        h('button', { class: 'link-btn', type: 'button', text: 'Mark as day off', onClick: () => actions.markOff(day.date) }),
        h('button', { class: 'link-btn', type: 'button', text: 'Missed today / sick day', onClick: () => actions.markSick(day.date) }),
      );
    } else if (rel === 'future') {
      foot.append(h('span', { text: 'Upcoming' }), h('button', { class: 'link-btn', type: 'button', text: 'Mark as day off', onClick: () => actions.markOff(day.date) }));
    }
    return foot;
  }

  function render(index) {
    const { state, today, summary } = store;
    const day = state.plan.days[index];
    const rel = day.date < today ? 'past' : day.date === today ? 'today' : 'future';
    const locked = rel === 'future';
    const toExam = diffDays(day.date, summary.exam);
    const countdown = toExam === 0 ? '' : toExam === 1 ? 'Exam tomorrow' : `${toExam} days to exam`;

    const ringFill = svg('circle', { class: 'ring-fill', cx: 26, cy: 26, r: RING_R, 'stroke-dasharray': RING_C.toFixed(2), 'stroke-dashoffset': RING_C.toFixed(2) });
    const ringLabel = h('span', { class: 'ring-label' });
    const ring = h('div', { class: 'ring', role: 'img', hidden: day.tasks.length === 0 }, svg('svg', { width: 52, height: 52, viewBox: '0 0 52 52' }, svg('circle', { class: 'ring-track', cx: 26, cy: 26, r: RING_R }), ringFill), ringLabel);

    const badges = [h('span', { class: 'badge', data: { type: day.type }, text: TYPE_LABEL[day.type] })];
    if (day.type === 'sa' && day.phase === 'dedicated') badges.push(h('span', { class: 'badge', text: 'Dedicated' }));
    if (rel === 'today') badges.unshift(h('span', { class: 'badge', data: { type: 'today' }, text: 'Today' }));
    if (state.log[day.date]?.sick) badges.push(h('span', { class: 'badge', data: { type: 'sick' }, text: 'Sick day' }));

    const head = h(
      'header',
      { class: 'dc-head' },
      h('div', { class: 'dc-eyebrow num', text: `${fmt(day.date, 'weekday')} · Day ${diffDays(summary.start, day.date) + 1} of ${summary.totalDays}` }),
      ring,
      h('h2', { class: 'dc-date', text: fmt(day.date, 'monthDay') }),
      h('div', { class: 'dc-meta' }, badges, countdown ? h('span', { class: 'num', text: countdown }) : null),
    );

    const rows = [];
    let blockNo = 0;
    const firstFallback = day.tasks.find((t) => t.kind === 'qbank' && t.fallback);
    for (const task of day.tasks) {
      if (task.kind === 'anki') rows.push(simpleRow(day, task, 'Anki reviews', null, locked));
      else if (task.kind === 'qbank') rows.push(blockRow(day, task, ++blockNo, locked, task === firstFallback));
      else if (task.kind === 'fa') rows.push(faRow(day, task, locked));
      else if (task.kind === 'sa') rows.push(saRow(day, task, locked));
      else if (task.kind === 'sareview') rows.push(simpleRow(day, task, 'Review the self-assessment', 'Go through every question you missed or guessed', locked));
      else rows.push(simpleRow(day, task, 'Review incorrects and guessed corrects', reviewTime(task), locked));
    }

    let body;
    if (day.type === 'exam') body = h('div', { class: 'dc-note' }, h('strong', { text: 'Exam day' }), 'USMLE Step 1. You have done the work. Good luck.');
    else if (day.type === 'rest') body = h('div', { class: 'dc-note' }, h('strong', { text: 'Rest' }), 'No studying today. Get your ID and scheduling permit ready, then switch off and sleep early.');
    else if (day.type === 'off') body = h('div', { class: 'dc-note' }, h('strong', { text: day.offLabel || 'Day off' }), 'Nothing is scheduled. The plan works around this day.');
    else body = h('ul', { class: 'tasks' }, rows.map((r) => r.row));

    const card = h('article', { class: 'day-card', 'aria-label': fmt(day.date, 'long'), data: { date: day.date, type: day.type, sig: signature(index) } }, head, body, footer(day, rel));

    const sync = () => {
      const entry = store.state.log[day.date];
      for (const r of rows) r.sync(entry);
      const p = dayProgress(day, entry);
      const pct = Math.round(p.fraction * 100);
      ringFill.setAttribute('stroke-dashoffset', (RING_C * (1 - p.fraction)).toFixed(2));
      ringFill.style.opacity = p.fraction > 0 ? '1' : '0'; // a zero-length round cap would still draw a dot
      ring.setAttribute('aria-label', `${pct}% of today's tasks done`);
      const wasComplete = ring.classList.contains('is-complete');
      if (p.complete !== wasComplete || !ringLabel.firstChild) {
        ring.classList.toggle('is-complete', p.complete);
        ringLabel.replaceChildren(p.complete ? icon('check', 22) : `${pct}%`);
      } else if (!p.complete) ringLabel.textContent = `${pct}%`;
    };
    refs.set(card, { sync });
    sync();
    return card;
  }

  /** Patches a mounted card, or returns a fresh one when its plan changed. */
  function update(card, index) {
    if (!card || card.dataset.sig !== signature(index)) return render(index);
    refs.get(card)?.sync();
    return card;
  }

  return { render, update };
}
