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
  [/\/admin\/structure\/menu\/manage\/main-menu/, 'menu-manage.html'],
  [/\/admin\/content/, 'admin/content.html'],
  [/\/node\/add\/news/, 'node-add-news-live.html'],
  [/\/node\/add\/page/, 'node-add-page.html'],
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

    const context = await chromium.launchPersistentContext('', {
      headless: false, // Extensions only work in headful mode
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
    await page.locator(`${UI} aside button[aria-expanded]`, { hasText: 'Multimedia' }).click();
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

  test('the widget renders inside the rail column, not beside it', async ({ page }) => {
    await inRail(page);
    const fits = await page.evaluate(() => {
      const host = document.querySelector('.d7-proxy-ui-form-host')!;
      const widget = [...host.children].find(c => c.getAttribute('slot')?.includes('teaser')) as HTMLElement;
      const aside = host.shadowRoot!.querySelector('aside')!;
      const w = widget.getBoundingClientRect(), a = aside.getBoundingClientRect();
      return w.width > 0 && w.left >= a.left - 2 && w.right <= a.right + 2;
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
    await page.locator(`${UI} aside button[aria-expanded]`, { hasText: 'Related Content' }).click();

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
    await page.locator(`${UI} aside button[aria-expanded]`, { hasText: 'Related Content' }).click();

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
    await page.locator(`${UI} aside button[aria-expanded]`, { hasText: 'Menu Placement' }).click();
    await expect(page.locator(`${UI} input[placeholder="Filter parent items"]`)).toBeVisible();
  };

  test('every parent Drupal offers is selectable, at any depth', async ({ page, settings }) => {
    await openMenuSection(page, settings);
    const labels = await page.locator(`${UI} aside button`).allInnerTexts();
    // Depth 4 and 5 entries must be present, not just the top two levels.
    for (const deep of ['Active BP Blood Pressure Monitoring', 'Video Tutorial', 'FAQ']) {
      expect(labels.some(t => t.trim() === deep), `"${deep}" should be selectable`).toBe(true);
    }
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
      const find = (text: string) => [...root.querySelectorAll('aside button')]
        .find(b => b.textContent?.trim() === text) as HTMLElement | undefined;
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
    await page.locator(`${UI} aside button`, { hasText: /^Video Tutorial$/ }).first().click();
    await expect(page.locator('#edit-menu-parent')).toHaveValue('main-menu:204');
  });

  test('filtering a deep item keeps its whole ancestor chain visible', async ({ page, settings }) => {
    await openMenuSection(page, settings);
    await page.fill(`${UI} input[placeholder="Filter parent items"]`, 'video');
    const labels = (await page.locator(`${UI} aside button`).allInnerTexts()).map(t => t.trim());
    // The match plus all four ancestors, so the position is never ambiguous.
    for (const crumb of ['Specialties', 'Cardiology & Cardiac Surgery', 'Our Services',
                         'Active BP Blood Pressure Monitoring', 'Video Tutorial']) {
      expect(labels, `"${crumb}" should be retained`).toContain(crumb);
    }
  });

  test('the breadcrumb shows the full path for a deep selection', async ({ page, settings }) => {
    await openMenuSection(page, settings);
    await page.locator(`${UI} aside button`, { hasText: /^Video Tutorial$/ }).first().click();
    const trail = await page.locator(`${UI} aside >> text=/Will appear under/`).innerText();
    expect(trail).toContain('Specialties');
    expect(trail).toContain('Our Services');
    expect(trail).toContain('Video Tutorial');
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
