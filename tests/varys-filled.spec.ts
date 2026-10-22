import { test, expect } from '@playwright/test';
import { filledFields, markFilled, resetFilled, unmarkFilled } from '../src/lib/varys/filled';

/**
 * Which fields the person filled from Varys on this page. The panel marks and unmarks them;
 * the save carries the list, so Varys can say "Filled from Varys: search title".
 */

test.describe('the fields filled from Varys', () => {
  test.beforeEach(() => resetFilled());

  test('start empty', () => {
    expect(filledFields()).toEqual([]);
  });

  test('filled fields are unique and sorted, and unmark removes', () => {
    resetFilled(); markFilled('title'); markFilled('meta_title'); markFilled('title');
    expect(filledFields()).toEqual(['meta_title', 'title']);
    unmarkFilled('title'); expect(filledFields()).toEqual(['meta_title']);
  });

  test('unmarking a field that was never marked changes nothing', () => {
    markFilled('headings');
    unmarkFilled('meta_description');
    expect(filledFields()).toEqual(['headings']);
  });

  test('every field can be marked, and they come back in alphabetical order', () => {
    for (const field of ['title', 'headings', 'meta_title', 'meta_description'] as const) markFilled(field);
    expect(filledFields()).toEqual(['headings', 'meta_description', 'meta_title', 'title']);
  });

  test('what filledFields returns is a copy, so changing it does not change what is marked', () => {
    markFilled('title');
    filledFields().push('headings');
    expect(filledFields()).toEqual(['title']);
  });

  test('resetFilled clears everything', () => {
    markFilled('title'); markFilled('headings');
    resetFilled();
    expect(filledFields()).toEqual([]);
  });
});
