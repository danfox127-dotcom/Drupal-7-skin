import { test, expect } from '@playwright/test';
import { SUGGESTIONS_NO_CURSOR_COPY, parseSuggestionsAnswer } from '../src/lib/varys/suggestions';

/**
 * The answer Varys gives for a page's Page Health suggestions, checked once in the worker so
 * the panel can read it without looking again.
 */

const side = { meta_title: 'Heart failure', meta_description: null, h1: 'Heart failure', h2s: ['Overview'] };
const ready = {
  status: 'ready', made_at: '2026-10-21T09:30:00Z', clinical_review_note: null, current: side, suggested: side,
};

test.describe('parsing a suggestions answer', () => {
  test('the four answers with nothing to show pass through', () => {
    for (const status of ['not_tracked', 'not_crawled', 'none', 'generating'] as const) {
      expect(parseSuggestionsAnswer({ status })).toEqual({ status });
    }
  });

  test('a ready answer passes through, and anything else Varys added is dropped', () => {
    expect(parseSuggestionsAnswer({ ...ready, extra: 1 })).toEqual(ready);
    expect(parseSuggestionsAnswer({ ...ready, clinical_review_note: 'Check the dose.' }))
      .toMatchObject({ clinical_review_note: 'Check the dose.' });
  });

  test('a ready answer missing a part, or with a part of the wrong type, is not an answer', () => {
    const { current, ...noCurrent } = ready;
    void current;
    expect(parseSuggestionsAnswer(noCurrent)).toBeNull();
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
