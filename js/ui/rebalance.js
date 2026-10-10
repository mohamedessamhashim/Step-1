// The rebalance sheet (missed days, sick days, days off) and the exam-date
// sheet. Both show the regenerated plan as a preview before anything is applied.

import { addDays, diffDays, dow, fmt, isDate } from '../dates.js';
import { applyChange, undoLast, undoTarget } from '../model.js';
import { patchSettings, previewPatch, rebalanceOptions } from '../rebalance.js';
import { clear, fmtN, h, icon, openSheet, plural, svg, toast } from './dom.js';

const isWeekendDate = (d) => dow(d) === 0 || dow(d) === 6;

function finishText(p) {
  if (p.unscheduled > 0) return { text: `${plural(p.unscheduled, 'question')} do not fit before the exam`, flag: true };
  if (!p.qbankFinish) return { text: 'Already finished', flag: false };
  if (p.finishInDedicated) {
    const into = diffDays(p.dedicatedStart, p.qbankFinish) + 1;
    return { text: `${fmt(p.qbankFinish, 'short')}, day ${into} of dedicated`, flag: true };
  }
  return { text: `${fmt(p.qbankFinish, 'short')}, before dedicated starts`, flag: false };
}

/** A strip of thin bars: one per day for the next few weeks, changed days in the accent. */
function loadBars(preview) {
  const days = preview.loads.slice(0, 35);
  if (!days.length) return null;
  const W = 350;
  const H = 40;
  const step = W / days.length;
  const bw = Math.min(8, step - 2);
  const max = Math.max(1, ...days.map((d) => Math.max(d.load, d.was)));
  const el = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Questions per day over the next five weeks' });
  days.forEach((d, i) => {
    const x = i * step + (step - bw) / 2;
    if (d.type === 'sa') {
      const cx = x + bw / 2;
      el.append(svg('path', { class: 'bar-sa', d: `M${cx} ${H - 9}l3 3l-3 3l-3 -3z` }));
      return;
    }
    if (d.load <= 0) return;
    const bh = Math.max(2, (d.load / max) * (H - 6));
    const r = Math.min(2, bw / 2);
    // rounded top, square at the baseline
    el.append(svg('path', { class: `bar${d.load !== d.was ? ' is-changed' : ''}`, d: `M${x} ${H - 1}v${-(bh - r)}q0 ${-r} ${r} ${-r}h${bw - 2 * r}q${r} 0 ${r} ${r}v${bh - r}z` }));
  });
  el.append(svg('line', { class: 'bar-base', x1: 0, x2: W, y1: H - 0.5, y2: H - 0.5 }));
  return h('div', { class: 'bars' }, el, h('div', { class: 'bars-caption' }, h('span', { text: fmt(days[0].date, 'md') }), h('span', { text: fmt(days[days.length - 1].date, 'md') })));
}

function loadText(option, pace) {
  const changed = option.preview.loads.filter((l) => l.load !== l.was && l.phase === 'working');
  if (option.kind === 'push') return `Unchanged: ${pace.weekday} on weekdays, ${pace.weekend} at weekends`;
  if (option.kind === 'keep' || !changed.length) return 'Unchanged. The questions move to the end of the plan';
  if (option.kind === 'weekends') {
    const shown = changed.slice(0, 4).map((l) => `${fmt(l.date, 'short')}: ${l.load}`);
    return `${shown.join(' · ')}${changed.length > 4 ? ` · and ${changed.length - 4} more` : ''}`;
  }
  const weekday = Math.max(0, ...changed.filter((l) => !isWeekendDate(l.date)).map((l) => l.load));
  const weekend = Math.max(0, ...changed.filter((l) => isWeekendDate(l.date)).map((l) => l.load));
  const parts = [];
  if (weekday) parts.push(`${weekday} on weekdays`);
  if (weekend) parts.push(`${weekend} at weekends`);
  const last = changed[changed.length - 1].date;
  return `${parts.join(', ')} through ${fmt(last, 'short')}, then back to normal`;
}

const TITLES = {
  spread: 'Spread them over the coming days',
  push: 'Push the exam and keep the pace',
  weekends: 'Add them to the next weekends',
  keep: 'Leave the plan as it is',
};

/**
 * opts: { title, intro, days: [{date, planned, done, shortfall, sa}], missed, basePatch, sick, context }
 * `basePatch` is applied whichever option is chosen (for example the new day off).
 */
export function openRebalance(store, opts) {
  const { title, intro, days = [], missed, basePatch = {}, sick = null, context = '' } = opts;
  const sheet = openSheet({ title, onClose: opts.onClose });
  let pushDays = null;
  let choice = null;

  const baseInput = () => {
    const s = store.state;
    const log = sick ? { ...s.log, [sick]: { ...(s.log[sick] ?? {}), sick: true } } : s.log;
    return { ...s, log, settings: patchSettings(s.settings, basePatch) };
  };

  function apply(option) {
    const p = option.preview;
    const moved = missed - (option.uncovered ?? 0);
    const label =
      option.kind === 'spread'
        ? `Spread ${plural(moved, 'question')} over ${plural(Object.keys(option.patch.extras).length, 'day')}`
        : option.kind === 'weekends'
          ? `Added ${plural(moved, 'question')} to ${plural(Object.keys(option.patch.extras).length, 'weekend day')}`
          : option.kind === 'push'
            ? `Moved the exam ${plural(option.days, 'day')} later, to ${fmt(p.examDate, 'short')}`
            : missed > 0
              ? `Left ${plural(missed, 'question')} at the end of the plan`
              : 'No change to the plan';
    store.act(applyChange, {
      kind: opts.kind ?? option.kind,
      label: context ? `${context}: ${label.charAt(0).toLowerCase()}${label.slice(1)}` : label,
      patch: { ...basePatch, ...option.patch },
      sick,
      resolve: days.map((d) => d.date),
    });
    sheet.close();
    toast('Plan updated.', { action: 'Undo', onAction: () => store.act(undoLast) });
  }

  function render() {
    const options = rebalanceOptions(baseInput(), store.today, missed, { pushDays });
    const order = ['spread', 'push', 'weekends', 'keep'];
    if (!choice || !options[choice]) choice = order.find((k) => options[k]);
    const pace = store.state.settings.pace;

    const body = clear(sheet.body);
    if (intro) body.append(h('p', { text: intro }));
    if (days.length) {
      body.append(
        h(
          'ul',
          { class: 'missed-list' },
          days.map((d) => {
            const sa = d.sa ? store.state.assessments.items.find((a) => a.id === d.sa)?.name : null;
            const what = d.shortfall > 0 ? `${d.shortfall} of ${d.planned} questions not done` : `${sa ?? 'Self-assessment'} not taken`;
            return h(
              'li',
              null,
              h('span', null, h('b', { text: fmt(d.date, 'short') }), ` · ${what}${d.shortfall > 0 && sa ? `, ${sa} not taken` : ''}`),
              h('button', { class: 'link-btn', type: 'button', text: 'Log it instead', onClick: () => { sheet.close(); opts.onOpenDay?.(d.date); } }),
            );
          }),
        ),
      );
    }

    const list = h('div', { class: 'opts', role: 'radiogroup', 'aria-label': 'What to do' });
    for (const kind of order) {
      const option = options[kind];
      if (!option) {
        if (missed > 0) {
          list.append(h('div', { class: 'opt is-unavailable' }, h('div', { class: 'opt-title', text: TITLES[kind] }), h('div', { class: 'hint', text: kind === 'weekends' ? 'No weekend days with room are left before dedicated.' : 'No working days with room are left before dedicated.' })));
        }
        continue;
      }
      const p = option.preview;
      const finish = finishText(p);
      const facts = h('dl', { class: 'opt-facts' });
      const fact = (k, v, flag) => facts.append(h('dt', { text: k }), h('dd', { class: flag ? 'is-flag' : '', text: v }));
      fact('Exam', p.examShift ? `${fmt(p.examDate, 'full')} (${p.examShift > 0 ? '+' : ''}${plural(p.examShift, 'day')})` : `${fmt(p.examDate, 'short')}, unchanged`);
      fact('Daily load', loadText(option, pace));
      fact('Qbank done', finish.text, finish.flag);
      const ifLeft = options.keep.preview.leftAtDedicated;
      if (p.unscheduled === 0 && (p.leftAtDedicated > 0 || ifLeft > 0)) {
        fact('Left for dedicated', `${plural(p.leftAtDedicated, 'question')}${kind !== 'keep' && p.leftAtDedicated !== ifLeft ? `, down from ${fmtN(ifLeft)}` : ''}`);
      }
      fact('Busiest day', `${fmtN(p.peak)} questions`);
      const was = options.keep.preview.pagesPerHour;
      if (p.pagesPerHour && was && p.pagesPerHour !== was) fact('First Aid', `${was} → ${p.pagesPerHour} pages an hour`);
      if (option.uncovered > 0) fact('Left over', `${plural(option.uncovered, 'question')} do not fit under the caps and stay at the end`, true);

      const card = h(
        'label',
        { class: 'opt' },
        h('input', {
          type: 'radio',
          name: 'rebalance',
          value: kind,
          checked: choice === kind,
          data: { key: `opt-${kind}` },
          onChange: () => {
            choice = kind;
          },
        }),
        h('div', { class: 'opt-title', text: TITLES[kind] }),
        facts,
        kind === 'keep' ? null : loadBars(p),
      );
      if (kind === 'push') {
        const set = (n) => {
          pushDays = Math.max(1, Math.min(90, n));
          choice = 'push';
          render();
        };
        card.append(
          h(
            'div',
            { class: 'stepper' },
            h('button', { type: 'button', 'aria-label': 'One day fewer', text: '−', disabled: option.days <= 1, onClick: (e) => { e.preventDefault(); set(option.days - 1); } }),
            h('output', { text: plural(option.days, 'day') }),
            h('button', { type: 'button', 'aria-label': 'One day more', text: '+', onClick: (e) => { e.preventDefault(); set(option.days + 1); } }),
          ),
        );
      }
      list.append(card);
    }
    body.append(list);

    sheet.setFoot(
      h('button', { class: 'btn btn-quiet', type: 'button', text: 'Not now', onClick: () => sheet.close() }),
      h('button', { class: 'btn btn-primary', type: 'button', text: 'Apply', onClick: () => apply(rebalanceOptions(baseInput(), store.today, missed, { pushDays })[choice]) }),
    );
  }

  render();
  return sheet;
}

/** Pick a new exam date and see the plan it produces before applying it. */
export function openExamSheet(store) {
  const sheet = openSheet({ title: 'Exam date' });
  const current = store.state.settings.examDate;
  let picked = current;
  const out = h('div');
  const input = h('input', {
    class: 'input',
    type: 'date',
    value: current,
    min: addDays(store.today > store.state.settings.startDate ? store.today : store.state.settings.startDate, 1),
    'aria-label': 'Exam date',
    onInput: (e) => {
      picked = e.target.value;
      render();
    },
  });
  const applyBtn = h('button', {
    class: 'btn btn-primary',
    type: 'button',
    text: 'Apply',
    onClick: () => {
      store.act(applyChange, { kind: 'exam', label: `Exam date moved from ${fmt(current, 'short')} to ${fmt(picked, 'short')}`, patch: { examDate: picked } });
      sheet.close();
      toast('Exam date changed and the plan rebuilt.', { action: 'Undo', onAction: () => store.act(undoLast) });
    },
  });

  function render() {
    clear(out);
    const valid = isDate(picked) && picked > store.state.settings.startDate && picked > store.today;
    applyBtn.disabled = !valid || picked === current;
    if (!valid) {
      out.append(h('p', { class: 'notice is-flag', text: 'Pick a date after today and after the start date.' }));
      return;
    }
    const { preview, plan, current: before } = previewPatch(store.state, store.today, { examDate: picked });
    const finish = finishText(preview);
    const facts = h('dl', { class: 'opt-facts', style: { marginTop: '14px' } });
    const fact = (k, v, flag) => facts.append(h('dt', { text: k }), h('dd', { class: flag ? 'is-flag' : '', text: v }));
    fact('Exam', `${fmt(picked, 'full')}${preview.examShift ? ` (${preview.examShift > 0 ? '+' : '−'}${plural(Math.abs(preview.examShift), 'day')})` : ', unchanged'}`);
    fact('Dedicated', `${fmt(plan.summary.dedicatedStart, 'short')} to ${fmt(addDays(picked, -1), 'short')}`);
    fact('Qbank done', finish.text, finish.flag);
    const sa = plan.summary.sa;
    fact('Self-assessments', sa.length ? `${sa.length} scheduled, from ${fmt(sa[0].date, 'short')} to ${fmt(sa[sa.length - 1].date, 'short')}` : 'None left to schedule');
    if (plan.summary.saUnplaced.length) fact('Not scheduled', `${plural(plan.summary.saUnplaced.length, 'self-assessment')} do not fit`, true);
    if (plan.summary.pagesPerHour) {
      const was = before.summary.pagesPerHour;
      fact('First Aid', `${was && was !== plan.summary.pagesPerHour ? `${was} → ` : ''}${plan.summary.pagesPerHour} pages an hour${plan.summary.faFits ? '' : ', and still not finished before dedicated'}`, !plan.summary.faFits);
    }
    out.append(facts, loadBars(preview));
  }

  sheet.body.append(h('p', { text: 'Changing the date rebuilds the plan from today. Past days stay as they are.' }), h('label', { class: 'field', style: { marginTop: '14px' } }, h('span', { text: 'New exam date' }), input), out);
  sheet.setFoot(h('button', { class: 'btn btn-quiet', type: 'button', text: 'Cancel', onClick: () => sheet.close() }), applyBtn);
  render();
  return sheet;
}

/** The change history, newest first, with Undo on the latest undoable entry. */
export function renderHistory(container, store) {
  clear(container);
  const { history } = store.state;
  const target = undoTarget(store.state);
  if (!history.length) {
    container.append(h('p', { class: 'hint', text: 'Nothing yet. Rebalances, days off, exam-date and count changes are listed here.' }));
    return;
  }
  const list = h('ul', { class: 'history' });
  for (const entry of history.slice().reverse()) {
    const when = new Date(entry.at);
    list.append(
      h(
        'li',
        null,
        h('div', null, h('span', { class: entry.undone ? 'is-undone' : '', text: entry.label }), h('time', { text: `${when.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}${entry.undone ? ' · undone' : ''}` })),
        entry === target ? h('button', { class: 'btn btn-small', type: 'button', data: { key: 'undo' }, onClick: () => store.act(undoLast) }, icon('undo', 16), 'Undo') : null,
      ),
    );
  }
  container.append(list);
}
