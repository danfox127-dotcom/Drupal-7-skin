import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/**
 * What a user ends up with, as opposed to what the code does.
 *
 * Every test in this repo until now checked behaviour once the extension was already
 * running. None checked that a person could get it running, and that is where it actually
 * broke: the GitHub source zip was downloaded instead of the release asset, and Chrome
 * accepted it. No error, no warning, card shown as enabled — and no service worker, so the
 * extension was inert. It was downloaded twice, which is what a silent failure buys you.
 *
 * The root manifest cannot be made loadable (crxjs needs it, and it points at TypeScript),
 * so the next best thing is to make the mistake legible. These assertions hold that in
 * place from both ends.
 */

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));

const PRODUCT_NAME = 'D7 Admin Proxy UI';

test.describe('the source manifest', () => {
  test('names itself as unloadable rather than as the product', () => {
    /**
     * If this ever reads like a real extension name again, loading the repo root goes
     * back to looking like a successful install.
     */
     const manifest = readJson(path.join(ROOT, 'manifest.json'));
    expect(manifest.name).not.toBe(PRODUCT_NAME);
    expect(manifest.name).toMatch(/do not load/i);
    // Useless as a warning if it does not say what to do instead.
    expect(manifest.name).toMatch(/dist/);
    // Chrome truncates long names in chrome://extensions; a warning nobody can read is
    // not a warning.
    expect(manifest.name.length).toBeLessThanOrEqual(45);
  });

  test('still points at TypeScript, which is why it cannot be loaded', () => {
    // The premise of the warning. If these ever become .js, the root folder might be
    // loadable and the warning would be actively misleading.
    const manifest = readJson(path.join(ROOT, 'manifest.json'));
    expect(manifest.background.service_worker).toMatch(/\.ts$/);
    expect(manifest.content_scripts[0].js[0]).toMatch(/\.tsx?$/);
  });
});

test.describe('the built extension', () => {
  const DIST = path.join(ROOT, 'dist');

  test.skip(() => !fs.existsSync(path.join(DIST, 'manifest.json')),
    'no dist/ — run npm run build');

  test('carries the real product name, not the warning', () => {
    /**
     * The other half. vite.config.ts reattaches the name for the build; without that
     * override every user would install something called "DO NOT LOAD".
     */
    const manifest = readJson(path.join(DIST, 'manifest.json'));
    expect(manifest.name).toBe(PRODUCT_NAME);
    expect(manifest.name).not.toMatch(/do not load/i);
  });

  test('points at files that exist and that Chrome can execute', () => {
    /**
     * The actual load failure, checked directly: Chrome needs every referenced path to
     * exist and to be JavaScript. Cheaper than launching a browser and it fails for a
     * readable reason.
     */
    const manifest = readJson(path.join(DIST, 'manifest.json'));
    const referenced: string[] = [
      manifest.background.service_worker,
      ...manifest.content_scripts.flatMap((cs: { js: string[] }) => cs.js),
      manifest.action.default_popup,
    ];

    for (const rel of referenced) {
      expect(fs.existsSync(path.join(DIST, rel)), `${rel} is missing from dist/`).toBe(true);
      expect(rel, `${rel} is not something Chrome can run`).toMatch(/\.(js|html)$/);
    }
  });

  test('version matches package.json, so the update check is meaningful', () => {
    // latest.json is compared against chrome.runtime.getManifest().version. Drift here
    // means the notifier either never fires or fires forever.
    const manifest = readJson(path.join(DIST, 'manifest.json'));
    const pkg = readJson(path.join(ROOT, 'package.json'));
    expect(manifest.version).toBe(pkg.version);
  });
});

test.describe('the install instructions', () => {
  /**
   * Documentation, asserted, because the wrong-zip download was a documentation failure
   * before it was anything else: the README's only install path was `npm install && npm
   * run build`, and it never mentioned the Releases page. A non-developer following it
   * had no route that worked.
   */
  test('README sends people to the release asset before the build path', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const releases = readme.indexOf('/releases/latest');
    const build = readme.indexOf('npm run build');
    expect(releases, 'README never links the Releases page').toBeGreaterThan(-1);
    expect(build, 'README lost the build instructions').toBeGreaterThan(-1);
    expect(releases, 'the build path comes first, so non-developers hit it first')
      .toBeLessThan(build);
  });

  test('README warns off the green Code button by name', () => {
    // The specific wrong action someone took. Naming it is the whole point.
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    expect(readme).toMatch(/Download ZIP/i);
  });

  test('a standalone install guide exists and does not assume a terminal', () => {
    const guide = path.join(ROOT, 'docs', 'INSTALL.md');
    expect(fs.existsSync(guide), 'docs/INSTALL.md is missing').toBe(true);
    const text = fs.readFileSync(guide, 'utf8');
    expect(text).toMatch(/releases\/latest/);
    expect(text).toMatch(/Load unpacked/i);
    // The guide is for someone who has never used GitHub. If it tells them to run npm,
    // it is the developer path wearing a different hat.
    expect(text).not.toMatch(/npm /);
  });
});
