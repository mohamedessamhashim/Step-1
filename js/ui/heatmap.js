// Progress panel: the contribution-style heatmap, totals, and qbank coverage by system.

import { addDays, dow, fmt } from '../dates.js';
import { isMissedDay, questionsDone } from '../model.js';
import { dayTotals } from '../planner.js';
import { clear, fmtN, h, plural } from './dom.js';

/** Colour step for a day's question count: 40, 80 and 100 each get their own. */
export const levelOf = (q) => (q >= 100 ? 4 : q >= 60 ? 3 : q >= 40 ? 2 : q > 0 ? 1 : 0);

export function createProgressPanel(root, store, { onOpenDay }) {
  const heat = h('div', { class: 'heat', role: 'group', 'aria-label': 'Questions done per day. Arrow keys move between days, Enter opens one.' });
  const tip = h('div', { class: 'tip', role: 'tooltip', hidden: true });
  const stats = h('div', { class: 'stats' });
  const overall = h('p', { class: 'muted', style: { marginTop: '10px' } });
  const cov = h('div', { class: 'cov' });
  const subjects = h('dl', { class: 'pairs' });
  const heatWrap = h('div', { style: { position: 'relative' } }, heat, tip);

  const legend = h(
    'div',
    { class: 'legend', 'aria-hidden': 'true' },
    h('span', { class: 'legend-scale' }, 'Less', h('i', { class: 'key key-0' }), h('i', { class: 'key key-1' }), h('i', { class: 'key key-2' }), h('i', { class: 'key key-3' }), h('i', { class: 'key key-4' }), 'More'),
    h('span', { class: 'legend-item' }, h('i', { class: 'key key-future' }), 'Upcoming'),
    h('span', { class: 'legend-item' }, h('i', { class: 'key key-missed' }), 'Missed'),
    h('span', { class: 'legend-item' }, h('i', { class: 'key-sa' }), 'Self-assessment'),
  );

  root.append(
    h('div', { class: 'panel-head' }, h('h2', { class: 'panel-h', id: 'progress-h', text: 'Progress' })),
    heatWrap,
    legend,
    stats,
    overall,
    h('h3', { class: 'sub-h', text: 'Qbank by system' }),
    cov,
    h('details', { class: 'fold' }, h('summary', { text: 'Unused by subject (as last entered)' }), subjects),
  );

  let pinned = null;
  let cells = new Map(); // date → button
  let focusDate = null;

  function describe(day) {
    const { state, today } = store;
    const entry = state.log[day.date];
    const q = questionsDone(entry);
    const byDate = store.stats.byDate[day.date];
    const sa = day.tasks.find((t) => t.kind === 'sa');
    const saName = sa ? (state.assessments.items.find((a) => a.id === sa.assessment)?.name ?? sa.assessment) : null;
    const score = sa ? state.scores[sa.assessment] : null;
    const planned = dayTotals(day).total;
    const missed = isMissedDay(day, entry, today);

    let value;
    if (day.type === 'exam') value = 'Exam day';
    else if (day.type === 'rest') value = 'Rest day';
    else if (day.type === 'off') value = day.offLabel ? `Day off: ${day.offLabel}` : 'Day off';
    else if (sa) value = score ? `${saName}${score.pct != null ? `: ${score.pct}%` : ' taken'}` : saName;
    else if (q > 0) value = `${plural(q, 'question')}${byDate?.pct != null ? ` · ${Math.round(byDate.pct)}% correct` : ''}`;
    else if (day.date > today) value = `Planned: ${plural(planned, 'question')}`;
    else value = missed ? `Missed: ${plural(planned, 'question')} planned` : `0 of ${planned} questions`;
    if (sa && q > 0) value += ` · ${plural(q, 'question')}`;

    return { q, missed, sa, taken: !!score, value, label: `${fmt(day.date, 'short')}${day.date === today ? ' · today' : ''}` };
  }

  function showTip(day, cell, pin) {
    const d = describe(day);
    clear(tip).append(h('div', { class: 'tip-value', text: d.value }), h('div', { class: 'tip-label', text: d.label }));
    if (pin) tip.append(h('button', { class: 'link-btn', type: 'button', text: 'Open this day', onClick: () => { hideTip(true); onOpenDay(day.date); } }));
    tip.classList.toggle('is-pinned', !!pin);
    tip.hidden = false;
    pinned = pin ? day.date : null;
    // Above the cell, centred, kept inside the panel.
    const wrap = heatWrap.getBoundingClientRect();
    const c = cell.getBoundingClientRect();
    const width = tip.offsetWidth;
    const left = Math.min(Math.max(0, c.left - wrap.left + c.width / 2 - width / 2), Math.max(0, wrap.width - width));
    let top = c.top - wrap.top - tip.offsetHeight - 8;
    if (top + wrap.top < 8) top = c.bottom - wrap.top + 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  function hideTip(force) {
    if (pinned && !force) return;
    pinned = null;
    tip.hidden = true;
  }

  document.addEventListener('pointerdown', (e) => {
    if (pinned && !heatWrap.contains(e.target)) hideTip(true);
  });

  function renderHeat() {
    const { state, today } = store;
    const days = state.plan.days;
    clear(heat);
    cells = new Map();
    if (!days.length) return;
    const lead = dow(days[0].date);
    const columns = Math.ceil((lead + days.length) / 7);
    heat.style.gridTemplateColumns = `auto repeat(${columns}, minmax(0, 1fr))`;
    heat.style.maxWidth = `${28 + columns * 34}px`;

    // Month names sit over the week in which the month starts.
    let lastMonth = '';
    days.forEach((day, i) => {
      const month = day.date.slice(0, 7);
      if (month === lastMonth) return;
      lastMonth = month;
      const col = Math.floor((lead + i) / 7) + 2;
      heat.append(h('div', { class: 'heat-month', text: fmt(day.date, 'month'), style: { gridRow: '1', gridColumn: `${col} / span 2` } }));
    });
    ['', 'Mon', '', 'Wed', '', 'Fri', ''].forEach((label, r) => {
      if (label) heat.append(h('div', { class: 'heat-dow', text: label, 'aria-hidden': 'true', style: { gridRow: String(r + 2), gridColumn: '1' } }));
    });

    const selected = store.selectedDate;
    if (!focusDate || !days.some((d) => d.date === focusDate)) focusDate = selected ?? days[0].date;
    days.forEach((day, i) => {
      const d = describe(day);
      const future = day.date > today;
      const cls = ['hm'];
      if (day.type === 'exam') cls.push('is-exam');
      else if (day.type === 'off') cls.push('is-off');
      else if (d.missed) cls.push('is-missed');
      else if (future && d.q === 0) cls.push('is-future');
      if (d.sa) cls.push('is-sa');
      if (d.taken) cls.push('is-taken');
      if (day.date === today) cls.push('is-today');
      if (day.date === selected) cls.push('is-selected');
      const cell = h('button', {
        class: cls.join(' '),
        type: 'button',
        tabIndex: day.date === focusDate ? 0 : -1,
        'aria-label': `${d.label}: ${d.value}`,
        data: { date: day.date, level: String(day.type === 'exam' || day.type === 'off' || d.missed ? 0 : levelOf(d.q)) },
        style: { gridRow: String(dow(day.date) + 2), gridColumn: String(Math.floor((lead + i) / 7) + 2) },
        onPointerenter: (e) => {
          if (e.pointerType === 'mouse' && !pinned) showTip(day, cell, false);
        },
        onPointerleave: () => hideTip(false),
        onFocus: () => {
          focusDate = day.date;
          if (!pinned) showTip(day, cell, false);
        },
        onBlur: () => hideTip(false),
        onClick: () => {
          if (pinned === day.date) hideTip(true);
          else showTip(day, cell, true);
        },
        onDblclick: () => onOpenDay(day.date),
        onKeydown: (e) => {
          const step = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[e.key];
          if (step) {
            e.preventDefault();
            e.stopPropagation();
            const target = cells.get(addDays(day.date, step));
            if (target) {
              cell.tabIndex = -1;
              target.tabIndex = 0;
              target.focus();
            }
          } else if (e.key === 'Enter') {
            e.preventDefault();
            hideTip(true);
            onOpenDay(day.date);
          } else if (e.key === 'Escape') hideTip(true);
        },
      });
      cells.set(day.date, cell);
      heat.append(cell);
    });
  }

  function renderStats() {
    const s = store.stats;
    const stat = (label, value, unit) => h('div', { class: 'stat' }, h('div', { class: 'stat-label', text: label }), h('div', { class: 'stat-value' }, value, unit ? h('small', { text: unit }) : null));
    clear(stats).append(stat('Done', fmtN(s.done)), stat('Remaining', fmtN(s.left)), stat('Correct', s.pct == null ? '–' : String(Math.round(s.pct)), s.pct == null ? '' : '%'));
    const all = store.state.qbank.totals.all;
    overall.textContent = all > 0 ? `Whole qbank: ${fmtN(Math.max(0, all - s.left))} of ${fmtN(all)} used (${Math.round(s.usedPct)}%).` : '';

    clear(cov);
    for (const sys of s.systems) {
      const complete = sys.left === 0;
      const share = sys.start > 0 ? sys.done / sys.start : 1;
      cov.append(
        h(
          'div',
          { class: 'cov-item', title: sys.name },
          h('div', { class: 'cov-top' }, h('span', { class: 'cov-name', text: sys.short || sys.name }), h('span', { class: 'cov-count', text: complete ? 'done' : `${fmtN(sys.left)} left` })),
          h('div', { class: 'meter', role: 'img', 'aria-label': `${sys.name}: ${fmtN(sys.done)} of ${fmtN(sys.start)} done` }, h('i', { style: { width: `${Math.round(share * 100)}%` } })),
        ),
      );
    }

    clear(subjects);
    for (const sub of store.state.qbank.subjects) subjects.append(h('dt', { text: sub.name }), h('dd', { text: fmtN(sub.unused) }));
  }

  return {
    render() {
      const keepPinned = pinned;
      renderHeat();
      renderStats();
      if (keepPinned && cells.has(keepPinned)) {
        const day = store.state.plan.days.find((d) => d.date === keepPinned);
        showTip(day, cells.get(keepPinned), true);
      } else hideTip(true);
    },
    /** Moves the "selected" outline without rebuilding the grid. */
    select(date) {
      for (const [d, cell] of cells) cell.classList.toggle('is-selected', d === date);
    },
  };
}
