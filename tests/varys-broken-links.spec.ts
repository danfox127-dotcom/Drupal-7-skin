import { test, expect } from '@playwright/test';
import { parseBrokenLinksAnswer } from '../src/lib/varys/brokenLinks';

/**
 * The answer Varys gives for a page's broken links (GET /api/extension/broken-links), checked
 * once in the worker so the panel can read it without looking again.
 */

const deadProfile = {
  url: 'https://www.vagelos.columbia.edu/profile/jane-roe',
  href: '/profile/jane-roe',
  text: 'Dr. Jane Roe',
  in_body: true,
  sitewide: false,
  state: 'broken',
  reason: 'not_found',
  since: '2026-11-01T06:12:00+00:00',
  suggestion: null,
};
const movedOutside = {
  url: 'https://www.iom.edu/reports',
  href: 'https://www.iom.edu/reports',
  text: 'the IOM report',
  in_body: null,
  sitewide: true,
  state: 'moved',
  reason: 'home_redirect',
  since: null,
  suggestion: 'https://www.nationalacademies.org/reports',
};

test.describe('parsing a broken-links answer', () => {
  test('parses ok links', () => {
    expect(parseBrokenLinksAnswer({ status: 'ok', checked: true, links: [{ ...deadProfile, extra: 1 }, movedOutside] }))
      .toEqual({
        kind: 'ok',
        links: [
          {
            url: 'https://www.vagelos.columbia.edu/profile/jane-roe', href: '/profile/jane-roe', text: 'Dr. Jane Roe',
            inBody: true, sitewide: false, state: 'broken', reason: 'not_found', since: '2026-11-01T06:12:00+00:00',
            suggestion: null,
          },
          {
            url: 'https://www.iom.edu/reports', href: 'https://www.iom.edu/reports', text: 'the IOM report',
            inBody: null, sitewide: true, state: 'moved', reason: 'home_redirect', since: null,
            suggestion: 'https://www.nationalacademies.org/reports',
          },
        ],
      });
  });

  test('a checked page with nothing broken is ok with no links', () => {
    expect(parseBrokenLinksAnswer({ status: 'ok', checked: true, links: [] })).toEqual({ kind: 'ok', links: [] });
  });

  test('checked false is unchecked', () => {
    expect(parseBrokenLinksAnswer({ status: 'ok', checked: false, links: [] })).toEqual({ kind: 'unchecked' });
  });

  test('unchecked page shows no section: links beside checked false are never passed on', () => {
    // Whatever else came with it, an unchecked page must not reach the panel as a list it
    // would count: "0 broken" there would be a claim nobody checked.
    expect(parseBrokenLinksAnswer({ status: 'ok', checked: false, links: [deadProfile] })).toEqual({ kind: 'unchecked' });
  });

  test('not_tracked passes through', () => {
    expect(parseBrokenLinksAnswer({ status: 'not_tracked' })).toEqual({ kind: 'not_tracked' });
  });

  test('malformed is error', () => {
    const bad: unknown[] = [
      null, 'ok', 7, [],
      { status: 'surprise' },
      { status: 'ok', links: [] },
      { status: 'ok', checked: 'yes', links: [] },
      { status: 'ok', checked: true },
      { status: 'ok', checked: true, links: 'none' },
      { status: 'ok', checked: true, links: [null] },
      { status: 'ok', checked: true, links: [{ ...deadProfile, url: 3 }] },
      { status: 'ok', checked: true, links: [{ ...deadProfile, url: '' }] },
      { status: 'ok', checked: true, links: [{ ...deadProfile, href: undefined }] },
      { status: 'ok', checked: true, links: [{ ...deadProfile, text: null }] },
      { status: 'ok', checked: true, links: [{ ...deadProfile, in_body: 'yes' }] },
      { status: 'ok', checked: true, links: [{ ...deadProfile, sitewide: null }] },
      { status: 'ok', checked: true, links: [{ ...deadProfile, state: 'fine' }] },
      { status: 'ok', checked: true, links: [{ ...deadProfile, reason: 404 }] },
      { status: 'ok', checked: true, links: [{ ...deadProfile, since: 1 }] },
      { status: 'ok', checked: true, links: [{ ...deadProfile, suggestion: false }] },
      // One malformed link rejects the answer, as a malformed suggestions answer does.
      { status: 'ok', checked: true, links: [deadProfile, { ...movedOutside, state: 'blocked' }] },
    ];
    for (const json of bad) {
      expect(parseBrokenLinksAnswer(json), JSON.stringify(json)).toEqual({ kind: 'error' });
    }
  });
});
