import { test, expect } from '@playwright/test';
import { availableCommands, filterCommands, COMMANDS, GROUP_ORDER } from '../src/lib/commands';
import { normalizeUrl, displayUrl } from '../src/popup/useImportQueue';
import { nodeIdFromPath, canExportHere } from '../src/lib/extractPublicHtml';

/**
 * Pure logic behind the palette and the import queue. No browser is launched —
 * the DOM-level behavior (⌘K opening the overlay, focus trapping) needs a real
 * extension context and is covered separately.
 */

/** Minimal Location stand-in; only pathname/origin are read. */
const loc = (pathname: string, origin = 'https://www.cuimc.columbia.edu') =>
  ({ pathname, origin, href: origin + pathname } as Location);

test.describe('command registry', () => {
  test('every registered command can actually do something', () => {
    // Guards against re-introducing the prototype's dead rows: a command must
    // either navigate or run, otherwise selecting it does nothing.
    for (const command of COMMANDS) {
      expect(
        Boolean(command.path) || Boolean(command.run),
        `${command.id} has neither path nor run`
      ).toBe(true);
    }
  });

  test('command ids are unique', () => {
    const ids = COMMANDS.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('results are ordered Create, then Go to, then Run', () => {
    const groups = availableCommands(loc('/node/123/edit')).map(c => c.group);
    const indices = groups.map(g => GROUP_ORDER.indexOf(g));
    const sorted = [...indices].sort((a, b) => a - b);
    expect(indices).toEqual(sorted);
  });

  test('node-only commands are hidden away from node pages', () => {
    const onNode = availableCommands(loc('/node/123/edit')).map(c => c.id);
    const onAdmin = availableCommands(loc('/admin/content')).map(c => c.id);

    expect(onNode).toContain('copy-html');
    expect(onAdmin).not.toContain('copy-html');
    // Navigation commands are context-free and present in both.
    expect(onAdmin).toContain('goto-menu');
  });
});

test.describe('command filtering', () => {
  const all = availableCommands(loc('/node/123/edit'));

  test('matches labels case-insensitively as a substring', () => {
    expect(filterCommands(all, 'MENU').map(c => c.id)).toContain('goto-menu');
    expect(filterCommands(all, 'menu').map(c => c.id)).toContain('goto-menu');
    expect(filterCommands(all, 'nu man').map(c => c.id)).toContain('goto-menu');
  });

  test('matches the group name, so "go to" narrows to navigation', () => {
    const ids = filterCommands(all, 'go to').map(c => c.id);
    expect(ids).toContain('goto-content');
    expect(ids).not.toContain('new-news');
  });

  test('an empty or whitespace query returns everything', () => {
    expect(filterCommands(all, '')).toHaveLength(all.length);
    expect(filterCommands(all, '   ')).toHaveLength(all.length);
  });

  test('a query matching nothing returns an empty list, not everything', () => {
    expect(filterCommands(all, 'zzzznope')).toHaveLength(0);
  });
});

test.describe('node id parsing', () => {
  test('reads the id from edit and view paths', () => {
    expect(nodeIdFromPath('/node/123/edit')).toBe('123');
    expect(nodeIdFromPath('/node/4567')).toBe('4567');
    expect(nodeIdFromPath('/node/89/revisions')).toBe('89');
  });

  test('returns null where there is no node id', () => {
    expect(nodeIdFromPath('/admin/content')).toBeNull();
    expect(nodeIdFromPath('/node/add/news')).toBeNull();
    // A path alias has no node id even though it is a node page.
    expect(nodeIdFromPath('/departments/cardiology')).toBeNull();
  });

  test('canExportHere follows the same rule', () => {
    expect(canExportHere(loc('/node/123/edit'))).toBe(true);
    expect(canExportHere(loc('/node/add/news'))).toBe(false);
  });
});

test.describe('import queue url handling', () => {
  test('accepts a full url unchanged', () => {
    expect(normalizeUrl('https://heartresearchtoday.org/news/x')).toBe('https://heartresearchtoday.org/news/x');
  });

  test('adds a scheme when someone pastes a bare host', () => {
    expect(normalizeUrl('oldsite.example.edu/about/leadership'))
      .toBe('https://oldsite.example.edu/about/leadership');
  });

  test('trims surrounding whitespace', () => {
    expect(normalizeUrl('  https://example.com/a  ')).toBe('https://example.com/a');
  });

  test('rejects input that is not a url', () => {
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl('   ')).toBeNull();
    // A bare word would otherwise parse as https://news
    expect(normalizeUrl('news')).toBeNull();
    expect(normalizeUrl('not a url at all')).toBeNull();
  });

  test('rejects non-http schemes', () => {
    // javascript: and file: must never reach chrome.tabs.create.
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('file:///etc/passwd')).toBeNull();
  });

  test('normalization is stable, so de-duplication works', () => {
    expect(normalizeUrl('example.com/a')).toBe(normalizeUrl('https://example.com/a'));
  });

  test('display strips the scheme and a trailing slash', () => {
    expect(displayUrl('https://example.com/a/')).toBe('example.com/a');
    expect(displayUrl('http://example.com')).toBe('example.com');
  });
});
