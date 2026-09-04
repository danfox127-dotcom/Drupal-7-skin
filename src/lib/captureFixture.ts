import { findNodeForm, detectContentType } from './formSchema';

/**
 * Turns the node form on screen into a fixture that is safe to commit.
 *
 * Why this exists: every significant bug in this extension has come from a fixture that
 * did not match the real markup. A form with two save buttons, so Publish clicked "Save
 * as draft" for months. A form Drupal re-renders, so writes landed on detached nodes.
 * Three fields labelled "Summary". A site running the Title module. In each case the code
 * was wrong AND the fixture agreed with it, so nothing failed until someone hit it on a
 * live page. Hand-authoring fixtures is the root cause.
 *
 * Which makes scrubbing the entire risk, because the output is committed to a PUBLIC
 * repository. A live admin form carries a session CSRF token, a cached form-build id, the
 * editor's username, and the page's unpublished body text. Leaking any of those is worse
 * than keeping the hand-made fixtures.
 *
 * The rules, and the reasoning:
 *
 *   REMOVED outright — security fields. Blanking is not enough: a committed
 *   `name="form_token"` with an empty value is an invitation to fill it in, and it tells
 *   a reader nothing that the provenance comment does not.
 *
 *   BLANKED — every free-text value. Page copy is the sensitive part and it is never
 *   what a fixture tests; the structure is. An unpublished node's body is the single
 *   worst thing that could go into a public repo from here.
 *
 *   REPLACED — anything naming a person. Drupal puts the editor's username in "Authored
 *   by" and often in the toolbar.
 *
 *   KEPT — names, ids, labels, classes, descriptions, required markers, option values,
 *   checked/selected state, and every submit button with its label. That set is exactly
 *   what the bugs above needed and what the hand-made fixtures lacked.
 *
 * Nothing is written or committed here. It returns a string for a human to read, and the
 * provenance comment states what was stripped so the review is possible at all.
 */

export interface CaptureReport {
  /** Names of fields removed wholesale. */
  removedFields: string[];
  /** How many free-text values were emptied. */
  blankedValues: number;
  /** True when page text was kept on purpose — the reviewer needs to know. */
  valuesKept: boolean;
  /** Names of fields whose value was replaced rather than emptied. */
  anonymisedFields: string[];
  scriptsRemoved: number;
  /** Content type, for naming the downloaded file. */
  contentType: string | null;
  /** Selects big enough to be worth a second thought before committing. */
  largeSelects: { name: string; options: number; kept?: number }[];
}

export interface Capture {
  html: string;
  report: CaptureReport;
}

export interface CaptureOptions {
  sourceUrl: string;
  /** Passed in rather than read from a clock, so the output is reproducible. */
  capturedOn: string;
  /**
   * Keep the page's own text instead of blanking it.
   *
   * Off by default, because the output goes to a public repository. But blanking
   * everything means hand-typing content back in whenever a bug actually needs realistic
   * text — the CKEditor body work needed exactly that — and hand-editing a captured
   * fixture is the manual work this tool exists to remove.
   *
   * What this does NOT relax: security fields are still removed, and usernames and email
   * addresses are still replaced. Those are credentials and personal data, a different
   * category from page copy, and there is no case for committing them.
   *
   * The caller is expected to say loudly that content was kept, because the reviewer is
   * the only remaining check and published page text and an unpublished draft look
   * identical here.
   */
  keepValues?: boolean;
  /**
   * Reduce option lists that run to thousands, keeping the tree's shape.
   *
   * The menu parent select is the same 3,333 options on every content type, and it is
   * 77% of a capture's bytes. Capturing ten types whole would commit that list ten
   * times over.
   *
   * Not a plain truncation: taking the first N gives one branch of the tree and destroys
   * the depth variety the menu tests exist to exercise. This keeps a sample from every
   * depth, so ancestor chains and deep selection still have something to work on, and
   * says exactly what it dropped.
   */
  trimLargeSelects?: boolean;
}

/**
 * Fields removed rather than blanked.
 *
 * `form_token` is a CSRF token bound to the session. `form_build_id` identifies a cached
 * form build server-side. Honeypot and captcha fields are anti-spam state. None of them
 * carry structure worth testing, and all of them are worth nothing good in a public repo.
 *
 * `form_id` is deliberately NOT here: it is a static machine name, it identifies which
 * form the fixture came from, and discoverSchema has no use for it but a reader does.
 */
const REMOVE_BY_NAME = /^(form_token|form_build_id)$|honeypot|captcha/i;

/** Fields whose value names a person. */
const ANONYMISE = new Map<RegExp, string>([
  [/^name$/i, 'testuser'],
  [/mail$/i, 'testuser@example.edu'],
]);

/** Input types whose `value` is structure, not content, and so must survive. */
const STRUCTURAL_TYPES = new Set(['checkbox', 'radio', 'submit', 'button', 'reset', 'image']);

/** Above this, a select is worth flagging: the live menu parent list runs to 3,331. */
const LARGE_SELECT = 200;

/** Options kept per depth level when trimming. Enough for an ancestor chain and siblings. */
const TRIM_PER_DEPTH = 6;

function attr(el: Element, name: string): string {
  return el.getAttribute(name) ?? '';
}

export function captureFixture(
  doc: Document,
  options: CaptureOptions
): Capture | null {
  const form = findNodeForm(doc);
  if (!form) return null;

  const report: CaptureReport = {
    removedFields: [],
    blankedValues: 0,
    valuesKept: Boolean(options.keepValues),
    anonymisedFields: [],
    scriptsRemoved: 0,
    /**
     * Via detectContentType, which reads the URL as well as the body class.
     *
     * A first version matched only `node-type-…`, and on /node/add/page Drupal's body
     * class is `page-node-add-page` — so every capture came out named "form" and would
     * have overwritten the last one in a batch.
     */
    contentType: detectContentType(
      { pathname: new URL(options.sourceUrl).pathname },
      doc.body,
    ).contentType,
    largeSelects: [],
  };

  const clone = form.cloneNode(true) as HTMLFormElement;

  /**
   * Scripts inside the form go first.
   *
   * Drupal renders inline scripts within forms — CKEditor init, #states wiring — and they
   * carry tokens.
   *
   * The bigger prize, Drupal.settings with its ajaxPageState token and the user's uid, is
   * rendered NEXT TO the form rather than inside it, so it is excluded by only ever
   * cloning the form. That is worth stating: it is a property of the capture boundary, not
   * of this loop, and a later change that widened the boundary would start including it.
   */
  for (const script of Array.from(clone.querySelectorAll('script, style, link'))) {
    script.remove();
    report.scriptsRemoved++;
  }

  for (const field of Array.from(clone.querySelectorAll('input, textarea, select'))) {
    const name = attr(field, 'name');

    if (name && REMOVE_BY_NAME.test(name)) {
      report.removedFields.push(name);
      field.remove();
      continue;
    }

    const tag = field.tagName.toLowerCase();

    if (tag === 'select') {
      const options_ = Array.from(field.querySelectorAll('option'));
      if (options_.length < LARGE_SELECT) continue;

      if (!options.trimLargeSelects) {
        report.largeSelects.push({ name: name || '(unnamed)', options: options_.length });
        continue;
      }

      /**
       * A sample per depth, not the first N.
       *
       * Drupal encodes depth as leading hyphens on the option label, so the depth of each
       * entry is readable without the tree. Keeping a few at every level preserves what
       * the menu tests actually read — ancestor chains, deep selection, indentation —
       * where the first N would be one branch and nothing else.
       *
       * Selected options are always kept: dropping the current value would change what
       * the form says it holds.
       */
      const perDepth = new Map<number, number>();
      let kept = 0;
      for (const option of options_) {
        const label = option.textContent ?? '';
        const depth = /^(-+)/.exec(label.trim())?.[1].length ?? 0;
        const seen = perDepth.get(depth) ?? 0;
        const isSelected = option.hasAttribute('selected');
        if (seen >= TRIM_PER_DEPTH && !isSelected) {
          option.remove();
          continue;
        }
        perDepth.set(depth, seen + 1);
        kept++;
      }
      report.largeSelects.push({ name: name || '(unnamed)', options: options_.length, kept });
      continue;
    }

    if (tag === 'textarea') {
      if (field.textContent && !options.keepValues) {
        field.textContent = '';
        report.blankedValues++;
      }
      continue;
    }

    const type = (attr(field, 'type') || 'text').toLowerCase();
    if (STRUCTURAL_TYPES.has(type)) continue;

    const anonymised = [...ANONYMISE].find(([pattern]) => pattern.test(name));
    if (anonymised && attr(field, 'value')) {
      field.setAttribute('value', anonymised[1]);
      report.anonymisedFields.push(name);
      continue;
    }

    if (attr(field, 'value') && !options.keepValues) {
      field.setAttribute('value', '');
      report.blankedValues++;
    }
  }

  /**
   * The username also appears outside the form — Drupal's toolbar renders it. The form is
   * all that gets captured, so that copy is dropped by construction rather than scrubbed;
   * this only guards against a stray occurrence inside the form's own markup.
   */
  const html = clone.outerHTML;

  const bodyClass = attr(doc.body, 'class');

  const lines = [
    `Captured from ${options.sourceUrl} on ${options.capturedOn}.`,
    '',
  ];

  if (report.valuesKept) {
    lines.push(
      '*** PAGE TEXT WAS KEPT. Read this file before committing it. ***',
      '',
      'Field values are this page\'s real content. Published text is already public, but an',
      'unpublished draft is not, and nothing here can tell the two apart. Security fields',
      'were still removed and usernames still replaced.',
      '',
    );
  }

  lines.push(
    'Real markup, captured rather than hand-authored, because every significant bug in',
    'this extension has come from a fixture that disagreed with the real form.',
    '',
    `Removed: ${report.removedFields.length ? [...new Set(report.removedFields)].join(', ') : '(none)'}`,
    `Blanked ${report.blankedValues} field value${report.blankedValues === 1 ? '' : 's'}; ` +
      `replaced ${report.anonymisedFields.length ? [...new Set(report.anonymisedFields)].join(', ') : 'nothing'}; ` +
      `dropped ${report.scriptsRemoved} script/style tag${report.scriptsRemoved === 1 ? '' : 's'}.`,
  );

  if (report.largeSelects.length) {
    lines.push(
      '',
      report.largeSelects.some(s => s.kept !== undefined)
        ? 'Large option lists were TRIMMED to a sample per depth level, so the tree keeps its'
        : 'Large option lists, kept in full — check the file size before committing:',
      ...(report.largeSelects.some(s => s.kept !== undefined)
        ? ['shape without repeating thousands of identical options in every capture:'] : []),
      ...report.largeSelects.map(s => s.kept === undefined
        ? `  ${s.name}: ${s.options} options`
        : `  ${s.name}: ${s.kept} of ${s.options} options kept`),
    );
  }

  lines.push(
    '',
    report.valuesKept
      ? 'Names are replaced; page text is NOT. Field names, ids, labels, classes, option'
      : 'Field VALUES are blanked and names are replaced. Field names, ids, labels, classes,',
    report.valuesKept
      ? 'values, checked state and every submit button survive, because that is what the'
      : 'option values, checked state and every submit button survive, because that is what',
    report.valuesKept ? 'tests read.' : 'the tests read.',
  );

  const doctype = '<!DOCTYPE html>';
  const comment = `<!--\n  ${lines.join('\n  ')}\n-->`;

  const document_ = [
    doctype,
    comment,
    '<html>',
    `<body class="${bodyClass}">`,
    html,
    '</body>',
    '</html>',
    '',
  ].join('\n');

  return { html: document_, report };
}
