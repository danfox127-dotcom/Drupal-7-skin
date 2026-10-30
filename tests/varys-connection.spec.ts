import { test, expect } from '@playwright/test';
import {
  CONNECTION_KEY, KEY_LEFT_LOCAL_BEFORE, acceptConnectMessage, getConnection, isValidKey, mayReplaceConnection,
  moveLegacyConnection, setConnection, toStatus,
} from '../src/lib/varys/connection';
import type { TrustedStore } from '../src/lib/varys/trustedStore';
import { VARYS_API, VARYS_APP_ORIGINS } from '../src/lib/varys/config';
import { assertProductionVarys, resolveVarys } from '../src/lib/varys/resolve';

/**
 * The Varys connection: who may hand the extension a key, and what is kept.
 *
 * The hand-off is the one place a web page talks to this extension, so the rules for
 * accepting it are pure functions and are tested here directly, with no browser. The
 * wiring (the manifest's externally_connectable, the worker's listener, the popup) is
 * covered end to end in tests/extension.test.ts.
 */

const APP = 'https://varys-wine.vercel.app';
const KEY = 'vxk_' + 'a'.repeat(43);
const message = (over: Record<string, unknown> = {}) =>
  ({ type: 'varysConnect', key: KEY, email: 'x@cumc.columbia.edu', ...over });

test.describe('acceptConnectMessage', () => {
  test('accepts a well-formed hand-off from the Varys app', () => {
    expect(acceptConnectMessage(message(), APP, [APP])).toEqual({
      ok: true, key: KEY, email: 'x@cumc.columbia.edu',
    });
  });

  test('rejects the same message from any other origin', () => {
    const from = (origin: string | undefined) => acceptConnectMessage(message(), origin, [APP]);
    expect(from('https://evil.example')).toEqual({ ok: false, error: 'origin' });
    // Origins that merely LOOK like the app: a downgrade, a prefix, a suffix, a port.
    expect(from('http://varys-wine.vercel.app')).toEqual({ ok: false, error: 'origin' });
    expect(from('https://evil-varys-wine.vercel.app')).toEqual({ ok: false, error: 'origin' });
    expect(from('https://varys-wine.vercel.app.evil.example')).toEqual({ ok: false, error: 'origin' });
    expect(from('https://varys-wine.vercel.app:8443')).toEqual({ ok: false, error: 'origin' });
    // No origin at all is not "probably fine".
    expect(from(undefined)).toEqual({ ok: false, error: 'origin' });
    expect(from('')).toEqual({ ok: false, error: 'origin' });
  });

  test('judges the origin before anything the message says', () => {
    // A stranger gets no hints about what a valid message looks like.
    expect(acceptConnectMessage({ type: 'nope', key: 'abc' }, 'https://evil.example', [APP]))
      .toEqual({ ok: false, error: 'origin' });
  });

  test('an empty allow-list accepts nothing', () => {
    expect(acceptConnectMessage(message(), APP, [])).toEqual({ ok: false, error: 'origin' });
  });

  test('rejects a key that is not a Varys key', () => {
    const bad = (key: unknown) => acceptConnectMessage(message({ key }), APP, [APP]);
    expect(bad('abc')).toEqual({ ok: false, error: 'key' });
    expect(bad('')).toEqual({ ok: false, error: 'key' });
    expect(bad(undefined)).toEqual({ ok: false, error: 'key' });
    expect(bad(12345)).toEqual({ ok: false, error: 'key' });
    expect(bad({ toString: () => KEY })).toEqual({ ok: false, error: 'key' });
    // The prefix is part of the format, not decoration.
    expect(bad('abc_' + 'a'.repeat(43))).toEqual({ ok: false, error: 'key' });
    // Too short by one character.
    expect(bad('vxk_' + 'a'.repeat(39))).toEqual({ ok: false, error: 'key' });
    // Characters outside the url-safe alphabet, including whitespace on either end.
    expect(bad('vxk_' + 'a'.repeat(42) + '!')).toEqual({ ok: false, error: 'key' });
    expect(bad(KEY + '\n')).toEqual({ ok: false, error: 'key' });
    expect(bad(' ' + KEY)).toEqual({ ok: false, error: 'key' });
  });

  test('rejects anything that is not a varysConnect message', () => {
    const bad = (m: unknown) => acceptConnectMessage(m, APP, [APP]);
    expect(bad(message({ type: 'fetchSource' }))).toEqual({ ok: false, error: 'type' });
    expect(bad(message({ type: undefined }))).toEqual({ ok: false, error: 'type' });
    expect(bad(null)).toEqual({ ok: false, error: 'type' });
    expect(bad(undefined)).toEqual({ ok: false, error: 'type' });
    expect(bad('varysConnect')).toEqual({ ok: false, error: 'type' });
    expect(bad([])).toEqual({ ok: false, error: 'type' });
  });

  test('rejects a hand-off with no usable email', () => {
    // The popup says "Connected as <email>", so a connection without one is a broken page.
    const bad = (email: unknown) => acceptConnectMessage(message({ email }), APP, [APP]);
    expect(bad(undefined)).toEqual({ ok: false, error: 'email' });
    expect(bad('')).toEqual({ ok: false, error: 'email' });
    expect(bad('   ')).toEqual({ ok: false, error: 'email' });
    expect(bad(42)).toEqual({ ok: false, error: 'email' });
    expect(bad('a'.repeat(400) + '@example.org')).toEqual({ ok: false, error: 'email' });
  });

  test('keeps only the fields it needs from a message that carries more', () => {
    const verdict = acceptConnectMessage(message({ admin: true, extra: 'x' }), APP, [APP]);
    expect(verdict).toEqual({ ok: true, key: KEY, email: 'x@cumc.columbia.edu' });
  });
});

test.describe('isValidKey', () => {
  test('is the same rule the hand-off uses', () => {
    expect(isValidKey(KEY)).toBe(true);
    expect(isValidKey('vxk_' + 'A1_-'.repeat(11))).toBe(true);
    expect(isValidKey('vxk_' + 'a'.repeat(39))).toBe(false);
    expect(isValidKey(null)).toBe(false);
  });
});

test.describe('what the popup may see', () => {
  test('a status never carries the key', () => {
    const status = toStatus({ key: KEY, email: 'x@cumc.columbia.edu', connectedAt: '2026-10-21T12:00:00.000Z' });
    expect(status).toEqual({
      email: 'x@cumc.columbia.edu', connectedAt: '2026-10-21T12:00:00.000Z', expired: false,
    });
    expect(JSON.stringify(status)).not.toContain('vxk_');
  });

  test('an expired connection says so', () => {
    expect(toStatus({ key: KEY, email: 'x@y.org', connectedAt: 'then', expired: true })?.expired).toBe(true);
  });

  test('no connection is no status, not an empty one', () => {
    expect(toStatus(null)).toBeNull();
  });
});

test.describe('the stored connection', () => {
  /**
   * The key lives in the trusted store (src/lib/varys/trustedStore.ts), which content scripts
   * cannot open. chrome.storage.local is where 0.7.x kept it, and is faked here only so the
   * one move out of it, on the update from 0.7.x, can be tested. Nothing else reads it.
   */
  const local: Record<string, unknown> = {};
  let localReads = 0;
  test.beforeEach(() => {
    for (const k of Object.keys(local)) delete local[k];
    localReads = 0;
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: async (keys: string | Record<string, unknown>) => {
            localReads++;
            const names = typeof keys === 'string' ? [keys] : Object.keys(keys);
            return Object.fromEntries(names.filter(k => k in local).map(k => [k, local[k]]));
          },
          set: async (items: Record<string, unknown>) => { Object.assign(local, items); },
          remove: async (key: string) => { delete local[key]; },
        },
      },
    };
  });
  test.afterEach(() => { delete (globalThis as unknown as { chrome?: unknown }).chrome; });

  /** An in-memory TrustedStore; `failFirstSet` makes its first write throw. */
  const fakeStore = (data = new Map<string, unknown>(), failFirstSet = false) => {
    let fail = failFirstSet;
    const store: TrustedStore = {
      get: async key => data.get(key),
      set: async (key, value) => {
        if (fail) { fail = false; throw new Error('disk full'); }
        data.set(key, structuredClone(value));
      },
      remove: async key => { data.delete(key); },
    };
    return { store, data };
  };

  const connection = { key: KEY, email: 'x@cumc.columbia.edu', connectedAt: '2026-10-21T12:00:00.000Z' };

  test('is kept in the trusted store, never in chrome.storage.local', async () => {
    const s = fakeStore();
    await setConnection(connection, s.store);
    expect(s.data.get(CONNECTION_KEY)).toEqual(connection);
    expect(CONNECTION_KEY).toBe('varysConnection');
    expect(Object.keys(local)).toEqual([]);
    expect(await getConnection(s.store)).toEqual(connection);
  });

  test('setting null forgets it, key and all', async () => {
    const s = fakeStore();
    await setConnection(connection, s.store);
    await setConnection(null, s.store);
    expect(await getConnection(s.store)).toBeNull();
    expect(s.data.has(CONNECTION_KEY)).toBe(false);
  });

  test('nothing stored reads as not connected', async () => {
    expect(await getConnection(fakeStore().store)).toBeNull();
  });

  test('a damaged record reads as not connected rather than as a connection', async () => {
    // Storage outlives a version of the extension. A record with a mangled key must not be
    // sent as a bearer token, and must not be shown as "connected".
    for (const bad of [
      'vxk_nope', 42, [], { ...connection, key: 'abc' }, { ...connection, email: undefined },
      { ...connection, connectedAt: 7 },
    ]) {
      const s = fakeStore();
      s.data.set(CONNECTION_KEY, bad);
      expect(await getConnection(s.store), JSON.stringify(bad)).toBeNull();
    }
  });

  test('keeps the expired flag, and drops anything it does not know', async () => {
    const s = fakeStore();
    s.data.set(CONNECTION_KEY, { ...connection, expired: true, surprise: 'x' });
    expect(await getConnection(s.store)).toEqual({ ...connection, expired: true });
  });

  const fromLocalEra = { reason: 'update', previousVersion: '0.7.1' } as const;

  test('an update from 0.7.x moves the connection across, then removes it', async () => {
    // Someone connected under 0.7.x updates: they stay connected, and the key leaves the area
    // content scripts can read.
    local[CONNECTION_KEY] = connection;
    const s = fakeStore();
    await moveLegacyConnection(fromLocalEra, s.store);
    expect(s.data.get(CONNECTION_KEY)).toEqual(connection);
    expect(Object.keys(local)).toEqual([]);
    expect(await getConnection(s.store)).toEqual(connection);
  });

  test('a fresh install never reads chrome.storage.local, and clears it', async () => {
    /**
     * Content scripts can WRITE chrome.storage.local. Whether to read it is decided by Chrome's
     * install event, which no page can raise, and never by what that area holds.
     */
    local[CONNECTION_KEY] = { ...connection, email: 'someone-else@example.com' };
    const s = fakeStore();
    await moveLegacyConnection({ reason: 'install' }, s.store);
    expect(localReads).toBe(0);
    expect(s.data.has(CONNECTION_KEY)).toBe(false);
    expect(Object.keys(local)).toEqual([]);
  });

  test('an update from a version that already used the trusted store never reads chrome.storage.local', async () => {
    for (const previousVersion of [KEY_LEFT_LOCAL_BEFORE, '0.8.0', '0.10.0', 'not a version']) {
      local[CONNECTION_KEY] = { ...connection, email: 'someone-else@example.com' };
      const s = fakeStore();
      await moveLegacyConnection({ reason: 'update', previousVersion }, s.store);
      expect(localReads, previousVersion).toBe(0);
      expect(s.data.has(CONNECTION_KEY), previousVersion).toBe(false);
      expect(Object.keys(local), previousVersion).toEqual([]);
    }
  });

  test('a browser update is not an extension update', async () => {
    local[CONNECTION_KEY] = connection;
    const s = fakeStore();
    await moveLegacyConnection({ reason: 'chrome_update' }, s.store);
    expect(localReads).toBe(0);
    expect(s.data.has(CONNECTION_KEY)).toBe(false);
  });

  test('a connection already in the trusted store is not replaced', async () => {
    const s = fakeStore();
    s.data.set(CONNECTION_KEY, connection);
    local[CONNECTION_KEY] = { ...connection, email: 'older@cumc.columbia.edu' };
    await moveLegacyConnection(fromLocalEra, s.store);
    expect(await getConnection(s.store)).toEqual(connection);
    expect(Object.keys(local)).toEqual([]);
  });

  test('a damaged 0.7 record is dropped, not moved', async () => {
    local[CONNECTION_KEY] = { ...connection, key: 'abc' };
    const s = fakeStore();
    await moveLegacyConnection(fromLocalEra, s.store);
    expect(s.data.has(CONNECTION_KEY)).toBe(false);
    expect(Object.keys(local)).toEqual([]);
  });

  test('a failed move reads as not connected, and still removes the old record', async () => {
    // There is no second chance: a later start has no install event to say the old area may be
    // read. The person reconnects; the key does not stay where content scripts can read it.
    local[CONNECTION_KEY] = connection;
    const s = fakeStore(new Map(), true);
    await moveLegacyConnection(fromLocalEra, s.store);
    expect(await getConnection(s.store)).toBeNull();
    expect(Object.keys(local)).toEqual([]);
  });

  test('a record in chrome.storage.local is never read as a connection', async () => {
    local[CONNECTION_KEY] = connection;
    expect(await getConnection(fakeStore().store)).toBeNull();
    expect(localReads).toBe(0);
  });

  test('a read waits for a move in progress', async () => {
    // The first message after an update can arrive while the move is still running.
    local[CONNECTION_KEY] = connection;
    const s = fakeStore();
    const moving = moveLegacyConnection(fromLocalEra, s.store);
    expect(await getConnection(s.store)).toEqual(connection);
    await moving;
  });
});

test.describe('where Varys is', () => {
  const PRODUCTION = { api: 'https://varys.fly.dev', appOrigins: ['https://varys-wine.vercel.app'] };
  const DEVELOPMENT = { api: 'http://localhost:8000', appOrigins: ['http://localhost:3000'] };

  test('the app code defaults to the production API and app', () => {
    // Outside a Vite build there is no import.meta.env, and the fallback is production.
    expect(VARYS_API).toBe('https://varys.fly.dev');
    expect(VARYS_APP_ORIGINS).toEqual(['https://varys-wine.vercel.app']);
  });

  test('a production build is production, whatever the environment says', () => {
    /**
     * The release script runs `npm run build` and nothing else, so a developer with
     * VITE_VARYS_API exported (or kept in a gitignored .env.local) would otherwise ship a
     * release that talks to localhost and lets localhost hand it a key.
     */
    expect(resolveVarys('production', {})).toEqual(PRODUCTION);
    expect(resolveVarys('production', undefined)).toEqual(PRODUCTION);
    expect(resolveVarys('production', {
      VITE_VARYS_API: 'http://localhost:8000',
      VITE_VARYS_APP_ORIGINS: 'http://localhost:3000',
    })).toEqual(PRODUCTION);
    expect(resolveVarys('production', {
      VITE_VARYS_API: 'https://api.example.org',
      VITE_VARYS_APP_ORIGINS: 'https://app.example.org,http://localhost:3000',
    })).toEqual(PRODUCTION);
  });

  test('the production answer cannot be changed by whoever called for it', () => {
    // A copy, so mutating a result cannot rewrite the constants the next build reads.
    const first = resolveVarys('production', {});
    first.appOrigins.push('http://localhost:3000');
    expect(resolveVarys('production', {})).toEqual(PRODUCTION);
  });

  test('a development build points at the local Varys by default', () => {
    expect(resolveVarys('development', {})).toEqual(DEVELOPMENT);
    expect(resolveVarys('development', undefined)).toEqual(DEVELOPMENT);
    // The local app is the FIRST origin, because Connect opens the first one.
    expect(resolveVarys('development', {}).appOrigins[0]).toBe('http://localhost:3000');
    // Any mode that is not production counts as development.
    expect(resolveVarys('staging', {})).toEqual(DEVELOPMENT);
  });

  test('a development build can be pointed elsewhere by the environment', () => {
    expect(resolveVarys('development', {
      VITE_VARYS_API: 'http://localhost:9000',
      VITE_VARYS_APP_ORIGINS: 'http://localhost:4000',
    })).toEqual({ api: 'http://localhost:9000', appOrigins: ['http://localhost:4000'] });
  });

  test('reduces what it is given to origins, so a permission pattern is always well formed', () => {
    // `api + '/*'` is a match pattern. A trailing slash or a path would make it `//*` or
    // a pattern for a path, which Chrome grants as something other than the whole API.
    expect(resolveVarys('development', {
      VITE_VARYS_API: 'https://api.example.org/',
      VITE_VARYS_APP_ORIGINS: 'https://app.example.org/x/',
    })).toEqual({ api: 'https://api.example.org', appOrigins: ['https://app.example.org'] });
  });

  test('takes a comma-separated list of apps and ignores junk entries', () => {
    expect(resolveVarys('development', {
      VITE_VARYS_APP_ORIGINS: 'https://a.example.org, nonsense ,https://b.example.org,javascript:alert(1)',
    }).appOrigins).toEqual(['https://a.example.org', 'https://b.example.org']);
  });

  test('falls back to the development defaults for empty or wholly invalid values', () => {
    expect(resolveVarys('development', { VITE_VARYS_API: '', VITE_VARYS_APP_ORIGINS: '' })).toEqual(DEVELOPMENT);
    expect(resolveVarys('development', { VITE_VARYS_API: 'not a url', VITE_VARYS_APP_ORIGINS: ' , nonsense' }))
      .toEqual(DEVELOPMENT);
  });
});

test.describe('the build-time guard on a production build', () => {
  const PRODUCTION = { api: 'https://varys.fly.dev', appOrigins: ['https://varys-wine.vercel.app'] };

  test('lets the production hosts through', () => {
    expect(() => assertProductionVarys(PRODUCTION)).not.toThrow();
    expect(() => assertProductionVarys(resolveVarys('production', {}))).not.toThrow();
  });

  test('throws, naming what it found, when a production build resolves to anything else', () => {
    expect(() => assertProductionVarys({ ...PRODUCTION, api: 'http://localhost:8000' }))
      .toThrow(/localhost:8000/);
    expect(() => assertProductionVarys({ ...PRODUCTION, appOrigins: ['http://localhost:3000'] }))
      .toThrow(/localhost:3000/);
    // Production plus one more is not production.
    expect(() => assertProductionVarys({
      ...PRODUCTION, appOrigins: [...PRODUCTION.appOrigins, 'https://evil.example'],
    })).toThrow(/evil\.example/);
    // Nor is an empty list, which would silently disable the hand-off.
    expect(() => assertProductionVarys({ ...PRODUCTION, appOrigins: [] })).toThrow();
  });

  test('throws when a resolver that stopped ignoring the environment is forced through it', () => {
    // What the guard is FOR: it is a second lock behind resolveVarys, so it is exercised
    // with a result resolveVarys would not produce today.
    const leaked = resolveVarys('development', {
      VITE_VARYS_API: 'http://localhost:8000', VITE_VARYS_APP_ORIGINS: 'http://localhost:3000',
    });
    expect(() => assertProductionVarys(leaked)).toThrow();
  });
});

test.describe('mayReplaceConnection', () => {
  const existing = { key: 'vxk_' + 'A'.repeat(43), email: 'me@columbia.edu', connectedAt: 'then' };

  test('a first connection, or the same account again, may be stored', () => {
    expect(mayReplaceConnection(null, 'me@columbia.edu')).toBe(true);
    expect(mayReplaceConnection(existing, 'me@columbia.edu')).toBe(true);
    expect(mayReplaceConnection(existing, ' ME@Columbia.edu ')).toBe(true);
    expect(mayReplaceConnection({ ...existing, expired: true }, 'me@columbia.edu')).toBe(true);
  });

  test('a different account never replaces it silently, expired or not', () => {
    expect(mayReplaceConnection(existing, 'someone.else@example.org')).toBe(false);
    expect(mayReplaceConnection({ ...existing, expired: true }, 'someone.else@example.org')).toBe(false);
  });
});
