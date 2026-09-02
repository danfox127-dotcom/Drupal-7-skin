import { test as base, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * End-to-end tests against the built extension.
 *
 * Fixtures are served at real, Drupal-shaped URLs on a host the manifest matches,
 * rather than loaded over file://. That matters for two reasons:
 *
 *  1. The content script gates features on the URL — `/node/…/edit`,
 *     `/admin/structure/menu/manage/main-menu`, `/admin/content`. A file:// path like
 *     `fixtures/node-edit.html` contains none of those, so nothing ever injected and
 *     all three original tests failed. Renaming the file would not have helped; the
 *     PATH is what is inspected.
 *  2. It exercises the real `host_permissions` match patterns, which a file:// URL
 *     bypasses entirely.
 *
 * Requires a built dist/ — run `npm run build` first.
 */

const DIST = path.join(__dirname, '../dist');
const FIXTURES = path.join(__dirname, 'fixtures');

/** Fixture served for each Drupal path, longest match first. */
const ROUTES: [RegExp, string][] = [
  // Longest match first: /add before the overview it belongs to, and the collapsed
  // variant before the plain one.
  [/\/admin\/structure\/menu\/manage\/[^/]+\/add/, 'menu-add-link.html'],
  [/\/admin\/structure\/menu\/manage\/main-menu-collapsed/, 'menu-manage-collapsed.html'],
  [/\/admin\/structure\/menu\/manage\/main-menu/, 'menu-manage.html'],
  [/\/media\/browser/, 'media-browser.html'],
  [/\/admin\/content/, 'admin/content.html'],
  [/\/node\/add\/news-ckeditor/, 'node-add-news-ckeditor.html'],
  [/\/node\/add\/news-media/, 'node-add-news-media.html'],
  [/\/node\/add\/news/, 'node-add-news-live.html'],
  [/\/node\/add\/page-bigmenu/, 'node-add-page-bigmenu.html'],
  [/\/node\/add\/page/, 'node-add-page.html'],
  [/\/node\/18948\/edit/, 'node-edit-media-populated.html'],
  [/\/node\/17176\/edit/, 'node-edit-specialty.html'],
  // Same form, CKEditor attaching on a delay — see the fixture's own comment.
  [/\/node\/17177\/edit/, 'node-edit-specialty-async.html'],
  [/\/node\/\d+\/edit/, 'node-edit.html'],
];

const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/** A host the shipped manifest matches. */
const HOST = 'https://www.cuimc.columbia.edu';

/**
 * A columbia.edu subdomain the manifest never names.
 *
 * The `*://*.columbia.edu/...` wildcard exists so a new Columbia D7 site works with no
 * manifest edit, rebuild, or reload. This host proves that, and would fail against the
 * previous per-site pattern list.
 */
const UNNAMED_HOST = 'https://someothersite.columbia.edu';

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
  /** Reads or writes the extension's settings via its own storage. */
  settings: (values: Record<string, unknown>) => Promise<void>;
}>({
  context: async ({}, use) => {
    if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
      throw new Error('dist/ is missing or unbuilt — run `npm run build` before the extension tests.');
    }

    /**
     * Headless by default.
     *
     * This used to say "Extensions only work in headful mode", which was true of Chrome's
     * OLD headless but not of --headless=new (Chrome 112+), which loads unpacked
     * extensions normally. It matters because the context fixture is per-test: headful, a
     * fifty-test file opens fifty windows one after another and steals focus each time,
     * which is unusable while anyone is working on the machine.
     *
     * Set D7_HEADFUL=1 to watch a run.
     */
    const context = await chromium.launchPersistentContext('', {
      headless: !process.env.D7_HEADFUL,
      /**
       * Full Chromium, not the headless shell.
       *
       * Playwright's default headless browser is `chrome-headless-shell`, a stripped
       * binary with NO extension support: it launches, serves pages, and silently ignores
       * `--load-extension`, so every test fails on a missing overlay with nothing in the
       * output to say why. `channel: 'chromium'` selects the full build, whose
       * --headless=new does load unpacked extensions.
       *
       * Skipped when CHROME_PATH is set, since channel and executablePath conflict.
       */
      ...(process.env.CHROME_PATH ? {} : { channel: 'chromium' as const }),
      // Falls back to Playwright's managed browser when unset. See playwright.config.ts.
      executablePath: process.env.CHROME_PATH || undefined,
      args: [
        `--disable-extensions-except=${DIST}`,
        `--load-extension=${DIST}`,
      ],
      ignoreHTTPSErrors: true,
    });

    await context.route(`**columbia.edu/**`, route => {
      const url = route.request().url();
      const match = ROUTES.find(([pattern]) => pattern.test(url));
      if (!match) {
        route.fulfill({ status: 404, contentType: 'text/html', body: '<html><body>not a fixture</body></html>' });
        return;
      }
      route.fulfill({ status: 200, contentType: 'text/html', body: read(match[1]) });
    });

    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    // The service worker landed with the import flow; before that there was no
    // background context and this fixture would have hung.
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    await use(worker.url().split('/')[2]);
  },

  settings: async ({ context, extensionId }, use) => {
    await use(async (values: Record<string, unknown>) => {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/index.html`);
      await page.evaluate(
        v => new Promise<void>(resolve => chrome.storage.local.set(v, () => resolve())),
        values
      );
      await page.close();
    });
  },
});

/** The shadow-root host every injected component lives in. */
const UI = '.d7-proxy-ui-container';

/**
 * Opens a rail section by panel id, revealing the secondary group first if needed.
 *
 * The rail lists Search, Topics, Related and Menu Placement openly; Display Template,
 * URL/SEO, Revision and Other sit behind one "Settings used occasionally" disclosure. A
 * test that clicks straight through to a section must not care which tier it is in, or
 * moving a section between tiers breaks a dozen unrelated tests. Menu Placement has now
 * moved tiers once without touching a single caller, which is the point.
 *
 * Keyed on `data-rail-panel`, NOT on header text. The group's own header lists the titles
 * it holds — "Menu Placement \u00b7 Display Template \u00b7 \u2026" \u2014 so `hasText: 'Menu Placement'`
 * matched the GROUP button, clicked that, and left the section itself shut. Every menu
 * test then failed looking for a parent picker that was one more click away.
 */
const openRailSection = async (page: Page, panel: string) => {
  const header = page.locator(`${UI} aside [data-rail-panel="${panel}"] > button[aria-expanded]`);
  if (await header.count() === 0) {
    await page.locator(`${UI} aside button[aria-expanded]`, { hasText: 'Settings used occasionally' }).click();
    await expect(header).toHaveCount(1);
  }
  if (await header.getAttribute('aria-expanded') === 'false') await header.click();
};

/**
 * Expands everything collapsed in the overlay, nested groups included.
 *
 * One pass is not enough: opening the secondary group renders section headers that were
 * not in the DOM when the pass started, so a single querySelectorAll misses them. Loops
 * until a pass finds nothing left to open.
 */
const expandAll = async (page: Page) => {
  await page.evaluate(async () => {
    const sr = (document.querySelector('.d7-proxy-ui-form-host') as HTMLElement).shadowRoot!;
    for (let pass = 0; pass < 4; pass++) {
      const shut = Array.from(sr.querySelectorAll<HTMLElement>('[aria-expanded="false"]'));
      if (shut.length === 0) break;
      shut.forEach(b => b.click());
      await new Promise(r => setTimeout(r, 150));
    }
    await new Promise(r => setTimeout(r, 250));
  });
};

test.describe('D7 Studio: injected on node edit forms', () => {
  test('Feature 1: Taxonomy Combobox is injected and syncs to the native select', async ({ page }) => {
    await page.goto(`${HOST}/node/123/edit`);

    const nativeSelect = page.locator('select[name="menu[parent]"]');
    await expect(page.locator(`${UI} >> text=Menu Parent Selector`)).toBeVisible();
    await expect(nativeSelect).toBeHidden();

    // Scoped by role, not position. `${UI} button` matches across EVERY injected
    // container, and HtmlExport is injected earlier in the DOM — so `.first()` hit
    // "Export Raw HTML" instead.
    //
    // The trigger also shows the CURRENT value, not a placeholder: the fixture has
    // <Main menu> pre-selected, which is the normal case on a real form. The
    // "Search for a parent..." placeholder only appears when nothing is selected,
    // which is what the original test wrongly clicked.
    const trigger = page.locator(`${UI} button[aria-haspopup="listbox"]`);
    await expect(trigger).toContainText('<Main menu>');
    await trigger.click();
    await page.click(`${UI} >> text=Our Doctors`);

    // The whole point: the modern control writes through to the real form field.
    await expect(nativeSelect).toHaveValue('main-menu:456');
    // And the trigger reflects the new selection.
    await expect(trigger).toContainText('Our Doctors');
  });

  test('the combobox strips Drupal\'s hyphen depth prefixes from labels', async ({ page }) => {
    await page.goto(`${HOST}/node/123/edit`);
    await page.locator(`${UI} button[aria-haspopup="listbox"]`).click();
    // Rendered as "About Us", not "-- About Us".
    await expect(page.locator(`${UI} >> text=About Us`).first()).toBeVisible();
    await expect(page.locator(`${UI}`).getByText('-- About Us')).toHaveCount(0);
  });

  test('Feature 2: HTML Export button is injected', async ({ page }) => {
    await page.goto(`${HOST}/node/123/edit`);
    await expect(page.locator(`${UI} >> text=Content Extraction Engine`)).toBeVisible();
    await expect(page.locator(`${UI} >> text=Export Raw HTML`)).toBeVisible();
  });
});

test.describe('D7 Studio: menu manager', () => {
  test('Feature 3: Menu Tree replaces the legacy table', async ({ page }) => {
    await page.goto(`${HOST}/admin/structure/menu/manage/main-menu`);

    await expect(page.locator(`${UI} >> text=Main Menu`).first()).toBeVisible();
    await expect(page.locator('table#menu-overview')).toBeHidden();
    await expect(page.locator(`${UI} >> text=About Us`).first()).toBeVisible();
  });

  test('parses the full hierarchy, including the disabled item', async ({ page }) => {
    await page.goto(`${HOST}/admin/structure/menu/manage/main-menu`);
    await expect(page.locator(`${UI} [data-menu-row]`)).toHaveCount(13);
    // Annual Report is unchecked in the fixture.
    await expect(page.locator(`${UI} >> text=Disabled`)).toHaveCount(1);
  });

  test('filtering keeps ancestors so hierarchy is never lost', async ({ page }) => {
    await page.goto(`${HOST}/admin/structure/menu/manage/main-menu`);
    await page.fill(`${UI} input[placeholder="Filter menu items"]`, 'billing');

    // The match plus its parent, not the match alone.
    await expect(page.locator(`${UI} [data-menu-row]`)).toHaveCount(2);
    await expect(page.locator(`${UI} >> text=Insurance & Billing`)).toBeVisible();
    await expect(page.locator(`${UI} >> text=Patient Resources`)).toBeVisible();
  });

  test('editing marks the menu dirty and Revert restores it', async ({ page }) => {
    await page.goto(`${HOST}/admin/structure/menu/manage/main-menu`);
    await expect(page.locator(`${UI} >> text=No changes`)).toBeVisible();

    await page.locator(`${UI} button[aria-label="Indent"]`).nth(1).click();
    await expect(page.locator(`${UI} >> text=1 change`)).toBeVisible();

    await page.locator(`${UI} button`, { hasText: 'Revert' }).click();
    await expect(page.locator(`${UI} >> text=No changes`)).toBeVisible();
  });
});

test.describe('D7 Studio: content list', () => {
  test('replaces Drupal\'s table and filters as you type', async ({ page }) => {
    await page.goto(`${HOST}/admin/content`);

    await expect(page.locator(`${UI} >> text=9 of 9 items`)).toBeVisible();
    await expect(page.locator('#node-admin-content table')).toBeHidden();

    await page.fill(`${UI} input[type=text]`, 'atrial');
    // No Apply button; the list narrows on keystroke.
    await expect(page.locator(`${UI} li[data-row-index]`)).toHaveCount(1);
  });

  test('maps Drupal status text onto the design\'s labels', async ({ page }) => {
    await page.goto(`${HOST}/admin/content`);
    // "not published" becomes Draft; "needs review" is a moderation state.
    await expect(page.locator(`${UI} >> text=Published`).first()).toBeVisible();
    await expect(page.locator(`${UI} >> text=Draft`).first()).toBeVisible();
    await expect(page.locator(`${UI} >> text=Needs review`).first()).toBeVisible();
  });

  test('J/K moves the keyboard cursor', async ({ page }) => {
    await page.goto(`${HOST}/admin/content`);
    await expect(page.locator(`${UI} li[data-row-index]`).first()).toBeVisible();

    await page.keyboard.press('j');
    // aria-current marks the cursor; class names carry hover: variants and are not a
    // reliable signal.
    await expect(page.locator(`${UI} li[aria-current="true"]`)).toHaveAttribute('data-row-index', '1');

    await page.keyboard.press('k');
    await expect(page.locator(`${UI} li[aria-current="true"]`)).toHaveAttribute('data-row-index', '0');
  });
});

test.describe('D7 Studio: command palette', () => {
  const OVERLAY = '.d7-proxy-ui-overlay';

  test('opens on the keyboard chord and closes on Escape', async ({ page }) => {
    await page.goto(`${HOST}/admin/content`);
    await expect(page.locator(`${UI}`).first()).toBeVisible();

    await expect(page.locator(`${OVERLAY} [role="dialog"]`)).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.locator(`${OVERLAY} [role="dialog"]`)).toBeVisible();

    await page.keyboard.press('Escape');
    // Unmounted, not merely hidden — a fixed overlay left on someone else's page
    // breaks their layout.
    await expect(page.locator(OVERLAY)).toHaveCount(0);
  });

  test('hides node-only commands away from a node page', async ({ page }) => {
    await page.goto(`${HOST}/admin/content`);
    await expect(page.locator(`${UI}`).first()).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');

    await expect(page.locator(`${OVERLAY} [role="option"]`).first()).toBeVisible();
    await expect(page.locator(`${OVERLAY} >> text=Copy public HTML of this node`)).toHaveCount(0);
    await expect(page.locator(`${OVERLAY} >> text=Main menu manager`)).toBeVisible();
  });

  test('offers Copy public HTML on a node page', async ({ page }) => {
    await page.goto(`${HOST}/node/123/edit`);
    await expect(page.locator(`${UI}`).first()).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.locator(`${OVERLAY} >> text=Copy public HTML of this node`)).toBeVisible();
  });
});

test.describe('D7 Studio: host matching', () => {
  test('a columbia.edu subdomain the manifest never names still works', async ({ page }) => {
    await page.goto(`${UNNAMED_HOST}/node/123/edit`);
    // The point of the wildcard: no manifest edit needed for a new Columbia site.
    await expect(page.locator(`${UI} >> text=Menu Parent Selector`)).toBeVisible();
  });

  test('the bare apex domain matches too, not only subdomains', async ({ page }) => {
    // Chrome's `*.` matches the domain itself as well as any depth of subdomain.
    await page.goto('https://columbia.edu/admin/content');
    await expect(page.locator(`${UI} >> text=9 of 9 items`)).toBeVisible();
  });

  test('a deep subdomain matches, since `*.` spans multiple levels', async ({ page }) => {
    await page.goto('https://www.vagelos.columbia.edu/admin/structure/menu/manage/main-menu');
    await expect(page.locator(`${UI} [data-menu-row]`)).toHaveCount(13);
  });

  test('paths outside /admin and /node are not matched', async ({ page }) => {
    // The wildcard widens the HOST, not the paths — the site root stays untouched.
    await page.goto(`${UNNAMED_HOST}/`);
    await expect(page.locator(UI)).toHaveCount(0);
  });
});

test.describe('D7 Studio: relocated native widgets', () => {
  /**
   * Media and Paragraphs widgets are moved into the overlay rather than reimplemented.
   * The properties below are what make that safe, and each fails silently if broken —
   * a widget that looks right but is no longer submitted loses the editor's work.
   */
  const inRail = async (page: import('@playwright/test').Page) => {
    await settingsFor(page);
    await page.goto(`${HOST}/node/add/news`);
    await expect(page.locator(`${UI} input[aria-label="Title"]`)).toBeVisible();
    // Multimedia sits in the left column now, expanded, so there is nothing to click —
    // but wait for it, because its slots are what these tests inspect.
    await expect(page.locator(`${UI} [data-left-section="multimedia"]`)).toBeVisible();
  };

  let settingsFor: (page: import('@playwright/test').Page) => Promise<void>;

  test.beforeEach(async ({ settings }) => {
    settingsFor = async () => { await settings({ nodeEditor: true, combobox: false, htmlExport: false }); };
  });

  test('the overlay mounts inside the form, and the form is not display:none', async ({ page }) => {
    await inRail(page);
    // Both are prerequisites: a widget outside the form is not submitted, and a
    // descendant of a display:none ancestor cannot be revealed at all.
    const state = await page.evaluate(() => {
      const host = document.querySelector('.d7-proxy-ui-form-host')!;
      const form = document.querySelector('form.node-form') as HTMLFormElement;
      return {
        hostInForm: Boolean(host.closest('form.node-form')),
        formVisible: getComputedStyle(form).display !== 'none',
        originalContentHidden: form.querySelectorAll('[data-d7-hidden]').length > 0,
      };
    });
    expect(state).toEqual({ hostInForm: true, formVisible: true, originalContentHidden: true });
  });

  test('media widgets are relocated, visible, and still inside the form', async ({ page }) => {
    await inRail(page);
    const relocated = await page.evaluate(() => {
      const host = document.querySelector('.d7-proxy-ui-form-host')!;
      return [...host.children].filter(c => c.hasAttribute('slot')).map(c => ({
        input: (c.querySelector('input') as HTMLInputElement | null)?.name,
        visible: getComputedStyle(c as HTMLElement).display !== 'none',
        inForm: Boolean(c.closest('form.node-form')),
      }));
    });
    expect(relocated.every(r => r.visible && r.inForm)).toBe(true);
    // Autocompletes are relocated as well, so this asserts the media pair is present
    // rather than that it is the whole set.
    expect(relocated.map(r => r.input)).toEqual(expect.arrayContaining([
      'media[field_image_teaser_und_0]', 'media[field_image_hero_und_0]',
    ]));
  });

  test('relocated inputs are still submitted with the form', async ({ page }) => {
    // The property that would break saving without any visible symptom.
    await inRail(page);
    const submitted = await page.evaluate(() => {
      const fd = new FormData(document.querySelector('form.node-form') as HTMLFormElement);
      return {
        teaser: fd.has('media[field_image_teaser_und_0]'),
        hero: fd.has('media[field_image_hero_und_0]'),
        title: fd.has('title_field[und][0][value]'),
      };
    });
    expect(submitted).toEqual({ teaser: true, hero: true, title: true });
  });

  test('a value entered in the relocated widget reaches the form data', async ({ page }) => {
    await inRail(page);
    await page.fill('input[name="media[field_image_teaser_und_0]"]', '12345');
    const value = await page.evaluate(() =>
      new FormData(document.querySelector('form.node-form') as HTMLFormElement)
        .get('media[field_image_teaser_und_0]'));
    expect(value).toBe('12345');
  });

  test('the widget renders inside its column, not overflowing beside it', async ({ page }) => {
    await inRail(page);
    // Measured against the Multimedia block, which is in the writing column now. A
    // projected widget wider than its host reads as a broken layout even though the
    // slotting worked, so the bound is worth keeping wherever the section lives.
    const fits = await page.evaluate(() => {
      const host = document.querySelector('.d7-proxy-ui-form-host')!;
      const widget = [...host.children].find(c => c.getAttribute('slot')?.includes('teaser')) as HTMLElement;
      const block = host.shadowRoot!.querySelector('[data-left-section="multimedia"]')!;
      const w = widget.getBoundingClientRect(), b = block.getBoundingClientRect();
      return w.width > 0 && w.left >= b.left - 2 && w.right <= b.right + 2;
    });
    expect(fits).toBe(true);
  });

  test('autocompletes are relocated so Drupal\'s type-to-select still works', async ({ page }) => {
    /**
     * The regression this guards. Drupal binds its autocomplete to the ORIGINAL input on
     * keyup; a re-rendered text box looks identical and has no type-ahead at all. On
     * Related Content that behavior is load-bearing — the editor is matching against real
     * node titles and cannot be expected to know them exactly.
     */
    await settingsFor(page);
    await page.goto(`${HOST}/node/add/news`);
    await expect(page.locator(`${UI} input[aria-label="Title"]`)).toBeVisible();
    await openRailSection(page, 'related');

    const relocated = await page.evaluate(() => {
      const host = document.querySelector('.d7-proxy-ui-form-host')!;
      const w = [...host.children].find(c => c.getAttribute('slot')?.includes('field-services'));
      return {
        found: Boolean(w),
        // Multi-value plumbing must travel with the field: the Add button is a SIBLING of
        // the delta table, so relocating only the inner .form-item would strand it and an
        // editor could never add a second item.
        addAnother: Boolean(w?.querySelector('input[value="Add another item"]')),
        rowWeight: Boolean(w?.querySelector('select[name*="_weight"]')),
        stillInForm: Boolean(w?.closest('form.node-form')),
      };
    });
    expect(relocated).toEqual({ found: true, addAnother: true, rowWeight: true, stillInForm: true });
  });

  test('a relocated autocomplete still submits what was typed', async ({ page }) => {
    await settingsFor(page);
    await page.goto(`${HOST}/node/add/news`);
    await expect(page.locator(`${UI} input[aria-label="Title"]`)).toBeVisible();
    await openRailSection(page, 'related');

    const input = page.locator('input[name="field_services[und][0][target_id]"]');
    // Real keystrokes: fill() dispatches only input/change, so it would not exercise the
    // keyup path Drupal's autocomplete listens on.
    await input.click();
    await input.pressSequentially('cardiology', { delay: 20 });

    const value = await page.evaluate(() =>
      new FormData(document.querySelector('form.node-form') as HTMLFormElement)
        .get('field_services[und][0][target_id]'));
    expect(value).toBe('cardiology');
  });

  test('the editor does not inject the standalone widgets it supersedes', async ({ page }) => {
    // They mount as siblings of the native controls, inside the content the editor hides,
    // so with the editor on they would render inside a display:none ancestor — invisible,
    // while still having hidden the native select they replaced.
    await settingsFor(page);
    // This fixture HAS a menu[parent], so the standalone combobox would inject here —
    // which is what makes the guard meaningful. It has no Title field, so wait on the
    // rail header instead.
    await page.goto(`${HOST}/node/123/edit`);
    await expect(page.locator(`${UI} >> text=Everything Else`)).toBeVisible();

    const zeroWidth = await page.evaluate(() =>
      [...document.querySelectorAll('.d7-proxy-ui-container')]
        .filter(h => !h.classList.contains('d7-proxy-ui-form-host'))
        .filter(h => h.getBoundingClientRect().width === 0).length);
    expect(zeroWidth).toBe(0);
  });

  test('the overlay does not duplicate Drupal\'s own field label', async ({ page }) => {
    await inRail(page);
    // Drupal's widget carries its own <label>; ours would read "TEASER IMAGE" above it.
    const count = await page.evaluate(() => {
      const host = document.querySelector('.d7-proxy-ui-form-host')!;
      return host.shadowRoot!.querySelectorAll('.text-eyebrow').length
        ? [...host.shadowRoot!.querySelectorAll('*')]
            .filter(e => /^teaser image$/i.test((e.textContent ?? '').trim())).length
        : 0;
    });
    expect(count).toBe(0);
  });
});

test.describe('D7 Studio: menu parent depth', () => {
  /**
   * The live main menu nests five levels before reaching a leaf. The picker previously
   * filtered options to depth <= 3, which silently removed most of the menu — only
   * top-level items and their immediate children could be chosen.
   *
   * Filtering by depth was wrong at any number: Drupal's menu[parent] select already
   * contains exactly the legal parents, so second-guessing it can only remove valid
   * choices.
   */
  const openMenuSection = async (page: import('@playwright/test').Page, settings: any) => {
    await settings({ nodeEditor: true, combobox: false, htmlExport: false });
    await page.goto(`${HOST}/node/add/page`);
    await expect(page.locator(`${UI} input[aria-label="Title"]`)).toBeVisible();
    await openRailSection(page, 'menu');
    await expect(page.locator(`${UI} input[placeholder="Filter parent items"]`)).toBeVisible();
  };

  test('every parent Drupal offers is selectable, at any depth', async ({ page, settings }) => {
    await openMenuSection(page, settings);
    // The row's LABEL, not the whole button: each row also carries its ancestor trail,
    // so matching the button's full text would break on that context by design.
    const labels = await page.locator(`${UI} aside [data-parent-label]`).allInnerTexts();
    // Depth 4 and 5 entries must be present, not just the top two levels.
    for (const deep of ['Active BP Blood Pressure Monitoring', 'Video Tutorial', 'FAQ']) {
      expect(labels.some(t => t.trim() === deep), `"${deep}" should be selectable`).toBe(true);
    }
  });

  /**
   * The bug this covers: picking a parent set menu[parent] on a fieldset Drupal ignores.
   *
   * Drupal 7 gates the whole menu fieldset on menu[enabled] — "Provide a menu link",
   * unchecked by default, with a "Not in menu" summary beside it. With it unchecked,
   * menu_node_save() discards the parent and the link title, so the placement silently
   * fails to persist and the node saves with no menu link at all.
   *
   * Drupal also requires a link title once enabled, so setting only the checkbox trades
   * silent loss for a validation error on save. Both have to be handled for a selection
   * to survive.
   */
  test('selecting a parent enables the menu link, so the placement survives save', async ({ page, settings }) => {
    await openMenuSection(page, settings);
    await expect(page.locator('#edit-menu-enabled')).not.toBeChecked();

    await page.locator(`${UI} aside button`, { hasText: 'Video Tutorial' }).first().click();

    await expect(page.locator('select[name="menu[parent]"]')).not.toHaveValue('');
    await expect(page.locator('#edit-menu-enabled'),
      'Drupal discards the whole fieldset when this is unchecked').toBeChecked();
  });

  test('enabling the menu link gives it a title, which Drupal requires', async ({ page, settings }) => {
    await openMenuSection(page, settings);
    await page.fill(`${UI} input[aria-label="Title"]`, 'Blood Pressure Video Tutorial');
    await page.locator(`${UI} aside button`, { hasText: 'Video Tutorial' }).first().click();

    // Empty link_title with enabled=1 fails Drupal's own validation on submit.
    await expect(page.locator('input[name="menu[link_title]"]'))
      .toHaveValue('Blood Pressure Video Tutorial');
  });

  /**
   * A row carrying only its own title is not enough to choose by.
   *
   * The live main menu has six items called "Our Services", one per specialty. Indentation
   * distinguishes them only while their parents are on screen, and a search shows matches
   * interleaved with dimmed ancestors that scroll away.
   */
  test('a deep parent row names its immediate ancestors', async ({ page, settings }) => {
    await openMenuSection(page, settings);
    await page.fill(`${UI} input[placeholder="Filter parent items"]`, 'Video Tutorial');

    const trail = page.locator(`${UI} aside [data-parent-option="main-menu:204"] [data-parent-trail]`);
    await expect(trail).toBeVisible();
    await expect(trail).toContainText('Our Services');
    await expect(trail).toContainText('Active BP Blood Pressure Monitoring');
    // Five ancestors, two shown — the rest are elided rather than wrapping the rail.
    await expect(trail).toContainText('…');
    await expect(trail).not.toContainText('Specialties');
  });

  test('a dimmed context row does not restate its own lineage', async ({ page, settings }) => {
    await openMenuSection(page, settings);
    await page.fill(`${UI} input[placeholder="Filter parent items"]`, 'Video Tutorial');

    // Specialties is present only to hold the hierarchy up, so a trail on it is noise.
    await expect(page.locator(`${UI} aside [data-parent-option="main-menu:200"]`)).toBeVisible();
    await expect(
      page.locator(`${UI} aside [data-parent-option="main-menu:200"] [data-parent-trail]`)
    ).toHaveCount(0);
  });

  /**
   * Order matters more than it looks.
   *
   * The Vagelos Page type adds two menu fields of its own — "Menu modal: NID" and
   * "Link tooltip" — which are not advanced, so marking core's attribute fields advanced
   * did not stop them pushing the parent picker to fifth position, below the panel's
   * visible area. The placement control has to lead the section named Menu Placement.
   */
  test('the parent picker comes before the fields it writes to', async ({ page, settings }) => {
    await openMenuSection(page, settings);
    const order = await page.evaluate(() => {
      const root = document.querySelector('.d7-proxy-ui-form-host')!.shadowRoot!;
      const picker = root.querySelector('aside input[placeholder="Filter parent items"]')!;
      const enabled = [...root.querySelectorAll('aside label')]
        .find(l => /Provide a menu link/i.test(l.textContent ?? ''))!;
      // DOCUMENT_POSITION_FOLLOWING === the checkbox comes after the picker.
      return Boolean(picker.compareDocumentPosition(enabled) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(order, 'the picker must precede "Provide a menu link"').toBe(true);
  });

  test('reports how deep the menu goes', async ({ page, settings }) => {
    await openMenuSection(page, settings);
    // 11 options spanning depths 0..5.
    await expect(page.locator(`${UI} aside >> text=/possible parents, 6 levels deep/`)).toBeVisible();
  });

  test('indentation increases with depth so hierarchy stays readable', async ({ page, settings }) => {
    await openMenuSection(page, settings);
    const pads = await page.evaluate(() => {
      const root = document.querySelector('.d7-proxy-ui-form-host')!.shadowRoot!;
      // Match on the label span, then measure the button that owns it.
      const find = (text: string) => [...root.querySelectorAll('aside [data-parent-label]')]
        .find(l => l.textContent?.trim() === text)
        ?.closest('button') as HTMLElement | undefined;
      return {
        specialties: parseFloat(getComputedStyle(find('Specialties')!).paddingLeft),
        services: parseFloat(getComputedStyle(find('Our Services')!).paddingLeft),
        tutorial: parseFloat(getComputedStyle(find('Video Tutorial')!).paddingLeft),
      };
    });
    expect(pads.services).toBeGreaterThan(pads.specialties);
    expect(pads.tutorial).toBeGreaterThan(pads.services);
  });

  test('a deep parent can be selected and is written to the native select', async ({ page, settings }) => {
    await openMenuSection(page, settings);
    await page.locator(`${UI} aside [data-parent-option="main-menu:204"]`).click();
    await expect(page.locator('#edit-menu-parent')).toHaveValue('main-menu:204');
  });

  test('filtering a deep item keeps its whole ancestor chain visible', async ({ page, settings }) => {
    await openMenuSection(page, settings);
    await page.fill(`${UI} input[placeholder="Filter parent items"]`, 'video');
    const labels = (await page.locator(`${UI} aside [data-parent-label]`).allInnerTexts()).map(t => t.trim());
    // The match plus all four ancestors, so the position is never ambiguous.
    for (const crumb of ['Specialties', 'Cardiology & Cardiac Surgery', 'Our Services',
                         'Active BP Blood Pressure Monitoring', 'Video Tutorial']) {
      expect(labels, `"${crumb}" should be retained`).toContain(crumb);
    }
  });

  test('the breadcrumb shows the full path for a deep selection', async ({ page, settings }) => {
    await openMenuSection(page, settings);
    await page.locator(`${UI} aside [data-parent-option="main-menu:204"]`).click();
    const trail = await page.locator(`${UI} aside >> text=/Will appear under/`).innerText();
    expect(trail).toContain('Specialties');
    expect(trail).toContain('Our Services');
    expect(trail).toContain('Video Tutorial');
  });
});

test.describe('D7 Studio: parent picker at real scale', () => {
  /**
   * Measured on the live Vagelos form: menu[parent] offers 3,149 options across two menus,
   * nested up to 16 levels. Rendering all of them is slow and useless — nobody scrolls
   * three thousand rows — so above a threshold the list stays empty until the editor types.
   */
  const open = async (page: import('@playwright/test').Page, settings: any) => {
    await settings({ nodeEditor: true, combobox: false, htmlExport: false });
    await page.goto(`${HOST}/node/add/page-bigmenu`);
    await expect(page.locator(`${UI} input[aria-label="Title"]`)).toBeVisible();
    await openRailSection(page, 'menu');
    await expect(page.locator(`${UI} input[placeholder="Filter parent items"]`)).toBeVisible();
  };

  const rowCount = (page: import('@playwright/test').Page) =>
    page.locator(`${UI} aside [style*="padding-left"]`).count();

  test('a large menu lists nothing until you type', async ({ page, settings }) => {
    await open(page, settings);
    expect(await rowCount(page)).toBe(0);
    await expect(page.locator(`${UI} aside >> text=/Type above to search/`)).toBeVisible();
  });

  test('it still reports the size and depth of the menu', async ({ page, settings }) => {
    await open(page, settings);
    await expect(page.locator(`${UI} aside >> text=/possible parents, \\d+ levels deep/`).first()).toBeVisible();
  });

  test('typing narrows to matches with their ancestors', async ({ page, settings }) => {
    await open(page, settings);
    await page.fill(`${UI} input[placeholder="Filter parent items"]`, 'Detail 7.1');
    const labels = (await page.locator(`${UI} aside [data-parent-label]`).allInnerTexts()).map(t => t.trim());
    expect(labels).toContain('Detail 7.1 Cardiology');
    // Ancestors retained, so the position in a 200-row menu is never ambiguous.
    expect(labels).toContain('Specialty 7');
    expect(labels).toContain('Service 7.1');
  });

  /**
   * Searching a section must reach INTO it.
   *
   * Reported on the live form: typing "ghar" found the Gharavi Lab menu root and one
   * unrelated news item, and nothing else — every page actually inside that section was
   * invisible, because none of them repeat the section's name in their own title. There
   * was no way to place a node under a child of a section you had just found.
   *
   * "Specialty 7" appears in no descendant's own label, only in their ancestry.
   */
  test('searching a parent surfaces the items beneath it', async ({ page, settings }) => {
    await open(page, settings);
    await page.fill(`${UI} input[placeholder="Filter parent items"]`, 'Specialty 7');

    const labels = (await page.locator(`${UI} aside [data-parent-label]`).allInnerTexts())
      .map(t => t.trim());
    expect(labels, 'the section itself').toContain('Specialty 7');
    expect(labels, 'a child of it').toContain('Service 7.1');
    expect(labels, 'a grandchild of it').toContain('Detail 7.1 Cardiology');
  });

  test('a descendant found by its ancestry is selectable, not just context', async ({ page, settings }) => {
    // Retained ancestors render dimmed and are still clickable, but a descendant surfaced
    // by the section name has to count as a real match — otherwise the count lies and it
    // reads as scaffolding rather than a result.
    await open(page, settings);
    await page.fill(`${UI} input[placeholder="Filter parent items"]`, 'Specialty 7');

    // Detail 7.1 Cardiology — a grandchild of Specialty 7, whose own label contains
    // nothing matching the query.
    const row = page.locator(`${UI} aside [data-parent-option="main-menu:3071"]`);
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.locator('#edit-menu-parent')).toHaveValue('main-menu:3071');
  });

  test('a broad query is capped rather than rendering everything', async ({ page, settings }) => {
    await open(page, settings);
    await page.fill(`${UI} input[placeholder="Filter parent items"]`, 'e');
    const rows = await rowCount(page);
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThanOrEqual(120);
    await expect(page.locator(`${UI} aside >> text=/keep typing to narrow/`)).toBeVisible();
  });

  test('a deep match can still be selected and written back', async ({ page, settings }) => {
    await open(page, settings);
    await page.fill(`${UI} input[placeholder="Filter parent items"]`, 'Detail 12.1');
    await page.locator(`${UI} aside [data-parent-option="main-menu:3121"]`).click();
    await expect(page.locator('#edit-menu-parent')).toHaveValue('main-menu:3121');
  });

  test('a small menu still lists everything immediately', async ({ page, settings }) => {
    // The threshold must not change behaviour for ordinary menus.
    await settings({ nodeEditor: true, combobox: false, htmlExport: false });
    await page.goto(`${HOST}/node/add/page`);
    await expect(page.locator(`${UI} input[aria-label="Title"]`)).toBeVisible();
    await openRailSection(page, 'menu');
    expect(await rowCount(page)).toBeGreaterThan(0);
    await expect(page.locator(`${UI} aside >> text=/Type above to search/`)).toHaveCount(0);
  });
});

test.describe('D7 Studio: rarely-used fields collapse', () => {
  /**
   * The live Page form's Menu Placement section filled with menu-attribute fields — ID,
   * Name, Relationship, Classes, Style, Target, Access key, Section style, Modal nid —
   * each with help text, which buried the parent picker the section exists for.
   *
   * They collapse rather than disappear: rarely is not never, and a section that silently
   * omits fields is worse than a long one.
   */
  const openMenu = async (page: import('@playwright/test').Page, settings: any) => {
    await settings({ nodeEditor: true, combobox: false, htmlExport: false });
    await page.goto(`${HOST}/node/add/page`);
    await expect(page.locator(`${UI} input[aria-label="Title"]`)).toBeVisible();
    await openRailSection(page, 'menu');
    await expect(page.locator(`${UI} input[placeholder="Filter parent items"]`)).toBeVisible();
  };

  test('menu-attribute fields are hidden behind a disclosure by default', async ({ page, settings }) => {
    await openMenu(page, settings);

    // The parent picker is visible; the attribute fields are not.
    await expect(page.locator(`${UI} aside >> text=Parent item`)).toBeVisible();
    await expect(page.locator(`${UI} [data-advanced-fields]`)).toHaveCount(0);
    await expect(page.locator(`${UI} aside >> text=/Show 9 rarely-used fields/`)).toBeVisible();
  });

  test('they are reachable and editable once revealed', async ({ page, settings }) => {
    await openMenu(page, settings);
    await page.locator(`${UI} aside button`, { hasText: /Show 9 rarely-used fields/ }).click();

    await expect(page.locator(`${UI} [data-advanced-fields]`)).toBeVisible();
    // And they still write through to the native inputs.
    const classes = page.locator(`${UI} [data-advanced-fields] input`).nth(3);
    await classes.fill('promo-link');
    const written = await page.evaluate(() =>
      (document.getElementById('edit-menu-attr-class') as HTMLInputElement).value);
    expect(written).toBe('promo-link');
  });

  test('the section header says how many are held back', async ({ page, settings }) => {
    await settings({ nodeEditor: true, combobox: false, htmlExport: false });
    await page.goto(`${HOST}/node/add/page`);
    await expect(page.locator(`${UI} input[aria-label="Title"]`)).toBeVisible();
    // Visible with nothing clicked: the count belongs on the section header, so nothing
    // feels missing before it is opened.
    await expect(page.locator(`${UI} aside >> text=/rarely used/`).first()).toBeVisible();
  });

  test('collapsing does not remove them from the form', async ({ page, settings }) => {
    // They must still submit while collapsed — hiding a field in the overlay must not
    // change what Drupal receives.
    await openMenu(page, settings);
    const submitted = await page.evaluate(() =>
      new FormData(document.querySelector('form.node-form') as HTMLFormElement)
        .has('menu[options][attributes][class]'));
    expect(submitted).toBe(true);
  });
});

test.describe('D7 Studio: safe defaults', () => {
  test('the two-pane editor is OFF by default, leaving the native form intact', async ({ page }) => {
    // It replaces an entire live editing form on discovery rules that are not yet
    // validated against real markup, so it must not be on for a fresh install.
    await page.goto(`${HOST}/node/add/news`);
    await expect(page.locator('form.node-form')).toBeVisible();
    await expect(page.locator('#edit-title-field')).toBeVisible();
  });

  test('turning the editor on replaces the form but keeps the native inputs', async ({ page, settings }) => {
    await settings({ nodeEditor: true });
    await page.goto(`${HOST}/node/add/news`);

    await expect(page.locator(`${UI} input[aria-label="Title"]`)).toBeVisible();
    // The form stays displayed and its ORIGINAL CONTENT is hidden instead. Hiding the
    // form itself would make relocated widgets unrevealable, since a descendant of a
    // display:none ancestor cannot be shown.
    await expect(page.locator('form.node-form')).toBeVisible();
    await expect(page.locator('form.node-form [data-d7-hidden]').first()).toBeAttached();
    // Hidden, never removed: the overlay writes to these and Drupal's submit saves them.
    await expect(page.locator('#edit-title-field')).toHaveCount(1);

    await page.fill(`${UI} input[aria-label="Title"]`, 'Ablation outcomes at five years');
    await expect(page.locator('#edit-title-field')).toHaveValue('Ablation outcomes at five years');
  });

  /**
   * The other direction, which nothing covered.
   *
   * PrimaryField and FieldControl read their value once, in a useState initializer, and
   * never again — no effect, no observer, no listener. So anything that writes to the
   * native input behind the overlay is invisible: the import applies a title to
   * Drupal's real field, the overlay keeps showing the empty box it captured at mount,
   * and an empty title box is indistinguishable from an import that failed.
   *
   * This reproduces exactly what fieldBinding.writeValue() does — assign, then dispatch
   * the bubbling input/change pair from notify().
   */
  test('the overlay reflects a value written to the native field behind it', async ({ page, settings }) => {
    await settings({ nodeEditor: true });
    await page.goto(`${HOST}/node/add/news`);
    await expect(page.locator(`${UI} input[aria-label="Title"]`)).toBeVisible();
    await expect(page.locator(`${UI} input[aria-label="Title"]`)).toHaveValue('');

    await page.evaluate(() => {
      const el = document.querySelector('#edit-title-field') as HTMLInputElement;
      el.value = 'Predicting Progression of IgA Nephropathy';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await expect(page.locator(`${UI} input[aria-label="Title"]`))
      .toHaveValue('Predicting Progression of IgA Nephropathy');
  });

  test('the schema diagnostic is off by default and on when enabled', async ({ page, settings }) => {
    const logs: string[] = [];
    page.on('console', m => logs.push(m.text()));

    await page.goto(`${HOST}/node/add/news`);
    await expect(page.locator('#edit-title-field')).toBeVisible();
    expect(logs.some(l => l.includes('Form schema'))).toBe(false);

    await settings({ debugSchema: true });
    await page.reload();
    await expect(page.locator('#edit-title-field')).toBeVisible();
    await expect.poll(() => logs.some(l => l.includes('content type: news'))).toBe(true);
  });
});

test.describe('Feature 5: the body keeps Drupal\'s real rich text editor', () => {
  /**
   * The body used to render a plain textarea beneath a row of grey aria-hidden spans
   * reading "B I Link H2 H3 List Table Image". None of them did anything, so the field
   * had no formatting controls at all.
   *
   * These assert the real editor is moved into the overlay and rebuilt there, rather
   * than a toolbar being reimplemented — the site's own button list is the point, and a
   * reimplementation could never know it.
   */
  const openBody = async (page: import('@playwright/test').Page) => {
    await page.goto(`${HOST}/node/add/news-ckeditor`);
    await page.waitForSelector('.d7-proxy-ui-form-host', { timeout: 15000 });
    // The rebuild is bracketed by two async hops through the service worker.
    await page.waitForFunction(
      () => !!document.querySelector('.cke'),
      undefined,
      { timeout: 15000 }
    );
  };

  test('the editor is rebuilt inside the overlay, carrying the site\'s own buttons', async ({ page, settings }) => {
    await settings({ nodeEditor: true, combobox: false, htmlExport: false });
    await openBody(page);

    const state = await page.evaluate(() => {
      const host = document.querySelector('.d7-proxy-ui-form-host') as HTMLElement;
      const cke = document.querySelector('.cke') as HTMLElement;
      const buttons = Array.from(cke.querySelectorAll('.cke_button')).map(b => b.textContent);
      return {
        // Inside the overlay host, not left behind in the hidden form content.
        insideOverlay: !!cke.closest('.d7-proxy-ui-form-host'),
        // And still inside the form, or it would not be submitted.
        insideForm: !!cke.closest('form'),
        slot: cke.closest('[slot]')?.getAttribute('slot') ?? null,
        buttons,
        instances: Object.keys((window as any).CKEDITOR.instances),
        hostHasSlotted: host.querySelectorAll('[slot]').length,
      };
    });

    expect(state.insideOverlay).toBe(true);
    expect(state.insideForm).toBe(true);
    expect(state.slot).toBeTruthy();
    // The site's configured buttons, not a default set we invented.
    expect(state.buttons).toEqual(['Bold', 'Italic', 'Link', 'Format', 'BulletedList', 'CU Media']);
    expect(state.instances).toEqual(['edit-body-value']);
  });

  test('the projecting slot exists, so the editor is actually rendered', async ({ page, settings }) => {
    await settings({ nodeEditor: true, combobox: false, htmlExport: false });
    await openBody(page);

    // An unslotted light-DOM child of a shadow host is not rendered AT ALL, so a
    // relocated editor with no matching slot would be invisible while still submitting.
    const rendered = await page.evaluate(() => {
      const host = document.querySelector('.d7-proxy-ui-form-host') as HTMLElement;
      const sr = host.shadowRoot!;
      const slotNames = new Set(
        Array.from(sr.querySelectorAll('slot')).map(s => s.getAttribute('name'))
      );
      const relocated = Array.from(host.children)
        .map(c => c.getAttribute('slot'))
        .filter(Boolean) as string[];
      const cke = document.querySelector('.cke') as HTMLElement;
      return {
        orphans: relocated.filter(n => !slotNames.has(n)),
        editorHasSize: cke.getBoundingClientRect().height > 0,
      };
    });

    expect(rendered.orphans).toEqual([]);
    expect(rendered.editorHasSize).toBe(true);
  });

  test('content survives the move, which a bare reparent would have destroyed', async ({ page, settings }) => {
    await settings({ nodeEditor: true, combobox: false, htmlExport: false });
    await openBody(page);

    // The editing surface is an iframe; moving one reloads it. Detaching before the move
    // and rebuilding after is what keeps the text.
    const data = await page.evaluate(() =>
      (window as any).CKEDITOR.instances['edit-body-value'].getData());
    expect(data).toContain('Original body text.');
  });

  test('no fake toolbar is drawn anywhere in the overlay', async ({ page, settings }) => {
    await settings({ nodeEditor: true, combobox: false, htmlExport: false });
    await openBody(page);

    // The old mock strip rendered these as aria-hidden spans. Nothing in the shadow tree
    // should claim to be a formatting control that isn't one.
    const fakes = await page.evaluate(() => {
      const sr = (document.querySelector('.d7-proxy-ui-form-host') as HTMLElement).shadowRoot!;
      return Array.from(sr.querySelectorAll('[aria-hidden="true"]'))
        .map(el => (el.textContent || '').trim())
        .filter(t => ['B', 'I', 'Link', 'H2', 'H3', 'List', 'Table', 'Image'].includes(t));
    });
    expect(fakes).toEqual([]);
  });

  test('the local draft records what was typed into the editor, not the stale textarea', async ({ page, settings }) => {
    await settings({ nodeEditor: true, combobox: false, htmlExport: false });
    await openBody(page);

    // A rich editor holds content in its own object until submit. Typing here mimics
    // that: the textarea still says "Original body text." afterwards.
    await page.evaluate(() =>
      (window as any).CKEDITOR.instances['edit-body-value'].setData('<p>Typed into the editor.</p>'));

    const stale = await page.evaluate(() =>
      (document.getElementById('edit-body-value') as HTMLTextAreaElement).value);
    expect(stale).toContain('Original body text.');

    // The autosave beat is 5s, and it syncs the editors before reading.
    await page.waitForFunction(
      () => (document.getElementById('edit-body-value') as HTMLTextAreaElement)
        .value.includes('Typed into the editor.'),
      undefined,
      { timeout: 20000 }
    );
  });
});

test.describe('Feature 5: a chosen image shows as selected', () => {
  /**
   * The reported symptom: uploading put the file in the library and it attached on save,
   * but the editor never showed it as selected.
   *
   * Cause was the wrapper climb. Media names its launcher media[field_image_teaser_und_0]
   * and its siblings field_image_teaser[und][0][fid]; a prefix test against baseName
   * `field_image_teaser` rejected the launcher's own name, so only the innermost
   * .form-item moved and Drupal's ajax wrapper stayed in the hidden form. The thumbnail
   * was then rendered into the hidden region — correct data, invisible UI.
   */
  const open = async (page: import('@playwright/test').Page, settings: (v: Record<string, unknown>) => Promise<void>) => {
    await settings({ nodeEditor: true, combobox: false, htmlExport: false });
    await page.goto(`${HOST}/node/add/news-media`);
    await page.waitForSelector('.d7-proxy-ui-form-host', { timeout: 15000 });
  };

  test('the whole widget moves, including the ajax wrapper and the hidden fid', async ({ page, settings }) => {
    await open(page, settings);

    const state = await page.evaluate(() => {
      const wrapper = document.getElementById('edit-field-image-teaser-und-0-ajax-wrapper')!;
      const fid = document.querySelector('input[name="field_image_teaser[und][0][fid]"]')!;
      return {
        wrapperInOverlay: !!wrapper.closest('.d7-proxy-ui-form-host'),
        fidInOverlay: !!fid.closest('.d7-proxy-ui-form-host'),
        // Still inside the form, or nothing would submit.
        fidInForm: !!fid.closest('form'),
        // Not stranded in the region we hid.
        fidHidden: !!fid.closest('[data-d7-hidden]'),
      };
    });

    expect(state).toEqual({
      wrapperInOverlay: true, fidInOverlay: true, fidInForm: true, fidHidden: false,
    });
  });

  test('the neighbouring image field is not swallowed by the climb', async ({ page, settings }) => {
    await open(page, settings);

    // Each field needs its own carrier, or one slot would try to project both.
    const slots = await page.evaluate(() => {
      const host = document.querySelector('.d7-proxy-ui-form-host') as HTMLElement;
      return Array.from(host.children)
        .map(c => c.getAttribute('slot'))
        .filter(Boolean);
    });

    expect(slots).toContain('field-media-field-image-teaser-und-0-');
    expect(slots).toContain('field-media-field-image-hero-und-0-');
  });

  test('after selection the thumbnail is visible in the overlay, not in the hidden form', async ({ page, settings }) => {
    await open(page, settings);

    const result = await page.evaluate(() =>
      (window as any).simulateMediaSelect('teaser', '9911', 'campus-quad.jpg'));
    expect(result).toBe('replaced');

    // A collapsed section renders no <slot>, so nothing projected into one has a box.
    // Multimedia is expanded in the left column, but expand the rest anyway so this test
    // measures the widget rather than the layout.
    await expandAll(page);

    const shown = await page.evaluate(() => {
      const preview = document.querySelector('.preview-teaser') as HTMLElement | null;
      if (!preview) return { found: false };
      const carrier = preview.closest('[slot]');
      return {
        found: true,
        inOverlay: !!preview.closest('.d7-proxy-ui-form-host'),
        // The carrier survived Drupal replacing its own wrapper, so this is still projected.
        stillSlotted: !!carrier,
        inHiddenRegion: !!preview.closest('[data-d7-hidden]'),
        rendered: preview.getBoundingClientRect().height > 0,
        filename: preview.querySelector('.filename')?.textContent,
      };
    });

    expect(shown.found).toBe(true);
    expect(shown.inOverlay).toBe(true);
    expect(shown.stillSlotted).toBe(true);
    expect(shown.inHiddenRegion).toBe(false);
    expect(shown.rendered).toBe(true);
    expect(shown.filename).toBe('campus-quad.jpg');
  });

  test('the fid from the selection is what the form would submit', async ({ page, settings }) => {
    await open(page, settings);
    await page.evaluate(() => (window as any).simulateMediaSelect('teaser', '9911', 'campus-quad.jpg'));

    const submitted = await page.evaluate(() => {
      const form = document.querySelector('form') as HTMLFormElement;
      const data = new FormData(form);
      return {
        fid: data.get('field_image_teaser[und][0][fid]'),
        // A duplicate empty copy left behind would override this on the server.
        copies: form.querySelectorAll('input[name="field_image_teaser[und][0][fid]"]').length,
      };
    });

    expect(submitted).toEqual({ fid: '9911', copies: 1 });
  });
});

test.describe('Feature 5: an existing article can still change its image', () => {
  /**
   * Reported from columbiadoctors.org/node/18948/edit: no option to change the image.
   *
   * The Multimedia section was absent from the rail entirely. A populated Media widget
   * has no visible control — the file is a hidden fid, and Remove/Edit are submit
   * buttons — and the walker drops hidden and submit inputs as structural. With nothing
   * left, the field did not exist, so the section that would have held it was never
   * rendered and there was no route to the image at all.
   */
  const open = async (page: import('@playwright/test').Page, settings: (v: Record<string, unknown>) => Promise<void>) => {
    await settings({ nodeEditor: true, combobox: false, htmlExport: false, debugSchema: true });
    await page.goto(`${HOST}/node/18948/edit`);
    await page.waitForSelector('.d7-proxy-ui-form-host', { timeout: 15000 });
    await expandAll(page);
  };

  test('the Multimedia section appears, in the writing column and already open', async ({ page, settings }) => {
    await open(page, settings);
    // In the left column with no toggle: the image is part of the article, and behind a
    // rail toggle it was reported missing twice.
    const block = page.locator(`${UI} [data-left-section="multimedia"]`);
    await expect(block).toBeVisible();
    await expect(block).toContainText('Multimedia');
    await expect(page.locator(`${UI} aside`)).not.toContainText('Multimedia');
  });

  test('both attached images are found, with their real labels', async ({ page, settings }) => {
    await open(page, settings);
    // Drupal's OWN label is what shows, and it lives in the light DOM being projected —
    // the overlay suppresses its own label for relocated widgets rather than printing it
    // twice. So shadowRoot.textContent is the wrong place to look; the host's children
    // are the right one.
    const labels = await page.evaluate(() => {
      const host = document.querySelector('.d7-proxy-ui-form-host') as HTMLElement;
      const visible = Array.from(host.querySelectorAll('label'))
        .filter(l => (l as HTMLElement).getBoundingClientRect().height > 0)
        .map(l => (l.textContent || '').trim());
      return {
        teaser: visible.includes('Teaser Image'),
        hero: visible.includes('Hero Image'),
        // And exactly once each, not doubled by our own label.
        teaserCount: visible.filter(t => t === 'Teaser Image').length,
      };
    });
    expect(labels).toEqual({ teaser: true, hero: true, teaserCount: 1 });
  });

  test('Drupal\'s own Remove and Edit buttons are reachable, which is how you change it', async ({ page, settings }) => {
    await open(page, settings);

    const controls = await page.evaluate(() => {
      const remove = document.querySelector('input[name="field_image_teaser_und_0_remove_button"]') as HTMLElement | null;
      const edit = document.querySelector('input[name="field_image_teaser_und_0_edit_button"]') as HTMLElement | null;
      const thumb = document.querySelector('.preview-teaser') as HTMLElement | null;
      return {
        removeInOverlay: !!remove?.closest('.d7-proxy-ui-form-host'),
        removeVisible: !!remove && remove.getBoundingClientRect().height > 0,
        editInOverlay: !!edit?.closest('.d7-proxy-ui-form-host'),
        thumbVisible: !!thumb && thumb.getBoundingClientRect().height > 0,
        filename: thumb?.querySelector('.filename')?.textContent,
      };
    });

    expect(controls.removeInOverlay).toBe(true);
    expect(controls.removeVisible).toBe(true);
    expect(controls.editInOverlay).toBe(true);
    expect(controls.thumbVisible).toBe(true);
    expect(controls.filename).toBe('puberty-study-teaser.jpg');
  });

  test('the existing fid is preserved, so saving does not detach the image', async ({ page, settings }) => {
    await open(page, settings);

    // The failure mode to guard against: surfacing the field but losing its value, which
    // would silently strip the image from a published article on save.
    const submitted = await page.evaluate(() => {
      const data = new FormData(document.querySelector('form') as HTMLFormElement);
      return {
        teaser: data.get('field_image_teaser[und][0][fid]'),
        hero: data.get('field_image_hero[und][0][fid]'),
      };
    });
    expect(submitted).toEqual({ teaser: '44120', hero: '44121' });
  });

  test('the form-level hidden inputs are still not mistaken for fields', async ({ page, settings }) => {
    await open(page, settings);
    const railText = await page.evaluate(() => {
      const sr = (document.querySelector('.d7-proxy-ui-form-host') as HTMLElement).shadowRoot!;
      return (sr.textContent || '').replace(/\s+/g, ' ');
    });
    // Recovering hidden fids must not also surface form_build_id and friends.
    expect(railText).not.toContain('form_build_id');
    expect(railText).not.toContain('form_token');
  });
});

test.describe('Feature 5: a content type other than News', () => {
  /**
   * Specialty, from columbiadoctors.org/node/17176/edit. The rail is assembled from
   * whichever fields a form actually has, so nothing should be News-specific — these
   * guard that, and cover the duplicate "Summary" this content type revealed.
   */
  const open = async (page: import('@playwright/test').Page, settings: (v: Record<string, unknown>) => Promise<void>) => {
    await settings({ nodeEditor: true, combobox: false, htmlExport: false });
    await page.goto(`${HOST}/node/17176/edit`);
    await page.waitForSelector('.d7-proxy-ui-form-host', { timeout: 15000 });
  };

  test('only one Summary claims to be the meta description', async ({ page, settings }) => {
    await open(page, settings);
    const claims = await page.evaluate(() => {
      const sr = (document.querySelector('.d7-proxy-ui-form-host') as HTMLElement).shadowRoot!;
      const text = (sr.textContent || '');
      return (text.match(/Doubles as the meta description/g) ?? []).length;
    });
    expect(claims).toBe(1);
  });

  test('the second Summary is still present and editable, just not as the summary', async ({ page, settings }) => {
    await open(page, settings);
    // Dropping it would be worse than mislabelling it: the field would be unreachable.
    const second = await page.evaluate(() => {
      const el = document.querySelector('textarea[name="field_specialty_summary[und][0][value]"]') as HTMLTextAreaElement | null;
      return { present: !!el, disabled: el?.disabled ?? null };
    });
    expect(second).toEqual({ present: true, disabled: false });
  });

  test('the SEO section forms on this content type too', async ({ page, settings }) => {
    await open(page, settings);
    const rail = await page.evaluate(() => {
      const sr = (document.querySelector('.d7-proxy-ui-form-host') as HTMLElement).shadowRoot!;
      return (sr.textContent || '').replace(/\s+/g, ' ');
    });
    expect(rail).toContain('URL, SEO & Sitemap');
  });

  test('the metatag and path fields are reachable once that section is open', async ({ page, settings }) => {
    await open(page, settings);
    await expandAll(page);
    const seo = await page.evaluate(() => {
      const sr = (document.querySelector('.d7-proxy-ui-form-host') as HTMLElement).shadowRoot!;
      const t = (sr.textContent || '').replace(/\s+/g, ' ');
      return {
        // Drupal's "Page title" IS metatags[…][title], which now leads the rail in the
        // Search section under a label saying what it actually controls.
        searchTitle: t.includes('Search result title'),
        alias: t.includes('URL alias'),
      };
    });
    expect(seo).toEqual({ searchTitle: true, alias: true });
  });
});

test.describe('Feature 5: the body owns its editor and its summary', () => {
  /**
   * Reported from columbiadoctors.org/node/17176/edit: the body showed raw HTML source in
   * a plain box labelled "Body (Edit summary)", with an extra "Summary" field beside the
   * two real ones.
   *
   * All of it came from core's text_textarea_with_summary, which this fixture had been
   * modelling wrongly. It is ONE widget of three controls that all collapse to the base
   * name `body` — value, Edit-summary textarea, text-format select — with the summary
   * nested inside the value's form-item and an "(Edit summary)" toggle appended to the
   * value's own label. Read as peers, that produced three separate fields and a label of
   * "Body (Edit summary)"; and because hasRichEditor searched the shared wrapper, all
   * three claimed the body's editor.
   *
   * The body is the field with the editor. The summary is a plain teaser that doubles as
   * the meta description and must NOT get one.
   */
  const open = async (page: import('@playwright/test').Page, settings: (v: Record<string, unknown>) => Promise<void>) => {
    const errors: string[] = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await settings({ nodeEditor: true, combobox: false, htmlExport: false, debugSchema: true });
    await page.goto(`${HOST}/node/17176/edit`);
    await page.waitForSelector('.d7-proxy-ui-form-host', { timeout: 15000 });
    await page.waitForFunction(() => !!document.querySelector('.cke'), undefined, { timeout: 15000 });
    return errors;
  };

  test('nothing is reported as invisible', async ({ page, settings }) => {
    const errors = await open(page, settings);
    await page.waitForTimeout(1200); // the orphan check runs a couple of frames after mount
    expect(errors.filter(e => /INVISIBLE|no matching slot/i.test(e))).toEqual([]);
  });

  test('every relocated widget has a slot once sections are open', async ({ page, settings }) => {
    await open(page, settings);
    await expandAll(page);
    const audit = await page.evaluate(() => {
      const host = document.querySelector('.d7-proxy-ui-form-host') as HTMLElement;
      const sr = host.shadowRoot!;
      const rendered = new Set(Array.from(sr.querySelectorAll('slot')).map(s => s.getAttribute('name')));
      const relocated = Array.from(host.children).map(c => c.getAttribute('slot')).filter(Boolean) as string[];
      return { relocated: relocated.length, orphans: relocated.filter(n => !rendered.has(n)) };
    });
    expect(audit.orphans).toEqual([]);
    expect(audit.relocated).toBeGreaterThan(0);
  });

  test('the body editor is on screen, and its content survived', async ({ page, settings }) => {
    await open(page, settings);
    const state = await page.evaluate(() => {
      const cke = document.querySelector('.cke_editor_edit-body-und-0-value') as HTMLElement | null;
      return {
        present: !!cke,
        inOverlay: !!cke?.closest('.d7-proxy-ui-form-host'),
        visible: !!cke && cke.getBoundingClientRect().height > 0,
        toolbar: cke?.querySelectorAll('.cke_button').length ?? 0,
        data: (window as any).CKEDITOR.instances['edit-body-und-0-value']?.getData(),
      };
    });
    expect(state.present).toBe(true);
    expect(state.inOverlay).toBe(true);
    expect(state.visible).toBe(true);
    // The site's own buttons, not a reimplementation of them.
    expect(state.toolbar).toBeGreaterThan(0);
    expect(state.data).toContain('Our Mission');
  });

  test('the body is not rendered as a plain textarea of HTML source', async ({ page, settings }) => {
    await open(page, settings);
    // What was actually reported: tags visible in a box with no toolbar. The native
    // textarea still exists and still submits, but it must not be the visible control.
    const source = await page.evaluate(() => {
      const ta = document.getElementById('edit-body-und-0-value') as HTMLTextAreaElement;
      return { exists: !!ta, visible: ta.getBoundingClientRect().height > 0 };
    });
    expect(source).toEqual({ exists: true, visible: false });
  });

  test('the Edit-summary textarea travels with the body, not as its own field', async ({ page, settings }) => {
    await open(page, settings);
    const summary = await page.evaluate(() => {
      const ta = document.getElementById('edit-body-und-0-summary') as HTMLTextAreaElement;
      const host = document.querySelector('.d7-proxy-ui-form-host') as HTMLElement;
      const sr = host.shadowRoot!;
      return {
        // Still on the form, so it still submits.
        // This fixture's form is id="specialty-node-form" — it has no .node-form class,
        // which is exactly why findNodeForm() also matches on the id suffix.
        submits: new FormData(document.querySelector('form[id$="-node-form"]') as HTMLFormElement)
          .get('body[und][0][summary]'),
        // Moved into the overlay as part of the body widget...
        inOverlay: !!ta.closest('.d7-proxy-ui-form-host'),
        // ...not stranded in the hidden region, and not given a box of its own.
        inHiddenRegion: !!ta.closest('[data-d7-hidden]'),
        ownControl: sr.querySelectorAll('textarea[data-machine-name*="[summary]"]').length,
        // Drupal's own toggle came with it.
        toggle: !!host.querySelector('.link-edit-summary'),
      };
    });
    expect(summary.submits).toBe('Existing teaser summary.');
    expect(summary.inOverlay).toBe(true);
    expect(summary.inHiddenRegion).toBe(false);
    expect(summary.ownControl).toBe(0);
    expect(summary.toggle).toBe(true);
  });

  test('the summary that is the meta description gets no editor', async ({ page, settings }) => {
    await open(page, settings);
    const summaries = await page.evaluate(() => ({
      // field_summary is the required teaser and the default meta description. A rich
      // editor on it would be wrong: it is plain text with a character budget.
      metaDescription: !!document.querySelector('.cke_editor_edit-summary'),
      second: !!document.querySelector('.cke_editor_edit-summary-alt'),
      instances: Object.keys((window as any).CKEDITOR.instances).sort(),
    }));
    expect(summaries.metaDescription).toBe(false);
    expect(summaries.second).toBe(false);
    expect(summaries.instances).toEqual(['edit-body-und-0-value']);
  });

  test('the body label does not absorb the Edit summary link', async ({ page, settings }) => {
    await open(page, settings);
    // "Body (Edit summary)" is what the live form showed. The parenthetical is a control.
    const labels = await page.evaluate(() => {
      const host = document.querySelector('.d7-proxy-ui-form-host') as HTMLElement;
      const sr = host.shadowRoot!;
      return {
        ourLabels: Array.from(sr.querySelectorAll('label, p, span'))
          .map(el => (el.textContent || '').trim())
          .filter(t => /^body \(edit summary\)$/i.test(t)).length,
        // Drupal's own label keeps its link, because that link still works.
        drupalToggle: !!host.querySelector('label .link-edit-summary'),
      };
    });
    expect(labels.ourLabels).toBe(0);
    expect(labels.drupalToggle).toBe(true);
  });

  test('a relocated field does not show its label twice', async ({ page, settings }) => {
    await open(page, settings);
    // Drupal's own <label> comes along with the widget, so the overlay must not add one.
    const counts = await page.evaluate(() => {
      const host = document.querySelector('.d7-proxy-ui-form-host') as HTMLElement;
      const sr = host.shadowRoot!;
      const ours = (sr.textContent || '').match(/BODY/g)?.length ?? 0;
      // Drupal's label is "Body (Edit summary)" in the DOM — the toggle is part of it.
      const drupals = Array.from(host.querySelectorAll('label'))
        .filter(l => /^Body\b/.test((l.textContent || '').trim())).length;
      return { ours, drupals };
    });
    expect(counts.drupals).toBe(1);
    expect(counts.ours).toBe(0);
  });
});

test.describe('Feature 5: the description is findable and the Titles are distinguishable', () => {
  /**
   * Reported: "description utterly buried, plus multiple different title fields".
   *
   * Both are real. The meta description sat ten fields deep in a collapsed
   * "URL, SEO & Sitemap" block, and a Specialty form carries six fields that render as
   * some form of "Title" — three of them literally the word "Title". Drupal's labels are
   * only unambiguous inside the tabs the overlay removes, so the overlay has to put that
   * context back.
   */
  const open = async (page: import('@playwright/test').Page, settings: (v: Record<string, unknown>) => Promise<void>) => {
    await settings({ nodeEditor: true, combobox: false, htmlExport: false });
    await page.goto(`${HOST}/node/17176/edit`);
    await page.waitForSelector('.d7-proxy-ui-form-host', { timeout: 15000 });
  };

  const railText = (page: import('@playwright/test').Page) => page.evaluate(() => {
    const sr = (document.querySelector('.d7-proxy-ui-form-host') as HTMLElement).shadowRoot!;
    return (sr.textContent || '').replace(/\s+/g, ' ');
  });

  test('Search & Social Preview leads the rail and is open without being clicked', async ({ page, settings }) => {
    await open(page, settings);

    const state = await page.evaluate(() => {
      const sr = (document.querySelector('.d7-proxy-ui-form-host') as HTMLElement).shadowRoot!;
      const toggles = Array.from(sr.querySelectorAll('button[aria-expanded]'));
      const first = toggles[0];
      return {
        firstSection: (first?.textContent || '').replace(/\s+/g, ' ').slice(0, 30),
        firstExpanded: first?.getAttribute('aria-expanded'),
      };
    });

    expect(state.firstSection).toContain('Search & Social Preview');
    // Prominence means visible on load, not one click away.
    expect(state.firstExpanded).toBe('true');
  });

  test('the description is reachable without opening anything', async ({ page, settings }) => {
    await open(page, settings);
    const text = await railText(page);
    expect(text).toContain('Search result description');
  });

  test('the description control is genuinely on screen', async ({ page, settings }) => {
    await open(page, settings);
    const box = await page.evaluate(() => {
      const sr = (document.querySelector('.d7-proxy-ui-form-host') as HTMLElement).shadowRoot!;
      const label = Array.from(sr.querySelectorAll('label'))
        .find(l => (l.textContent || '').includes('Search result description'));
      const el = label?.parentElement?.parentElement?.querySelector('textarea, input');
      return el ? (el as HTMLElement).getBoundingClientRect().height > 0 : false;
    });
    expect(box).toBe(true);
  });

  test('no two fields in the rail read the same bare "Title"', async ({ page, settings }) => {
    await open(page, settings);
    await expandAll(page);

    const bare = await page.evaluate(() => {
      const sr = (document.querySelector('.d7-proxy-ui-form-host') as HTMLElement).shadowRoot!;
      return Array.from(sr.querySelectorAll('label'))
        .map(l => (l.textContent || '').trim().toLowerCase())
        .filter(t => t === 'title').length;
    });

    // Drupal's own "Title" labels on the metatag and menu-attribute fields are replaced
    // with what each one actually controls.
    expect(bare).toBe(0);
  });

  test('each title-ish field says which title it is', async ({ page, settings }) => {
    await open(page, settings);
    await expandAll(page);
    const text = await railText(page);

    expect(text).toContain('Search result title');
    expect(text).toContain('Share title (Facebook, LinkedIn)');
    expect(text).toContain('Share title (Twitter/X)');
    expect(text).toContain('Link tooltip');
    // The menu link's own title is already unambiguous, so it keeps Drupal's wording.
    expect(text).toContain('Menu link title');
  });

  test('the two Summary boxes are told apart on screen', async ({ page, settings }) => {
    await open(page, settings);
    // Reported: two boxes both reading "Summary", one of them the meta description.
    const summaries = await page.evaluate(() => {
      const sr = (document.querySelector('.d7-proxy-ui-form-host') as HTMLElement).shadowRoot!;
      const labels = Array.from(sr.querySelectorAll('label, p, span'))
        .map(el => (el.textContent || '').trim())
        .filter(t => /summary$/i.test(t));
      return {
        plain: labels.filter(t => /^summary$/i.test(t)).length,
        qualified: labels.filter(t => /^specialty summary$/i.test(t)).length,
      };
    });
    // Exactly one keeps the bare name; the other says which summary it is.
    expect(summaries.plain).toBe(1);
    expect(summaries.qualified).toBe(1);
  });

  test('a relabelled field still says what Drupal calls it', async ({ page, settings }) => {
    await open(page, settings);
    // Renaming without a trace would strand anyone cross-referencing the Drupal form.
    const tip = await page.evaluate(() => {
      const sr = (document.querySelector('.d7-proxy-ui-form-host') as HTMLElement).shadowRoot!;
      const label = Array.from(sr.querySelectorAll('label'))
        .find(l => (l.textContent || '').includes('Search result description'));
      return label?.getAttribute('title');
    });
    expect(tip).toBe('Drupal calls this "Description"');
  });
});

test.describe('Feature 5: the rail is triaged, and the image is not in it', () => {
  /**
   * Ten stacked rail headers gave Revision the same weight as Topics, and put the teaser
   * image — part of the article, not a setting about it — behind a toggle that renders no
   * `<slot>` while shut. So the widget was not small, it was absent, and "I'm not seeing
   * an option to change the image" was reported twice.
   *
   * Multimedia moved to the writing column, the five occasional sections went behind one
   * disclosure, and Groups folded under Related Content.
   */
  const open = async (page: Page, settings: (v: Record<string, unknown>) => Promise<void>) => {
    await settings({ nodeEditor: true, combobox: false, htmlExport: false });
    await page.goto(`${HOST}/node/add/news`);
    await expect(page.locator(`${UI} input[aria-label="Title"]`)).toBeVisible();
  };

  test('the image widget has a box on load, with nothing clicked', async ({ page, settings }) => {
    await open(page, settings);
    // The whole point of the move. A projected widget in a collapsed section measures
    // zero, so height is the assertion that would have caught the original report.
    const box = await page.evaluate(() => {
      const sr = (document.querySelector('.d7-proxy-ui-form-host') as HTMLElement).shadowRoot!;
      const block = sr.querySelector('[data-left-section="multimedia"]') as HTMLElement | null;
      if (!block) return { found: false };
      const slots = Array.from(block.querySelectorAll('slot'));
      return {
        found: true,
        inAside: !!block.closest('aside'),
        rendered: block.getBoundingClientRect().height > 0,
        slots: slots.length,
        projecting: slots.filter(s => (s as HTMLSlotElement).assignedNodes().length > 0).length,
      };
    });
    expect(box.found).toBe(true);
    expect(box.inAside).toBe(false);
    expect(box.rendered).toBe(true);
    expect(box.projecting).toBeGreaterThan(0);
  });

  /** The rail's top-level headers, in order, excluding those nested in the group. */
  const topHeaders = (page: Page) => page.evaluate(() => {
    const sr = (document.querySelector('.d7-proxy-ui-form-host') as HTMLElement).shadowRoot!;
    const aside = sr.querySelector('aside')!;
    return Array.from(aside.querySelectorAll(':scope > div > button[aria-expanded]'))
      .map(b => (b.querySelector('span > span') || b).textContent!.replace(/\s+/g, ' ').trim());
  });

  test('the rail leads with the sections used on most saves', async ({ page, settings }) => {
    await open(page, settings);
    // News carries no menu fields, so its rail is three sections plus the group.
    expect(await topHeaders(page)).toEqual([
      'Search & Social Preview',
      'Topics & Tags',
      'Related Content',
      'Settings used occasionally',
    ]);
  });

  test('Menu Placement is listed openly, not inside the group', async ({ page, settings }) => {
    await settings({ nodeEditor: true, combobox: false, htmlExport: false });
    // The Page type is where menu placement is actually used, and the only fixture with
    // menu fields — asserting this on News would prove nothing, since News has none.
    await page.goto(`${HOST}/node/add/page`);
    await expect(page.locator(`${UI} input[aria-label="Title"]`)).toBeVisible();

    expect(await topHeaders(page)).toContain('Menu Placement');
    // Its parent picker is the heaviest control in the rail; a disclosure in front of it
    // costs more than it saves.
    await expect(page.locator(`${UI} aside [data-rail-more] [data-rail-panel="menu"]`)).toHaveCount(0);
  });

  test('the occasional settings are named on the collapsed header, then reachable', async ({ page, settings }) => {
    await open(page, settings);
    const more = page.locator(`${UI} aside button[aria-expanded]`, { hasText: 'Settings used occasionally' });

    // Named while shut: a group whose contents are a mystery is worse than a long list.
    await expect(more).toContainText('URL, SEO & Sitemap');
    await expect(more).toContainText('Revision');
    await expect(page.locator(`${UI} [data-rail-more]`)).toHaveCount(0);

    await more.click();
    const revealed = page.locator(`${UI} [data-rail-more]`);
    await expect(revealed).toContainText('URL, SEO & Sitemap');
    await expect(revealed).toContainText('Revision');
  });

  test('Groups is drawn under Related Content, not as a section of its own', async ({ page, settings }) => {
    await open(page, settings);
    await openRailSection(page, 'related');

    // Asserted on the subgroup element, not on panel text: the Related Content header
    // now reads "replaced the Related Content and Groups tabs", so a text match for
    // "Groups" would pass whether or not a single Groups field was drawn.
    const placement = await page.evaluate(() => {
      const sr = (document.querySelector('.d7-proxy-ui-form-host') as HTMLElement).shadowRoot!;
      const subgroup = sr.querySelector('[data-panel-subgroup="groups"]');
      return {
        exists: !!subgroup,
        insideRelated: subgroup?.closest('[data-rail-panel]')?.getAttribute('data-rail-panel') ?? null,
        // Captioned, not silently mixed in with the entity references.
        captioned: /groups/i.test(subgroup?.querySelector('p')?.textContent ?? ''),
        controls: subgroup?.querySelectorAll('input, select, textarea, slot').length ?? 0,
        ownPanel: !!sr.querySelector('[data-rail-panel="groups"]'),
      };
    });

    expect(placement.exists).toBe(true);
    expect(placement.insideRelated).toBe('related');
    expect(placement.captioned).toBe(true);
    expect(placement.controls).toBeGreaterThan(0);
    expect(placement.ownPanel).toBe(false);
  });

  test('the Groups fields still write through to the native inputs', async ({ page, settings }) => {
    await open(page, settings);
    await openRailSection(page, 'related');
    // Folding is a layout change only; what Drupal receives must be untouched.
    const submitted = await page.evaluate(() =>
      new FormData(document.querySelector('form.node-form') as HTMLFormElement)
        .has('og_group_ref[und][0][default][0][target_id]'));
    expect(submitted).toBe(true);
  });
});

test.describe('Feature 5: a rich editor that loads late is still found', () => {
  /**
   * The actual cause of "the body needs the html editor", reported twice from
   * columbiadoctors.org/node/17176/edit.
   *
   * CKEditor is ASYNCHRONOUS. `CKEDITOR.replace()` registers the instance immediately but
   * then loads config and plugins before firing instanceReady and inserting its container.
   * This content script runs at DOMContentLoaded and sampled the DOM once, so it found no
   * container, decided the body had no editor, and rendered a plain textarea full of HTML
   * tags — under a note reading "This field has no rich text editor in Drupal".
   *
   * Whether a field has an editor decides three things together, which is why one wrong
   * answer produced three symptoms: the body is relocated rather than reimplemented, its
   * Edit-summary folds into it instead of becoming a separate box, and the plain-text note
   * is shown or not.
   *
   * Every other fixture attaches CKEditor synchronously from an inline script, so the
   * entire suite passed while the live site failed. This one attaches after 600ms.
   */
  const open = async (page: Page, settings: (v: Record<string, unknown>) => Promise<void>) => {
    await settings({ nodeEditor: true, combobox: false, htmlExport: false });
    await page.goto(`${HOST}/node/17177/edit`);
    await page.waitForSelector('.d7-proxy-ui-form-host', { timeout: 20000 });
  };

  test('the fixture really does attach late, or this proves nothing', async ({ page }) => {
    // Guards the guard: if the fixture ever becomes synchronous, the tests below would
    // pass for the wrong reason and the regression could return unnoticed.
    await page.goto(`${HOST}/node/17177/edit`);
    const atLoad = await page.evaluate(() => ({
      deferred: !!(window as any).CKEDITOR?.__deferred,
      containers: document.querySelectorAll('.cke').length,
    }));
    expect(atLoad.deferred).toBe(true);
    expect(atLoad.containers).toBe(0);
  });

  test('the body gets the real editor, not a plain textarea', async ({ page, settings }) => {
    await open(page, settings);
    const state = await page.evaluate(() => {
      const cke = document.querySelector('.cke_editor_edit-body-und-0-value') as HTMLElement | null;
      const ta = document.getElementById('edit-body-und-0-value') as HTMLTextAreaElement;
      return {
        editor: !!cke,
        inOverlay: !!cke?.closest('.d7-proxy-ui-form-host'),
        toolbar: cke?.querySelectorAll('.cke_button').length ?? 0,
        sourceVisible: ta.getBoundingClientRect().height > 0,
      };
    });
    expect(state.editor).toBe(true);
    expect(state.inOverlay).toBe(true);
    expect(state.toolbar).toBeGreaterThan(0);
    expect(state.sourceVisible).toBe(false);
  });

  test('the "no rich text editor" note is not shown for the body', async ({ page, settings }) => {
    await open(page, settings);
    // This note is correct for a genuinely plain field and wrong here. It is the exact
    // string that appeared under the body on the live form.
    const text = await page.evaluate(() => {
      const sr = (document.querySelector('.d7-proxy-ui-form-host') as HTMLElement).shadowRoot!;
      return (sr.textContent || '').replace(/\s+/g, ' ');
    });
    expect(text).not.toContain('no rich text editor in Drupal');
  });

  test('the Edit-summary still folds into the body', async ({ page, settings }) => {
    await open(page, settings);
    // The fold requires the body to be rich, so a late editor previously left a third
    // summary box on the form. Same root cause, different symptom.
    //
    // Asserted as the exact SET of summary labels, not by searching for "Body summary":
    // which of the three claims the summary role depends on DOM order, so that string is
    // not guaranteed to appear even when the bug is present. Without the fix this list has
    // three entries — verified by disabling the wait and re-running.
    const summary = await page.evaluate(() => {
      const sr = (document.querySelector('.d7-proxy-ui-form-host') as HTMLElement).shadowRoot!;
      return {
        labels: Array.from(sr.querySelectorAll('label, p, span'))
          .map(el => (el.textContent || '').trim())
          .filter(t => /summary$/i.test(t) && t.length < 40),
        stillSubmits: new FormData(document.querySelector('form[id$="-node-form"]') as HTMLFormElement)
          .get('body[und][0][summary]'),
      };
    });
    expect(summary.labels).toEqual(['Summary', 'Specialty summary']);
    // Folded from the overlay, still submitted by the form.
    expect(summary.stillSubmits).toBe('Existing teaser summary.');
  });
});


test.describe('Feature 3: a menu too large to render gets search, not a worse table', () => {
  /**
   * The verdict from testing the real main menu: the tree manager showed 9 rows out of
   * 3,000+, was slower than Drupal's own page, and its one useful feature — the filter —
   * could only search those 9. Expanding subtrees on demand did not rescue it, because
   * Drupal already does that and does it faster.
   *
   * So on a menu Drupal loads on demand, its table is LEFT ALONE, and the thing Drupal has
   * never had is added above it: search across the whole menu. The index comes from the
   * menu's parent-link select, which Drupal builds from the full tree whatever BigMenu does
   * to the table — one request, not one per subtree.
   */
  const MENU = `${HOST}/admin/structure/menu/manage/main-menu-collapsed`;

  const open = async (page: Page, settings: (v: Record<string, unknown>) => Promise<void>) => {
    await settings({ menuTree: true, combobox: false, htmlExport: false, nodeEditor: false });
    await page.goto(MENU);
    await expect(page.locator(`${UI} input[aria-label="Search this menu"]`)).toBeVisible();
  };

  test('Drupal\'s own table is left in place, not replaced', async ({ page, settings }) => {
    await open(page, settings);
    // The whole correction. Hiding it made the page slower and less capable.
    const native = await page.evaluate(() => {
      const table = document.querySelector('table#menu-overview') as HTMLElement;
      return { present: !!table, visible: table.getBoundingClientRect().height > 0 };
    });
    expect(native).toEqual({ present: true, visible: true });
    // And no tree manager over the top of it.
    await expect(page.locator(`${UI} input[placeholder="Filter menu items"]`)).toHaveCount(0);
  });

  test('the index is built from the parent select in one request', async ({ page, settings }) => {
    const fetched: string[] = [];
    page.on('request', r => {
      if (/\/admin\/structure\/menu\/manage\/[^/]+\/add/.test(r.url())) fetched.push(r.url());
      // The thing being avoided: one request per subtree.
      if (/bigmenu-customize/.test(r.url())) fetched.push(r.url());
    });

    await open(page, settings);
    await expect(page.locator(`${UI} >> text=/233 items/`)).toBeVisible();

    expect(fetched.filter(u => /bigmenu-customize/.test(u))).toEqual([]);
    expect(fetched.filter(u => /\/add/.test(u))).toHaveLength(1);
  });

  test('an item Drupal never rendered is findable', async ({ page, settings }) => {
    await open(page, settings);
    // "Substance Use Disorders" is three levels deep under Specialties › Psychiatry, and is
    // not in the table at all — it is exactly what could not be found before.
    await page.fill(`${UI} input[aria-label="Search this menu"]`, 'substance');

    const result = page.locator(`${UI} [data-menu-search-results] a`).first();
    await expect(result).toContainText('Substance Use Disorders');
    // The path, because a bare title is not enough to know which item this is.
    await expect(result).toContainText('Specialties');
    await expect(result).toContainText('Psychiatry & Psychology');
    await expect(result).toHaveAttribute('href', '/admin/structure/menu/item/208/edit');
  });

  test('the ancestor path separates two items with the same title', async ({ page, settings }) => {
    await open(page, settings);
    // Two "Surgery" items, under Cardiology and under Dermatology. Title alone cannot tell
    // them apart, which is the reason the index carries ancestors at all.
    await page.fill(`${UI} input[aria-label="Search this menu"]`, 'dermatology surgery');
    const results = page.locator(`${UI} [data-menu-search-results] a`);
    await expect(results).toHaveCount(1);
    await expect(results.first()).toHaveAttribute('href', '/admin/structure/menu/item/206/edit');
  });

  test('a broad query is capped, and says how many it is hiding', async ({ page, settings }) => {
    await open(page, settings);
    await page.fill(`${UI} input[aria-label="Search this menu"]`, 'clinic');
    // 220 match; rendering all of them would freeze the page, and claiming 50 matched would
    // misrepresent the menu.
    await expect(page.locator(`${UI} >> text=/Showing 50 of 220 matches/`)).toBeVisible();
    await expect(page.locator(`${UI} [data-menu-search-results] a`)).toHaveCount(50);
  });

  test('an empty query lists nothing rather than everything', async ({ page, settings }) => {
    await open(page, settings);
    await expect(page.locator(`${UI} [data-menu-search-results]`)).toHaveCount(0);
    await page.fill(`${UI} input[aria-label="Search this menu"]`, 'clinic');
    await expect(page.locator(`${UI} [data-menu-search-results]`)).toBeVisible();
    await page.fill(`${UI} input[aria-label="Search this menu"]`, '   ');
    await expect(page.locator(`${UI} [data-menu-search-results] a`)).toHaveCount(0);
  });

  test('a query matching nothing says so, naming the menu', async ({ page, settings }) => {
    await open(page, settings);
    await page.fill(`${UI} input[aria-label="Search this menu"]`, 'zzzznotathing');
    await expect(page.locator(`${UI} >> text=/Nothing in main-menu-collapsed matches/`)).toBeVisible();
  });

  test('the index is cached, so a second visit costs no request', async ({ page, settings }) => {
    await open(page, settings);
    await expect(page.locator(`${UI} >> text=/233 items/`)).toBeVisible();

    const fetched: string[] = [];
    page.on('request', r => {
      if (/\/admin\/structure\/menu\/manage\/[^/]+\/add/.test(r.url())) fetched.push(r.url());
    });
    await page.goto(MENU);
    await expect(page.locator(`${UI} >> text=/233 items/`)).toBeVisible();
    // Stale is acceptable and shown; a request on every page load is not.
    expect(fetched).toEqual([]);
  });

  test('rows show their real titles, not the drag handle', async ({ page, settings }) => {
    /**
     * Kept from the earlier work because it is a real parser bug, still exercised through
     * the tree manager on menus small enough to render whole.
     *
     * Core's tabledrag inserts <a class="tabledrag-handle" href="#"> as the FIRST anchor in
     * a row's first cell, and the parser used `td:nth-child(1) a` — so every row on the live
     * site read "Untitled" pointing at "#". No fixture had a handle, so the whole suite
     * agreed with the parser. They all have one now.
     */
    await settings({ menuTree: true, combobox: false, htmlExport: false, nodeEditor: false });
    await page.goto(`${HOST}/admin/structure/menu/manage/main-menu`);
    await expect(page.locator(`${UI} input[placeholder="Filter menu items"]`)).toBeVisible();

    const text = await page.evaluate(() => {
      const el = document.querySelector('.d7-proxy-ui-container') as HTMLElement;
      return ((el.shadowRoot ?? el).textContent || '');
    });
    expect(text).not.toContain('Untitled');
    expect(text).toContain('About Us');
  });

  test('a menu small enough to render whole still gets the tree manager', async ({ page, settings }) => {
    await settings({ menuTree: true, combobox: false, htmlExport: false, nodeEditor: false });
    await page.goto(`${HOST}/admin/structure/menu/manage/main-menu`);
    // Where the manager genuinely beats the native table, it is still used, and there the
    // filter works because every row is present.
    await expect(page.locator(`${UI} input[placeholder="Filter menu items"]`)).toBeVisible();
    const native = await page.evaluate(() =>
      (document.querySelector('table#menu-overview') as HTMLElement).style.display);
    expect(native).toBe('none');
  });
});


test.describe('Feature 5: the media browser round trip, end to end', () => {
  /**
   * The gap this closes: selection was only ever verified by calling
   * simulateMediaSelect() straight from the test, which is the LAST step of the flow. The
   * launcher click, the dialog, the iframe and the callback into the opener were never
   * exercised — so nothing proved the launcher still worked after the overlay relocated it
   * into a shadow host's light DOM, or that the dialog was painted on top of the overlay
   * rather than behind it.
   *
   * The fixture now models Drupal's actual path: launcher → Drupal.media.popups.mediaBrowser
   * → a dialog on document.body holding an iframe at /media/browser → the iframe calls
   * Drupal.media.browser.select in the opener → ajax replaces the widget wrapper.
   */
  const open = async (page: Page, settings: (v: Record<string, unknown>) => Promise<void>) => {
    await settings({ nodeEditor: true, combobox: false, htmlExport: false });
    await page.goto(`${HOST}/node/add/news-media`);
    await expect(page.locator(`${UI} input[aria-label="Title"]`)).toBeVisible();
    await expect(page.locator(`${UI} [data-left-section="multimedia"]`)).toBeVisible();
  };

  /** The relocated launcher, which lives in the host's light DOM, not the shadow root. */
  const launcher = (page: Page) =>
    page.locator('.d7-proxy-ui-form-host a.launcher[data-field="teaser"]');

  const pickFromLibrary = async (page: Page, filename: string) => {
    const frame = page.frameLocator('#media-browser-frame');
    await frame.locator(`.media-item:has-text("${filename}")`).click();
  };

  test('the relocated launcher still opens the browser', async ({ page, settings }) => {
    await open(page, settings);
    // Drupal bound this handler at page load, on the element it rendered. The overlay then
    // moved that element — a moved node keeps its listeners, and this is the assertion that
    // would fail if the widget were ever rebuilt instead of relocated.
    await launcher(page).click();
    await expect(page.locator('#media-browser-dialog')).toBeVisible();
    await expect(page.locator('#media-browser-frame')).toHaveAttribute(
      'src', '/media/browser?field=teaser'
    );
  });

  test('the dialog is on top of the overlay, not behind it', async ({ page, settings }) => {
    await open(page, settings);
    await launcher(page).click();

    /**
     * jQuery UI appends its dialog to document.body, outside the overlay's host, so which
     * one paints on top is a question about stacking rather than nesting. A dialog behind
     * the overlay is unusable and would look exactly like the browser failing to open.
     */
    const onTop = await page.evaluate(() => {
      const dialog = document.getElementById('media-browser-dialog') as HTMLElement;
      const box = dialog.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 8);
      return {
        dialogVisible: box.width > 0 && box.height > 0,
        // The topmost element at the dialog's own position must belong to the dialog.
        hitInsideDialog: !!hit && dialog.contains(hit),
      };
    });
    expect(onTop).toEqual({ dialogVisible: true, hitInsideDialog: true });
  });

  test('choosing a file in the iframe reaches the form and the overlay', async ({ page, settings }) => {
    await open(page, settings);
    await launcher(page).click();
    await pickFromLibrary(page, 'campus-quad.jpg');

    // The dialog closes and the widget comes back with the file attached.
    await expect(page.locator('#media-browser-dialog')).toHaveCount(0);
    await expect(page.locator('.d7-proxy-ui-form-host .preview-teaser')).toBeVisible();

    const state = await page.evaluate(() => {
      const preview = document.querySelector('.preview-teaser') as HTMLElement;
      const form = document.querySelector('form[id$="-node-form"]') as HTMLFormElement;
      return {
        // Rendered in the overlay, not stranded in the hidden original form.
        inOverlay: !!preview.closest('.d7-proxy-ui-form-host'),
        inHiddenRegion: !!preview.closest('[data-d7-hidden]'),
        // Drupal replaces the wrapper wholesale, so the carrier is what keeps it projected.
        stillSlotted: !!preview.closest('[slot]'),
        rendered: preview.getBoundingClientRect().height > 0,
        filename: preview.querySelector('.filename')?.textContent,
        fid: new FormData(form).get('field_image_teaser[und][0][fid]'),
      };
    });

    expect(state.inOverlay).toBe(true);
    expect(state.inHiddenRegion).toBe(false);
    expect(state.stillSlotted).toBe(true);
    expect(state.rendered).toBe(true);
    expect(state.filename).toBe('campus-quad.jpg');
    expect(state.fid).toBe('9911');
  });

  test('an image can be changed: remove, then pick another', async ({ page, settings }) => {
    await open(page, settings);
    await launcher(page).click();
    await pickFromLibrary(page, 'campus-quad.jpg');
    await expect(page.locator('.d7-proxy-ui-form-host .preview-teaser')).toBeVisible();

    /**
     * The real flow, and the one that was reported broken: a POPULATED media widget has no
     * Browse launcher, only Remove. So changing an image means removing first, and every
     * step after that runs against markup Drupal has already replaced once — the launcher
     * clicked at the end is a DIFFERENT element from the one the overlay originally moved.
     */
    await page.locator('.d7-proxy-ui-form-host .preview-teaser a.remove').click();
    await expect(page.locator('.d7-proxy-ui-form-host .preview-teaser')).toHaveCount(0);

    // The launcher is back, still inside the overlay rather than stranded in the hidden form.
    await expect(launcher(page)).toBeVisible();
    await launcher(page).click();
    await pickFromLibrary(page, 'atrium.png');

    await expect(page.locator('.d7-proxy-ui-form-host .filename')).toHaveText('atrium.png');

    const submitted = await page.evaluate(() => {
      const form = document.querySelector('form[id$="-node-form"]') as HTMLFormElement;
      return {
        fid: new FormData(form).get('field_image_teaser[und][0][fid]'),
        // A leftover copy from the first selection would override this on the server.
        copies: form.querySelectorAll('input[name="field_image_teaser[und][0][fid]"]').length,
        previews: document.querySelectorAll('.preview-teaser').length,
      };
    });
    expect(submitted).toEqual({ fid: '9913', copies: 1, previews: 1 });
  });

  test('a removed image is really cleared, not just hidden', async ({ page, settings }) => {
    await open(page, settings);
    await launcher(page).click();
    await pickFromLibrary(page, 'campus-quad.jpg');
    await expect(page.locator('.d7-proxy-ui-form-host .preview-teaser')).toBeVisible();

    await page.locator('.d7-proxy-ui-form-host .preview-teaser a.remove').click();
    await expect(page.locator('.d7-proxy-ui-form-host .preview-teaser')).toHaveCount(0);

    // Saving after a remove must not resubmit the old fid.
    const fid = await page.evaluate(() =>
      new FormData(document.querySelector('form[id$="-node-form"]') as HTMLFormElement)
        .get('field_image_teaser[und][0][fid]'));
    expect(fid).toBe('0');
  });

  test('the second field is untouched by the first field\'s selection', async ({ page, settings }) => {
    await open(page, settings);
    await launcher(page).click();
    await pickFromLibrary(page, 'lab-bench.jpg');
    await expect(page.locator('.d7-proxy-ui-form-host .preview-teaser')).toBeVisible();

    // Two media fields share a name shape and an ajax-wrapper convention; writing the
    // wrong one would be invisible until publication.
    const hero = await page.evaluate(() => {
      const form = document.querySelector('form[id$="-node-form"]') as HTMLFormElement;
      return {
        heroFid: new FormData(form).get('field_image_hero[und][0][fid]'),
        heroPreview: document.querySelectorAll('.preview-hero').length,
        heroStillSlotted: !!document
          .querySelector('input[name="field_image_hero[und][0][fid]"]')
          ?.closest('[slot]'),
      };
    });
    expect(hero).toEqual({ heroFid: '0', heroPreview: 0, heroStillSlotted: true });
  });

  test('the browser can be opened from the second field too', async ({ page, settings }) => {
    await open(page, settings);
    await page.locator('.d7-proxy-ui-form-host a.launcher[data-field="hero"]').click();
    await expect(page.locator('#media-browser-frame')).toHaveAttribute(
      'src', '/media/browser?field=hero'
    );
    await pickFromLibrary(page, 'atrium.png');
    await expect(page.locator('.d7-proxy-ui-form-host .preview-hero')).toBeVisible();
  });

  test('the iframe found its opener, so the callback path is real', async ({ page, settings }) => {
    await open(page, settings);
    await launcher(page).click();
    await pickFromLibrary(page, 'campus-quad.jpg');

    // The browser marks the document when the opener's API is missing. Without this, a test
    // could pass on a fixture that silently never called back at all.
    const missing = await page.evaluate(() => {
      const frame = document.getElementById('media-browser-frame') as HTMLIFrameElement | null;
      return frame?.contentDocument?.body?.getAttribute('data-callback-missing') ?? null;
    });
    expect(missing).toBeNull();
  });
});
