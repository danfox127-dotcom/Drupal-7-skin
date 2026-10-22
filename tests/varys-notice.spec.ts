import { test, expect, type Page } from '@playwright/test';
import * as esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/**
 * The notice shown after a save is sent to Varys (src/lib/varys/notice.ts).
 *
 * The worker hands showVarysNotice to chrome.scripting.executeScript, which sends the
 * function's SOURCE TEXT to the page. So every test here runs it the same way: the function is
 * bundled and minified as a release build is, turned back into text, and evaluated in a page
 * that has nothing else loaded. A reference to anything outside its own body fails here
 * exactly as it would in a real tab. The real injection is covered in tests/extension.test.ts.
 */

const HOST = 'https://www.cuimc.columbia.edu';
let source: string;

test.beforeAll(async () => {
  const result = await esbuild.build({
    stdin: { contents: `export { showVarysNotice } from './src/lib/varys/notice';`, resolveDir: ROOT, loader: 'ts' },
    bundle: true, write: false, format: 'iife', globalName: 'Notice', minify: true,
    platform: 'browser', target: 'chrome110',
  });
  const bundled = new Function(`${result.outputFiles[0].text}; return Notice;`)() as {
    showVarysNotice: (...args: unknown[]) => void;
  };
  source = bundled.showVarysNotice.toString();
});

/**
 * A bare page with chrome.runtime.sendMessage stubbed: it records each message on
 * window.__sent and answers with the next of `answers`.
 */
async function open(page: Page, answers: unknown[] = []) {
  await page.route(`${HOST}/**`, route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><body><p>The public page.</p></body></html>',
  }));
  await page.goto(`${HOST}/news/foo`);
  await page.evaluate(queued => {
    const w = window as any;
    w.__sent = [];
    Object.defineProperty(window, 'chrome', {
      configurable: true,
      value: { runtime: { sendMessage: (m: unknown) => { w.__sent.push(m); return Promise.resolve(queued.shift()); } } },
    });
  }, answers);
}

/** Runs the notice from its source text, the way executeScript does. */
const show = (page: Page, notice: unknown) =>
  page.evaluate(([src, n]) => {
    // eslint-disable-next-line no-new-func
    (new Function(`return (${src as string})`)())(n);
  }, [source, notice] as const);

const sent = (page: Page) => page.evaluate(() => (window as any).__sent as unknown[]);
const notice = (page: Page) => page.getByRole('status');

const LOGGED = {
  message: 'Logged in Varys as a title and description change.',
  action: { label: 'Undo', type: 'varysUndo', saveId: 41 },
};

test('shows the message in a shadow root of its own, and Dismiss takes it away', async ({ page }) => {
  await open(page);
  await show(page, { message: "This site isn't in Varys, so nothing was logged." });

  await expect(notice(page)).toHaveText(/This site isn't in Varys, so nothing was logged\./);
  // In a shadow root, so the page's CSS cannot restyle it and its own scripts do not see it.
  expect(await page.evaluate(() => !!document.getElementById('d7-varys-notice')?.shadowRoot)).toBe(true);
  // No action was asked for, so there is none.
  await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice(page)).toHaveCount(0);
  expect(await page.evaluate(() => document.getElementById('d7-varys-notice'))).toBeNull();
});

test('sits at the bottom centre of the window, in the brand colours', async ({ page }) => {
  await open(page);
  await show(page, LOGGED);
  const box = await notice(page).boundingBox();
  const viewport = page.viewportSize()!;
  expect(Math.abs(box!.x + box!.width / 2 - viewport.width / 2)).toBeLessThan(2);
  expect(viewport.height - (box!.y + box!.height)).toBeLessThan(60);

  const colours = await page.evaluate(() => {
    const root = document.getElementById('d7-varys-notice')!.shadowRoot!;
    const panel = root.querySelector('[role="status"]') as HTMLElement;
    const undo = Array.from(root.querySelectorAll('button')).find(b => b.textContent === 'Undo')!;
    return { text: getComputedStyle(panel).color, button: getComputedStyle(undo).backgroundColor };
  });
  expect(colours).toEqual({ text: 'rgb(26, 26, 26)', button: 'rgb(29, 79, 145)' });
});

test('Undo asks the worker, then shows what Varys said and goes', async ({ page }) => {
  await open(page, [{ ok: true, message: 'Removed from Varys.' }]);
  await show(page, LOGGED);

  await page.getByRole('button', { name: 'Undo' }).click();

  await expect(notice(page)).toHaveText(/Removed from Varys\./);
  await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0);
  expect(await sent(page)).toEqual([{ type: 'varysUndo', saveId: 41 }]);
});

test('Log it anyway becomes Undo once the save counts', async ({ page }) => {
  await open(page, [
    {
      ok: true,
      message: 'Logged in Varys as a search edit.',
      action: { label: 'Undo', type: 'varysUndo', saveId: 42 },
    },
    { ok: true, message: 'Removed from Varys.' },
  ]);
  await show(page, {
    message: "Not logged in Varys: this didn't look like a search edit.",
    action: { label: 'Log it anyway', type: 'varysLogAnyway', saveId: 42 },
  });

  await page.getByRole('button', { name: 'Log it anyway' }).click();
  await expect(notice(page)).toHaveText(/Logged in Varys as a search edit\./);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(notice(page)).toHaveText(/Removed from Varys\./);

  expect(await sent(page)).toEqual([
    { type: 'varysLogAnyway', saveId: 42 },
    { type: 'varysUndo', saveId: 42 },
  ]);
});

test('an action that did not go through says why and can be tried again', async ({ page }) => {
  await open(page, [
    { ok: false, message: "Varys couldn't be reached, so nothing changed. Try again in a moment." },
    { ok: true, message: 'Removed from Varys.' },
  ]);
  await show(page, LOGGED);

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(notice(page)).toHaveText(/couldn't be reached, so nothing changed/);
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(notice(page)).toHaveText(/Removed from Varys\./);
});

test('no answer at all leaves the button to try again', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    Object.defineProperty(window, 'chrome', {
      configurable: true,
      value: { runtime: { sendMessage: () => Promise.reject(new Error('Extension context invalidated.')) } },
    });
  });
  await show(page, LOGGED);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
  await expect(notice(page)).toHaveText(/Logged in Varys/);
});

test('goes by itself after ten seconds, but not while someone is using it', async ({ page }) => {
  await page.clock.install();
  await open(page);
  await show(page, LOGGED);

  await page.clock.runFor(9_000);
  await expect(notice(page)).toHaveCount(1);
  // Keyboard focus on its button holds it open.
  await page.getByRole('button', { name: 'Undo' }).focus();
  await page.clock.runFor(30_000);
  await expect(notice(page)).toHaveCount(1);

  await page.evaluate(() => {
    const root = document.getElementById('d7-varys-notice')!.shadowRoot!;
    (root.activeElement as HTMLElement | null)?.blur();
  });
  await page.clock.runFor(10_001);
  await expect(notice(page)).toHaveCount(0);
});

test('a second notice replaces the first rather than stacking', async ({ page }) => {
  await open(page);
  await show(page, { message: 'First.' });
  await show(page, { message: 'Second.' });
  await expect(notice(page)).toHaveCount(1);
  await expect(notice(page)).toHaveText(/Second\./);
});

test('the message is shown as text, never as markup', async ({ page }) => {
  await open(page);
  await show(page, { message: '<img src=x onerror="window.__ran = true">Logged.' });
  await expect(notice(page)).toContainText('<img src=x');
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as any).__ran)).toBeUndefined();
});
