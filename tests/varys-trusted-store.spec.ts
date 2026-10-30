import { test, expect } from '@playwright/test';
import * as esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';
import { TRUSTED_DB, TRUSTED_DB_VERSION, TRUSTED_STORE } from '../src/lib/varys/trustedStore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The store the Varys key lives in: IndexedDB in the extension's own origin.
 *
 * chrome.storage.local is exposed to content scripts, so a key kept there is readable by
 * anything that takes over a Columbia admin tab's renderer. A content script's `indexedDB` is
 * the PAGE's origin, so the extension's own database is out of its reach. These tests run the
 * store in an ordinary page with a real origin (IndexedDB does not exist on a data: URL); the
 * worker and the isolation itself are covered end to end in tests/extension.test.ts.
 */

let bundle: string;

test.beforeAll(async () => {
  const result = await esbuild.build({
    stdin: {
      contents: `export { trustedStore } from './src/lib/varys/trustedStore';`,
      resolveDir: path.join(__dirname, '..'),
      loader: 'ts',
    },
    bundle: true, write: false, format: 'iife', globalName: 'Trusted',
    platform: 'browser', target: 'es2020',
  });
  bundle = result.outputFiles[0].text;
});

async function load(page: import('@playwright/test').Page) {
  await page.route('https://store.test/**', route =>
    route.fulfill({ contentType: 'text/html', body: '<html><body>store</body></html>' }));
  await page.goto('https://store.test/');
  await page.addScriptTag({ content: bundle });
}

test.describe('the trusted store', () => {
  test('a value written is read back as a copy', async ({ page }) => {
    await load(page);
    const read = await page.evaluate(async () => {
      const store = (window as any).Trusted.trustedStore;
      const value = { x: 1, nested: { y: 'z' } };
      await store.set('a', value);
      value.x = 2;
      return store.get('a');
    });
    expect(read).toEqual({ x: 1, nested: { y: 'z' } });
  });

  test('an absent key reads as undefined', async ({ page }) => {
    await load(page);
    expect(await page.evaluate(async () =>
      (await (window as any).Trusted.trustedStore.get('nothing here')) === undefined)).toBe(true);
  });

  test('remove forgets a value', async ({ page }) => {
    await load(page);
    expect(await page.evaluate(async () => {
      const store = (window as any).Trusted.trustedStore;
      await store.set('a', 'kept');
      await store.remove('a');
      return (await store.get('a')) === undefined;
    })).toBe(true);
  });

  test('a write has committed when set resolves', async ({ page }) => {
    // Resolving on the request's success rather than the transaction's completion would let
    // the worker be stopped between the two and lose the write.
    await load(page);
    const seen = await page.evaluate(async ([db, version, storeName]) => {
      await (window as any).Trusted.trustedStore.set('a', 1);
      return new Promise((resolve, reject) => {
        const open = indexedDB.open(db, version);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const get = open.result.transaction(storeName, 'readonly').objectStore(storeName).get('a');
          get.onsuccess = () => { open.result.close(); resolve(get.result); };
          get.onerror = () => reject(get.error);
        };
      });
    }, [TRUSTED_DB, TRUSTED_DB_VERSION, TRUSTED_STORE] as const);
    expect(seen).toBe(1);
  });
});
