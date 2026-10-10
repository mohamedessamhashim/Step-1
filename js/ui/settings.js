// The Settings sheet: pace and dates, qbank counts, First Aid, self-assessments,
// days off, data and sync, appearance, and the change history.
// Fields save as soon as they are changed; there is no Save button.

import { SEED } from '../../data/seed.js';
import { addDays, fmt, isDate, range } from '../dates.js';
import { clearScore, firstAidRead, moveInOrder, remainingBySystem, setScore, updateAssessment, updateChapter, updateCounts, updateSetting, updateSystem } from '../model.js';
import { parseDashboard } from '../parse.js';
import { chapterRanges } from '../planner.js';
import { clear, fmtN, h, icon, morphChildren, openSheet, plural, toast } from './dom.js';
import { clearLock, hasLock, setLock } from './lock.js';
import { renderHistory } from './rebalance.js';

const SECTIONS = [
  ['plan', 'Plan'],
  ['qbank', 'Qbank'],
  ['firstaid', 'First Aid'],
  ['sa', 'Self-assessments'],
  ['off', 'Days off'],
  ['data', 'Data & sync'],
  ['look', 'Appearance & lock'],
  ['history', 'History'],
];

const TOTAL_LABELS = { all: 'All questions', unused: 'Unused', used: 'Used', correct: 'Correct', incorrect: 'Incorrect', marked: 'Marked', omitted: 'Omitted' };

export function openSettings(store, app, start = 'plan') {
  let section = start;
  let draft = null; // qbank counts waiting for "Update counts": { systems, subjects, totals, note }
  const sheet = openSheet({
    title: 'Settings',
    wide: true,
    onClose: () => {
      unsubscribe();
      app.onSettingsClosed?.();
    },
  });
  sheet.nav.hidden = false;
  const body = sheet.body;
  body.classList.add('settings-body');
  // Mark a field as committed before its own handler runs, so the update shows the saved value in it.
  body.addEventListener(
    'change',
    (e) => {
      if (e.target instanceof HTMLElement) e.target.dataset.committed = '1';
    },
    true,
  );

  // Updates the open section in place, so the field being edited and the button being tapped stay put.
  const refresh = () => morphChildren(body, content());
  const set = (path, value, label) => store.act(updateSetting, path, value, SEED.settings, label);
  // Handlers look fields up when they run. The sheet is updated in place, so an element
  // captured while building a section may not be the one on screen.
  const field = (key) => body.querySelector(`[data-key="${key}"]`);
  const getSetting = (path) => path.split('.').reduce((o, k) => o?.[k], store.state.settings);

  // ----- field builders -----

  /**
   * A text field for whole numbers. It commits when the field is left or Enter is
   * pressed; an empty field commits null. With `live`, it commits on every
   * keystroke instead (used where a button depends on what has been typed).
   */
  const numberInput = (key, label, value, { min = 0, max = 9999, placeholder = '', live = false, onCommit }) => {
    const commit = (e) => {
      const raw = e.target.value.trim();
      if (raw === '') return onCommit(null);
      const n = Number(raw);
      if (!Number.isFinite(n)) return refresh();
      return onCommit(Math.min(max, Math.max(min, Math.round(n))));
    };
    return h('input', {
      class: 'input is-narrow',
      type: 'text',
      inputMode: 'numeric',
      autocomplete: 'off',
      value: value === null || value === undefined ? '' : String(value),
      placeholder,
      'aria-label': label,
      data: { key },
      onInput: live ? commit : null,
      onChange: live ? () => refresh() : commit,
    });
  };

  const dateInput = (key, label, value, { min, max, onCommit }) =>
    h('input', {
      class: 'input is-date',
      type: 'date',
      value: value ?? '',
      min,
      max,
      'aria-label': label,
      data: { key },
      onChange: (e) => {
        if (e.target.value === '' || isDate(e.target.value)) onCommit(e.target.value || null);
      },
    });

  /** One setting per line: what it is on the left, the control on the right. */
  const row = (title, hint, control) => h('div', { class: 'form-row' }, h('div', null, h('div', { class: 'form-row-title', text: title }), hint ? h('div', { class: 'hint', text: hint }) : null), control);

  /** A numeric setting stored at `path` in settings. */
  const settingRow = (title, path, { hint, allowEmpty = false, ...limits } = {}) => {
    const current = getSetting(path);
    return row(
      title,
      hint,
      numberInput(path, title, current, {
        ...limits,
        onCommit: (v) => {
          if (v === null && !allowEmpty) return refresh();
          return set(path, v, `${title}: ${current ?? 'none'} → ${v ?? 'none'}`) || refresh();
        },
      }),
    );
  };

  const toggleRow = (key, title, hint, checked, onChange) =>
    row(title, hint, h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked, 'aria-label': title, data: { key }, onChange: (e) => onChange(e.target.checked) }), h('i')));

  const orderButtons = (list, id, i, n) =>
    h(
      'span',
      { class: 'order-btns' },
      h('button', { type: 'button', 'aria-label': 'Move up', disabled: i === 0, data: { key: `${list}-${id}-up` }, onClick: () => store.act(moveInOrder, list, id, -1) }, icon('up', 16)),
      h('button', { type: 'button', 'aria-label': 'Move down', disabled: i === n - 1, data: { key: `${list}-${id}-down` }, onClick: () => store.act(moveInOrder, list, id, 1) }, icon('down', 16)),
    );

  const group = (title, ...children) => h('section', null, h('h3', { text: title }), children);
  /** A small labelled field inside a list item. */
  const mini = (label, control, grow = false) => h('label', { class: `mini${grow ? ' is-grow' : ''}` }, h('span', { text: label }), control);
  const actions = (...children) => h('div', { style: { display: 'flex', gap: '10px', marginTop: '12px', flexWrap: 'wrap', alignItems: 'center' } }, children);

  // ----- sections -----

  function planSection() {
    const s = store.state.settings;
    const sum = store.summary;
    return [
      group(
        'Dates',
        row('Start date', null, dateInput('startDate', 'Start date', s.startDate, { max: addDays(s.examDate, -1), onCommit: (v) => (v ? set('startDate', v, `Start date: ${fmt(s.startDate, 'short')} → ${fmt(v, 'short')}`) : refresh()) })),
        row('Exam date', fmt(s.examDate, 'full'), h('button', { class: 'btn btn-small', type: 'button', text: 'Change', data: { key: 'exam' }, onClick: () => app.openExamSheet() })),
        settingRow('Dedicated days before the exam', 'dedicatedDays', { max: 60, hint: `Dedicated now starts ${fmt(sum.dedicatedStart, 'short')}. The last day is a rest day.` }),
      ),
      group(
        'Questions per day',
        settingRow('Weekdays', 'pace.weekday', { max: 400 }),
        settingRow('Saturdays and Sundays', 'pace.weekend', { max: 400 }),
        row('Weekend pace starts', 'Weekend days before this use the weekday number.', dateInput('pace.weekendFrom', 'Weekend pace starts', s.pace.weekendFrom, { onCommit: (v) => (v ? set('pace.weekendFrom', v, `Weekend pace starts ${fmt(v, 'short')}`) : refresh()) })),
        settingRow('Dedicated days', 'pace.dedicated', { max: 400 }),
        settingRow('Questions per block', 'pace.blockMax', { min: 1, max: 40, hint: 'Your qbank allows 40 at most.' }),
      ),
      group(
        'Catching up',
        settingRow('Most on a weekday', 'caps.weekday', { max: 400, hint: 'The ceiling when missed questions are spread over the coming days.' }),
        settingRow('Most on a weekend day', 'caps.weekend', { max: 400 }),
      ),
      group(
        'Daily tasks',
        toggleRow('anki', 'Anki reviews every morning', 'Listed first on each study day. Skipping it never counts against the day.', s.anki, (v) => set('anki', v, `Anki reviews: ${v ? 'on' : 'off'}`)),
        toggleRow('randomAfterSa1', 'Random blocks after self-assessment #1', 'Before it, blocks follow the day’s First Aid chapter. Dedicated is always random.', s.randomAfterSa1, (v) => set('randomAfterSa1', v, `Random blocks after self-assessment #1: ${v ? 'on' : 'off'}`)),
        settingRow('Review incorrects (minutes)', 'reviewMinutes', { max: 240 }),
      ),
    ];
  }

  function qbankSection() {
    const state = store.state;
    const left = remainingBySystem(state);
    const d = draft ?? { systems: {}, subjects: {}, totals: {} };
    const pending = Object.keys(d.systems).length + Object.keys(d.subjects).length + Object.keys(d.totals).length;
    const edit = (kind, key, v) => {
      draft ??= { systems: {}, subjects: {}, totals: {} };
      if (v === null) delete draft[kind][key];
      else draft[kind][key] = v;
      refresh();
    };
    const paste = h('textarea', { class: 'textarea', placeholder: 'Paste the text of your qbank dashboard here: system names with their unused counts, in any layout.', data: { key: 'paste', keep: '' }, 'aria-label': 'Dashboard text' });
    const systemsTotal = state.qbank.systems.reduce((a, s) => a + (d.systems[s.id] ?? left[s.id]), 0);
    const unusedTotal = d.totals.unused ?? state.qbank.totals.unused;

    const read = () => {
      const r = parseDashboard(field('paste').value, { systems: state.qbank.systems, subjects: state.qbank.subjects });
      if (!r.found.systems && !r.found.subjects && !r.found.totals) {
        toast('No counts were recognised in that text.');
        return;
      }
      const missing = r.found.systems && r.missingSystems.length ? ` Not found: ${r.missingSystems.slice(0, 4).join(', ')}${r.missingSystems.length > 4 ? ` and ${r.missingSystems.length - 4} more` : ''}.` : '';
      const keep = (found, current) => Object.fromEntries(Object.entries(found).filter(([k, v]) => v !== current(k)));
      draft = {
        systems: keep(r.systems, (id) => left[id]),
        subjects: keep(r.subjects, (name) => state.qbank.subjects.find((s) => s.name === name)?.unused),
        totals: keep(r.totals, (key) => state.qbank.totals[key]),
        note: `Read ${plural(r.found.systems, 'system')}, ${plural(r.found.subjects, 'subject')} and ${plural(r.found.totals, 'total')}.${missing}`,
      };
      refresh();
    };

    return [
      group(
        'Update from the dashboard',
        paste,
        actions(h('button', { class: 'btn', type: 'button', text: 'Read the pasted text', data: { key: 'parse' }, onClick: read }), h('span', { class: 'hint', text: 'Nothing changes until you press Update counts.' })),
        draft?.note ? h('p', { class: 'notice', style: { marginTop: '12px' }, text: `${draft.note} ${pending ? 'Check the changed numbers below, then update.' : 'They match what is already here.'}` }) : null,
      ),
      group(
        'Unused questions by system',
        h(
          'div',
          { class: 'items' },
          state.qbank.systems.map((s) => {
            const now = left[s.id];
            const next = d.systems[s.id];
            const changed = next !== undefined && next !== now;
            const chapter = h(
              'select',
              { class: 'select', data: { key: `map-${s.id}` }, onChange: (e) => store.act(updateSystem, s.id, { chapter: e.target.value || null }) },
              h('option', { value: '', text: 'Random blocks only', selected: !s.chapter }),
              state.firstAid.chapters.map((c) => h('option', { value: c.id, text: c.name, selected: s.chapter === c.id })),
            );
            return h(
              'div',
              { class: 'item no-order' },
              h('div', { class: 'item-name' }, s.name, changed ? h('div', { class: `hint num ${next > now ? 'diff-up' : 'diff-down'}`, text: `${fmtN(now)} → ${fmtN(next)}` }) : null),
              h('div', { class: 'item-fields' }, mini('Unused now', numberInput(`sys-${s.id}`, `${s.name}: unused`, next ?? now, { max: 99999, live: true, onCommit: (v) => edit('systems', s.id, v === null || v === now ? null : v) })), mini('First Aid chapter', chapter, true)),
            );
          }),
        ),
        h('p', { class: `hint num${systemsTotal !== unusedTotal ? ' diff-up' : ''}`, style: { marginTop: '10px' }, text: `The systems add up to ${fmtN(systemsTotal)}${systemsTotal !== unusedTotal ? `, but the Unused total below says ${fmtN(unusedTotal)}` : ', matching the Unused total'}.` }),
      ),
      group('Totals', h('div', { class: 'rows-2' }, Object.keys(TOTAL_LABELS).map((key) => row(TOTAL_LABELS[key], null, numberInput(`total-${key}`, TOTAL_LABELS[key], d.totals[key] ?? state.qbank.totals[key], { max: 99999, live: true, onCommit: (v) => edit('totals', key, v === null || v === state.qbank.totals[key] ? null : v) }))))),
      group('Unused by subject (for reference)', h('div', { class: 'rows-2' }, state.qbank.subjects.map((s) => row(s.name, null, numberInput(`sub-${s.name}`, `${s.name}: unused`, d.subjects[s.name] ?? s.unused, { max: 99999, live: true, onCommit: (v) => edit('subjects', s.name, v === null || v === s.unused ? null : v) }))))),
      h(
        'section',
        null,
        actions(
          h('button', {
            class: 'btn btn-primary',
            type: 'button',
            text: pending ? `Update counts (${plural(pending, 'change')})` : 'Update counts',
            disabled: !pending,
            data: { key: 'apply-counts' },
            onClick: () => {
              const counts = draft;
              draft = null;
              store.act(updateCounts, counts, store.today);
              toast(`Counts updated: ${fmtN(store.stats.left)} unused. The plan has been rebuilt.`);
            },
          }),
          pending
            ? h('button', {
                class: 'btn btn-quiet',
                type: 'button',
                text: 'Discard',
                data: { key: 'discard-counts' },
                onClick: () => {
                  draft = null;
                  refresh();
                },
              })
            : null,
        ),
      ),
    ];
  }

  function firstAidSection() {
    const state = store.state;
    const sum = store.summary;
    const ranges = chapterRanges(state.firstAid);
    const read = firstAidRead(state);
    const byId = Object.fromEntries(state.firstAid.chapters.map((c) => [c.id, c]));
    const order = state.firstAid.order;
    const pace = state.settings.fa.pagesPerHour;
    const paceNote = !sum.faFits
      ? h('p', { class: 'notice is-flag', style: { marginTop: '12px' }, text: sum.firstOpen >= sum.dedicatedStart ? `${plural(sum.faOverflow, 'hour')} of chapter reading ${sum.faOverflow === 1 ? 'is' : 'are'} still unread, and dedicated has started.` : `At this pace ${plural(sum.faOverflow, 'hour')} of reading will not fit before dedicated starts.` })
      : sum.faFinish
        ? h('p', { class: 'hint', style: { marginTop: '10px' }, text: `${sum.pagesPerHour ? `At ${sum.pagesPerHour} pages an hour the` : 'The'} last chapter finishes on ${fmt(sum.faFinish, 'short')}.` })
        : null;
    return [
      group(
        'Pace',
        row(
          'Pages per hour',
          'Leave empty and it is worked out so every chapter finishes before dedicated.',
          numberInput('fa.pagesPerHour', 'Pages per hour', pace, { min: 1, max: 200, placeholder: sum.pagesAuto && sum.pagesPerHour ? `auto: ${sum.pagesPerHour}` : 'auto', onCommit: (v) => set('fa.pagesPerHour', v, `First Aid pace: ${pace ?? 'auto'} → ${v ?? 'auto'}`) || refresh() }),
        ),
        toggleRow('fa.onSaDays', 'First Aid on self-assessment days', 'Turning this off leaves fewer reading days, so the pace goes up.', state.settings.fa.onSaDays, (v) => set('fa.onSaDays', v, `First Aid on self-assessment days: ${v ? 'on' : 'off'}`)),
        paceNote,
      ),
      group(
        'Chapters, in reading order',
        h(
          'div',
          { class: 'items' },
          order.map((id, i) => {
            const c = byId[id];
            const r = ranges[id];
            const paged = r.pages != null;
            const progressFields = paged
              ? mini('Pages read', numberInput(`ch-${id}-read`, `${c.name}: pages read`, Math.min(r.pages, read[id].pages), { max: r.pages, onCommit: (v) => store.act(updateChapter, id, { pagesRead: v ?? 0 }) || refresh() }))
              : [
                  mini('Hours', numberInput(`ch-${id}-hours`, `${c.name}: hours`, c.estHours, { max: 60, onCommit: (v) => store.act(updateChapter, id, { estHours: v ?? 0 }) || refresh() })),
                  mini('Hours done', numberInput(`ch-${id}-sessions`, `${c.name}: hours done`, Math.min(c.estHours, read[id].sessions), { max: 60, onCommit: (v) => store.act(updateChapter, id, { sessionsDone: v ?? 0 }) || refresh() })),
                ];
            return h(
              'div',
              { class: 'item' },
              orderButtons('firstAid', id, i, order.length),
              h('div', { class: 'item-name' }, c.name, h('div', { class: 'hint num', text: paged ? `pp. ${r.start}–${r.end} · ${plural(r.pages, 'page')}` : `By time: ${plural(c.estHours, 'hour')}, until pages are entered` })),
              h(
                'div',
                { class: 'item-fields' },
                mini('Start page', numberInput(`ch-${id}-start`, `${c.name}: start page`, c.start, { min: 1, max: 5000, placeholder: '–', onCommit: (v) => store.act(updateChapter, id, { start: v }) })),
                mini('End page', numberInput(`ch-${id}-end`, `${c.name}: end page`, c.end, { min: 1, max: 5000, placeholder: r.derivedEnd ? String(r.end) : '–', onCommit: (v) => store.act(updateChapter, id, { end: v }) })),
                progressFields,
              ),
            );
          }),
        ),
        h('p', { class: 'hint', style: { marginTop: '10px' }, text: 'An empty end page uses the next chapter’s start page minus one. A chapter with no page range is planned by its hours.' }),
      ),
    ];
  }

  function saSection() {
    const state = store.state;
    const s = state.settings.sa;
    const planned = Object.fromEntries(store.summary.sa.map((x) => [x.id, x.date]));
    const order = state.assessments.order;
    const byId = Object.fromEntries(state.assessments.items.map((a) => [a.id, a]));
    const share = Math.round(s.startFraction * 100);
    return [
      group(
        'When',
        settingRow('On working-phase Saturdays', 'sa.workingCount', { max: order.length, hint: 'The first ones in the list below. The rest go in dedicated.' }),
        row('Start when this share is done (%)', 'The first one lands on the Saturday nearest this mark.', numberInput('sa.startFraction', 'Start when this share is done', share, { max: 100, onCommit: (v) => (v === null ? refresh() : set('sa.startFraction', v / 100, `Self-assessments start at ${v}% done (was ${share}%)`) || refresh()) })),
        settingRow('Days apart in dedicated', 'sa.spacing', { min: 1, max: 14 }),
        settingRow('Last one, days before the exam', 'sa.lastGap', { min: 1, max: 14 }),
      ),
      group(
        'Order and scores',
        h(
          'div',
          { class: 'items' },
          order.map((id, i) => {
            const a = byId[id];
            const score = state.scores[id];
            const where = i < s.workingCount ? 'Saturday' : 'Dedicated';
            const pct = h('input', {
              class: 'input is-narrow',
              type: 'text',
              inputMode: 'decimal',
              value: score?.pct ?? '',
              placeholder: '–',
              data: { key: `sa-${id}-pct` },
              onChange: (e) => {
                const v = e.target.value.trim();
                const date = score?.date ?? (store.today >= state.settings.startDate ? store.today : state.settings.startDate);
                store.act(setScore, id, { date, pct: v === '' ? null : Number(v) }) || refresh();
              },
            });
            return h(
              'div',
              { class: 'item' },
              orderButtons('assessments', id, i, order.length),
              h(
                'div',
                { class: 'item-name' },
                h('input', { class: 'input', type: 'text', value: a.name, 'aria-label': 'Name', data: { key: `sa-${id}-name` }, onChange: (e) => store.act(updateAssessment, id, { name: e.target.value }) || refresh() }),
                h('div', { class: 'hint', style: { marginTop: '4px' }, text: `${where} · ${score ? `taken ${fmt(score.date, 'short')}` : planned[id] ? `planned ${fmt(planned[id], 'short')}` : 'not scheduled'}` }),
              ),
              h(
                'div',
                { class: 'item-fields' },
                mini('Questions', numberInput(`sa-${id}-q`, `${a.name}: questions`, a.questions, { min: 1, max: 1000, onCommit: (v) => (v ? store.act(updateAssessment, id, { questions: v }) : refresh()) })),
                mini('Taken on', dateInput(`sa-${id}-date`, `${a.name}: taken on`, score?.date, { onCommit: (v) => (v ? store.act(setScore, id, { date: v }) : store.act(clearScore, id)) })),
                mini('% correct', pct),
                score ? h('button', { class: 'btn btn-small btn-quiet', type: 'button', text: 'Clear', data: { key: `sa-${id}-clear` }, onClick: () => store.act(clearScore, id) }) : null,
              ),
            );
          }),
        ),
      ),
    ];
  }

  function offSection() {
    const state = store.state;
    const entries = Object.entries(state.settings.daysOff);
    const field = (label, control) => h('label', { class: 'field' }, h('span', { text: label }), control);
    const from = h('input', { class: 'input', type: 'date', min: store.today, max: state.settings.examDate, data: { key: 'off-from', keep: '' } });
    const to = h('input', { class: 'input', type: 'date', min: store.today, max: state.settings.examDate, data: { key: 'off-to', keep: '' } });
    const label = h('input', { class: 'input', type: 'text', placeholder: 'Thanksgiving, travel…', maxLength: 60, data: { key: 'off-label', keep: '' } });
    const add = () => {
      const a = field('off-from').value;
      const b = field('off-to').value || a;
      if (!isDate(a) || !isDate(b) || b < a) {
        toast('Pick the first day off (and a later last day, if it is a range).');
        return;
      }
      app.addDaysOff(range(a, b), field('off-label').value.trim());
    };
    return [
      group(
        'Add days off',
        h('div', { class: 'form-grid' }, field('From', from), field('To (optional)', to), field('Label (optional)', label)),
        actions(h('button', { class: 'btn btn-primary', type: 'button', text: 'Add and rebalance', data: { key: 'off-add' }, onClick: add })),
        h('p', { class: 'hint', style: { marginTop: '10px' }, text: 'You will see where the displaced questions go before anything changes. A day can also be marked off from its card.' }),
      ),
      group(
        'Marked off',
        entries.length
          ? h('ul', { class: 'history' }, entries.map(([date, text]) => h('li', null, h('div', null, fmt(date, 'full'), text ? h('time', { text }) : null), h('button', { class: 'btn btn-small', type: 'button', text: 'Remove', data: { key: `off-${date}` }, onClick: () => app.removeDayOff(date) }))))
          : h('p', { class: 'hint', text: 'No days off yet.' }),
      ),
    ];
  }

  function dataSection() {
    const sync = app.sync.info();
    const backup = app.backupInfo();
    const token = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: 'ghp_…', data: { key: 'token', keep: '' }, 'aria-label': 'GitHub token' });
    const importInput = h('input', {
      type: 'file',
      accept: 'application/json,.json',
      hidden: true,
      data: { key: 'import-file' },
      onChange: (e) => {
        if (e.target.files[0]) app.importFile(e.target.files[0]);
        e.target.value = '';
      },
    });
    return [
      group(
        'Backup',
        h('p', { class: 'hint', text: 'Everything is saved in this browser as you go. A JSON file is a backup you can keep or move to another device.' }),
        actions(h('button', { class: 'btn', type: 'button', text: 'Export JSON', data: { key: 'export' }, onClick: () => app.exportFile() }), h('button', { class: 'btn', type: 'button', text: 'Import JSON', data: { key: 'import' }, onClick: () => field('import-file').click() }), importInput),
        backup ? h('div', { style: { marginTop: '12px' } }, row('Previous copy on this device', `${backup.reason}, ${new Date(backup.at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`, h('button', { class: 'btn btn-small', type: 'button', text: 'Restore', data: { key: 'restore' }, onClick: () => app.restoreBackup() }))) : null,
      ),
      group(
        'Sync between devices',
        sync.connected
          ? [
              h('p', { class: `notice${sync.status === 'error' ? ' is-flag' : ''}`, text: sync.text }),
              actions(h('button', { class: 'btn', type: 'button', text: 'Sync now', data: { key: 'sync-now' }, onClick: () => app.sync.now() }), h('button', { class: 'btn btn-quiet btn-warn', type: 'button', text: 'Disconnect this device', data: { key: 'sync-off' }, onClick: () => app.sync.disconnect() })),
            ]
          : [
              h('p', { class: 'hint' }, 'Optional. Paste a GitHub personal access token that has only the ', h('b', { text: 'gist' }), ' scope. The planner keeps your data in a private gist and loads the latest copy when it opens. The newest edit wins.'),
              actions(h('div', { style: { flex: '1 1 220px' } }, token), h('button', { class: 'btn btn-primary', type: 'button', text: 'Connect', data: { key: 'sync-on' }, onClick: () => app.sync.connect(field('token').value.trim()) })),
              h('p', { class: 'hint', style: { marginTop: '10px' } }, h('a', { href: 'https://github.com/settings/tokens/new?scopes=gist&description=Step%201%20planner', target: '_blank', rel: 'noopener', text: 'Create a token on GitHub' }), '. It is stored only in this browser and is never put in the gist, the export file or the site’s code.'),
            ],
      ),
      group('Start over', row('Reset to the starting data', 'Clears the log, scores and settings. A copy is kept for Restore.', h('button', { class: 'btn btn-small btn-warn', type: 'button', text: 'Reset', data: { key: 'reset' }, onClick: () => app.reset() }))),
    ];
  }

  function lookSection() {
    const theme = app.theme.get();
    const locked = hasLock(localStorage);
    const code = h('input', { class: 'input', type: 'password', inputMode: 'numeric', autocomplete: 'new-password', placeholder: 'At least 4 characters', data: { key: 'code', keep: '' }, 'aria-label': 'New passcode' });
    const themeButton = ([value, text]) =>
      h('button', {
        type: 'button',
        text,
        'aria-pressed': String(theme === value),
        data: { key: `theme-${value}` },
        onClick: () => {
          app.theme.set(value);
          refresh();
        },
      });
    const savePasscode = async () => {
      const value = field('code').value;
      if (value.length < 4) {
        toast('Use at least 4 characters.');
        return;
      }
      await setLock(localStorage, value);
      toast('Passcode set for this device.');
      refresh();
    };
    return [
      group('Theme', row('Colours', 'Auto follows the device. The choice is kept per device.', h('div', { class: 'seg', role: 'group', 'aria-label': 'Theme' }, [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(themeButton)))),
      group('Score chart', settingRow('Goal line (% correct)', 'goalPct', { min: 1, max: 100, allowEmpty: true, placeholder: 'none', hint: 'Optional. Draws a dashed line on the self-assessment chart.' })),
      group(
        'Passcode',
        h('p', { class: 'hint', text: 'Asks for a passcode when the planner opens on this device. It is a convenience, not security: the data is not encrypted.' }),
        locked
          ? row(
              'A passcode is set',
              null,
              h('button', {
                class: 'btn btn-small',
                type: 'button',
                text: 'Remove',
                data: { key: 'lock-off' },
                onClick: () => {
                  clearLock(localStorage);
                  toast('Passcode removed.');
                  refresh();
                },
              }),
            )
          : actions(h('div', { style: { flex: '1 1 200px' } }, code), h('button', { class: 'btn', type: 'button', text: 'Set passcode', data: { key: 'lock-on' }, onClick: savePasscode })),
      ),
    ];
  }

  function historySection() {
    const box = h('div');
    renderHistory(box, store);
    return [group('Changes to the plan', box)];
  }

  const content = () => builders[section]().flat(Infinity).filter(Boolean);
  const builders = { plan: planSection, qbank: qbankSection, firstaid: firstAidSection, sa: saSection, off: offSection, data: dataSection, look: lookSection, history: historySection };

  function render() {
    clear(sheet.nav).append(
      ...SECTIONS.map(([id, text]) =>
        h('button', {
          type: 'button',
          role: 'tab',
          text,
          'aria-selected': String(section === id),
          data: { section: id },
          onClick: () => {
            section = id;
            render();
            body.scrollTop = 0;
          },
        }),
      ),
    );
    clear(body).append(...content());
  }

  render();
  const unsubscribe = store.subscribe(refresh);
  return { close: sheet.close, refresh };
}
