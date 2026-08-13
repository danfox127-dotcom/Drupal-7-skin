import { test, expect } from '@playwright/test';
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
