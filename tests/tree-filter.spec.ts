import { test, expect } from '@playwright/test';
import { filterTreeRetainingAncestors, ancestorIndices } from '../src/lib/treeFilter';

/**
 * The menu hierarchy from the prototype, flattened the way Drupal renders it.
 * Depth carries the nesting; there is no containment.
 */
const MENU = [
  { title: 'About Us', depth: 0 },
  { title: 'Annual Report 2021-2022', depth: 1 },
  { title: "Dean's Message", depth: 2 },
  { title: 'Leadership Message', depth: 2 },
  { title: 'Excellence in Patient Care', depth: 2 },
  { title: 'Innovations', depth: 2 },
  { title: 'Our Locations', depth: 0 },
  { title: 'Patient Resources', depth: 0 },
  { title: 'Insurance & Billing', depth: 1 },
  { title: 'Find a Doctor', depth: 0 },
];

const titles = (items: { title: string }[]) => items.map(i => i.title);
const filter = (q: string) => filterTreeRetainingAncestors(MENU, q, i => i.title);

test.describe('ancestorIndices', () => {
  test('finds the full chain for a deeply nested item', () => {
    // Dean's Message (depth 2) -> Annual Report (1) -> About Us (0)
    expect(ancestorIndices(MENU, 2)).toEqual([1, 0]);
  });

  test('a root item has no ancestors', () => {
    expect(ancestorIndices(MENU, 0)).toEqual([]);
    expect(ancestorIndices(MENU, 6)).toEqual([]);
  });

  test('picks the nearest preceding parent, not an earlier same-depth item', () => {
    // Insurance & Billing (depth 1) belongs to Patient Resources (index 7),
    // not to About Us, even though About Us is also depth 0 earlier on.
    expect(ancestorIndices(MENU, 8)).toEqual([7]);
  });
});

test.describe('filterTreeRetainingAncestors', () => {
  test('a matching child keeps its parents visible', () => {
    const result = filter("dean's");
    expect(titles(result.items)).toEqual([
      'About Us',
      'Annual Report 2021-2022',
      "Dean's Message",
    ]);
  });

  test('reports match count separately from retained ancestors', () => {
    const result = filter("dean's");
    expect(result.matchCount).toBe(1);
    expect(result.items).toHaveLength(3);
  });

  test('distinguishes a real match from a retained ancestor', () => {
    const result = filter("dean's");
    const byTitle = (t: string) => result.items.find(i => i.title === t)!;
    expect(result.isMatch(byTitle("Dean's Message"))).toBe(true);
    expect(result.isMatch(byTitle('About Us'))).toBe(false);
    expect(result.isMatch(byTitle('Annual Report 2021-2022'))).toBe(false);
  });

  test('is case-insensitive and matches substrings', () => {
    expect(titles(filter('MESSAGE').items)).toContain("Dean's Message");
    expect(titles(filter('message').items)).toContain('Leadership Message');
    expect(titles(filter('sur').items)).toContain('Insurance & Billing');
  });

  test('keeps original order, not match order', () => {
    // "o" matches items scattered through the list; output must stay top-to-bottom.
    const result = filter('o');
    const indices = result.items.map(i => MENU.indexOf(i));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  test('several matches under one parent list that parent once', () => {
    const result = filter('message');
    expect(titles(result.items)).toEqual([
      'About Us',
      'Annual Report 2021-2022',
      "Dean's Message",
      'Leadership Message',
    ]);
  });

  test('an empty query returns everything and matches everything', () => {
    const result = filter('');
    expect(result.items).toHaveLength(MENU.length);
    expect(result.matchCount).toBe(MENU.length);
    expect(result.isMatch(MENU[0])).toBe(true);
  });

  test('a whitespace-only query behaves as empty', () => {
    expect(filter('   ').items).toHaveLength(MENU.length);
  });

  test('no matches returns nothing, not everything', () => {
    const result = filter('zzzznope');
    expect(result.items).toHaveLength(0);
    expect(result.matchCount).toBe(0);
  });

  test('matching a parent does not pull in its children', () => {
    // Only ancestors are retained. "About Us" matching must not drag the whole
    // subtree along, or filtering would barely narrow anything.
    const result = filter('about us');
    expect(titles(result.items)).toEqual(['About Us']);
  });

  test('handles a tree that starts at a non-zero depth without hanging', () => {
    const orphan = [{ title: 'Deep', depth: 3 }];
    const result = filterTreeRetainingAncestors(orphan, 'deep', i => i.title);
    expect(titles(result.items)).toEqual(['Deep']);
  });
});
