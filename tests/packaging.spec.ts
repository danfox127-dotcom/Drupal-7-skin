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

test.describe('Chrome Web Store readiness', () => {
  const DIST = path.join(ROOT, 'dist');

  test.skip(() => !fs.existsSync(path.join(DIST, 'manifest.json')),
    'no dist/ — run npm run build');

  /**
   * The store rejects a submission with no 128px icon, and Chrome falls back to a grey
   * letter tile without one. This extension shipped for two releases with no `icons` key
   * and no image file anywhere in the repo, which nobody noticed because the fallback
   * looks like a deliberate choice.
   */
  test('declares every icon size, in both places Chrome reads them', () => {
    const manifest = readJson(path.join(DIST, 'manifest.json'));
    for (const size of ['16', '32', '48', '128']) {
      expect(manifest.icons?.[size], `icons.${size} missing`).toBeTruthy();
      expect(manifest.action?.default_icon?.[size], `action.default_icon.${size} missing`)
        .toBeTruthy();
    }
  });

  test('every declared icon exists in the build at its stated size', async () => {
    /**
     * Declaring a path is not the same as shipping the file. The icons live in public/,
     * which Vite copies to the extension root — a build change that dropped publicDir
     * would leave the manifest pointing at four missing files, and Chrome reports that
     * only as a silent fallback to the grey tile.
     *
     * The dimensions are read from the PNG header rather than trusted: a 128px file
     * named icon-16.png would pass an existence check and fail review.
     */
    const manifest = readJson(path.join(DIST, 'manifest.json'));
    for (const [size, rel] of Object.entries(manifest.icons as Record<string, string>)) {
      const file = path.join(DIST, rel);
      expect(fs.existsSync(file), `${rel} is declared but missing`).toBe(true);
      // PNG: width and height are big-endian uint32 at byte offsets 16 and 20.
      const header = fs.readFileSync(file).subarray(0, 24);
      expect(header.subarray(1, 4).toString(), `${rel} is not a PNG`).toBe('PNG');
      expect(header.readUInt32BE(16), `${rel} width`).toBe(Number(size));
      expect(header.readUInt32BE(20), `${rel} height`).toBe(Number(size));
    }
  });

  test('the content script asks for no broader access than the admin paths', () => {
    /**
     * The file:// match was removed for the store submission: it handed the content
     * script every local file on the machine, for a feature normal use never touches.
     * (Written out in prose rather than as the literal pattern, because the pattern
     * contains the sequence that ends a block comment — which is exactly how this test
     * file first failed to parse at all.)
     *
     * Asserted rather than trusted, because a broad match pattern is the single easiest
     * thing to reintroduce while debugging and the hardest to notice afterwards — and
     * here it would be a permission escalation shipped to every installed copy.
     */
    const manifest = readJson(path.join(DIST, 'manifest.json'));
    const matches: string[] = manifest.content_scripts.flatMap(
      (cs: { matches: string[] }) => cs.matches);

    expect(matches).not.toContain('file://*/*');
    for (const pattern of matches) {
      expect(pattern, `${pattern} is not an http(s) pattern`).toMatch(/^\*:\/\//);
      expect(pattern, `${pattern} does not restrict the path`)
        .toMatch(/\/(admin|node)\/\*$/);
    }
  });

  test('requests no host permission beyond the two Columbia domains', () => {
    // The always-granted set. The importer's *://*/* is OPTIONAL and requested at
    // runtime per origin, which is the distinction a reviewer cares about.
    const manifest = readJson(path.join(DIST, 'manifest.json'));
    for (const pattern of manifest.host_permissions as string[]) {
      expect(pattern).toMatch(/columbia\.edu|columbiadoctors\.org/);
    }
    expect(manifest.optional_host_permissions).toContain('*://*/*');
    expect(manifest.host_permissions).not.toContain('*://*/*');
  });

  test('bundles all its code, since the store rejects remotely hosted code', () => {
    /**
     * A <script src> pointing off-origin is an automatic rejection under the store's
     * remote-code policy. Everything here is bundled by Vite, and this asserts it stays
     * that way.
     */
    const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
    const external = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
      .map(m => m[1])
      .filter(src => /^(https?:)?\/\//.test(src));
    expect(external, 'the popup loads a remote script').toEqual([]);
  });
});

test.describe('the store submission document', () => {
  /**
   * The dashboard demands a written justification per permission, and a missing or vague
   * one is the most common cause of a slow review. Adding a permission is easy;
   * remembering to justify it two months later is not — so the document is held to the
   * manifest rather than trusted to stay in step with it.
   */
  const doc = () => fs.readFileSync(path.join(ROOT, 'docs', 'CHROME-WEB-STORE.md'), 'utf8');

  test('justifies every permission the manifest actually requests', () => {
    const manifest = readJson(path.join(ROOT, 'manifest.json'));
    const text = doc();
    const required = [
      ...manifest.permissions,
      ...manifest.host_permissions,
      ...manifest.optional_host_permissions,
    ];
    const undocumented = required.filter((p: string) => !text.includes(p));
    expect(undocumented, 'these are requested but not justified for review').toEqual([]);
  });

  test('does not justify permissions the manifest no longer requests', () => {
    /**
     * The other direction, which matters just as much: a justification for a permission
     * that has been dropped tells a reviewer the submission was not read before sending,
     * and invites a question about why it was ever needed.
     */
    const manifest = readJson(path.join(ROOT, 'manifest.json'));
    const text = doc();
    const granted = new Set<string>([
      ...manifest.permissions,
      ...manifest.host_permissions,
      ...manifest.optional_host_permissions,
    ]);
    // Only checks permissions this project has actually used, so the test does not
    // become a list of every Chrome permission in existence.
    const retired = ['downloads', 'cookies', 'webNavigation', 'activeTab', 'alarms']
      .filter(p => !granted.has(p))
      .filter(p => text.includes('**`' + p + '`**'));
    expect(retired, 'justified but not requested').toEqual([]);
  });

  test('states the two things that block submission rather than implying readiness', () => {
    /**
     * Screenshots and a privacy policy are both mandatory and neither exists yet. A
     * submission guide that reads as complete when it is not wastes the one sitting that
     * someone sets aside to do this.
     */
    const text = doc();
    expect(text).toMatch(/NOT YET MADE/);
    expect(text).toMatch(/no policy yet|Privacy policy URL/i);
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
