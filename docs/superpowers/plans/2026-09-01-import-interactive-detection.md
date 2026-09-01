# Interactive-Content Detection for the Importer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the HTML importer report interactive content it strips, instead of silently dropping it and producing a plausible-looking node that is missing the page's whole purpose.

**Architecture:** One new pure module, `src/lib/import/interactive.ts`, inspects the parsed source document and returns `Unmapped[]` entries. `extract()` appends them to its existing fixed list. A secondary change adds `formsRemoved`/`scriptsRemoved` to `BodyStats`. Nothing about what gets imported changes.

**Tech Stack:** TypeScript, DOM APIs (`DOMParser`, `compareDocumentPosition`), Playwright test runner, esbuild for test bundling.

**Spec:** `docs/superpowers/specs/2026-09-01-import-interactive-detection-design.md`

## Global Constraints

- **No behavioural change to imported content.** Proposals, images, and body HTML must be byte-identical before and after this work. Only `unmapped` and `bodyStats` change.
- **Detection must be silent on ordinary pages.** A page with no content-bearing form and no `<noscript>` must produce zero findings.
- **A form is content-bearing only with ≥2 controls** whose type is not `submit`, `button`, `reset`, `image`, `search`, or `hidden`, and which is not inside `nav`, `header`, `footer`, `aside`, or `[role="search"]`.
- **Scripts never trigger a finding.** They are only attributed as dependencies once a form or `<noscript>` trigger has already fired.
- **One entry per page.** A page firing both rules produces one `Unmapped`, not two.
- **Same-origin means same origin as `sourceUrl`.**
- **Every test must fail before its implementation exists.** Run it and see the failure. Do not skip the red step.
- `import type { Unmapped } from './extract'` — type-only, so the extract↔interactive cycle is erased at compile time and there is no runtime circular import.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/import/interactive.ts` (create) | Detect interactive regions; describe them as `Unmapped[]`. Pure, no I/O. |
| `src/lib/import/extract.ts` (modify) | Rename `UNMAPPED`→`ALWAYS_UNMAPPED`; append `findInteractive()`; add two `BodyStats` counters. |
| `tests/import-extract.spec.ts` (modify) | Add `sourceUrl` parameter to `run()`; add two fixtures; add five tests. |

**Correction (found during Task 1).** The claim originally here — that no existing test
asserts on `unmapped` — was wrong, and wrong for an instructive reason: the file contained a
raw NUL byte (a deliberate `'java<NUL>script:alert(1)'` security payload), which made grep
treat it as binary and silently return no matches. The byte has since been re-encoded as
`\u0000`.

What is actually there:

- `tests/import-extract.spec.ts:408` asserts
  `expect(r.unmapped.map(u => u.label)).toEqual(['Topics', 'Related Content', 'Menu Placement', 'Groups'])`
  against the default `SOURCE`. This is an **exact** match, so it already fails if any
  finding is added to an ordinary article — a stricter guard than the
  `toHaveLength(4)` test Task 2 planned to add. Task 2's duplicate is therefore dropped.
- `tests/import-extract.spec.ts:418` asserts `summary.total === proposals.length + unmapped.length`,
  which holds regardless.

Both pass unchanged, because `SOURCE` has no form and no `<noscript>`.

---

## Task 1: Detect a form-anchored calculator and name its scripts

**Files:**
- Create: `src/lib/import/interactive.ts`
- Modify: `src/lib/import/extract.ts` (rename `UNMAPPED` at line ~326; wire into the return at line ~487)
- Test: `tests/import-extract.spec.ts`

**Interfaces:**
- Consumes: `Unmapped` (type) from `./extract`
- Produces: `findInteractive(doc: Document, sourceUrl: string): Unmapped[]`

- [ ] **Step 1: Add the calculator fixture and a sourceUrl parameter to the test harness**

The existing `run()` hardcodes a heartresearchtoday.org URL. Same-origin script attribution cannot be tested without control over it.

In `tests/import-extract.spec.ts`, change the `run()` signature and its `page.evaluate` call:

```ts
async function run(
  page: import('@playwright/test').Page,
  html = SOURCE,
  allowed: { tags: string[]; source: 'drupal-filter-tips' | 'default' } = { tags: [], source: 'default' },
  sourceUrl = 'https://heartresearchtoday.org/news/ablation-five-year-outcomes'
) {
  await page.goto('data:text/html,<body>host</body>');
  await page.addScriptTag({ content: bundle });
  return page.evaluate(([h, a, u]) => {
    const api = (window as any).Extract;
    const result = api.extract(h, u, a);
    return {
      proposals: result.proposals,
      images: result.images,
      unmapped: result.unmapped,
      bodyStats: result.bodyStats,
      allowedTags: result.allowedTags,
      annotatedHtml: result.annotatedHtml,
      summary: api.matchSummary(result),
      accepted: api.acceptedCount(result.proposals),
    };
  }, [html, allowed, sourceUrl] as const);
}
```

Then add this fixture below `SOURCE`. It is trimmed from the real page at
`https://columbiamedicine.org/divisions/gharavi/calculators/calc_progression.php` — real
markup, not an approximation. Note the `<h2>` inside `<noscript>`, which is a trap for the
label heuristic, and the three `<script>` tags at end of body, outside any article container.

```ts
const CALCULATOR = `<!DOCTYPE html>
<html><head>
  <title>Gharavi Lab</title>
  <link rel="stylesheet" href="common/style.css">
</head><body>
  <div class="main nosidenav">
    <h1 class="noline">IgA Nephropathy Progression Calculator</h1>
    <noscript><h2 style="color:red">This calculator requires Javascript.  Please enable Javascript to continue.</h2></noscript>
    <p><em>Krzysztof Kiryluk, MD, MS and David A. Fasel</em></p>
    <p>This risk score is based on the analysis of 619 biopsy-diagnosed Chinese patients with IgA nephropathy followed for an average of 41.3 months from the time of diagnosis.</p>
    <form name="form" autocomplete="off">
      <table>
        <tr><td>Glomerular Filtration Rate:</td><td><input type="text" id="inputEGFR" placeholder="15 - 150"> ml/min/1.73m</td></tr>
        <tr><td>Hemoglobin:</td><td><input type="text" id="inputHb" placeholder="5 - 18"> g/dL</td></tr>
        <tr><td>Serum Albumin:</td><td><input type="text" id="inputserumAlbumin" placeholder="0.0 - 6.0" data-decimals="1"> g/dL</td></tr>
        <tr><td>Systolic Blood Pressure:</td><td><input type="text" id="inputSBP" placeholder="80 - 250"> mm Hg</td></tr>
      </table>
      <p><input id="btnCalc" type="button" class="btn" value="Calculate">
      <input type="button" value="Reset" onClick="ResetForm()" class="btn reset"></p>
    </form>
    <p class="legalText"><strong>Interpretation:</strong></p>
    <table border="0" class="CKDTable">
      <tr><th scope="col">Risk Group</th><th scope="col">Risk Score</th><th scope="col">Explanation</th></tr>
      <tr><td>Low</td><td>&lt; -0.887</td><td>First tertile of the risk score distribution. Patients in this risk group may require dialysis or kidney transplantation within 20.5 years of diagnosis on average.</td></tr>
      <tr><td>High</td><td>&gt; 0.993</td><td>Third tertile of the risk score distribution. Patients in this risk group may require dialysis or kidney transplantation within 5.4 years of diagnosis on average.</td></tr>
    </table>
    <ol class="legalText reference">
      <li>Jingyuan Xie, Krzysztof Kiryluk, et al: <a href="http://www.ncbi.nlm.nih.gov/pubmed/22719981">Predicting Progression of IgA Nephropathy: New Clinical Progression Risk Score.</a> PLoS One 2012;7(6):e38904</li>
    </ol>
  </div>
  <div class="footer"><p>&copy; 2026 Columbia University</p></div>
  <script src="//ajax.googleapis.com/ajax/libs/jquery/1.7.2/jquery.min.js" type="text/javascript"></script>
  <script src="common/global.js" type="text/javascript"></script>
  <script src="common/calc_progression.js" type="text/javascript"></script>
</body></html>`;

const CALC_URL = 'https://columbiamedicine.org/divisions/gharavi/calculators/calc_progression.php';
```

- [ ] **Step 2: Write the failing test**

Add a new `test.describe` block at the end of `tests/import-extract.spec.ts`:

```ts
test.describe('interactive content', () => {
  test('names the calculator and the scripts that drive it', async ({ page }) => {
    const r = await run(page, CALCULATOR, { tags: [], source: 'default' }, CALC_URL);
    const finding = r.unmapped.find(u => /interactive/i.test(u.label));

    expect(finding, 'a calculator page must produce an interactive finding').toBeTruthy();
    // The label must come from the h1, NOT the <h2> inside <noscript>.
    expect(finding!.label).toContain('IgA Nephropathy Progression Calculator');
    expect(finding!.label).not.toMatch(/requires Javascript/i);
    expect(finding!.reason).toContain('4 text inputs');
    // Same-origin scripts are attributed; the googleapis jQuery is not.
    expect(finding!.reason).toContain('calc_progression.js');
    expect(finding!.reason).toContain('global.js');
    expect(finding!.reason).not.toContain('jquery');
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `npx playwright test tests/import-extract.spec.ts -g "names the calculator" --workers=1`

Expected: FAIL — `a calculator page must produce an interactive finding` — `finding` is `undefined`, because `unmapped` is still the four fixed entries.

- [ ] **Step 4: Create `src/lib/import/interactive.ts`**

Note `isContentForm` accepts a **single** control at this stage. Task 2 tightens it to two, driven by its own failing test. Do not pre-empt that here.

```ts
/**
 * Reports interactive content the importer strips but cannot carry.
 *
 * `NOISE_SELECTORS` in extract.ts removes `form` and `script` wholesale, and nothing
 * counted or named the loss. A legacy calculator page therefore imported as clean prose
 * with its entire reason for existing missing, and the review said nothing.
 *
 * This does not attempt to port anything. It names what was dropped, which is the same
 * contract as the rest of the "Left for you" panel.
 */

import type { Unmapped } from './extract';

/** Containers whose forms are navigation furniture, not page content. */
const CHROME = 'nav, header, footer, aside, [role="search"]';

/** Control types that carry no data: buttons, and search boxes we deliberately ignore. */
const INERT_TYPES = new Set(['submit', 'button', 'reset', 'image', 'search', 'hidden']);

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

function contentControls(form: Element): Element[] {
  return Array.from(form.querySelectorAll('input, select, textarea')).filter(control => {
    if (control.tagName.toLowerCase() !== 'input') return true;
    const type = (control.getAttribute('type') ?? 'text').toLowerCase();
    return !INERT_TYPES.has(type);
  });
}

function isContentForm(form: Element): boolean {
  if (form.closest(CHROME)) return false;
  return contentControls(form).length >= 1;
}

/**
 * Scripts sharing an origin with the source page.
 *
 * Origin, not position: both calculators load their logic from the end of <body>, outside
 * any article container, so location tells us nothing. A protocol-relative CDN URL such as
 * `//ajax.googleapis.com/...` resolves against the source's scheme and lands on a different
 * origin, which is how third-party libraries stay out of this list.
 */
function firstPartyScripts(doc: Document, sourceUrl: string): string[] {
  let base: URL;
  try { base = new URL(sourceUrl); } catch { return []; }

  const found: string[] = [];
  for (const script of Array.from(doc.querySelectorAll('script[src]'))) {
    const raw = norm(script.getAttribute('src'));
    if (!raw) continue;
    try {
      if (new URL(raw, base).origin !== base.origin) continue;
    } catch { continue; }
    found.push(raw);
  }
  return [...new Set(found)];
}

/**
 * The nearest heading before the element, for naming the finding.
 *
 * Headings inside <noscript> are excluded deliberately: both calculator pages open with
 * `<noscript><h2>This calculator requires Javascript.</h2></noscript>`, which sits between
 * the h1 and the form and would otherwise win.
 */
function headingFor(el: Element, doc: Document): string {
  const headings = Array.from(doc.querySelectorAll('h1, h2, h3'))
    .filter(h => !h.closest('noscript'));

  let best = '';
  for (const heading of headings) {
    if (el.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_PRECEDING) {
      best = norm(heading.textContent);
    }
  }
  return best
    || norm(doc.querySelector('h1:not(noscript h1)')?.textContent)
    || norm(doc.title)
    || 'this page';
}

/** "A form with 4 text inputs, 1 dropdown" — what the editor would have seen. */
function describeForm(form: Element): string {
  const texts = contentControls(form).filter(
    c => c.tagName.toLowerCase() === 'input' && (c.getAttribute('type') ?? 'text').toLowerCase() === 'text'
  ).length;
  const selects = form.querySelectorAll('select').length;
  const radioGroups = new Set(
    Array.from(form.querySelectorAll('input[type="radio"]')).map(r => r.getAttribute('name'))
  ).size;

  const parts = [
    texts ? `${texts} text input${texts === 1 ? '' : 's'}` : null,
    selects ? `${selects} dropdown${selects === 1 ? '' : 's'}` : null,
    radioGroups ? `${radioGroups} option group${radioGroups === 1 ? '' : 's'}` : null,
  ].filter(Boolean);

  return parts.length ? `A form with ${parts.join(', ')}` : 'A form';
}

export function findInteractive(doc: Document, sourceUrl: string): Unmapped[] {
  const form = Array.from(doc.querySelectorAll('form')).find(isContentForm) ?? null;
  if (!form) return [];

  const scripts = firstPartyScripts(doc, sourceUrl);
  const driven = scripts.length
    ? ` driven by ${scripts.join(' and ')}`
    : '';

  return [{
    label: `Interactive content — “${headingFor(form, doc)}”`,
    reason: `${describeForm(form)}${driven}. Forms and scripts cannot live in a node body; `
      + `this needs a Full HTML block or a module.`,
  }];
}
```

- [ ] **Step 5: Wire it into `extract()`**

In `src/lib/import/extract.ts`, add the import at the top of the file:

```ts
import { findInteractive } from './interactive';
```

Rename the constant at line ~326 from `UNMAPPED` to `ALWAYS_UNMAPPED`, keeping its comment, and update its declaration line:

```ts
/** Fields the extractor deliberately does not guess, and why. */
const ALWAYS_UNMAPPED: Unmapped[] = [
```

Then change the return value at line ~487 from `unmapped: UNMAPPED,` to:

```ts
    unmapped: [...ALWAYS_UNMAPPED, ...findInteractive(doc, sourceUrl)],
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `npx playwright test tests/import-extract.spec.ts -g "names the calculator" --workers=1`
Expected: PASS

- [ ] **Step 7: Run the whole import suite for regressions**

Run: `npx playwright test tests/import-extract.spec.ts --workers=1`
Expected: all pass. If anything fails, it means an existing test did depend on `unmapped` — stop and report rather than editing the old test.

- [ ] **Step 8: Commit**

```bash
git add src/lib/import/interactive.ts src/lib/import/extract.ts tests/import-extract.spec.ts
git commit -m "feat: name the interactive content the importer cannot carry

A legacy calculator page imported as clean prose with the calculator
silently gone. NOISE_SELECTORS drops form and script wholesale, and
UNMAPPED was a fixed constant that never mentioned it."
```

---

## Task 2: Stop the rule firing on site search boxes

**Files:**
- Modify: `src/lib/import/interactive.ts` (`isContentForm`)
- Test: `tests/import-extract.spec.ts`

**Interfaces:**
- Consumes: `findInteractive` from Task 1
- Produces: no signature change

This is the test that keeps the feature usable. A finding on every page is worse than no finding at all, because it trains the reader to skip the panel.

- [ ] **Step 1: Add the search-box fixture**

Drupal's search block renders `type="text"`, not `type="search"` — which is exactly why the type list alone is not enough. This fixture reproduces it faithfully, and deliberately places it in a `<div id="header">` rather than a `<header>` element, so the element-name chrome exclusion does **not** save us.

```ts
const SEARCHY = `<!DOCTYPE html>
<html><head><title>Department News | Example</title></head><body>
  <div id="header">
    <form action="/search" method="get" id="search-block-form">
      <input type="text" title="Enter the terms you wish to search for." class="form-text" id="edit-search-block-form--2" name="search_block_form" maxlength="128" />
      <input type="submit" id="edit-submit" value="Search" class="form-submit" />
    </form>
  </div>
  <article class="article">
    <h1>Department Names New Chief of Nephrology</h1>
    <p>The department announced this week that a new chief of nephrology will join in the fall, following a national search that began last year.</p>
    <p>The appointment follows an eighteen-month search process involving faculty from three affiliated hospitals and the medical school.</p>
    <p>A formal introduction is planned for the autumn faculty meeting, with clinical duties beginning shortly afterward.</p>
  </article>
</body></html>`;
```

- [ ] **Step 2: Write the failing test**

Add inside the `interactive content` describe block:

```ts
test('a site search box is not interactive content', async ({ page }) => {
  const r = await run(page, SEARCHY);
  const finding = r.unmapped.find(u => /interactive/i.test(u.label));
  expect(finding, 'a masthead search form must not be reported').toBeFalsy();
});
```

The "ordinary article produces no finding" case is already covered, exactly, by the existing
test at line 408 (`toEqual` on all four labels against `SOURCE`). Do not duplicate it.

- [ ] **Step 3: Run and confirm the first one fails**

Run: `npx playwright test tests/import-extract.spec.ts -g "site search box" --workers=1`

Expected: FAIL — `a masthead search form must not be reported`. Task 1's `isContentForm` accepts one control, and `input[type=text]` named `search_block_form` counts as one.

Also confirm `lists Topics, Related Content, Menu Placement and Groups with reasons` (line 408) still passes — `SOURCE` has no form, so no finding should be appended. A failure there means Task 1 leaked a finding onto ordinary pages.

- [ ] **Step 4: Raise the threshold to two controls**

In `src/lib/import/interactive.ts`, replace `isContentForm`:

```ts
/**
 * A form worth reporting.
 *
 * The ≥2 threshold is doing the real work, not the type list. Drupal's search block is
 * `<input type="text" name="search_block_form">` plus a submit — excluding `type="search"`
 * would not touch it, and it can sit in a `<div id="header">` that no element-name chrome
 * selector catches. What separates it from a calculator is that it asks one question.
 *
 * The cost is a genuine single-field calculator going unreported. Accepted: a rule that
 * fires on every page in the site would be ignored within a week, which is strictly worse
 * than a rule with a known gap.
 */
function isContentForm(form: Element): boolean {
  if (form.closest(CHROME)) return false;
  return contentControls(form).length >= 2;
}
```

- [ ] **Step 5: Run both tests and confirm they pass**

Run: `npx playwright test tests/import-extract.spec.ts -g "interactive content" --workers=1`
Expected: all three pass — the calculator still reports (4 controls), the search box does not.

- [ ] **Step 6: Verify the guard is real by reverting it**

Temporarily change `>= 2` back to `>= 1`, re-run, and confirm `a site search box is not interactive content` FAILS. Then restore `>= 2`. A test that passes either way is not a guard; this step is the only thing that proves it is.

- [ ] **Step 7: Commit**

```bash
git add src/lib/import/interactive.ts tests/import-extract.spec.ts
git commit -m "fix: require two controls before calling a form interactive

Drupal's search block is type=text, not type=search, so the type list
alone reported it. Field count is what separates a search box from a
calculator."
```

---

## Task 3: Fire on `<noscript>` when there is no form

**Files:**
- Modify: `src/lib/import/interactive.ts` (`findInteractive`)
- Test: `tests/import-extract.spec.ts`

**Interfaces:**
- Consumes: `findInteractive`, `headingFor`, `firstPartyScripts` from Task 1
- Produces: no signature change

A page that says "this requires JavaScript" is telling you outright that it is interactive. Near-zero false-positive rate, and it catches script-driven widgets that have no form.

- [ ] **Step 1: Add the fixture**

```ts
const NOSCRIPT_ONLY = `<!DOCTYPE html>
<html><head><title>Cohort Explorer</title></head><body>
  <div class="main">
    <h1>Cohort Data Explorer</h1>
    <noscript><h2>This tool requires Javascript to display cohort data.</h2></noscript>
    <p>The explorer plots enrollment across the four participating sites and updates as new cohorts are entered into the registry each quarter.</p>
    <p>Data are refreshed nightly from the coordinating center and reflect enrollment as of the previous business day.</p>
    <div id="chart"></div>
  </div>
  <script src="js/explorer.js"></script>
</body></html>`;

const EXPLORER_URL = 'https://columbiamedicine.org/divisions/gharavi/explorer.php';
```

- [ ] **Step 2: Write the failing test**

```ts
test('a noscript notice is enough, with no form present', async ({ page }) => {
  const r = await run(page, NOSCRIPT_ONLY, { tags: [], source: 'default' }, EXPLORER_URL);
  const finding = r.unmapped.find(u => /interactive/i.test(u.label));

  expect(finding, 'a page declaring it needs JavaScript must be reported').toBeTruthy();
  expect(finding!.label).toContain('Cohort Data Explorer');
  // It must describe what was actually seen, not claim a form exists.
  expect(finding!.reason).not.toMatch(/a form with/i);
  expect(finding!.reason).toContain('requires Javascript');
  expect(finding!.reason).toContain('explorer.js');
});

test('a page with both a form and a noscript reports once', async ({ page }) => {
  const r = await run(page, CALCULATOR, { tags: [], source: 'default' }, CALC_URL);
  const findings = r.unmapped.filter(u => /interactive/i.test(u.label));
  expect(findings).toHaveLength(1);
});
```

- [ ] **Step 3: Run and confirm the first fails**

Run: `npx playwright test tests/import-extract.spec.ts -g "noscript notice" --workers=1`
Expected: FAIL — `a page declaring it needs JavaScript must be reported`. `findInteractive` returns `[]` when no form matches.

(`reports once` should already pass, since Task 1 returns at most one entry. Confirm it.)

- [ ] **Step 4: Add the noscript branch**

Replace `findInteractive` in `src/lib/import/interactive.ts`:

```ts
export function findInteractive(doc: Document, sourceUrl: string): Unmapped[] {
  const form = Array.from(doc.querySelectorAll('form')).find(isContentForm) ?? null;
  const noscript = doc.querySelector('noscript');

  // The form wins when both are present: it describes the page more concretely, and one
  // page yields one entry.
  const anchor = form ?? noscript;
  if (!anchor) return [];

  const scripts = firstPartyScripts(doc, sourceUrl);
  const driven = scripts.length ? ` driven by ${scripts.join(' and ')}` : '';

  const what = form
    ? describeForm(form)
    : `A page that reports “${norm(noscript!.textContent).slice(0, 90)}” without JavaScript`;

  return [{
    label: `Interactive content — “${headingFor(anchor, doc)}”`,
    reason: `${what}${driven}. Forms and scripts cannot live in a node body; `
      + `this needs a Full HTML block or a module.`,
  }];
}
```

- [ ] **Step 5: Run and confirm both pass**

Run: `npx playwright test tests/import-extract.spec.ts -g "interactive content" --workers=1`
Expected: all five pass.

- [ ] **Step 6: Verify the label trap is real**

`headingFor` filters headings inside `<noscript>`. Temporarily remove `.filter(h => !h.closest('noscript'))` and re-run. Expected: `names the calculator and the scripts that drive it` FAILS on `expect(finding!.label).not.toMatch(/requires Javascript/i)`, because the noscript `<h2>` sits between the h1 and the form. Restore the filter.

- [ ] **Step 7: Commit**

```bash
git add src/lib/import/interactive.ts tests/import-extract.spec.ts
git commit -m "feat: treat a noscript notice as interactive content

A page that says it needs JavaScript is telling us outright. Catches
script-driven widgets that have no form to anchor on."
```

---

## Task 4: Count the forms and scripts the body filter removes

**Files:**
- Modify: `src/lib/import/extract.ts` (`BodyStats` at line ~43; `filterBody` stats at line ~272; provenance `removed` array at line ~449)
- Test: `tests/import-extract.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `BodyStats.formsRemoved: number`, `BodyStats.scriptsRemoved: number`

`stats.embedsRemoved` counts only `iframe,object,embed` while `NOISE_SELECTORS` also removes `form`, `script`, `style`, and `noscript`. An incomplete count presented as a complete one is the same defect this whole plan is about, in miniature.

- [ ] **Step 1: Write the failing test**

```ts
test('the body provenance line counts the form and scripts it dropped', async ({ page }) => {
  const r = await run(page, CALCULATOR, { tags: [], source: 'default' }, CALC_URL);
  expect(r.bodyStats.formsRemoved).toBe(1);
  expect(r.bodyStats.scriptsRemoved).toBe(3);

  const body = r.proposals.find(p => p.key === 'body')!;
  expect(body.source).toContain('1 form');
  expect(body.source).toContain('3 scripts');
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npx playwright test tests/import-extract.spec.ts -g "counts the form and scripts" --workers=1`
Expected: FAIL — `r.bodyStats.formsRemoved` is `undefined`.

- [ ] **Step 3: Add the fields to `BodyStats`**

In `src/lib/import/extract.ts`, in the `BodyStats` interface after `embedsRemoved`:

```ts
  embedsRemoved: number;
  formsRemoved: number;
  scriptsRemoved: number;
```

- [ ] **Step 4: Initialise them in both literals**

There are **two** `BodyStats` object literals — one inside `filterBody` (~line 221) and one in `extract()` (~line 426). Both must gain the fields or TypeScript will fail:

```ts
    paragraphs: 0, headings: 0, lists: 0, linksKept: 0,
    inlineStylesRemoved: 0, embedsRemoved: 0, formsRemoved: 0, scriptsRemoved: 0,
    classesRemoved: 0, tagsStripped: [],
    unsafeUrlsRemoved: 0,
```

- [ ] **Step 5: Count them**

In `filterBody`, next to the existing `embedsRemoved` line (~272). Count on `article`, the original element, because `clone` has already had them removed:

```ts
  stats.embedsRemoved = article.querySelectorAll('iframe,object,embed').length;
  stats.formsRemoved = article.querySelectorAll('form').length;
  stats.scriptsRemoved = article.querySelectorAll('script').length;
```

- [ ] **Step 6: Add them to the provenance line**

In `extract()`, in the `removed` array (~line 449), after the `embedsRemoved` entry:

```ts
        bodyStats.formsRemoved
          ? `${bodyStats.formsRemoved} form${bodyStats.formsRemoved === 1 ? '' : 's'}`
          : null,
        bodyStats.scriptsRemoved
          ? `${bodyStats.scriptsRemoved} script${bodyStats.scriptsRemoved === 1 ? '' : 's'}`
          : null,
```

- [ ] **Step 7: Run and confirm it passes**

Run: `npx playwright test tests/import-extract.spec.ts -g "counts the form and scripts" --workers=1`
Expected: PASS

Note: `findArticle()` falls through to `doc.body` on the calculator fixture, since none of its seven selectors match `<div class="main nosidenav">`. That is why the three end-of-body scripts are inside `article` and counted. If the count comes back `0`, the cause is `findArticle` picking a narrower container — check before changing the assertion.

- [ ] **Step 8: Commit**

```bash
git add src/lib/import/extract.ts tests/import-extract.spec.ts
git commit -m "fix: count the forms and scripts the body filter drops

embedsRemoved counted three of the tags NOISE_SELECTORS removes and
was presented as the complete figure."
```

---

## Task 5: Guard that the prose still imports

**Files:**
- Test: `tests/import-extract.spec.ts`

**Interfaces:**
- Consumes: `CALCULATOR`, `CALC_URL` from Task 1
- Produces: nothing

This test passes the moment it is written, and that is its purpose. It is a characterization guard, not TDD: it pins the Global Constraint that detection must not change what gets imported. Without it, a later change turning this feature into "refuse to import interactive pages" would go unnoticed.

- [ ] **Step 1: Write the test**

```ts
test('detection does not change what gets imported', async ({ page }) => {
  const r = await run(page, CALCULATOR, { tags: [], source: 'default' }, CALC_URL);

  const title = r.proposals.find(p => p.key === 'title')!;
  expect(title.value).toBe('IgA Nephropathy Progression Calculator');

  const body = r.proposals.find(p => p.key === 'body')!;
  expect(body.accepted).toBe(true);
  // The prose around the calculator must survive in full.
  expect(body.value).toContain('619 biopsy-diagnosed Chinese patients');
  expect(body.value).toContain('First tertile of the risk score distribution');
  expect(body.value).toContain('PLoS One 2012');
  // And the calculator itself must not.
  expect(body.value).not.toContain('inputEGFR');
  expect(body.value).not.toContain('calc_progression.js');
});
```

- [ ] **Step 2: Run it**

Run: `npx playwright test tests/import-extract.spec.ts -g "does not change what gets imported" --workers=1`
Expected: PASS immediately. If it fails, an earlier task changed import behaviour and violated a Global Constraint — stop and report; do not adjust the assertion to match.

- [ ] **Step 3: Run the full suite**

Run: `npx playwright test tests/import-extract.spec.ts --workers=1`
Expected: all pass.

- [ ] **Step 4: Run the unit and extension suites**

Do **not** run `npm run build` at the same time — Vite cleans `dist`, which the extension suite loads from.

Run: `npm test` then `npx playwright test tests/extension.test.ts --workers=1`
Expected: 244 unit + 106 extension, plus the new import tests.

- [ ] **Step 5: Commit**

```bash
git add tests/import-extract.spec.ts
git commit -m "test: pin that interactive detection leaves the import unchanged"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| New `findInteractive(doc, sourceUrl): Unmapped[]` module | 1 |
| `extract()` appends to `ALWAYS_UNMAPPED` | 1 |
| Rule 1 — form with ≥2 content controls, not in chrome | 1 (≥1), 2 (≥2) |
| Rule 2 — `<noscript>` trigger | 3 |
| Scripts never trigger alone; attributed after a trigger fires | 1 |
| Same-origin defined against `sourceUrl`; third-party excluded | 1 |
| One entry per page | 3 |
| Label from nearest preceding heading, excluding `<noscript>` | 1, verified 3 |
| Noscript-only entry must not claim a form exists | 3 |
| `formsRemoved`/`scriptsRemoved` in `BodyStats` and provenance | 4 |
| `matchSummary` total shifts — accepted, no code change needed | n/a |
| Import behaviour unchanged | 5 |
| Script-only widgets undetected — accepted gap | n/a (partially mitigated by rule 2) |

No gaps.

**Placeholder scan:** none. Every code step carries the actual code.

**Type consistency:** `findInteractive(doc: Document, sourceUrl: string): Unmapped[]` is used identically in Tasks 1 and 3. `contentControls`, `isContentForm`, `headingFor`, `describeForm`, `firstPartyScripts`, `CHROME`, `INERT_TYPES`, `norm` are defined once in Task 1 and referenced by those names in Tasks 2 and 3. `BodyStats.formsRemoved`/`scriptsRemoved` are named identically in Task 4's interface block, both object literals, the counter assignments, and the test.
