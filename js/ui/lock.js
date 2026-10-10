// Optional passcode screen. This is a convenience to keep the planner from
// opening at a glance, not security: the data sits unencrypted in this
// browser's localStorage, and clearing the lock entry removes the passcode.

import { KEYS, readJson, writeJson } from '../storage.js';
import { h } from './dom.js';

const UNLOCKED = 'step1.unlocked';

async function digest(salt, code) {
  const text = `${salt}:${code}`;
  if (globalThis.crypto?.subtle) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // crypto.subtle is missing on plain http (other than localhost). A simple hash will do for a convenience lock.
  let a = 0xdeadbeef;
  let b = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  return `x${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}

export const hasLock = (storage) => !!readJson(storage, KEYS.lock)?.hash;

export async function setLock(storage, code) {
  const salt = Math.random().toString(36).slice(2) + Date.now().toString(36);
  writeJson(storage, KEYS.lock, { salt, hash: await digest(salt, code) });
  try {
    sessionStorage.setItem(UNLOCKED, '1');
  } catch {
    /* fine */
  }
}

export const clearLock = (storage) => writeJson(storage, KEYS.lock, null);

async function matches(storage, code) {
  const lock = readJson(storage, KEYS.lock);
  return !!lock && (await digest(lock.salt, code)) === lock.hash;
}

/** Resolves once the planner may be shown: straight away when no passcode is set. */
export function unlock(root, storage) {
  let open = false;
  try {
    open = sessionStorage.getItem(UNLOCKED) === '1';
  } catch {
    /* fine */
  }
  if (!hasLock(storage) || open) return Promise.resolve();

  return new Promise((resolve) => {
    const input = h('input', { class: 'input', type: 'password', inputMode: 'numeric', autocomplete: 'off', 'aria-label': 'Passcode', placeholder: '••••' });
    const error = h('div', { class: 'lock-error', role: 'alert' });
    const card = h(
      'form',
      {
        class: 'lock-card',
        onSubmit: async (e) => {
          e.preventDefault();
          if (await matches(storage, input.value)) {
            try {
              sessionStorage.setItem(UNLOCKED, '1');
            } catch {
              /* fine */
            }
            root.hidden = true;
            root.replaceChildren();
            resolve();
            return;
          }
          error.textContent = 'That passcode is not right.';
          input.value = '';
          card.classList.remove('is-wrong');
          void card.offsetWidth;
          card.classList.add('is-wrong');
          input.focus();
        },
      },
      h('h1', { text: 'Step 1' }),
      h('p', { text: 'Enter your passcode to open the planner.' }),
      input,
      error,
      h('button', { class: 'btn btn-primary', type: 'submit', text: 'Unlock' }),
    );
    root.replaceChildren(card);
    root.hidden = false;
    input.focus();
  });
}
