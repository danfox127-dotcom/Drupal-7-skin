# Report interactive content the importer cannot carry

**Status:** approved, not yet implemented
**Date:** 2026-09-01

## The problem

`src/lib/import/extract.ts` removes `script, style, noscript, iframe, object, embed, form`
wholesale via `NOISE_SELECTORS` (line 125) before any tag filtering runs. Nothing counts or
reports the removal: `stats.embedsRemoved` counts only `iframe,object,embed`, and `UNMAPPED`
(line 326) is a hardcoded four-entry constant that never varies by page.

The result is silent loss. Importing
`https://columbiamedicine.org/divisions/gharavi/calculators/calc_progression.php`
today produces a clean, plausible node — description, risk-score equation, three-row
interpretation table, reference, disclaimer — and drops the calculator that is the page's
entire reason for existing. Nothing in the review says so.

Those pages were the prompt for this work, but the defect is general: it applies to every
legacy interactive page on these sites.

### What the source pages actually are

Verified by fetching both pages and all their assets:

- No server-side logic. Neither `<form>` has an `action` or `method`; there is no XHR,
  `fetch`, or `$.post`/`$.get` anywhere in the HTML or JS. The `.php` extension is vestigial.
- All logic is in `common/global.js` (2 KB), `common/calc_progression.js` (2 KB), and
  `common/calc_egfr.js` (8.7 KB), loaded at end of `<body>`.
- jQuery 1.7.2 from a protocol-relative `//ajax.googleapis.com` URL.

Porting the calculators themselves is a separate, one-time content job and is **out of scope
here**. This spec covers only the importer telling the truth about what it drops.

## Design

### New module: `src/lib/import/interactive.ts`

```ts
export function findInteractive(doc: Document, sourceUrl: string): Unmapped[]
```

Inspects the source document and returns one `Unmapped` entry per interactive region found.
Pure; reads only, proposes nothing, writes nothing.

`extract()` changes one line — `unmapped: UNMAPPED` becomes
`unmapped: [...ALWAYS_UNMAPPED, ...findInteractive(doc, sourceUrl)]`. The existing constant is
renamed `ALWAYS_UNMAPPED` to distinguish the fixed entries from the page-derived ones.

### Detection rule

The dominant risk is crying wolf. Nearly every legacy page loads analytics and a CDN library;
if scripts alone triggered a finding, every import would show one and the panel would become
noise — worse than silence, because it trains the reader to skip it.

**The form is the anchor.** A finding requires one of:

1. A `<form>` inside the article region containing at least one `input`/`select`/`textarea`
   whose type is not `search`, `submit`, or `hidden`. This excludes site search boxes, which
   are chrome rather than content.
2. A `<noscript>` element — a page stating outright that it does not work without JS.
   `calc_progression.php` carries exactly that ("This calculator requires Javascript").

Scripts never trigger a finding on their own. Once a trigger fires, same-origin scripts on the
page are attributed to it as dependencies; this is how `common/calc_progression.js` is named
despite sitting outside the article at end of `<body>`. Third-party origins are excluded as
infrastructure, not page logic.

The entry's label comes from the nearest preceding heading, falling back to the page `h1`.

### Expected output

For `calc_progression.php`:

> **Interactive calculator — "IgA Nephropathy Progression Calculator"**
> A form with 4 text inputs and a Calculate button, driven by `common/calc_progression.js`
> and `common/global.js`. Forms and scripts cannot live in a node body; this needs a Full
> HTML block or a module.

### Secondary change: honest counters

`BodyStats` gains `formsRemoved` and `scriptsRemoved`, counted on the article before
`NOISE_SELECTORS` runs, and both join the body provenance line. Minor next to the Unmapped
entry, but `embedsRemoved` is currently an incomplete count presented as a complete one — the
same defect in miniature.

### Accepted consequences

- **`matchSummary()` totals shift.** `total = proposals.length + unmapped.length`, so a
  calculator page reads "7 of 12" where it read "7 of 11". Correct — there genuinely is more
  unmatched content. Confirmed acceptable by the user.
- **Script-only widgets are not detected.** A chart or map with no form and no `<noscript>`
  goes unreported. Detecting it means guessing at scripts, which reintroduces the noise
  problem. Deliberate gap, not an oversight.

## Testing

Every test below must fail when its rule is disabled. That will be verified by reverting each
rule and observing the failure, not assumed.

| Test | Fails when |
|---|---|
| Fixture trimmed from the real `calc_progression.php` markup yields an unmapped entry naming both the calculator and `calc_progression.js` | detection returns `[]` |
| An article page with a site search form in `<header>` yields **no** finding | the search/chrome exclusion is removed |
| The calculator fixture's body proposal still contains the interpretation table and reference list | this becomes "refuse to import interactive pages" |
| `formsRemoved`/`scriptsRemoved` appear in the body provenance string | the counters are dropped |

Fixtures use real fetched markup, not invented approximations — invented fixtures agreeing
with broken code has been the recurring failure mode on this codebase.

Tests follow the existing `tests/import-extract.spec.ts` pattern: inline `SOURCE` constants,
esbuild-bundled, executed in a Playwright page for a real `DOMParser`.

## Out of scope

- Porting, rewriting, or extracting the calculators.
- Offering a copyable snippet or generated code.
- Any change to what the importer writes into the node form.
