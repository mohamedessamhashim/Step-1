// Optional cross-device sync through a private GitHub Gist.
//
// The whole state is one JSON file in the gist. Conflicts are settled by
// timestamp: whichever copy was edited last wins, and the caller keeps the
// losing copy as a local backup. `fetch` is passed in so this can be tested
// against a fake GitHub.

export const GIST_FILE = 'step1-planner.json';
export const GIST_DESCRIPTION = 'Step 1 planner data (private, written by the planner app)';
const API = 'https://api.github.com';

export class SyncError extends Error {
  /** kind: 'auth' | 'rate' | 'missing' | 'network' | 'api' */
  constructor(message, kind) {
    super(message);
    this.name = 'SyncError';
    this.kind = kind;
  }
}

/** Last write wins: 'pull' when the remote copy is newer, 'push' when the local one is. */
export function decide(local, remote) {
  if (!remote) return 'push';
  const l = local?.updatedAt ?? 0;
  const r = remote.updatedAt ?? 0;
  return r > l ? 'pull' : l > r ? 'push' : 'same';
}

export function createGistClient({ fetch, token }) {
  async function call(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        cache: 'no-store',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new SyncError('Could not reach GitHub. Your changes are saved on this device.', 'network');
    }
    if (res.ok) return res.json();
    if (res.status === 401) throw new SyncError('GitHub rejected the token. Check it in Settings.', 'auth');
    if (res.status === 403 || res.status === 429) {
      const limited = res.headers?.get?.('x-ratelimit-remaining') === '0' || res.status === 429;
      throw limited
        ? new SyncError('GitHub rate limit reached. Sync will retry later.', 'rate')
        : new SyncError('The token is not allowed to use gists. It needs the "gist" scope.', 'auth');
    }
    if (res.status === 404) throw new SyncError('The sync gist was not found.', 'missing');
    throw new SyncError(`GitHub answered with an error (${res.status}).`, 'api');
  }

  const files = (state) => ({ [GIST_FILE]: { content: JSON.stringify(state) } });

  return {
    /** Finds the planner gist among the account's gists. Returns its id or null. */
    async find() {
      for (let page = 1; page <= 5; page++) {
        const list = await call(`/gists?per_page=100&page=${page}`);
        const hit = list.find((g) => g.files && g.files[GIST_FILE]);
        if (hit) return hit.id;
        if (list.length < 100) break;
      }
      return null;
    },
    /** The raw saved object, or null when the gist has no usable planner file. */
    async read(id) {
      const gist = await call(`/gists/${id}`);
      const file = gist.files?.[GIST_FILE];
      if (!file) return null;
      let text = file.content;
      if (file.truncated && file.raw_url) {
        try {
          text = await (await fetch(file.raw_url, { cache: 'no-store' })).text();
        } catch {
          throw new SyncError('Could not download the synced data.', 'network');
        }
      }
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
    async create(state) {
      const gist = await call('/gists', { method: 'POST', body: { description: GIST_DESCRIPTION, public: false, files: files(state) } });
      return gist.id;
    },
    async write(id, state) {
      await call(`/gists/${id}`, { method: 'PATCH', body: { files: files(state) } });
    },
  };
}

/**
 * One round of sync. Returns { action, gistId, state? } where action is
 * 'created' | 'pulled' | 'pushed' | 'same'. On 'pulled', `state` is the newer remote copy.
 * `accept(raw)` turns the remote object into a valid state, or throws if it is not one.
 */
export async function syncOnce({ client, gistId, local, accept }) {
  let id = gistId || (await client.find());
  if (!id) return { action: 'created', gistId: await client.create(local) };

  let raw;
  try {
    raw = await client.read(id);
  } catch (err) {
    if (err.kind !== 'missing') throw err;
    // The saved gist was deleted: look for another, or start a new one.
    id = await client.find();
    if (!id) return { action: 'created', gistId: await client.create(local) };
    raw = await client.read(id);
  }

  let remote = null;
  if (raw) {
    try {
      remote = accept(raw);
    } catch {
      remote = null; // unreadable remote copy: the local one replaces it
    }
  }

  const action = decide(local, remote);
  if (action === 'pull') return { action: 'pulled', gistId: id, state: remote };
  if (action === 'push') {
    await client.write(id, local);
    return { action: 'pushed', gistId: id };
  }
  return { action: 'same', gistId: id };
}
