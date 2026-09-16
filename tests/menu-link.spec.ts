import { test, expect } from '@playwright/test';
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Placing a node in a menu, as a rule rather than as a feature of one widget.
 *
 * Drupal 7 gates the whole menu fieldset on menu[enabled] — "Provide a menu link",
 * unticked by default and captioned "Not in menu". With it unticked, menu_node_save()
 * discards the parent and the link title on save and reports nothing. So writing
 * menu[parent] alone sets a value Drupal has already decided to ignore.
 *
 * The two-pane editor got this right. The standalone searchable parent picker — which is
 * ON by default, and is therefore what almost everyone actually uses — did not: it set
 * menu[parent] and nothing else, so every placement made through it was silently lost on
 * save. That is the bug this covers, and it was in the shipped default path.
 */

let bundle: string;

test.beforeAll(async () => {
  const entry = path.join(__dirname, 'fixtures', '.menu-link-entry.ts');
  fs.writeFileSync(entry, `export { enableMenuLink } from '../../src/lib/menuLink';`);
  const built = await esbuild.build({
    entryPoints: [entry],
    bundle: true, write: false, format: 'iife', globalName: 'M',
    platform: 'browser', target: 'es2020',
  });
  bundle = built.outputFiles[0].text;
  fs.unlinkSync(entry);
});

/** A node form carrying the menu controls core renders, plus the Title module's field. */
function form(opts: {
  enabled?: boolean;
  linkTitle?: string;
  nodeTitle?: string;
  coreTitle?: boolean;
  omitEnabled?: boolean;
} = {}) {
  const titleName = opts.coreTitle ? 'title' : 'title_field[und][0][value]';
  return `
    <form id="page-node-form">
      <input type="text" name="${titleName}" value="${opts.nodeTitle ?? ''}" />
      <select name="menu[parent]"><option value="main-menu:0">Main menu</option></select>
      ${opts.omitEnabled ? '' : `
        <input type="checkbox" name="menu[enabled]" value="1"
               ${opts.enabled ? 'checked' : ''} />`}
      <input type="text" name="menu[link_title]" value="${opts.linkTitle ?? ''}" />
    </form>`;
}

async function run(page: import('@playwright/test').Page, html: string) {
  await page.goto('data:text/html,<body></body>');
  await page.setContent(html);
  await page.addScriptTag({ content: bundle });
  return page.evaluate(() => {
    const seen: string[] = [];
    for (const name of ['menu[enabled]', 'menu[link_title]']) {
      const el = document.querySelector(`[name="${name}"]`);
      el?.addEventListener('change', () => seen.push(`${name}:change`));
    }
    const outcome = (window as any).M.enableMenuLink(document);
    const enabled = document.querySelector<HTMLInputElement>('[name="menu[enabled]"]');
    const linkTitle = document.querySelector<HTMLInputElement>('[name="menu[link_title]"]');
    return {
      outcome,
      checked: enabled ? enabled.checked : null,
      linkTitleValue: linkTitle?.value ?? null,
      events: seen,
    };
  });
}

test('ticks "Provide a menu link" when it is unticked', async ({ page }) => {
  // The bug, directly. Without this the placement is discarded on save.
  const r = await run(page, form({ enabled: false, nodeTitle: 'Kidney Transplant' }));
  expect(r.checked).toBe(true);
  expect(r.outcome.ticked).toBe(true);
});

test('fills the link title from the node title, which Drupal then requires', async ({ page }) => {
  /**
   * Ticking the box alone trades silent loss for a validation error on save: Drupal
   * requires a link title once the link is enabled.
   */
  const r = await run(page, form({ enabled: false, nodeTitle: 'Kidney Transplant' }));
  expect(r.linkTitleValue).toBe('Kidney Transplant');
  expect(r.outcome.titleWritten).toBe('Kidney Transplant');
});

test('reads core\'s title field as well as the Title module\'s', async ({ page }) => {
  // These sites run the Title module, so the node title is title_field[und][0][value].
  // Core's plain `title` has to keep working for any site that does not.
  const r = await run(page, form({ enabled: false, nodeTitle: 'Core Titled', coreTitle: true }));
  expect(r.linkTitleValue).toBe('Core Titled');
});

test('leaves a link title the editor has already typed alone', async ({ page }) => {
  // Overwriting deliberate input would be worse than the original bug.
  const r = await run(page, form({
    enabled: false, nodeTitle: 'Node Title', linkTitle: 'Shorter Menu Label',
  }));
  expect(r.linkTitleValue).toBe('Shorter Menu Label');
  expect(r.outcome.titleWritten).toBeNull();
});

test('reports no change when the box was already ticked', async ({ page }) => {
  /**
   * Not cosmetic: the caller uses `ticked` to decide whether to tell the editor their
   * placement was enabled for them. Saying so when nothing happened is noise.
   */
  const r = await run(page, form({ enabled: true, nodeTitle: 'Already In Menu' }));
  expect(r.checked).toBe(true);
  expect(r.outcome.ticked).toBe(false);
});

test('fires change so Drupal reveals the fieldset it was hiding', async ({ page }) => {
  /**
   * Drupal's #states JavaScript watches this checkbox and unhides the menu fieldset.
   * Assigning .checked without dispatching leaves the fieldset collapsed, so the editor
   * sees "Not in menu" next to a parent they just chose and reasonably assumes it failed.
   */
  const r = await run(page, form({ enabled: false, nodeTitle: 'Needs Events' }));
  expect(r.events).toContain('menu[enabled]:change');
  expect(r.events).toContain('menu[link_title]:change');
});

test('reports what is missing rather than throwing on a form without menu controls', async ({ page }) => {
  /**
   * Not every content type exposes the menu fieldset, and a user without
   * "administer menu" gets the form without it. The picker must not break there.
   */
  const r = await run(page, form({ omitEnabled: true, nodeTitle: 'No Menu Controls' }));
  expect(r.outcome.missing).toContain('menu[enabled]');
  expect(r.outcome.ticked).toBe(false);
});

test('does nothing about the title when the node has no title yet', async ({ page }) => {
  // Filling the link title with an empty string would satisfy nothing and hide the
  // real validation error the editor needs to see.
  const r = await run(page, form({ enabled: false, nodeTitle: '' }));
  expect(r.checked).toBe(true);
  expect(r.outcome.titleWritten).toBeNull();
  expect(r.linkTitleValue).toBe('');
});
