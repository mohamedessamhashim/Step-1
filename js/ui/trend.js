// Self-assessment score trend: one line across the ten assessments in order,
// plus the schedule as a plain list (which is also the chart's table view).

import { fmt } from '../dates.js';
import { clear, h, svg } from './dom.js';

const shortName = (name) => {
  const m = /^\s*([A-Za-z])[A-Za-z]*\s*(\d+)\s*$/.exec(name);
  return m ? `${m[1].toUpperCase()}${m[2]}` : name.slice(0, 4);
};

export function createTrend(root, store, { onOpenDay }) {
  const chart = h('div', { class: 'trend' });
  const tip = h('div', { class: 'tip', role: 'tooltip', hidden: true });
  const list = h('ul', { class: 'sa-list' });
  const empty = h('p', { class: 'trend-empty' });
  root.append(h('h3', { class: 'sub-h', text: 'Self-assessments' }), chart, h('details', { class: 'fold' }, h('summary', { text: 'Schedule and scores' }), list));

  /** One row per assessment, in order: when it was taken or is planned, and the score. */
  function rows() {
    const { state, summary } = store;
    const planned = Object.fromEntries(summary.sa.map((s) => [s.id, s.date]));
    return state.assessments.order
      .map((id) => state.assessments.items.find((a) => a.id === id))
      .filter(Boolean)
      .map((a) => {
        const score = state.scores[a.id];
        return { id: a.id, name: a.name, taken: !!score, pct: score?.pct ?? null, date: score?.date ?? planned[a.id] ?? null };
      });
  }

  function render() {
    const data = rows();
    const scored = data.filter((d) => d.pct != null);
    const goal = store.state.settings.goalPct;

    clear(list);
    for (const d of data) {
      const when = d.date ? `${d.taken ? '' : 'planned '}${fmt(d.date, 'short')}` : 'not scheduled';
      const nameEl = d.date && d.date >= store.summary.start && d.date <= store.summary.exam ? h('button', { type: 'button', text: d.name, onClick: () => onOpenDay(d.date) }) : h('span', { text: d.name });
      list.append(h('li', null, nameEl, h('span', { class: 'when', text: when }), h('span', { class: 'score', text: d.pct != null ? `${d.pct}%` : d.taken ? 'taken' : '' })));
    }

    clear(chart);
    chart.append(tip);
    tip.hidden = true;
    if (!scored.length) {
      const next = data.find((d) => !d.taken && d.date);
      empty.textContent = next ? `No scores yet. ${next.name} is planned for ${fmt(next.date, 'short')}.` : 'No scores yet.';
      chart.append(empty);
      return;
    }

    const W = Math.max(260, Math.round(chart.clientWidth - 28) || 300);
    const H = 156;
    const m = { l: 30, r: 14, t: 18, b: 26 };
    const values = scored.map((d) => d.pct).concat(goal ? [goal] : []);
    let lo = Math.max(0, Math.floor((Math.min(...values) - 6) / 10) * 10);
    let hi = Math.min(100, Math.ceil((Math.max(...values) + 6) / 10) * 10);
    if (hi - lo < 20) {
      lo = Math.max(0, lo - 10);
      hi = Math.min(100, hi + 10);
    }
    const step = hi - lo > 50 ? 20 : 10;
    const x = (i) => m.l + ((W - m.l - m.r) * (i + 0.5)) / data.length;
    const y = (v) => m.t + (H - m.t - m.b) * (1 - (v - lo) / (hi - lo));
    const slot = (W - m.l - m.r) / data.length;

    const el = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `Self-assessment scores: ${scored.map((d) => `${d.name} ${d.pct}%`).join(', ')}` });
    for (let v = lo; v <= hi; v += step) {
      el.append(svg('line', { class: 'trend-grid', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }), svg('text', { class: 'trend-axis', x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end', text: String(v) }));
    }
    if (goal) {
      el.append(svg('line', { class: 'trend-goal', x1: m.l, x2: W - m.r, y1: y(goal), y2: y(goal) }), svg('text', { class: 'trend-axis', x: W - m.r, y: y(goal) - 5, 'text-anchor': 'end', text: `goal ${goal}` }));
    }
    data.forEach((d, i) => {
      el.append(svg('text', { class: 'trend-axis', x: x(i), y: H - 6, 'text-anchor': 'middle', text: shortName(d.name) }));
    });
    const points = data.map((d, i) => ({ ...d, i })).filter((d) => d.pct != null);
    if (points.length > 1) el.append(svg('path', { class: 'trend-line', d: points.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)} ${y(p.pct).toFixed(1)}`).join(' ') }));
    data.forEach((d, i) => {
      if (d.pct != null) el.append(svg('circle', { class: 'trend-dot', cx: x(i), cy: y(d.pct), r: 5 }));
      else el.append(svg('circle', { class: 'trend-dot-empty', cx: x(i), cy: y(lo), r: 3 }));
    });
    // Only the latest score is labelled on the chart; the rest are in the tooltip and the list.
    const latest = points[points.length - 1];
    const labelY = y(latest.pct) - 11 < 12 ? y(latest.pct) + 20 : y(latest.pct) - 11;
    el.append(svg('text', { class: 'trend-value', x: x(latest.i), y: labelY, 'text-anchor': latest.i === data.length - 1 ? 'end' : 'middle', text: `${latest.pct}%` }));

    // One wide hit area per assessment, so the pointer never has to land on a dot.
    data.forEach((d, i) => {
      const show = () => {
        const value = d.pct != null ? `${d.pct}%` : d.taken ? 'Taken, no score entered' : 'Not taken yet';
        const when = d.date ? ` · ${d.taken ? '' : 'planned '}${fmt(d.date, 'short')}` : '';
        clear(tip).append(h('div', { class: 'tip-value', text: value }), h('div', { class: 'tip-label', text: `${d.name}${when}` }));
        tip.hidden = false;
        const box = chart.getBoundingClientRect();
        const scale = el.getBoundingClientRect().width / W;
        const cx = 14 + x(i) * scale;
        tip.style.left = `${Math.min(Math.max(0, cx - tip.offsetWidth / 2), box.width - tip.offsetWidth)}px`;
        tip.style.top = `${Math.max(0, 14 + (d.pct != null ? y(d.pct) : y(lo)) * scale - tip.offsetHeight - 12)}px`;
      };
      el.append(
        svg('rect', {
          class: 'trend-hit',
          x: x(i) - slot / 2,
          y: 0,
          width: slot,
          height: H,
          tabindex: 0,
          role: 'button',
          'aria-label': `${d.name}: ${d.pct != null ? `${d.pct}%` : d.taken ? 'taken' : 'not taken yet'}`,
          onPointerenter: show,
          onPointerleave: () => (tip.hidden = true),
          onFocus: show,
          onBlur: () => (tip.hidden = true),
          onClick: () => d.date && onOpenDay(d.date),
          onKeydown: (e) => {
            if (e.key === 'Enter' && d.date) onOpenDay(d.date);
          },
        }),
      );
    });
    chart.append(el);
  }

  new ResizeObserver(() => {
    if (chart.querySelector('svg') && Math.abs(chart.clientWidth - 28 - Number(chart.querySelector('svg').getAttribute('width'))) > 12) render();
  }).observe(chart);

  return { render };
}
