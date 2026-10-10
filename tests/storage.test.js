import test from 'node:test';
import assert from 'node:assert/strict';

import { SEED } from '../data/seed.js';
import { applyChange, createState, replan, setBlockDone, setScore, toggleTask } from '../js/model.js';
import { exportJson, importJson, KEYS, loadBackup, loadState, migrate, readJson, saveBackup, saveState, writeJson } from '../js/storage.js';
import { createGistClient, decide, GIST_FILE, SyncError, syncOnce } from '../js/sync.js';

/** localStorage stand-in. `quota` makes writes fail once that many characters are stored. */
function fakeStorage(quota = Infinity) {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (String(v).length > quota) throw new Error('QuotaExceededError');
      map.set(k, String(v));
    },
    removeItem: (k) => map.delete(k),
  };
}

/** A state with a bit of everything in it. */
function usedState() {
  let { state } = replan(createState(SEED), '2026-10-12');
  state = setBlockDone(state, '2026-10-12', 'b0', 25, 1000);
  state = toggleTask(state, '2026-10-12', 'fa', true, 1100);
  state = setScore(state, 'nbme28', { date: '2026-11-07', pct: 64, weak: ['renal'] }, 1200);
  state = applyChange(state, { kind: 'dayoff', label: 'Thanksgiving off', patch: { daysOff: { '2026-11-26': 'Thanksgiving' } } }, 1300);
  return replan(state, '2026-10-12').state;
}

test('save and load round-trip the whole state', () => {
  const storage = fakeStorage();
  assert.equal(loadState(storage, SEED), null, 'nothing saved yet');
  const state = usedState();
  assert.equal(saveState(storage, state), true);
  assert.deepEqual(loadState(storage, SEED), state);
});

test('export and import round-trip, without anything device-specific', () => {
  const state = usedState();
  const text = exportJson(state, new Date('2026-10-12T20:00:00Z'));
  const file = JSON.parse(text);
  assert.equal(file.app, 'step1-planner');
  assert.equal(file.exported, '2026-10-12T20:00:00.000Z');
  assert.ok(!/token|passcode|ghp_/i.test(text), 'no token or passcode in the backup file');
  assert.deepEqual(importJson(text, SEED), state);
  // A bare state object (no wrapper) is accepted too.
  assert.deepEqual(importJson(JSON.stringify(state), SEED), state);
});

test('import rejects files that are not planner data', () => {
  assert.throws(() => importJson('not json', SEED), /not valid JSON/);
  assert.throws(() => importJson('{"hello":"world"}', SEED), /not a Step 1 planner file/);
  assert.throws(() => importJson('[1,2,3]', SEED), /not a Step 1 planner file/);
});

test('loading fills gaps and drops junk instead of failing', () => {
  const state = usedState();
  const damaged = structuredClone(state);
  delete damaged.settings.caps;
  delete damaged.history;
  damaged.settings.pace.blockMax = 400;
  damaged.qbank.systems[0].start = 'lots';
  damaged.log['not-a-date'] = { blocks: {} };
  damaged.log['2026-10-12'].blocks.b0.done = '25';
  damaged.scores.broken = { pct: 50 };
  damaged.plan.days.push({ nope: true });
  damaged.firstAid.order = ['cardiovascular', 'ghost'];

  const fixed = migrate(damaged, SEED);
  assert.deepEqual(fixed.settings.caps, SEED.settings.caps);
  assert.equal(fixed.settings.pace.blockMax, 40);
  assert.equal(fixed.qbank.systems[0].start, 0);
  assert.deepEqual(Object.keys(fixed.log), ['2026-10-12', '2026-11-07'], 'the junk date is dropped');
  assert.equal(fixed.log['2026-10-12'].blocks.b0.done, 25);
  assert.deepEqual(Object.keys(fixed.scores), ['nbme28']);
  assert.equal(fixed.plan.days.length, state.plan.days.length);
  assert.deepEqual(fixed.history, []);
  assert.equal(fixed.firstAid.order[0], 'cardiovascular');
  assert.equal(fixed.firstAid.order.length, 17, 'chapters missing from the order are put back');
  // The repaired state still plans.
  assert.equal(replan(fixed, '2026-10-13').state.plan.days.length, 79);
});

test('unreadable saved data is set aside, not overwritten', () => {
  const storage = fakeStorage();
  storage.setItem(KEYS.state, '{"settings": broken');
  assert.equal(loadState(storage, SEED), null);
  assert.equal(storage.getItem(KEYS.corrupt), '{"settings": broken');
});

test('a full or blocked localStorage reports failure instead of throwing', () => {
  const storage = fakeStorage(10);
  assert.equal(saveState(storage, usedState()), false);
  assert.equal(writeJson(storage, KEYS.theme, 'a very long value'), false);
  assert.equal(readJson(storage, KEYS.theme, 'auto'), 'auto');
});

test('the backup copy can be restored', () => {
  const storage = fakeStorage();
  const state = usedState();
  assert.equal(loadBackup(storage, SEED), null);
  saveBackup(storage, state, 'Replaced by a newer synced copy', 5000);
  const b = loadBackup(storage, SEED);
  assert.equal(b.at, 5000);
  assert.equal(b.reason, 'Replaced by a newer synced copy');
  assert.deepEqual(b.state, state);
});

// ---------- sync ----------

/** A tiny in-memory GitHub Gist API. */
function fakeGitHub({ token = 'good-token' } = {}) {
  const gists = new Map();
  const calls = [];
  let nextId = 1;
  let offline = false;
  const res = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: (k) => headers[k.toLowerCase()] ?? null } });
  const fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push(`${method} ${url.replace('https://api.github.com', '')}`);
    if (offline) throw new TypeError('Failed to fetch');
    if (init.headers?.Authorization !== `Bearer ${token}`) return res(401, { message: 'Bad credentials' });
    const path = url.replace('https://api.github.com', '');
    const body = init.body ? JSON.parse(init.body) : null;
    if (method === 'GET' && path.startsWith('/gists?')) return res(200, [...gists.values()].map((g) => ({ id: g.id, files: Object.fromEntries(Object.keys(g.files).map((f) => [f, {}])) })));
    if (method === 'POST' && path === '/gists') {
      const id = `g${nextId++}`;
      gists.set(id, { id, public: body.public, description: body.description, files: body.files });
      return res(201, { id });
    }
    const id = path.split('/')[2];
    if (!gists.has(id)) return res(404, { message: 'Not Found' });
    if (method === 'GET') return res(200, gists.get(id));
    if (method === 'PATCH') {
      Object.assign(gists.get(id).files, body.files);
      return res(200, { id });
    }
    return res(405, {});
  };
  return { fetch, gists, calls, setOffline: (v) => (offline = v) };
}

const accept = (raw) => migrate(raw, SEED);

test('newest edit wins', () => {
  assert.equal(decide({ updatedAt: 5 }, null), 'push');
  assert.equal(decide({ updatedAt: 5 }, { updatedAt: 9 }), 'pull');
  assert.equal(decide({ updatedAt: 9 }, { updatedAt: 5 }), 'push');
  assert.equal(decide({ updatedAt: 5 }, { updatedAt: 5 }), 'same');
  assert.equal(decide({ updatedAt: 0 }, { updatedAt: 1 }), 'pull', 'a device that was never used takes the synced copy');
});

test('first sync creates a private gist; a second device finds it and pulls', async () => {
  const hub = fakeGitHub();
  const client = createGistClient({ fetch: hub.fetch, token: 'good-token' });
  const phone = usedState();

  const first = await syncOnce({ client, gistId: null, local: phone, accept });
  assert.equal(first.action, 'created');
  const gist = hub.gists.get(first.gistId);
  assert.equal(gist.public, false, 'the gist must be private');
  assert.deepEqual(Object.keys(gist.files), [GIST_FILE]);
  assert.deepEqual(JSON.parse(gist.files[GIST_FILE].content), phone);
  assert.ok(!gist.files[GIST_FILE].content.includes('good-token'), 'the token is never written to the gist');

  // A new laptop has only the token: it finds the gist and takes the data.
  const laptop = createState(SEED);
  const second = await syncOnce({ client, gistId: null, local: laptop, accept });
  assert.equal(second.action, 'pulled');
  assert.equal(second.gistId, first.gistId);
  assert.deepEqual(second.state, phone);
  assert.equal(hub.gists.size, 1, 'no second gist is created');

  // Nothing changed since: nothing to do.
  assert.equal((await syncOnce({ client, gistId: first.gistId, local: phone, accept })).action, 'same');
});

test('pushes when local is newer, pulls when remote is newer', async () => {
  const hub = fakeGitHub();
  const client = createGistClient({ fetch: hub.fetch, token: 'good-token' });
  const v1 = usedState();
  const { gistId } = await syncOnce({ client, gistId: null, local: v1, accept });

  const v2 = setBlockDone(v1, '2026-10-12', 'b0', 40, v1.updatedAt + 500);
  hub.calls.length = 0;
  assert.equal((await syncOnce({ client, gistId, local: v2, accept })).action, 'pushed');
  assert.deepEqual(hub.calls, [`GET /gists/${gistId}`, `PATCH /gists/${gistId}`]);
  assert.equal(JSON.parse(hub.gists.get(gistId).files[GIST_FILE].content).log['2026-10-12'].blocks.b0.done, 40);

  // The stale device loses, whatever it has locally.
  const stale = await syncOnce({ client, gistId, local: v1, accept });
  assert.equal(stale.action, 'pulled');
  assert.equal(stale.state.updatedAt, v2.updatedAt);
});

test('a deleted gist is replaced, and an unreadable one is overwritten', async () => {
  const hub = fakeGitHub();
  const client = createGistClient({ fetch: hub.fetch, token: 'good-token' });
  const local = usedState();
  const again = await syncOnce({ client, gistId: 'gone', local, accept });
  assert.equal(again.action, 'created');

  hub.gists.get(again.gistId).files[GIST_FILE].content = '{"oops": true}';
  assert.equal((await syncOnce({ client, gistId: again.gistId, local, accept })).action, 'pushed');
  assert.deepEqual(JSON.parse(hub.gists.get(again.gistId).files[GIST_FILE].content), local);
});

test('bad token and no network are reported clearly and change nothing', async () => {
  const hub = fakeGitHub();
  const local = usedState();
  const bad = createGistClient({ fetch: hub.fetch, token: 'wrong' });
  await assert.rejects(syncOnce({ client: bad, gistId: null, local, accept }), (e) => e instanceof SyncError && e.kind === 'auth');
  assert.equal(hub.gists.size, 0);

  hub.setOffline(true);
  const client = createGistClient({ fetch: hub.fetch, token: 'good-token' });
  await assert.rejects(syncOnce({ client, gistId: null, local, accept }), (e) => e instanceof SyncError && e.kind === 'network');
  assert.equal(hub.gists.size, 0);
});
