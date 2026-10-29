import { test, expect } from '@playwright/test';
import { SUGGESTIONS_NO_CURSOR_COPY, parseSuggestionsAnswer } from '../src/lib/varys/suggestions';

/**
 * The answer Varys gives for a page's Page Health suggestions, checked once in the worker so
 * the panel can read it without looking again.
 */

const side = { meta_title: 'Heart failure', meta_description: null, h1: 'Heart failure', h2s: ['Overview'] };
const ready = {
  status: 'ready', made_at: '2026-10-21T09:30:00Z', clinical_review_note: null, current: side, suggested: side,
  named_doctors: ['Jacqueline L Steele, MD', 'Jane Q. Roe, MD'],
};

test.describe('parsing a suggestions answer', () => {
  test('the three answers with nothing to show pass through', () => {
    for (const status of ['not_tracked', 'not_crawled', 'generating'] as const) {
      expect(parseSuggestionsAnswer({ status })).toEqual({ status });
    }
  });

  test('a page with no suggestions yet keeps the doctors Varys found named in the article', () => {
    expect(parseSuggestionsAnswer({ status: 'none', named_doctors: ['Jacqueline L Steele, MD'], extra: 1 }))
      .toEqual({ status: 'none', named_doctors: ['Jacqueline L Steele, MD'] });
  });

  test('a page with no suggestions from an older Varys has none named', () => {
    expect(parseSuggestionsAnswer({ status: 'none' })).toEqual({ status: 'none', named_doctors: [] });
  });

  test('on a page with no suggestions, named_doctors that is not a list of text is dropped to none', () => {
    for (const bad of ['Jane Q. Roe, MD', 7, null, ['Jane Q. Roe, MD', 3], [null]]) {
      expect(parseSuggestionsAnswer({ status: 'none', named_doctors: bad })).toEqual({ status: 'none', named_doctors: [] });
    }
  });

  test('a ready answer passes through, and anything else Varys added is dropped', () => {
    expect(parseSuggestionsAnswer({ ...ready, extra: 1 })).toEqual(ready);
    expect(parseSuggestionsAnswer({ ...ready, clinical_review_note: 'Check the dose.' }))
      .toMatchObject({ clinical_review_note: 'Check the dose.' });
  });

  test('a ready answer keeps the doctors Varys found named in the article', () => {
    expect(parseSuggestionsAnswer(ready)).toMatchObject({ named_doctors: ['Jacqueline L Steele, MD', 'Jane Q. Roe, MD'] });
    expect(parseSuggestionsAnswer({ ...ready, named_doctors: [] })).toMatchObject({ named_doctors: [] });
  });

  test('an older Varys answer without named_doctors still parses', () => {
    const { named_doctors, ...older } = ready;
    void named_doctors;
    expect(parseSuggestionsAnswer(older)).toEqual({ ...ready, named_doctors: [] });
  });

  test('named_doctors that is not a list of text is dropped to none, without rejecting the answer', () => {
    for (const bad of ['Jane Q. Roe, MD', 7, null, { 0: 'Jane Q. Roe, MD' }, ['Jane Q. Roe, MD', 3], [null], [['Jane Q. Roe, MD']]]) {
      expect(parseSuggestionsAnswer({ ...ready, named_doctors: bad })).toEqual({ ...ready, named_doctors: [] });
    }
  });

  test('a ready answer may have no made_at time, because Varys\'s generated_at can be null', () => {
    expect(parseSuggestionsAnswer({ ...ready, made_at: null })).toEqual({ ...ready, made_at: null });
  });

  test('a ready answer missing a part, or with a part of the wrong type, is not an answer', () => {
    const { current, ...noCurrent } = ready;
    void current;
    expect(parseSuggestionsAnswer(noCurrent)).toBeNull();
    // A null made_at is fine; a missing key is not, and nor is anything but text or null.
    const { made_at, ...noMadeAt } = ready;
    void made_at;
    expect(parseSuggestionsAnswer(noMadeAt)).toBeNull();
    expect(parseSuggestionsAnswer({ ...ready, made_at: 20261021 })).toBeNull();
    expect(parseSuggestionsAnswer({ ...ready, clinical_review_note: undefined })).toBeNull();
    expect(parseSuggestionsAnswer({ ...ready, suggested: { ...side, h2s: 'Overview' } })).toBeNull();
    expect(parseSuggestionsAnswer({ ...ready, suggested: { ...side, h2s: ['Overview', 3] } })).toBeNull();
    expect(parseSuggestionsAnswer({ ...ready, suggested: { ...side, h1: undefined } })).toBeNull();
  });

  test('an unknown status, or something that is not an object, is not an answer', () => {
    for (const bad of [{ status: 'soon' }, { status: 7 }, {}, [], 'ready', 7, null, undefined]) {
      expect(parseSuggestionsAnswer(bad)).toBeNull();
    }
  });

  test('the no-cursor copy tells the person where to click', () => {
    expect(SUGGESTIONS_NO_CURSOR_COPY).toBe('Click in the body where the heading should go, then press Insert again.');
  });
});
