import { test, expect } from '@playwright/test';
import { canCopyFrom, canPasteInto, describeTarget } from '../src/lib/clone/whereAmI';

/**
 * Which copy/paste actions are possible at a URL.
 *
 * Shared by the popup and the palette, which is the point: the popup can only see the
 * active tab's address and the content script can see the DOM, so the one thing they
 * must agree on is this. Drift would show up as a button that is enabled and then fails.
 */
test.describe('copying', () => {
  test('an edit form is the only page worth copying from', () => {
    expect(canCopyFrom('/node/1313/edit')).toBe(true);
    expect(canCopyFrom('/node/1313/edit?destination=admin/content')).toBe(true);
  });

  test('an add form has nothing on it to copy', () => {
    // Offering it would store an empty snapshot and then report success.
    expect(canCopyFrom('/node/add/program')).toBe(false);
  });

  test('a view page is not a form', () => {
    expect(canCopyFrom('/node/1313')).toBe(false);
    expect(canCopyFrom('/admin/content')).toBe(false);
    expect(canCopyFrom(null)).toBe(false);
  });
});

test.describe('pasting', () => {
  test('both kinds of node form accept a paste', () => {
    expect(canPasteInto('/node/add/program')).toBe(true);
    expect(canPasteInto('/node/1313/edit')).toBe(true);
  });

  test('the content-type chooser is not a form', () => {
    // /node/add with no type lists the types; there are no fields to fill.
    expect(canPasteInto('/node/add')).toBe(false);
    expect(canPasteInto('/admin/content')).toBe(false);
  });
});

test.describe('naming the target', () => {
  test('an add form is named by its content type', () => {
    expect(describeTarget('/node/add/program')).toBe('new program');
    // Drupal hyphenates machine names in URLs.
    expect(describeTarget('/node/add/timeline-entry')).toBe('new timeline entry');
  });

  test('an edit form is named by its node', () => {
    expect(describeTarget('/node/1313/edit')).toBe('node 1313');
  });

  test('anywhere else has no name to give', () => {
    expect(describeTarget('/admin/content')).toBeNull();
  });
});
