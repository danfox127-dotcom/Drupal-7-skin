import { test, expect } from '@playwright/test';
import { DENY_RULES, denyReason } from '../src/lib/clone/denyList';

/**
 * The safety core: fields a cross-site paste must never write.
 *
 * Tested in BOTH directions on purpose. A deny list that is too broad is as much a bug
 * as one that is too narrow — silently refusing to copy the body would make the whole
 * feature useless while every "is it denied?" test still passed.
 */

test.describe('what must never be copied', () => {
  const denied: [string, string][] = [
    ['menu[enabled]', 'menu placement'],
    ['menu[parent]', 'menu placement'],
    ['menu[link_title]', 'menu placement'],
    ['path[alias]', 'URL alias'],
    ['name', 'authored by'],
    ['date', 'authored on'],
    ['status', 'publish status'],
    ['promote', 'front page promotion'],
    ['sticky', 'front page promotion'],
    ['revision', 'revision flag'],
    ['log', 'revision message'],
    ['field_image_teaser[und][0][fid]', 'a source-site file id'],
    ['media[field_image_teaser_und_0]', 'a media widget'],
    ['body[und][0][format]', 'a text format'],
    ['form_token', 'a security token'],
    ['form_build_id', 'a form build id'],
  ];

  for (const [machineName, what] of denied) {
    test(`${machineName} is refused — ${what}`, () => {
      expect(denyReason(machineName), `${machineName} was NOT denied`).not.toBeNull();
    });
  }
});

test.describe('what must still be copied', () => {
  /**
   * The other direction, and the more dangerous one. Every name here is real, taken from
   * the captured content types. `field_news_date` is the trap: a rule of /date/ rather
   * than /^date$/ would eat it, and News would lose its display date with the review
   * cheerfully reporting the field as intentionally skipped.
   */
  const allowed = [
    'title_field[und][0][value]',
    'body[und][0][value]',
    'field_summary[und][0][value]',
    'field_subtitle[und][0][value]',
    'field_news_date[und][0][value][date]',
    'field_news_byline[und][0][value]',
    'field_news_categories[und]',
    'field_conditions[und][0][target_id]',
    'og_group_ref[und][0][default][0][target_id]',
    'field_page_paragraphs[und][0][field_text][und][0][value]',
    'field_list_display[und]',
    'field_news_external_url[und][0][url]',
  ];

  for (const machineName of allowed) {
    test(`${machineName} is allowed through`, () => {
      const rule = denyReason(machineName);
      expect(rule, `${machineName} was denied by "${rule?.label}" — the paste would skip it`)
        .toBeNull();
    });
  }
});

test('groups are not on the deny list, because they are matched by name', () => {
  /**
   * Stated as its own test because it was a deliberate decision, not an oversight:
   * og_group_ref IS copied, resolved against the destination's own group names, and left
   * blank when there is no match. Adding it to the deny list would be an easy "safety"
   * change that silently removes a field the feature was asked to fill.
   */
  expect(denyReason('og_group_ref[und][0][default][0][target_id]')).toBeNull();
});

test('every rule can explain itself to a person', () => {
  for (const rule of DENY_RULES) {
    expect(rule.label.trim(), 'a rule with no label cannot be grouped in the review').not.toBe('');
    expect(rule.reason.trim(), `${rule.label} has no reason`).not.toBe('');
    // A reason is shown in the UI, so it has to read as a sentence rather than a code.
    expect(rule.reason.length, `${rule.label}'s reason is too terse to help`).toBeGreaterThan(20);
  }
});
