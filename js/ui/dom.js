// Small DOM helpers shared by the UI modules.
// Text always goes in through textContent, never innerHTML: labels, names and
// imported data are user-supplied.

const SVG_NS = 'http://www.w3.org/2000/svg';

// Event handlers are kept on the element and called through one shared
// listener. That lets morphChildren() hand a kept element its new handlers.
const HANDLERS = Symbol('handlers');
function dispatch(e) {
  return this[HANDLERS]?.[e.type]?.call(this, e);
}
function listen(el, type, fn) {
  (el[HANDLERS] ??= {})[type] = fn;
  el.addEventListener(type, dispatch);
}

function apply(el, props) {
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.setAttribute('class', value);
    else if (key === 'text') el.textContent = value;
    else if (key === 'data') Object.assign(el.dataset, value);
    else if (key === 'style') Object.assign(el.style, value);
    else if (key.startsWith('on')) listen(el, key.slice(2).toLowerCase(), value);
    else if (key in el && !(el instanceof SVGElement) && key !== 'list' && key !== 'form') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** h('div', { class: 'x', onClick }, child, 'text') */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  apply(el, props);
  return append(el, children);
}

export function svg(tag, props, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'text') el.textContent = value;
    else if (key.startsWith('on')) listen(el, key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value);
  }
  return append(el, children);
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

const ICONS = {
  left: 'M15 5l-7 7 7 7',
  right: 'M9 5l7 7-7 7',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  close: 'M6 6l12 12M18 6L6 18',
  // settings: three sliders
  sliders: 'M4 7h9 M17 7h3 M13 7a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M4 12h3 M11 12h9 M7 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M4 17h8 M16 17h4 M12 17a2 2 0 1 0 4 0a2 2 0 1 0 -4 0',
  sun: 'M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0 -8z M12 2.5v2.5 M12 19v2.5 M4.2 4.2l1.8 1.8 M18 18l1.8 1.8 M2.5 12H5 M19 12h2.5 M4.2 19.8L6 18 M18 6l1.8 -1.8',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  cloud: 'M7 18.5a4.5 4.5 0 0 1 -0.6 -8.96A6 6 0 0 1 18 10a4.25 4.25 0 0 1 -0.5 8.5z',
  flag: 'M5 21V4 M5 4.5h11l-2 4l2 4H5',
  info: 'M12 21a9 9 0 1 0 0 -18a9 9 0 0 0 0 18z M12 11v5.5 M12 7.6v0.2',
  undo: 'M8 7L4 11l4 4 M4 11h10a5 5 0 0 1 0 10h-3',
};

export function icon(name, size = 20) {
  return svg(
    'svg',
    { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    svg('path', { d: ICONS[name] }),
  );
}

export const fmtN = (n) => Math.round(n).toLocaleString('en-US');
export const plural = (n, word, many = `${word}s`) => `${fmtN(n)} ${n === 1 ? word : many}`;
export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- sheets ----------

/**
 * Opens a modal sheet. `build(close)` returns { title, body, foot?, wide?, nav? }.
 * Returns { dialog, close, body } so callers can re-render the body in place.
 */
export function openSheet({ title, wide = false, onClose } = {}) {
  const dialog = h('dialog', { class: `sheet${wide ? ' is-wide' : ''}`, 'aria-label': title });
  const titleEl = h('h2', { class: 'sheet-title', text: title });
  const close = () => dialog.close();
  const head = h('div', { class: 'sheet-head' }, titleEl, h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onClick: close }, icon('close')));
  const nav = h('div', { class: 'settings-nav', role: 'tablist', hidden: true });
  const body = h('div', { class: 'sheet-body', tabIndex: -1 });
  const foot = h('div', { class: 'sheet-foot', hidden: true });
  dialog.append(head, nav, body, foot);
  dialog.addEventListener('close', () => {
    dialog.remove();
    onClose?.();
  });
  // A click on the backdrop (outside the sheet) closes it.
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
  });
  document.getElementById('sheets').append(dialog);
  dialog.showModal();
  body.focus({ preventScroll: true }); // so the first Tab goes to the first control, without a ring on Close
  return {
    dialog,
    close,
    body,
    nav,
    foot,
    setTitle: (t) => {
      titleEl.textContent = t;
    },
    setFoot: (...buttons) => {
      foot.hidden = buttons.length === 0;
      clear(foot).append(...buttons);
    },
  };
}

export const anySheetOpen = () => !!document.querySelector('dialog.sheet[open]');

/**
 * Makes `target`'s children match `nodes`, reusing the elements already there
 * wherever the tags line up. Because the elements stay, so do focus, the
 * on-screen keyboard, scroll position and a tap that is half-way through.
 *
 * Form fields: a field that is being typed in keeps its text; a field marked
 * data-keep (free text that is not saved state) is never overwritten.
 */
export function morphChildren(target, nodes) {
  const olds = [...target.childNodes];
  nodes.forEach((next, i) => {
    const old = olds[i];
    if (!old) target.append(next);
    else if (old.nodeType !== next.nodeType || old.nodeName !== next.nodeName || old.namespaceURI !== next.namespaceURI) target.replaceChild(next, old);
    else morphNode(old, next);
  });
  for (let i = nodes.length; i < olds.length; i++) olds[i].remove();
}

function morphNode(old, next) {
  if (old.nodeType !== 1) {
    if (old.nodeValue !== next.nodeValue) old.nodeValue = next.nodeValue;
    return;
  }
  const committed = old.hasAttribute('data-committed');
  for (const { name, value } of [...next.attributes]) if (old.getAttribute(name) !== value) old.setAttribute(name, value);
  for (const { name } of [...old.attributes]) if (!next.hasAttribute(name) && name !== 'open') old.removeAttribute(name);
  if (old[HANDLERS] || next[HANDLERS]) {
    old[HANDLERS] = next[HANDLERS] ?? {};
    for (const type of Object.keys(old[HANDLERS])) old.addEventListener(type, dispatch);
  }
  if (old.nodeName === 'INPUT' || old.nodeName === 'TEXTAREA') {
    if (old.type === 'checkbox' || old.type === 'radio') old.checked = next.checked;
    else if (old.type !== 'file' && !old.hasAttribute('data-keep')) {
      const typing = document.activeElement === old && !committed;
      if (!typing && old.value !== next.value) old.value = next.value;
    }
    return;
  }
  morphChildren(old, [...next.childNodes]);
  if (old.nodeName === 'SELECT' && old.value !== next.value) old.value = next.value;
}

// ---------- toasts ----------

/** Where a toast goes: inside the topmost open sheet (so it is not hidden behind it), else the page. */
function toastHost() {
  const open = document.querySelectorAll('dialog.sheet[open]');
  const top = open[open.length - 1];
  if (!top) return document.getElementById('toasts');
  let host = top.querySelector(':scope > .toasts');
  if (!host) {
    host = h('div', { class: 'toasts', 'aria-live': 'polite' });
    top.append(host);
  }
  return host;
}

export function toast(message, { action, onAction, ms = 4500 } = {}) {
  const host = toastHost();
  const el = h('div', { class: 'toast', role: 'status' }, h('span', { text: message }));
  const leave = () => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 260);
  };
  if (action) {
    el.append(
      h('button', {
        type: 'button',
        text: action,
        onClick: () => {
          onAction?.();
          leave();
        },
      }),
    );
  }
  host.append(el);
  setTimeout(leave, ms);
  return el;
}
