// The day carousel. Five cards stay mounted (the current one and two on each
// side) and are placed with transforms, so the neighbours peek in from the
// edges. Dragging follows the pointer; letting go springs to the nearest card.

import { reducedMotion } from './dom.js';

const AROUND = 2; // cards kept mounted on each side
const GAP = 10; // px between cards
const STIFFNESS = 230;
const DAMPING = 25; // a little under critical, for a soft overshoot

export function createCarousel(stage, { count, render, update, onChange }) {
  let total = count;
  let index = 0;
  let offset = 0; // px the row is shifted by; 0 = current card centred
  let raf = 0;
  let drag = null;
  let draggedAt = 0;
  const slots = new Map(); // day index → slot element

  const clampIndex = (i) => Math.min(total - 1, Math.max(0, i));
  const stride = () => (slots.get(index)?.offsetWidth || stage.clientWidth) + GAP;

  function mount() {
    for (const [i, el] of slots) {
      if (Math.abs(i - index) > AROUND || i >= total) {
        el.remove();
        slots.delete(i);
      }
    }
    for (let i = Math.max(0, index - AROUND); i <= Math.min(total - 1, index + AROUND); i++) {
      if (slots.has(i)) continue;
      const el = document.createElement('div');
      el.className = 'slot';
      el.append(render(i));
      stage.append(el);
      slots.set(i, el);
    }
  }

  function layout() {
    const s = stride();
    for (const [i, el] of slots) {
      const rel = i - index + offset / s;
      const d = Math.min(1, Math.abs(rel));
      // A neighbour shrinks a little; pull it in by the same amount so its near edge stays one gap away and peeks.
      const x = rel * s - Math.sign(rel) * d * (s - GAP) * 0.03;
      el.style.transform = `translate3d(${x.toFixed(2)}px, ${(d * 10).toFixed(2)}px, 0) scale(${(1 - d * 0.06).toFixed(4)})`;
      el.style.opacity = (1 - d * 0.45).toFixed(3);
      el.style.zIndex = String(10 - Math.round(Math.abs(rel)));
      const current = i === index;
      el.classList.toggle('is-current', current);
      el.inert = !current;
    }
  }

  function syncHeight() {
    const el = slots.get(index);
    if (el) stage.style.height = `${el.offsetHeight}px`;
  }

  const resize = new ResizeObserver(() => {
    syncHeight();
    if (!drag && !raf) layout();
  });
  function observe() {
    resize.disconnect();
    resize.observe(stage);
    const el = slots.get(index);
    if (el) resize.observe(el);
  }

  function settle(velocity = 0) {
    cancelAnimationFrame(raf);
    raf = 0;
    if (reducedMotion() || Math.abs(offset) < 0.5) {
      offset = 0;
      layout();
      return;
    }
    let x = offset;
    let v = velocity * 1000; // px per second
    let last = performance.now();
    const frame = (now) => {
      const dt = Math.min(0.034, (now - last) / 1000) / 2;
      last = now;
      for (let n = 0; n < 2; n++) {
        v += (-STIFFNESS * x - DAMPING * v) * dt;
        x += v * dt;
      }
      offset = x;
      if (Math.abs(x) < 0.4 && Math.abs(v) < 10) {
        offset = 0;
        raf = 0;
        layout();
        return;
      }
      layout();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  }

  function go(to, velocity = 0) {
    const target = clampIndex(to);
    const delta = target - index;
    if (delta === 0) {
      settle(velocity);
      return;
    }
    const s = stride();
    index = target;
    // Keep what is on screen where it is, then let the spring bring the new card in.
    // A far jump (Today, a calendar tap) slides in from half a card away instead.
    offset = Math.abs(delta) <= AROUND ? offset + delta * s : Math.sign(delta) * s * 0.5;
    mount();
    layout();
    syncHeight();
    observe();
    onChange?.(index);
    settle(velocity);
  }

  // ----- pointer drag (touch and mouse) -----

  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest?.('input, textarea, select')) return;
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, active: false, lastX: e.clientX, lastT: e.timeStamp, v: 0, base: 0 };
  });

  stage.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.active) {
      const dx = e.clientX - drag.x0;
      const dy = e.clientY - drag.y0;
      if (Math.abs(dx) < 8) {
        if (Math.abs(dy) > 12) drag = null; // a vertical scroll, not a swipe
        return;
      }
      if (Math.abs(dy) > Math.abs(dx)) {
        drag = null;
        return;
      }
      drag.active = true;
      drag.x0 = e.clientX;
      drag.base = offset;
      cancelAnimationFrame(raf);
      raf = 0;
      try {
        stage.setPointerCapture(e.pointerId);
      } catch {
        /* capture is a nicety */
      }
      stage.classList.add('is-dragging');
    }
    const dt = e.timeStamp - drag.lastT;
    if (dt > 0) drag.v = 0.7 * ((e.clientX - drag.lastX) / dt) + 0.3 * drag.v;
    drag.lastX = e.clientX;
    drag.lastT = e.timeStamp;
    let next = drag.base + (e.clientX - drag.x0);
    // Rubber band at the first and last day.
    if ((index === 0 && next > 0) || (index === total - 1 && next < 0)) next *= 0.3;
    offset = next;
    layout();
  });

  const release = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (!d.active) return;
    stage.classList.remove('is-dragging');
    draggedAt = performance.now();
    const s = stride();
    const stale = e.timeStamp - d.lastT > 80; // finger rested before lifting: no fling
    const v = stale ? 0 : d.v;
    let target = index;
    if (e.type !== 'pointercancel') {
      if (offset < -s * 0.22 || v < -0.45) target = index + 1;
      else if (offset > s * 0.22 || v > 0.45) target = index - 1;
    }
    go(target, v);
  };
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);

  // A drag must not also count as a click on whatever was under the pointer.
  stage.addEventListener(
    'click',
    (e) => {
      if (performance.now() - draggedAt < 350) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // A tap on a peeking neighbour moves to it. (Neighbours are inert, so the click lands on the stage.)
      const current = slots.get(index);
      if (!current || current.contains(e.target)) return;
      const r = current.getBoundingClientRect();
      if (e.clientY < r.top || e.clientY > r.bottom + 40) return;
      if (e.clientX < r.left) go(index - 1);
      else if (e.clientX > r.right) go(index + 1);
    },
    true,
  );
  stage.addEventListener('dragstart', (e) => e.preventDefault());

  // Two-finger horizontal swipe on a trackpad: one step per gesture.
  let wheelSum = 0;
  let wheelQuietUntil = 0;
  stage.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      const now = performance.now();
      if (now < wheelQuietUntil) {
        wheelQuietUntil = now + 220; // still the tail of the same gesture
        return;
      }
      wheelSum += e.deltaX;
      if (Math.abs(wheelSum) > 50) {
        go(index + Math.sign(wheelSum));
        wheelSum = 0;
        wheelQuietUntil = now + 320;
      }
    },
    { passive: false },
  );

  window.addEventListener('resize', () => {
    if (!drag && !raf) layout();
    syncHeight();
  });

  return {
    get index() {
      return index;
    },
    go,
    next: () => go(index + 1),
    prev: () => go(index - 1),
    /** Shows a day immediately, with no animation. Used on first load. */
    show(i) {
      index = clampIndex(i);
      offset = 0;
      mount();
      layout();
      syncHeight();
      observe();
      onChange?.(index);
    },
    /** Called after the data changed: re-draws the mounted cards in place. */
    refresh(newCount = total) {
      total = newCount;
      const was = index;
      index = clampIndex(index);
      mount();
      for (const [i, el] of slots) {
        const card = el.firstElementChild;
        const next = update(card, i);
        if (next !== card) el.replaceChildren(next);
      }
      layout();
      syncHeight();
      observe();
      if (was !== index) onChange?.(index);
    },
  };
}
