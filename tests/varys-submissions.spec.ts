import { test, expect } from '@playwright/test';
import type { PageState } from '../src/lib/varys/pageState';
import {
  EXPIRED_COPY, QUEUE_MAX_ENTRIES, UNREACHABLE_COPY, UNTRACKED_COPY,
  failureOf, isTrackedSite, knownUntracked, mergeCarriedBefore, nextOpenedForm, noteLoading, noticeForResult,
  outcomeOfNavigation, outcomeOfTimeout, outcomeWhenLoaded, pruneQueue, queueVerdict, storedNoticeFor,
  toSaveRequest,
  type OpenedForm, type PendingSubmit, type QueuedSave,
} from '../src/lib/varys/submissions';

/**
 * Following a Drupal save to Varys: the decisions the service worker makes, tested directly.
 * The worker's storage, network and tab events are covered end to end in
 * tests/extension.test.ts.
 */

const HOST = 'https://www.cuimc.columbia.edu';
const FORM = `${HOST}/node/23110/edit`;

const state = (title: string, over: Partial<PageState> = {}): PageState => ({
  title,
  meta_title: null,
  meta_description: 'A description.',
  summary: null,
  alias: null,
  headings: [],
  links: [],
  body_words: 10,
  new_sentences: [],
  ...over,
});

const pending = (over: Partial<PendingSubmit> = {}, payload: Partial<PendingSubmit['payload']> = {}): PendingSubmit => ({
  tabId: 7,
  formPath: '/node/23110/edit',
  formUrl: FORM,
  submittedAt: 1_000,
  email: 'a@cumc.columbia.edu',
  loadingSeen: true,
  ...over,
  payload: {
    pageUrl: `${HOST}/node/23110`,
    nodeId: '23110',
    contentType: 'list',
    button: 'publish',
    isNew: false,
    before: state('Before'),
    after: state('After'),
    bodyChangeRatio: 0.1,
    varysFilled: [],
    ...payload,
  },
});

/** An add form: no page yet, no node id, no before. */
const pendingNew = (over: Partial<PendingSubmit> = {}) => pending(
  { formPath: '/node/add/news', formUrl: `${HOST}/node/add/news`, ...over },
  { pageUrl: null, nodeId: null, isNew: true, before: null },
);

test.describe('outcomeOfNavigation', () => {
  test('back on the same path is a failed save', () => {
    expect(outcomeOfNavigation(pending(), FORM)).toEqual({ kind: 'failed' });
    // A query string or the other spelling of the host is still the same form.
    expect(outcomeOfNavigation(pending(), `${FORM}?render=1`)).toEqual({ kind: 'failed' });
    expect(outcomeOfNavigation(pending(), 'https://cuimc.columbia.edu/node/23110/edit')).toEqual({ kind: 'failed' });
    expect(outcomeOfNavigation(pendingNew(), `${HOST}/node/add/news`)).toEqual({ kind: 'failed' });
  });

  test('landing on /news/foo is a save of /news/foo', () => {
    // The form only knew /node/23110 (it had no View tab); where Drupal landed is the alias.
    expect(outcomeOfNavigation(pending(), `${HOST}/news/foo`))
      .toEqual({ kind: 'saved', pageUrl: `${HOST}/news/foo`, nodeId: '23110' });
    // And for a new page, where the form knew nothing at all.
    expect(outcomeOfNavigation(pendingNew(), `${HOST}/news/foo?x=1#top`))
      .toEqual({ kind: 'saved', pageUrl: `${HOST}/news/foo`, nodeId: null });
  });

  test('landing on /admin/content with no pageUrl but a nodeId gives /node/<id>', () => {
    const p = pending({}, { pageUrl: null });
    expect(outcomeOfNavigation(p, `${HOST}/admin/content`))
      .toEqual({ kind: 'saved', pageUrl: `${HOST}/node/23110`, nodeId: '23110' });
  });

  test('a new page that lands on /node/N takes its id from there', () => {
    expect(outcomeOfNavigation(pendingNew(), `${HOST}/node/24001`))
      .toEqual({ kind: 'saved', pageUrl: `${HOST}/node/24001`, nodeId: '24001' });
  });

  test('a ?destination on the form means where it landed is not the page that was saved', () => {
    // An Edit link in a listing carries ?destination=<the listing>.
    const p = pending({ formUrl: `${FORM}?destination=news` }, { pageUrl: `${HOST}/conditions/asthma` });
    expect(outcomeOfNavigation(p, `${HOST}/news`))
      .toEqual({ kind: 'saved', pageUrl: `${HOST}/conditions/asthma`, nodeId: '23110' });
  });

  test('admin screens, node sub-pages and node forms are never the page address', () => {
    const p = pending({}, { pageUrl: `${HOST}/conditions/asthma` });
    for (const landed of ['/admin/content', '/node/23110/revisions', '/node/23110/edit/', '/node/add/news']) {
      expect(outcomeOfNavigation(p, HOST + landed), landed)
        .toEqual({ kind: 'saved', pageUrl: `${HOST}/conditions/asthma`, nodeId: '23110' });
    }
  });

  test('a new page that lands somewhere with no address cannot be sent', () => {
    expect(outcomeOfNavigation(pendingNew(), `${HOST}/admin/content`)).toEqual({ kind: 'noAddress' });
  });

  test('landing on the login page, or on another site, means the save did not happen', () => {
    // An expired Drupal session sends Save to /user/login; a single sign-on sends it off the
    // site. Neither is a page that was saved, and neither is the form failing validation.
    for (const landed of [`${HOST}/user`, `${HOST}/user/login?destination=node/23110/edit`,
      'https://cas.columbia.edu/cas/login', 'https://example.org/node/5']) {
      expect(outcomeOfNavigation(pending(), landed), landed).toEqual({ kind: 'interrupted' });
      expect(outcomeOfNavigation(pendingNew(), landed), landed).toEqual({ kind: 'interrupted' });
    }
    // /users or /userguide is a page like any other.
    expect(outcomeOfNavigation(pending({}, { pageUrl: null }), `${HOST}/userguide`))
      .toEqual({ kind: 'saved', pageUrl: `${HOST}/userguide`, nodeId: '23110' });
  });

  test('a load that was already under way when Save was pressed is not the answer to it', () => {
    // The form page's own load, finishing just after Save: back on the form's path, it would
    // read as a failed save, and the real save would never be sent.
    const waiting = pending({ submittedAt: 5_000, loadingSeen: false });
    expect(outcomeWhenLoaded(waiting, FORM)).toBeNull();
    expect(outcomeWhenLoaded(noteLoading(waiting, 4_999), FORM)).toBeNull();

    // A load that STARTED after Save is the answer.
    const answered = noteLoading(waiting, 5_000);
    expect(answered.loadingSeen).toBe(true);
    expect(outcomeWhenLoaded(answered, FORM)).toEqual({ kind: 'failed' });
    expect(outcomeWhenLoaded(noteLoading(waiting, 5_120), `${HOST}/news/foo`))
      .toEqual({ kind: 'saved', pageUrl: `${HOST}/news/foo`, nodeId: '23110' });
  });

  test('a save never seen to finish is sent with the address the form knew', () => {
    expect(outcomeOfTimeout(pending()))
      .toEqual({ kind: 'saved', pageUrl: `${HOST}/node/23110`, nodeId: '23110' });
    expect(outcomeOfTimeout(pendingNew())).toEqual({ kind: 'noAddress' });
  });
});

test.describe('the before a form first opened with', () => {
  const OPENED = (before: PageState | null, url = FORM, formPath = '/node/23110/edit') =>
    ({ kind: 'opened' as const, url, formPath, before, raw: null });

  test('failed save keeps the original before', () => {
    const original = state('Original');
    const attempted = state('Attempt one');

    let opened = nextOpenedForm(undefined, OPENED(original));
    const first = mergeCarriedBefore(opened, pending({}, { before: original, after: attempted }));
    expect(first.payload.before).toEqual(original);

    // Drupal re-renders the form at the same address with the submitted values in it...
    expect(outcomeOfNavigation(first, FORM)).toEqual({ kind: 'failed' });
    opened = nextOpenedForm(opened, { kind: 'navigated', url: FORM });
    // ...so the content script on the re-render reads them as its before.
    opened = nextOpenedForm(opened, OPENED(attempted));

    const second = mergeCarriedBefore(opened, pending({}, { before: attempted, after: state('Attempt two') }));
    expect(second.payload.before).toEqual(original);
    expect(second.payload.after.title).toBe('Attempt two');
  });

  test('preview keeps the original before', () => {
    const original = state('Original');
    const previewed = state('Previewed', { meta_description: 'Previewed description.' });

    let opened = nextOpenedForm(undefined, OPENED(original));
    // Preview re-renders the same edit path with the values being previewed.
    opened = nextOpenedForm(opened, { kind: 'navigated', url: FORM });
    opened = nextOpenedForm(opened, OPENED(previewed));

    const saved = mergeCarriedBefore(opened, pending({}, { before: previewed }));
    expect(saved.payload.before).toEqual(original);
  });

  test('leaving the form, a different form, or a save that went through starts afresh', () => {
    const original = state('Original');
    const opened = nextOpenedForm(undefined, OPENED(original)) as OpenedForm;

    expect(nextOpenedForm(opened, { kind: 'navigated', url: `${HOST}/news/foo` })).toBeUndefined();
    expect(nextOpenedForm(opened, { kind: 'navigated', url: `${HOST}/admin/content` })).toBeUndefined();
    expect(nextOpenedForm(opened, { kind: 'saved' })).toBeUndefined();

    const other = state('Other page');
    expect(nextOpenedForm(opened, OPENED(other, `${HOST}/node/5/edit`, '/node/5/edit'))?.before).toEqual(other);
  });

  test('a detour to log in, here or on another site, keeps the original before', () => {
    // Save landed on the login page because Drupal's session had expired. The person logs in
    // and is sent back to the form, and the page in Drupal is still the original.
    const original = state('Original');
    let opened = nextOpenedForm(undefined, OPENED(original));
    for (const url of [`${HOST}/user/login?destination=node/23110/edit`, 'https://cas.columbia.edu/cas/login',
      `${HOST}/user`, FORM]) {
      opened = nextOpenedForm(opened, { kind: 'navigated', url });
      expect(opened?.before, url).toEqual(original);
    }
    opened = nextOpenedForm(opened, OPENED(state('Back from logging in')));
    expect(mergeCarriedBefore(opened, pending({}, { before: state('Back from logging in') })).payload.before).toEqual(original);
  });

  test('a save from some other form keeps its own before', () => {
    const opened = nextOpenedForm(undefined, OPENED(state('Original'), `${HOST}/node/5/edit`, '/node/5/edit'));
    const mine = state('Mine');
    expect(mergeCarriedBefore(opened, pending({}, { before: mine })).payload.before).toEqual(mine);
    expect(mergeCarriedBefore(undefined, pending({}, { before: mine })).payload.before).toEqual(mine);
  });

  test('a new page keeps a before of null', () => {
    const opened = nextOpenedForm(undefined, OPENED(null, `${HOST}/node/add/news`, '/node/add/news'));
    const merged = mergeCarriedBefore(opened, pendingNew());
    expect('before' in merged.payload).toBe(true);
    expect(merged.payload.before).toBeNull();
  });
});

test.describe('the request Varys is sent', () => {
  test('maps the message to the snake_case contract, before always present', () => {
    const p = pendingNew();
    const request = toSaveRequest(p.payload, `${HOST}/news/foo`, '24001');
    expect(request).toEqual({
      page_url: `${HOST}/news/foo`,
      node_id: '24001',
      content_type: 'list',
      button: 'publish',
      body_change_ratio: 0.1,
      before: null,
      after: p.payload.after,
      varys_filled: [],
    });
    expect(Object.keys(request)).toContain('before');
  });

  test('toSaveRequest carries varys_filled', () => {
    const payload = pending({}, { varysFilled: ['meta_title'] }).payload;
    expect(toSaveRequest(payload, HOST, null).varys_filled).toEqual(['meta_title']);
    const two = pending({}, { varysFilled: ['headings', 'title'] }).payload;
    expect(toSaveRequest(two, HOST, null).varys_filled).toEqual(['headings', 'title']);
  });

  test('the summary rides inside the before and after, as they are', () => {
    const p = pending({}, { before: state('Before', { summary: 'Old.' }), after: state('After', { summary: 'New.' }) });
    const request = toSaveRequest(p.payload, HOST, null);
    expect(request.before?.summary).toBe('Old.');
    expect(request.after.summary).toBe('New.');
  });

  test('a ratio outside 0..1, or not a number, never reaches Varys', () => {
    const at = (r: number) => toSaveRequest(pending({}, { bodyChangeRatio: r }).payload, HOST, null).body_change_ratio;
    expect(at(1.0000001)).toBe(1);
    expect(at(-0.1)).toBe(0);
    expect(at(Number.NaN)).toBe(0);
  });
});

test.describe('what a failed request means', () => {
  test('a queued save that Varys refuses for itself does not hold up the rest', () => {
    for (const status of [200, 201, 204]) expect(queueVerdict(status), String(status)).toBe('sent');
    // Malformed: this extension's bug, and it would fail the same way for ever.
    expect(queueVerdict(422)).toBe('dropped');
    // Refused for a reason of its own (it is gone, or not this person's): kept, and the next is tried.
    for (const status of [400, 403, 404, 409, 429]) expect(queueVerdict(status), String(status)).toBe('kept');
    // Varys is away or the key is dead: nothing after this one can go either.
    for (const status of [null, 401, 500, 502, 503]) expect(queueVerdict(status), String(status)).toBe('stop');
  });

  test('401 is an expired key, 422 a malformed request, and anything else is worth retrying', () => {
    expect(failureOf(401)).toBe('expired');
    expect(failureOf(422)).toBe('malformed');
    for (const status of [null, 400, 403, 404, 429, 500, 502, 503]) expect(failureOf(status), String(status)).toBe('retry');
  });

  test('with an expired key, the cached site list alone says a site is untracked', () => {
    /**
     * An expired key cannot ask Varys which sites it tracks. A save on a site it does not
     * track used to be queued and the editor told to reconnect, and then the flush dropped it
     * without a word. The list Varys last gave this person, at any age, is enough to say so
     * now; with no list for this person the save is queued as before.
     */
    const email = 'a@cumc.columbia.edu';
    const cache = { email, sites: ['nursing.columbia.edu'], fetchedAt: 1_000 };
    expect(knownUntracked(`${HOST}/news/foo`, cache, email)).toBe(true);
    expect(knownUntracked('https://www.nursing.columbia.edu/x', cache, email)).toBe(false);
    // No list, or one fetched for someone else: not known, so queued.
    expect(knownUntracked(`${HOST}/news/foo`, undefined, email)).toBe(false);
    expect(knownUntracked(`${HOST}/news/foo`, { ...cache, email: 'b@cumc.columbia.edu' }, email)).toBe(false);
    // An empty list is a list: Varys tracks nothing for this person.
    expect(knownUntracked(`${HOST}/news/foo`, { ...cache, sites: [] }, email)).toBe(true);
  });

  test('a site is tracked by its bare host', () => {
    const sites = ['cuimc.columbia.edu', 'vagelos.columbia.edu'];
    expect(isTrackedSite(`${HOST}/news/foo`, sites)).toBe(true);
    expect(isTrackedSite('https://CUIMC.columbia.edu/x', sites)).toBe(true);
    expect(isTrackedSite('https://www.nursing.columbia.edu/x', sites)).toBe(false);
    expect(isTrackedSite('not a url', sites)).toBe(false);
  });
});

test.describe('the notice', () => {
  test('a counted save offers Undo and an uncounted one Log it anyway, in Varys\'s words', () => {
    expect(noticeForResult({ save_id: 41, outcome: 'logged', message: 'Logged in Varys as a headings change.' }))
      .toEqual({ message: 'Logged in Varys as a headings change.', action: { label: 'Undo', type: 'varysUndo', saveId: 41 } });
    expect(noticeForResult({ save_id: 42, outcome: 'not_logged', message: 'Not logged.' }))
      .toEqual({ message: 'Not logged.', action: { label: 'Log it anyway', type: 'varysLogAnyway', saveId: 42 } });
    expect(noticeForResult({ save_id: null, outcome: 'untracked_site', message: 'Not a Varys site.' }))
      .toEqual({ message: 'Not a Varys site.' });
  });

  test('no message means no notice', () => {
    expect(noticeForResult({ save_id: 41, outcome: 'logged' })).toBeNull();
    expect(noticeForResult({ save_id: 41, outcome: 'logged', message: ' ' })).toBeNull();
    expect(noticeForResult(null)).toBeNull();
    expect(noticeForResult('Logged')).toBeNull();
  });

  test('the extension\'s own copy is the copy that was agreed', () => {
    expect(UNTRACKED_COPY).toBe("This site isn't in Varys, so nothing was logged.");
    expect(UNREACHABLE_COPY).toBe("Varys couldn't be reached. This save will be sent when it can.");
    expect(EXPIRED_COPY).toBe('Your Varys connection has expired. Reconnect from the extension menu to log this save.');
  });

  test('a stored notice is shown once, on the same site, while it is fresh', () => {
    const stored = { host: 'www.cuimc.columbia.edu', notice: { message: 'Logged.' }, storedAt: 1_000 };
    expect(storedNoticeFor(stored, 'cuimc.columbia.edu', 2_000)).toEqual({ message: 'Logged.' });
    expect(storedNoticeFor(stored, 'www.nursing.columbia.edu', 2_000)).toBeNull();
    expect(storedNoticeFor(stored, 'www.cuimc.columbia.edu', 1_000 + 60 * 60 * 1000 + 1)).toBeNull();
    expect(storedNoticeFor(undefined, 'www.cuimc.columbia.edu', 2_000)).toBeNull();
    expect(storedNoticeFor({ host: 'www.cuimc.columbia.edu', storedAt: 1_000 }, 'www.cuimc.columbia.edu', 2_000)).toBeNull();
  });
});

test.describe('pruneQueue', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = 100 * DAY;
  const entry = (queuedAt: number, page = 'a'): QueuedSave => ({
    request: toSaveRequest(pending().payload, `${HOST}/${page}`, null),
    queuedAt,
    email: 'x@cumc.columbia.edu',
  });

  test('drops an 8-day-old entry and caps the queue at 50', () => {
    expect(pruneQueue([entry(NOW - 8 * DAY), entry(NOW - DAY)], NOW)).toEqual([entry(NOW - DAY)]);

    const many = Array.from({ length: 60 }, (_, i) => entry(NOW - (60 - i) * 1000, `p${i}`));
    const kept = pruneQueue(many, NOW);
    expect(kept).toHaveLength(QUEUE_MAX_ENTRIES);
    // The newest fifty, oldest first, which is the order they are sent in.
    expect(kept[0].request.page_url).toBe(`${HOST}/p10`);
    expect(kept[49].request.page_url).toBe(`${HOST}/p59`);
  });

  test('keeps the oldest first, and drops anything that is not a queued save', () => {
    const later = entry(NOW - 1000, 'later');
    const earlier = entry(NOW - 2000, 'earlier');
    expect(pruneQueue([later, { junk: true }, null, earlier], NOW)).toEqual([earlier, later]);
    expect(pruneQueue(undefined, NOW)).toEqual([]);
    expect(pruneQueue({ not: 'a list' }, NOW)).toEqual([]);
  });
});
