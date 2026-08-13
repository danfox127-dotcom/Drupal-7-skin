import { test, expect } from '@playwright/test';
import * as esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import {
  mapColumns, statusKind, statusLabel, nodeIdFromHref,
} from '../src/lib/parseContentList';
import { countChanges } from '../src/components/MenuTree';

/**
 * Pure logic for the content list and the menu manager's dirty count.
 *
 * The DOM-level parse (parseContentList / findContentTable / currentUsername) needs
 * a real document, so it is exercised in the browser against
 * tests/fixtures/admin/content.html rather than here.
 */

test.describe('column mapping', () => {
  test('maps Drupal 7 core headers', () => {
    const columns = mapColumns(['', 'Title', 'Content type', 'Author', 'Status', 'Updated', 'Operations']);
    expect(columns).toEqual({ title: 1, type: 2, author: 3, status: 4, updated: 5 });
  });

  test('is order-independent, so a reordered table still parses', () => {
    const columns = mapColumns(['Status', 'Title', 'Updated', 'Content type']);
    expect(columns.title).toBe(1);
    expect(columns.status).toBe(0);
    expect(columns.updated).toBe(2);
    expect(columns.type).toBe(3);
  });

  test('tolerates extra whitespace and case from sortable header markup', () => {
    const columns = mapColumns(['  TITLE  ', '\n Content Type \n']);
    expect(columns.title).toBe(0);
    expect(columns.type).toBe(1);
  });

  test('accepts aliases a site may have renamed', () => {
    expect(mapColumns(['Name', 'Type', 'Submitted by', 'Moderation state', 'Changed'])).toEqual({
      title: 0, type: 1, author: 2, status: 3, updated: 4,
    });
  });

  test('omits columns that are absent rather than guessing an index', () => {
    const columns = mapColumns(['Title', 'Operations']);
    expect(columns.title).toBe(0);
    expect(columns.type).toBeUndefined();
    expect(columns.status).toBeUndefined();
  });

  test('a prefix match catches a header carrying a sort indicator', () => {
    expect(mapColumns(['Title sort ascending']).title).toBe(0);
  });
});

test.describe('status interpretation', () => {
  test('maps Drupal core states', () => {
    expect(statusKind('published')).toBe('published');
    expect(statusKind('not published')).toBe('draft');
  });

  test('maps moderation states from contrib', () => {
    expect(statusKind('needs review')).toBe('review');
    expect(statusKind('Needs Review')).toBe('review');
    expect(statusKind('draft')).toBe('draft');
    expect(statusKind('unpublished')).toBe('draft');
  });

  test('"not published" is a draft, not published — order of checks matters', () => {
    // Both strings contain "published"; the negative must win.
    expect(statusKind('not published')).not.toBe('published');
  });

  test('an unrecognized state is unknown rather than mislabeled', () => {
    expect(statusKind('embargoed')).toBe('unknown');
    expect(statusKind('')).toBe('unknown');
  });

  test('labels fall back to the raw text for unknown states', () => {
    expect(statusLabel('published')).toBe('Published');
    expect(statusLabel('not published')).toBe('Draft');
    expect(statusLabel('needs review')).toBe('Needs review');
    expect(statusLabel('embargoed')).toBe('embargoed');
    expect(statusLabel('   ')).toBe('—');
  });
});

test.describe('node id from href', () => {
  test('reads the id from a canonical node path', () => {
    expect(nodeIdFromHref('/node/451')).toBe('451');
    expect(nodeIdFromHref('/node/451/edit?destination=admin/content')).toBe('451');
  });

  test('returns null for a path alias', () => {
    expect(nodeIdFromHref('/columbia-surgeons-named-top-doctors')).toBeNull();
    expect(nodeIdFromHref('')).toBeNull();
  });
});

test.describe('menu dirty count', () => {
  const base = [
    { id: 'a', title: 'A', path: '/a', depth: 0, enabled: true },
    { id: 'b', title: 'B', path: '/b', depth: 1, enabled: true },
    { id: 'c', title: 'C', path: '/c', depth: 0, enabled: true },
  ];

  test('an untouched list is clean', () => {
    expect(countChanges(base, base)).toBe(0);
    // A structurally equal copy is also clean — comparison is by value, not identity.
    expect(countChanges(base.map(i => ({ ...i })), base)).toBe(0);
  });

  test('counts a depth change', () => {
    const next = base.map(i => (i.id === 'b' ? { ...i, depth: 2 } : i));
    expect(countChanges(next, base)).toBe(1);
  });

  test('counts an enabled toggle', () => {
    const next = base.map(i => (i.id === 'c' ? { ...i, enabled: false } : i));
    expect(countChanges(next, base)).toBe(1);
  });

  test('counts both rows involved in a reorder', () => {
    // Swapping two rows moves both, so both are dirty.
    const next = [base[1], base[0], base[2]];
    expect(countChanges(next, base)).toBe(2);
  });

  test('counts a removed row by way of the rows that shifted', () => {
    const next = [base[0], base[2]];
    // 'c' moved from index 2 to 1.
    expect(countChanges(next, base)).toBe(1);
  });

  test('counts an added row', () => {
    const next = [...base, { id: 'd', title: 'D', path: '/d', depth: 0, enabled: true }];
    expect(countChanges(next, base)).toBe(1);
  });
});

test.describe('parsing /admin/content when it is a View', () => {
  /**
   * The real page failed to parse, degrading to Drupal's table. /admin/content is often a
   * View rather than core's node_admin_content, and a View can rename its headers, omit
   * the thead entirely, or sit alongside other tables.
   *
   * These run in a browser because the fallback reads the rows, not just header strings.
   */
  let bundle: string;

  test.beforeAll(async () => {
    const result = await esbuild.build({
      entryPoints: [path.join(__dirname, '../src/lib/parseContentList.ts')],
      bundle: true, write: false, format: 'iife', globalName: 'CL',
      platform: 'browser', target: 'es2020',
    });
    bundle = result.outputFiles[0].text;
  });

  const load = async (page: import('@playwright/test').Page, body: string) => {
    await page.goto(`data:text/html,${encodeURIComponent(`<body>${body}</body>`)}`);
    await page.addScriptTag({ content: bundle });
  };

  const rowsOf = (page: import('@playwright/test').Page) =>
    page.evaluate(() => (window as any).CL.parseContentList(document));

  /** A view whose headers are renamed beyond recognition. */
  const RENAMED = `
    <table class="views-table">
      <thead><tr><th>Page name</th><th>Kind</th><th>Last touched</th></tr></thead>
      <tbody>
        <tr><td class="views-field views-field-title"><a href="/node/451">Abin Sajan, MD</a></td>
            <td>Profile</td><td>08/12/2026</td></tr>
        <tr><td class="views-field views-field-title"><a href="/node/452">Eric Lam, DO</a></td>
            <td>Profile</td><td>08/11/2026</td></tr>
      </tbody>
    </table>`;

  test('parses a view whose Title header was renamed', async ({ page }) => {
    await load(page, RENAMED);
    const rows = await rowsOf(page);
    expect(rows).not.toBeNull();
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe('Abin Sajan, MD');
    expect(rows[0].nodeId).toBe('451');
  });

  test('parses a table with no thead at all', async ({ page }) => {
    await load(page, `
      <table class="views-table">
        <tbody>
          <tr><td><a href="/node/700">Heart Failure</a></td><td>Condition</td></tr>
          <tr><td><a href="/node/701">Cardiology</a></td><td>Specialty</td></tr>
        </tbody>
      </table>`);
    const rows = await rowsOf(page);
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => r.title)).toEqual(['Heart Failure', 'Cardiology']);
  });

  test('picks the content table over an unrelated one on the same page', async ({ page }) => {
    // Exposed filters and admin blocks often render their own tables.
    await load(page, `
      <table id="filters"><thead><tr><th>Name</th></tr></thead>
        <tbody><tr><td>Published</td></tr></tbody></table>
      ${RENAMED}`);
    const rows = await rowsOf(page);
    expect(rows).toHaveLength(2);
    expect(rows[0].nodeId).toBe('451');
  });

  test('still returns null when no table lists nodes, so Drupal keeps its page', async ({ page }) => {
    await load(page, `
      <table><thead><tr><th>Setting</th><th>Value</th></tr></thead>
        <tbody><tr><td>Cache</td><td>On</td></tr></tbody></table>`);
    expect(await rowsOf(page)).toBeNull();
  });

  test('the title column is inferred from whichever column holds node links', async ({ page }) => {
    // Some views put operations or a checkbox first, so the title is not column 0.
    await load(page, `
      <table>
        <tbody>
          <tr><td><input type="checkbox"></td><td>Profile</td>
              <td><a href="/node/900">Jin Min Min Han, MD</a></td></tr>
        </tbody>
      </table>`);
    const rows = await rowsOf(page);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Jin Min Min Han, MD');
  });

  test('the diagnostic is a string that names the tables and the outcome', async ({ page }) => {
    await load(page, RENAMED);
    const report = await page.evaluate(() => (window as any).CL.diagnoseContentList(document));
    expect(typeof report).toBe('string');
    // It has to survive whatever renders it — an object logged here shows as
    // "[object Object]" on Chrome's extension error page.
    expect(report).toContain('nodeLinks=2');
    expect(report).toContain('Page name');
    expect(report).toContain('rows parsed: 2');
  });

  test('the diagnostic explains a failure rather than just reporting one', async ({ page }) => {
    await load(page, '<div>no tables here</div>');
    const report = await page.evaluate(() => (window as any).CL.diagnoseContentList(document));
    expect(report).toContain('0 table(s)');
    expect(report).toContain('chose: none');
  });

  /**
   * Regression: demo-dean-cuimc-chai.pantheonsite.io/admin/content, verified live.
   *
   * Two failures compounded there. Pathauto meant not one href in a 51-row listing
   * contained "/node/", so both link-based heuristics scored 0; the last resort then took
   * the first table with a Title header, which was Drupal's own floating-header CLONE with
   * an empty tbody. Result: rows parsed: 0 and the whole feature silently declined.
   */
  const ALIASED_WITH_STICKY_CLONE = `
    <table class="sticky-header">
      <thead><tr><th></th><th>Title</th><th>Type</th><th>Author</th><th>Published</th>
                 <th>Status</th><th>Updated</th><th>Operations</th></tr></thead>
      <tbody></tbody>
    </table>
    <table class="views-table sticky-enabled cols-8 tableheader-processed sticky-table">
      <thead><tr><th></th><th>Title</th><th>Type</th><th>Author</th><th>Published</th>
                 <th>Status</th><th>Updated</th><th>Operations</th></tr></thead>
      <tbody>
        <tr class="views-table-row-select-all even">
          <td colspan="16"><span class="vbo-table-this-page">Selected <strong>50 rows</strong>
            in this page.</span></td>
        </tr>
        <tr><td><input type="checkbox"></td>
            <td><a href="/events/medicine-grand-rounds-34">Medicine Grand Rounds</a></td>
            <td>Event</td><td>dfox</td><td>08/12/2026</td><td>Published</td><td>08/12/2026</td>
            <td><a href="/node/8821/edit">edit</a></td></tr>
        <tr><td><input type="checkbox"></td>
            <td><a href="/events/iicd-seminar-series-jun-allard">IICD Seminar Series</a></td>
            <td>Event</td><td>dfox</td><td>08/11/2026</td><td>Published</td><td>08/11/2026</td>
            <td><a href="/node/8822/edit">edit</a></td></tr>
      </tbody>
    </table>`;

  test('ignores Drupal\'s empty sticky-header clone and parses the real table', async ({ page }) => {
    await load(page, ALIASED_WITH_STICKY_CLONE);
    const rows = await rowsOf(page);
    expect(rows).not.toBeNull();
    // 2 content rows — the VBO "Selected 50 rows" strip is furniture, not a record.
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe('Medicine Grand Rounds');
  });

  test('drops the Views Bulk Operations select-all row instead of listing it as content', async ({ page }) => {
    await load(page, ALIASED_WITH_STICKY_CLONE);
    const rows = await rowsOf(page);
    expect(rows.map((r: any) => r.title)).not.toContain(expect.stringContaining('Selected'));
    expect(rows.every((r: any) => !/Selected/.test(r.title))).toBe(true);
  });

  test('finds the title column when every content link is a Pathauto alias', async ({ page }) => {
    // No "/node/N" title links anywhere — only the operations column is unaliased.
    await load(page, ALIASED_WITH_STICKY_CLONE);
    const rows = await rowsOf(page);
    expect(rows[1].title).toBe('IICD Seminar Series');
    // nodeId comes from the aliased href, so it is legitimately absent; the row still works.
    expect(rows[1].updated).toBe('08/11/2026');
  });

  test('a sticky clone is never chosen even when it is the only Title-headed table', async ({ page }) => {
    await load(page, `
      <table class="sticky-header">
        <thead><tr><th>Title</th><th>Type</th></tr></thead><tbody></tbody>
      </table>`);
    // Nothing parseable remains, so Drupal must keep its own page.
    expect(await rowsOf(page)).toBeNull();
  });
});
