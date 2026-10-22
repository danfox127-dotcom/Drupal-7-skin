import { test, expect } from '@playwright/test';
import {
  CONNECTION_KEY, acceptConnectMessage, getConnection, isValidKey, setConnection, toStatus,
} from '../src/lib/varys/connection';
import { VARYS_API, VARYS_APP_ORIGINS, resolveVarys } from '../src/lib/varys/config';

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
  /** An in-memory chrome.storage.local, promise style as in a service worker. */
  const store: Record<string, unknown> = {};
  test.beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: async (keys: string | Record<string, unknown>) => {
            const names = typeof keys === 'string' ? [keys] : Object.keys(keys);
            return Object.fromEntries(names.filter(k => k in store).map(k => [k, store[k]]));
          },
          set: async (items: Record<string, unknown>) => { Object.assign(store, items); },
          remove: async (key: string) => { delete store[key]; },
        },
      },
    };
  });
  test.afterEach(() => { delete (globalThis as unknown as { chrome?: unknown }).chrome; });

  const connection = { key: KEY, email: 'x@cumc.columbia.edu', connectedAt: '2026-10-21T12:00:00.000Z' };

  test('is stored under its own key, apart from the settings', async () => {
    await setConnection(connection);
    expect(Object.keys(store)).toEqual([CONNECTION_KEY]);
    expect(CONNECTION_KEY).toBe('varysConnection');
    expect(await getConnection()).toEqual(connection);
  });

  test('setting null forgets it, key and all', async () => {
    await setConnection(connection);
    await setConnection(null);
    expect(await getConnection()).toBeNull();
    expect(Object.keys(store)).toEqual([]);
  });

  test('nothing stored reads as not connected', async () => {
    expect(await getConnection()).toBeNull();
  });

  test('a damaged record reads as not connected rather than as a connection', async () => {
    // Storage outlives a version of the extension. A record with a mangled key must not be
    // sent as a bearer token, and must not be shown as "connected".
    for (const bad of [
      'vxk_nope', 42, [], { ...connection, key: 'abc' }, { ...connection, email: undefined },
      { ...connection, connectedAt: 7 },
    ]) {
      store[CONNECTION_KEY] = bad;
      expect(await getConnection(), JSON.stringify(bad)).toBeNull();
    }
  });

  test('keeps the expired flag, and drops anything it does not know', async () => {
    store[CONNECTION_KEY] = { ...connection, expired: true, surprise: 'x' };
    expect(await getConnection()).toEqual({ ...connection, expired: true });
  });
});

test.describe('where Varys is', () => {
  test('defaults to the production API and app', () => {
    expect(VARYS_API).toBe('https://varys.fly.dev');
    expect(VARYS_APP_ORIGINS).toEqual(['https://varys-wine.vercel.app']);
  });

  test('can be pointed elsewhere for a development build', () => {
    expect(resolveVarys({
      VITE_VARYS_API: 'http://localhost:8000',
      VITE_VARYS_APP_ORIGINS: 'http://localhost:3000',
    })).toEqual({ api: 'http://localhost:8000', appOrigins: ['http://localhost:3000'] });
  });

  test('reduces what it is given to origins, so a permission pattern is always well formed', () => {
    // `api + '/*'` is a match pattern. A trailing slash or a path would make it `//*` or
    // a pattern for a path, which Chrome grants as something other than the whole API.
    expect(resolveVarys({ VITE_VARYS_API: 'https://api.example.org/', VITE_VARYS_APP_ORIGINS: 'https://app.example.org/x/' }))
      .toEqual({ api: 'https://api.example.org', appOrigins: ['https://app.example.org'] });
  });

  test('takes a comma-separated list of apps and ignores junk entries', () => {
    expect(resolveVarys({ VITE_VARYS_APP_ORIGINS: 'https://a.example.org, nonsense ,https://b.example.org,javascript:alert(1)' }).appOrigins)
      .toEqual(['https://a.example.org', 'https://b.example.org']);
  });

  test('falls back to production for empty, missing or wholly invalid values', () => {
    const production = { api: 'https://varys.fly.dev', appOrigins: ['https://varys-wine.vercel.app'] };
    expect(resolveVarys({})).toEqual(production);
    expect(resolveVarys(undefined)).toEqual(production);
    expect(resolveVarys({ VITE_VARYS_API: '', VITE_VARYS_APP_ORIGINS: '' })).toEqual(production);
    expect(resolveVarys({ VITE_VARYS_API: 'not a url', VITE_VARYS_APP_ORIGINS: ' , nonsense' })).toEqual(production);
  });
});
