import { test, expect } from '@playwright/test';
import {
  parseMenuIndex, withAncestors, searchMenuIndex, countMenuMatches,
  menuItemEditUrl, menuIndexSourceUrl, MenuIndexItem,
} from '../src/lib/menuIndex';

/**
 * The index that makes a filter possible on a menu too large to render.
 *
 * BigMenu shows 9 of 3,000+ rows and loads each subtree on request, so filtering the
 * visible rows is useless and expanding everything defeats the module. Drupal builds its
 * parent-link select from the FULL tree regardless, so one page carries every item.
 *
 * Parsing runs in Node against a DOM built with the browser's own parser in the extension
 * tests; here it is exercised through a minimal fake so the ordering and depth logic can be
 * pinned down exactly.
 */

/** Builds the shape Drupal emits: option value "menu:mlid", label with hyphen depth. */
function selectWith(rows: [string, string][]): ParentNode {
  const options = rows.map(([value, label]) =>
    ({ getAttribute: () => value, textContent: label }));
  const select = { querySelectorAll: () => options };
  return { querySelectorAll: (sel: string) => (sel === 'select' ? [select] : []) } as unknown as ParentNode;
}

test.describe('parseMenuIndex', () => {
  test('reads mlid, title and depth from the option label', () => {
    const items = parseMenuIndex(selectWith([
      ['main-menu:0', '<Main menu>'],
      ['main-menu:100', 'About Us'],
      ['main-menu:101', '-Annual Report'],
      ['main-menu:102', '--Dean’s Message'],
    ]));

    expect(items).toEqual([
      { mlid: '100', title: 'About Us', depth: 0, ancestors: [] },
      { mlid: '101', title: 'Annual Report', depth: 1, ancestors: ['About Us'] },
      { mlid: '102', title: 'Dean’s Message', depth: 2, ancestors: ['About Us', 'Annual Report'] },
    ]);
  });

  test('drops the menu root, which is a parent option and not an item', () => {
    // `main-menu:0` means "top level" in the select. Listing it as a search result would
    // offer an edit page that does not exist.
    const items = parseMenuIndex(selectWith([['main-menu:0', '<Main menu>']]));
    expect(items).toEqual([]);
  });

  test('is not anchored to a select name', () => {
    // Drupal calls it menu[parent] on a node form and parent on the menu link form, and a
    // theme can rename it. The option VALUE shape is the reliable signal.
    const items = parseMenuIndex(selectWith([['footer-menu:7', 'Contact']]));
    expect(items).toEqual([{ mlid: '7', title: 'Contact', depth: 0, ancestors: [] }]);
  });

  test('filters to one menu when asked', () => {
    const items = parseMenuIndex(selectWith([
      ['main-menu:1', 'Home'],
      ['footer-menu:2', 'Privacy'],
    ]), 'main-menu');
    expect(items.map(i => i.title)).toEqual(['Home']);
  });

  test('ignores selects that are not menu parents', () => {
    const doc = {
      querySelectorAll: () => [
        { querySelectorAll: () => [{ getAttribute: () => 'full', textContent: 'Full node' }] },
        { querySelectorAll: () => [{ getAttribute: () => 'main-menu:5', textContent: 'Real' }] },
      ],
    } as unknown as ParentNode;
    expect(parseMenuIndex(doc).map(i => i.title)).toEqual(['Real']);
  });

  test('returns nothing rather than guessing when no parent select exists', () => {
    const doc = { querySelectorAll: () => [] } as unknown as ParentNode;
    expect(parseMenuIndex(doc)).toEqual([]);
  });
});

test.describe('withAncestors', () => {
  test('a sibling after a deep branch does not inherit that branch', () => {
    // The bug this guards: a stale trail would give "Locations" the ancestors of the
    // Cardiology subtree above it, and the search result would name the wrong parent.
    const items: MenuIndexItem[] = [
      { mlid: '1', title: 'Specialties', depth: 0, ancestors: [] },
      { mlid: '2', title: 'Cardiology', depth: 1, ancestors: [] },
      { mlid: '3', title: 'Our Services', depth: 2, ancestors: [] },
      { mlid: '4', title: 'Locations', depth: 0, ancestors: [] },
    ];
    expect(withAncestors(items).map(i => i.ancestors)).toEqual([
      [], ['Specialties'], ['Specialties', 'Cardiology'], [],
    ]);
  });

  test('a jump deeper than one level does not invent an ancestor', () => {
    const items: MenuIndexItem[] = [
      { mlid: '1', title: 'Top', depth: 0, ancestors: [] },
      { mlid: '2', title: 'Deep', depth: 2, ancestors: [] },
    ];
    // Drupal should not emit this, but a malformed tree must not produce undefined in a
    // breadcrumb rendered to the user.
    expect(withAncestors(items)[1].ancestors.every(a => typeof a === 'string')).toBe(true);
  });
});

test.describe('searchMenuIndex', () => {
  const items = withAncestors([
    { mlid: '1', title: 'Specialties', depth: 0, ancestors: [] },
    { mlid: '2', title: 'Cardiology', depth: 1, ancestors: [] },
    { mlid: '3', title: 'Surgery', depth: 2, ancestors: [] },
    { mlid: '4', title: 'Dermatology', depth: 1, ancestors: [] },
    { mlid: '5', title: 'Surgery', depth: 2, ancestors: [] },
  ]);

  test('matches on the ancestor path, not only the title', () => {
    // Two items are called "Surgery"; the path is the only thing that separates them.
    const hits = searchMenuIndex(items, 'cardiology surgery');
    expect(hits.map(i => i.mlid)).toEqual(['3']);
  });

  test('every term must match, so a query narrows', () => {
    expect(searchMenuIndex(items, 'surgery').map(i => i.mlid)).toEqual(['3', '5']);
    expect(searchMenuIndex(items, 'derm surgery').map(i => i.mlid)).toEqual(['5']);
  });

  test('an empty query returns nothing rather than everything', () => {
    // 3,000 rows rendered on focus would freeze the page.
    expect(searchMenuIndex(items, '   ')).toEqual([]);
  });

  test('results are capped, and the true total is still reported', () => {
    const many = withAncestors(Array.from({ length: 300 }, (_, i) => (
      { mlid: String(i + 1), title: `Clinic ${i}`, depth: 0, ancestors: [] }
    )));
    expect(searchMenuIndex(many, 'clinic', 50)).toHaveLength(50);
    // Saying "50" when 300 matched would misrepresent the menu.
    expect(countMenuMatches(many, 'clinic')).toBe(300);
  });
});

test.describe('urls', () => {
  test('an item links to its own edit form', () => {
    expect(menuItemEditUrl('7191')).toBe('/admin/structure/menu/item/7191/edit');
  });

  test('the index comes from the menu\'s own add-link form', () => {
    // Not a node form: this exists for whatever menu is being viewed, with no guess about
    // which content types the site has.
    expect(menuIndexSourceUrl('main-menu')).toBe('/admin/structure/menu/manage/main-menu/add');
  });
});

test.describe('a prefix that does not match the menu name', () => {
  test('indexes anyway rather than reporting nothing to search', () => {
    // The URL segment is the machine name in stock Drupal, so this should not arise. The
    // failure it prevents is the feature saying "no parent list found" while a perfectly
    // good one sits on the page.
    const doc = selectWith([['other-name:5', 'Real Item']]);
    expect(parseMenuIndex(doc, 'main-menu').map(i => i.title)).toEqual(['Real Item']);
  });

  test('still prefers the named menu when it is present', () => {
    const doc = selectWith([
      ['main-menu:1', 'Wanted'],
      ['footer-menu:2', 'Unwanted'],
    ]);
    expect(parseMenuIndex(doc, 'main-menu').map(i => i.title)).toEqual(['Wanted']);
  });
});
