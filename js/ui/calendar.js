// Calendar panel: one month at a time from the start month to the exam month.
// Tapping a day moves the day card to it. The exam date is changed from here.

import { addDays, addMonths, daysInMonth, dow, fmt, monthStart } from '../dates.js';
import { isMissedDay } from '../model.js';
import { clear, h, icon } from './dom.js';

export function createCalendarPanel(root, store, { onOpenDay, onChangeExam }) {
  let month = null; // first day of the month on show
  const title = h('div', { class: 'cal-month', 'aria-live': 'polite' });
  const prev = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Previous month', onClick: () => turn(-1) }, icon('left', 18));
  const next = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Next month', onClick: () => turn(1) }, icon('right', 18));
  const grid = h('div', { class: 'cal-grid' });
  const examDate = h('div', { class: 'exam-row-date num' });

  root.append(
    h('div', { class: 'panel-head' }, h('h2', { class: 'panel-h', id: 'calendar-h', text: 'Calendar' }), h('div', { class: 'cal-nav' }, prev, title, next)),
    h('div', { class: 'cal' }, grid),
    h(
      'div',
      { class: 'legend', 'aria-hidden': 'true' },
      h('span', { class: 'legend-item' }, h('i', { class: 'key key-exam' }), 'Exam'),
      h('span', { class: 'legend-item' }, h('i', { class: 'key key-ded' }), 'Dedicated'),
      h('span', { class: 'legend-item' }, h('i', { class: 'key-sa' }), 'Self-assessment'),
      h('span', { class: 'legend-item' }, h('i', { class: 'key key-off' }), 'Day off'),
    ),
    h('div', { class: 'exam-row' }, h('div', null, h('div', { class: 'exam-row-label', text: 'Exam date' }), examDate), h('button', { class: 'btn btn-small', type: 'button', text: 'Change', onClick: () => onChangeExam() })),
  );

  const bounds = () => ({ first: monthStart(store.summary.start), last: monthStart(store.summary.exam) });

  function turn(by) {
    const { first, last } = bounds();
    const target = addMonths(month, by);
    if (target < first || target > last) return;
    month = target;
    render();
  }

  function render() {
    const { state, today, summary } = store;
    const { first, last } = bounds();
    if (!month) month = monthStart(store.selectedDate ?? today);
    if (month < first) month = first;
    if (month > last) month = last;
    title.textContent = fmt(month, 'monthYear');
    prev.disabled = month <= first;
    next.disabled = month >= last;
    examDate.textContent = fmt(summary.exam, 'full');

    const byDate = new Map(state.plan.days.map((d) => [d.date, d]));
    const lastDedicated = addDays(summary.exam, -1);
    clear(grid);
    for (const d of ['S', 'M', 'T', 'W', 'T', 'F', 'S']) grid.append(h('div', { class: 'cal-dow', text: d, 'aria-hidden': 'true' }));
    for (let i = 0; i < dow(month); i++) grid.append(h('div'));
    for (let n = 0; n < daysInMonth(month); n++) {
      const date = addDays(month, n);
      const day = byDate.get(date);
      const cls = ['cal-day'];
      const notes = [];
      let mark = null;
      if (day) {
        if (day.type === 'exam') {
          cls.push('is-exam');
          notes.push('exam day');
        } else if (day.phase === 'dedicated') {
          cls.push('is-ded');
          if (date === summary.dedicatedStart) cls.push('is-first');
          if (date === lastDedicated) cls.push('is-last');
          if (dow(date) === 0 || n === 0) cls.push('is-rowstart');
          if (dow(date) === 6 || n === daysInMonth(month) - 1) cls.push('is-rowend');
          notes.push(day.type === 'rest' ? 'rest day' : 'dedicated');
        }
        const sa = day.tasks.find((t) => t.kind === 'sa');
        if (sa) {
          cls.push('is-sa');
          if (state.scores[sa.assessment]) cls.push('is-taken');
          mark = h('i', { class: 'cal-mark' });
          notes.push(state.assessments.items.find((a) => a.id === sa.assessment)?.name ?? 'self-assessment');
        }
        if (day.type === 'off') {
          cls.push('is-off');
          notes.push(day.offLabel ? `day off, ${day.offLabel}` : 'day off');
        }
        if (isMissedDay(day, state.log[date], today)) {
          cls.push('is-missed');
          notes.push('missed');
        }
      }
      if (date === today) {
        cls.push('is-today');
        notes.push('today');
      }
      if (date === store.selectedDate) cls.push('is-selected');
      grid.append(
        h(
          'button',
          {
            class: cls.join(' '),
            type: 'button',
            disabled: !day,
            'aria-label': `${fmt(date, 'long')}${notes.length ? `, ${notes.join(', ')}` : ''}`,
            'aria-current': date === store.selectedDate ? 'date' : null,
            data: { date },
            onClick: () => onOpenDay(date),
          },
          h('span', { text: String(n + 1) }),
          mark,
        ),
      );
    }
  }

  return {
    render,
    /** Follows the day card: flips to its month and moves the selection. */
    select(date) {
      const target = monthStart(date);
      if (target !== month) {
        month = target;
      }
      render();
    },
  };
}
