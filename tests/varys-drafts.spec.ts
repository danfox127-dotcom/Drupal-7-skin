import { test, expect } from '@playwright/test';
import { DRAFT_NOT_FOUND_COPY, parseDraft, parseDraftList } from '../src/lib/varys/drafts';

/**
 * The two answers Varys gives for a person's drafts, checked once in the worker so the panel
 * and the fill can read them without looking again. The shapes are Varys's own, from
 * GET /api/extension/drafts and GET /api/extension/drafts/{id}.
 */

const summary = { id: 'job-1', title: 'Heart failure explained', made_at: '2026-10-23T10:00:00+00:00' };

const ready = {
  status: 'ready',
  id: 'job-1',
  title: 'Heart failure: what to know',
  label: 'Heart failure explained',
  made_at: '2026-10-23T10:00:00+00:00',
  body_html: '<h2>Symptoms</h2><p>Shortness of breath.</p>',
  overview_bullets: ['What heart failure is', 'How it is treated'],
  summary: 'A short summary.',
  meta_title: 'Heart failure | CUIMC',
  doctors: [
    { name: 'Jane Roe', status: 'matched', full_name: 'Jane Q. Roe, MD', source: 'quoted', exact: true },
    { name: 'Sam Poe', status: 'not_matched', full_name: null, source: 'topic', exact: false },
  ],
  dropped: { tables: 1, images: 2 },
  counts: { words: 850, headings: 4, lists: 2, links: 3 },
};

test.describe('parsing the list of drafts', () => {
  test('not_tracked passes through', () => {
    expect(parseDraftList({ status: 'not_tracked' })).toEqual({ status: 'not_tracked' });
  });

  test('an ok list passes through, and anything else Varys added is dropped', () => {
    expect(parseDraftList({ status: 'ok', drafts: [summary], extra: 1 }))
      .toEqual({ status: 'ok', drafts: [summary] });
    expect(parseDraftList({ status: 'ok', drafts: [{ ...summary, extra: 1 }] }))
      .toEqual({ status: 'ok', drafts: [summary] });
  });

  test('an ok list with no drafts is an answer, not a failure', () => {
    expect(parseDraftList({ status: 'ok', drafts: [] })).toEqual({ status: 'ok', drafts: [] });
  });

  test('a list missing its drafts, or with a draft of the wrong shape, is not an answer', () => {
    expect(parseDraftList({ status: 'ok' })).toBeNull();
    expect(parseDraftList({ status: 'ok', drafts: 'job-1' })).toBeNull();
    expect(parseDraftList({ status: 'ok', drafts: [{ ...summary, id: 7 }] })).toBeNull();
    expect(parseDraftList({ status: 'ok', drafts: [{ ...summary, title: null }] })).toBeNull();
    expect(parseDraftList({ status: 'ok', drafts: [{ id: 'job-1', title: 'x' }] })).toBeNull();
    // One bad draft spoils the list: the panel would otherwise show a shorter one without saying so.
    expect(parseDraftList({ status: 'ok', drafts: [summary, { ...summary, made_at: undefined }] })).toBeNull();
  });

  test('an unknown status, or something that is not an object, is not an answer', () => {
    for (const bad of [{ status: 'soon' }, { status: 'ready' }, { status: 7 }, {}, [], 'ok', 7, null, undefined]) {
      expect(parseDraftList(bad)).toBeNull();
    }
  });
});

test.describe('parsing one draft', () => {
  test('not_tracked passes through', () => {
    expect(parseDraft({ status: 'not_tracked' })).toEqual({ status: 'not_tracked' });
  });

  test('a ready draft passes through whole, and anything else Varys added is dropped', () => {
    expect(parseDraft(ready)).toEqual(ready);
    expect(parseDraft({ ...ready, extra: 1 })).toEqual(ready);
  });

  test('a ready draft keeps the confirmed title apart from the list label', () => {
    // Drupal's Title is only ever filled from `title`; `label` is for showing in the list.
    expect(parseDraft(ready)).toMatchObject({ title: 'Heart failure: what to know', label: 'Heart failure explained' });
  });

  test('a ready draft may have no title, summary, search title or doctors, and says so with null', () => {
    const bare = { ...ready, title: null, summary: null, meta_title: null, doctors: null };
    expect(parseDraft(bare)).toEqual(bare);
  });

  test('a ready draft with no bullets and no doctors is still an answer', () => {
    const empty = { ...ready, overview_bullets: [], doctors: [] };
    expect(parseDraft(empty)).toEqual(empty);
  });

  test('a ready draft missing body_html, or with one that is not text, is not an answer', () => {
    const { body_html, ...noBody } = ready;
    void body_html;
    expect(parseDraft(noBody)).toBeNull();
    expect(parseDraft({ ...ready, body_html: null })).toBeNull();
    expect(parseDraft({ ...ready, body_html: 42 })).toBeNull();
    expect(parseDraft({ ...ready, body_html: undefined })).toBeNull();
    // An empty body is text, and the fill decides what to do with it.
    expect(parseDraft({ ...ready, body_html: '' })).toMatchObject({ status: 'ready', body_html: '' });
  });

  test('a ready draft missing any other part, or with a part of the wrong type, is not an answer', () => {
    for (const key of ['id', 'label', 'made_at', 'overview_bullets', 'dropped', 'counts']) {
      const { [key]: dropped, ...rest } = ready as Record<string, unknown>;
      void dropped;
      expect(parseDraft(rest), `without ${key}`).toBeNull();
    }
    // title, summary, meta_title and doctors may be null, but not missing or another type.
    for (const key of ['title', 'summary', 'meta_title', 'doctors']) {
      const { [key]: dropped, ...rest } = ready as Record<string, unknown>;
      void dropped;
      expect(parseDraft(rest), `without ${key}`).toBeNull();
    }
    expect(parseDraft({ ...ready, title: 7 })).toBeNull();
    expect(parseDraft({ ...ready, overview_bullets: 'one' })).toBeNull();
    expect(parseDraft({ ...ready, overview_bullets: ['one', 2] })).toBeNull();
    expect(parseDraft({ ...ready, dropped: { tables: 1 } })).toBeNull();
    expect(parseDraft({ ...ready, dropped: { tables: '1', images: 2 } })).toBeNull();
    expect(parseDraft({ ...ready, counts: { words: 1, headings: 1, lists: 1 } })).toBeNull();
    expect(parseDraft({ ...ready, counts: null })).toBeNull();
  });

  test('a doctor of the wrong shape spoils the answer, as the fill acts on each one', () => {
    const doctor = ready.doctors[0];
    expect(parseDraft({ ...ready, doctors: [{ ...doctor, status: 'maybe' }] })).toBeNull();
    expect(parseDraft({ ...ready, doctors: [{ ...doctor, source: 'guess' }] })).toBeNull();
    expect(parseDraft({ ...ready, doctors: [{ ...doctor, exact: 'yes' }] })).toBeNull();
    expect(parseDraft({ ...ready, doctors: [{ ...doctor, full_name: 3 }] })).toBeNull();
    expect(parseDraft({ ...ready, doctors: [{ ...doctor, name: null }] })).toBeNull();
    expect(parseDraft({ ...ready, doctors: 'Jane Roe' })).toBeNull();
    for (const status of ['matched', 'ambiguous', 'not_matched']) {
      expect(parseDraft({ ...ready, doctors: [{ ...doctor, status }] })).not.toBeNull();
    }
  });

  test('an unknown status, or something that is not an object, is not an answer', () => {
    for (const bad of [{ status: 'soon' }, { status: 'ok' }, { status: 7 }, {}, [], 'ready', 7, null, undefined]) {
      expect(parseDraft(bad)).toBeNull();
    }
  });

  test('the not-found copy is Varys\'s own wording', () => {
    expect(DRAFT_NOT_FOUND_COPY).toBe("Varys can't find that draft.");
  });
});
