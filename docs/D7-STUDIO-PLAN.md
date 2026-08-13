# D7 Studio — Phased Implementation Plan

Source: `design_handoff_d7_studio` (README + `D7 Studio.dc.html` prototype, 8 screens).
Target: this repo (React 18 + TS + Tailwind, Vite, MV3, `@dnd-kit`).

This plan sequences the handoff into six phases ordered by **risk retired per unit of
work**, not by screen number. Cheap, self-contained work that can't be invalidated comes
first; work that depends on unverified live-site markup comes after that markup is
confirmed.

---

## Phase 0 — Retire the integration risk (blocker)

Nothing in this handoff is worth building until we know the content script reads the real
forms. Every screen depends on parsing live D7 markup.

**Open, and confirm on a real logged-in page** (`vagelos` or `cuimc`, `/node/N/edit`):

1. Does the injected UI appear at all?
2. F12 → Console: `[D7 Proxy]` messages, or silence?
3. The exact URL from the address bar.

**Then capture the markup the later phases depend on.** For one News and one Page form,
save the rendered DOM (DevTools → Elements → right-click `<form>` → Copy outerHTML) for:

- the fieldset/tab wrappers and their labels
- `name` attributes of every field, including the `menu[parent]` select
- required markers and help text
- the vertical-tab block (Meta tags, URL path, XML sitemap, Revision, Shield)
- `<body>` class list (content-type detection reads `node-type-{type}` from it)

**Also fix the test suite, which is currently red.** All three Playwright tests fail: they
load `tests/fixtures/node-edit.html`, but the URL guards in `src/content/index.tsx`
require `/node/` in the path and `node-edit.html` does not contain it. Either restructure
fixtures to mirror Drupal paths (`fixtures/node/123/edit.html`) or serve them from a local
HTTP server with real paths. We need a green suite before refactoring behind it.

**Exit criteria:** UI confirmed injecting on a real page; saved DOM for two content types;
`npm test` green.

---

## Phase 1 — Design system foundation ✅ COMPLETE

Pure styling. Cannot be invalidated by anything learned in Phase 0, so it proceeded in
parallel.

**Delivered:** `src/styles/tokens.js` (single source of truth), Columbia tokens wired into
`tailwind.config.js` with off-brand utilities removed outright, `src/styles/fonts.css`,
global focus ring and shadow-root typography in `main.css`, shared `adoptedStyleSheets` in
`inject.tsx`, all three injected components plus the popup restyled, and 43 passing
contrast tests. Compiled CSS dropped 18.4KB → 15.0KB.

**Two AA violations found in the handoff's own palette.** It declares WCAG 2.2 AA
mandatory, then assigns colors to small text that do not meet it. Measured:

| Token | Handoff use | On white | Needs | Resolution |
|---|---|---|---|---|
| `#75787B` | help text, 12.5px | 4.44:1 | 4.5:1 | added `ink.help` `#696C6F` for text; `#75787B` kept for icons (3:1) |
| `#76881D` | status text, 14.5px | 3.96:1 | 4.5:1 | added `olive.text` `#637218`; `#76881D` kept for fills/dots |
| `#D0D0CE` | input borders | 1.54:1 | 3:1 (1.4.11) | added `rule.control` `#8B8B8A`; `#D0D0CE` kept for decorative rules |
| `#9A9A97` | menu-item paths | 2.82:1 | 4.5:1 | paths use `ink.help`; `#9A9A97` limited to disabled/placeholder, which WCAG exempts |

Brand values are preserved wherever AA permits — the split is by role, not a palette
rewrite. **These four deviations need design sign-off**, since they visibly darken small
text against what the prototype shows.

Fonts were not bundled: the woff2 download was declined. `fonts.css` holds ready-to-
uncomment `@font-face` blocks and the stacks fall back gracefully, so dropping the files
into `src/assets/fonts/` later needs no component changes. Until then headings render in
Georgia rather than EB Garamond.

**Tailwind tokens.** Extend `tailwind.config.js` with the Columbia palette rather than
scattering hex values. From the handoff:

| Token | Value | Use |
|---|---|---|
| `blue.primary` | `#1D4F91` | primary actions, links, focus |
| `blue.hover` | `#003087` | hover/darker navy |
| `blue.columbia` | `#B9D9EB` | banners, borders |
| `blue.tint` | `#EAF2F9` | chips, row hover, fills |
| `blue.tintDeep` | `#DCEBF6` | deeper fill |
| `blue.onColumbia` | `#12365F` | text on Columbia Blue |
| `canvas` | `#E9E9E6` | page canvas |
| `rail` | `#FAFAF8` | right rail |
| `legacy.100/200/300` | `#F5F5F2` / `#F2F2EF` / `#EDEDEA` | legacy surfaces |
| `ink` | `#1A1A1A` | body text |
| `ink.secondary` | `#53565A` | secondary |
| `ink.muted` | `#75787B` | help text |
| `ink.placeholder` | `#9A9A97` | placeholder, disabled |
| `border.DEFAULT` | `#D0D0CE` | borders |
| `border.hairline` | `#E6E6E3` | hairlines |
| `olive` | `#76881D` | success / enabled |
| `orange` | `#B94700` | required / dirty / low confidence |

Constraints to encode, not just document: **max three colors per composition** (grays are
structural); **no gradients**; **radii 0 on large surfaces, 4px on inputs/chips/buttons,
no pills**; only two shadows (`0 2px 8px rgba(20,32,64,.08)` card, `0 12px 40px
rgba(20,32,64,.18)` modal); focus ring `2px solid #1D4F91` at 2px offset, always visible;
transitions 200–400ms `cubic-bezier(0.4,0,0.2,1)`, no bounce or scale-on-press.

**Accessibility gate.** White on Columbia Blue `#B9D9EB` fails AA and is forbidden — use
`#1A1A1A` or `#12365F` on light-blue fields. Do not introduce any green other than
`#76881D`. Worth a unit test asserting contrast ratios on the token pairs actually used,
so this can't regress silently.

**Fonts.** Source Sans 3 (UI), EB Garamond (titles, body-editing surfaces, headings),
Cinzel (wordmark only). Bundle as local `woff2` under `src/assets/fonts/` and `@font-face`
them — MV3 CSP makes CDN webfonts unreliable, and shadow roots need them reachable from
the extension origin.

**Retire the off-brand treatments the handoff names explicitly.** `rounded-xl` /
`rounded-3xl` / `shadow-2xl` and the indigo palette appear in `TaxonomyCombobox.tsx:40`,
`MenuTree.tsx`, `HtmlExport.tsx`, and `popup/App.tsx`. These go.

**Refactor the shadow-DOM style pipeline first.** `inject.tsx` currently inlines the whole
compiled stylesheet into every shadow root via `main.css?inline`. That is fine for three
injections; at eight screens it duplicates ~18KB of CSS per root. Switch to one
`CSSStyleSheet` built once and shared via `adoptedStyleSheets`. Doing this before adding
components avoids reworking every one later.

**Exit criteria:** tokens in Tailwind; fonts rendering in a shadow root; contrast test
passing; shared stylesheet; existing three components restyled with no behavior change.

---

## Phase 2 — Popup + command palette

Both are self-contained, need no live D7 markup, and deliver visible progress.

**Popup (screen 7).** 320px, `#1D4F91` header with wordmark and active host. `App.tsx`
already derives the host from the active tab, so that logic stays. Add the **Import
Queue**: paste field + Add button, one row per queued URL (click to open review, × to
remove), count line. Quick links become All Content, Create News, Create Page, Main Menu,
Import from URL. Keep the `useSettings.ts` feature toggles.

**Command palette (screen 8).** Fixed overlay, `rgba(20,32,64,.45)` scrim, 620px panel
130px from top, white, 1px `#D0D0CE`, modal shadow. Borderless 16px search over a 320px
scrolling result list; each row has a 74px group label (Create / Go to / Run) in uppercase
`#1D4F91`, the command at 14.5px, shortcut in mono `#9A9A97`. Footer: "↑↓ to move · ⏎ to
run · esc to close". Opens on ⌘K / Ctrl+K from any injected screen, closes on Escape.

Because it must open over the *page*, it belongs in the content script as its own shadow
root — not inside another component's root, or its scrim will be clipped.

Replace the prototype's text arrows (`←→↑↓`, `▴▾`, `⣿`) with Lucide icons throughout;
Lucide is already a dependency.

**Exit criteria:** popup matches screen 7 including queue; palette opens/closes on every
injected surface, keyboard-navigable, focus-trapped.

---

## Phase 3 — Menu manager + content list

Both evolve or sit beside existing code, and depend only on markup patterns already proven
against fixtures.

**Menu manager (screen 5).** Evolve `MenuTree.tsx`. Keep `parseDrupalMenuTable` and
`syncTreeToDrupal` (weights and `plid` write-back) and the existing `MAX_DEPTH = 5`; change
`INDENT_PX` 32 → 26. Add: sticky bar with item count, filter input, dirty-state count
(`#B94700` when non-zero), Revert (restores parsed original), Save menu; five 26px square
controls per row (outdent, indent, up, down, enabled toggle); path in mono `#9A9A97`;
disabled rows `#FAFAF8` / `#9A9A97`.

**Filtering must retain ancestors** — matching a child keeps its parents visible so
hierarchy is never lost. This is the one genuinely new algorithm here and it is shared with
the menu-parent picker in Phase 5; build it once as a utility with unit tests.

**Content list (screen 4).** New component on `/admin/content`. CSS grid
`1fr 150px 130px 150px 210px`; header row on `#FAFAF8`, uppercase 11px labels; rows hover
`#EAF2F9`; title `#1D4F91`, status colored (`#76881D` published, `#B94700` draft,
`#1D4F91` needs review). **Filters apply as you type — no Apply button.** Chip row of
content types, then dashed-border saved views (My recent edits, Unpublished drafts, Needs
review). Per-row Edit / View / Copy HTML — no bulk Operations dropdown. J/K to move, ⏎ to
edit. "Copy HTML" reuses `HtmlExport.tsx`'s sanitizer, so extract that logic out of the
component now.

**Exit criteria:** manager round-trips a real menu with correct weights/`plid`; ancestor-
retaining filter unit-tested; content list filters on keystroke with working J/K/⏎.

---

## Phase 4 — Field discovery engine

**This is the architectural decision the handoff flags as open question #1, and I recommend
its own recommendation: derive fields from the rendered DOM. Do not hardcode the matrix.**

Reasoning: the handoff documents News / Page / Specialty, but names ten more types coming
(Condition, Event Importer, Gallery, Landing, List, Testimonial, Timeline Entry, Profile,
Treatment), flags the Specialty column as unconfirmed, and notes in open question #2 that
machine names may differ per host. A hardcoded matrix would need editing for each new type
on each site — it would be stale before the first release.

**Design.** A `src/lib/formSchema/` module that:

1. Detects content type from `/node/add/{type}`, or from the `node-type-{type}` body class
   on `/node/{nid}/edit`.
2. Walks the rendered form: fieldsets, `<label>` text, `name` attributes, required markers,
   help text, and the vertical-tab block.
3. Emits a normalized `FieldDescriptor[]`: `{ machineName, label, kind, required, help,
   nativeEl, section }`.
4. Assigns each field to a rail section via a **small declarative rules table** —
   `menu[*]` → Menu Placement, `field_topics*` → Topics & Tags, the four related-content
   autocompletes → Related Content, image fields → Multimedia, meta/URL/sitemap tabs →
   URL SEO & Sitemap, group flags → Groups.
5. Falls back to a generic grouping for unknown types rather than an empty rail.

**Per-host overrides are NOT needed.** The handoff's open question #2 assumed the same
content type might use different machine names on `columbiadoctors.org` versus
`vagelos.columbia.edu`. Confirmed with the user: the admin UI is the same across all three
sites, so one field map serves all of them. Keep the discovery layer host-agnostic and add
overrides only if a divergence actually turns up — do not build the `hosts/{host}.ts` layer
speculatively.

**Write-back contract**, uniform for every control: set `.value` on the hidden native input
and dispatch `new Event('change', { bubbles: true })`, exactly as `TaxonomyCombobox`
already does for `menu[parent]`. Drupal's own submit performs the save. Never write to
Drupal implicitly.

This phase is **fixture-driven**: build it against the DOM captured in Phase 0, with a
fixture per content type per host. It is the highest-leverage phase — screens 1, 2, and 3
are all just presentations of its output.

**Exit criteria:** given a saved real News form, emits the correct descriptor set with
correct sections and required flags; same for Page; unknown type degrades gracefully.

---

## Phase 5 — Two-pane node editor overlay (lead direction)

Screen 1, the primary UX win: replaces the five-tab / long-scroll form. Consumes Phase 4's
descriptors; ships only after Phase 4 is trustworthy.

**Ship screen 1 only.** The handoff says screens 1–3 are three treatments of one form and
to ship one, with the two-pane overlay as the lead direction. Screens 2 (accordion) and 3
(patched native) are deliberately deferred — revisit only if the overlay proves wrong in
use. Building all three triples the surface area for one shipped outcome.

**Shell.** 1440px container, white on `#E9E9E6` canvas, 1px `#D0D0CE`. Sticky action bar
44px from viewport top, `z-index: 40`: content-type badge (`#1D4F91`, white, 600 11px,
uppercase, `.1em`), detection line ("Fields read from /node/add/news"), autosave status
(7px `#76881D` dot), completion hint, "Save draft to Drupal" (outline), "Publish" (filled).
Body grid `1fr 392px`, `align-items: start`; left padding `34px 44px 60px`, `gap: 26px`, 1px
right border; rail `#FAFAF8`.

Omit the prototype's type chips — they exist only to demo detection; in production the type
comes from the URL.

**Left column.** Title (borderless, EB Garamond 40px/1.15, 1px bottom border); Subtitle
(borderless, EB Garamond italic 21px, `#53565A`); type-specific field grid from Phase 4;
Summary (textarea min-height 78px + live counter, "Doubles as the meta description. N
characters remaining."); Body (toolbar strip on `#F5F5F2`, 26px tool cells, 300px min-height
surface, EB Garamond 18px/1.6 `#3A3A3A`); References (News only). Required fields marked
with the **word** "Required" in `#B94700` — not a bare asterisk.

**Right rail**, header "EVERYTHING ELSE" plus a plain-language note of what it replaced.
Collapsible sections, each a full-width button row (`13px 18px`, hover `#F2F2EF`) with name,
value summary, chevron: Topics & Tags (search + 224px scroll list + removable chips, "First
topic selected becomes the primary topic"), Related Content (one search across all four
entity types, type-badged results), Multimedia (one card per declared image field, 74×60
placeholder), Menu Placement (evolves `TaxonomyCombobox` — keep its filter, add ancestor
retention from Phase 3 and the breadcrumb confirmation, clamp depth 0–3), Display Template
(three radio rows), URL/SEO/Sitemap (preview card + four-row summary + "Override defaults"),
Groups (flag checkbox + one search over Your/Other), Revision footer note.

Section open/closed state persists per content type.

**Autosave.** Local only, `chrome.storage.local`, keyed by URL + node id, status text
refreshing every 5s. "Save draft to Drupal" triggers the real submit and creates a revision.

**Two correctness problems that need handling here, not later:**

- **Server-side validation** (open question #6). Drupal still rejects on submit, and the
  native fields are hidden, so returned error markup must be caught and mapped back to the
  owning field — otherwise the user sees a failed save with no visible cause. Requires a
  `machineName → rail section` reverse index and auto-opening the offending section.
- **Autosave conflict** (open question #5). Define behavior when the local draft predates
  the current Drupal revision. Recommendation: detect via the form's `changed` timestamp
  and show a non-destructive banner offering keep-mine / discard-mine. Never silently
  overwrite.

**Exit criteria:** a real News and a real Page node created and edited end-to-end through
the overlay, with values landing correctly in Drupal; validation errors surface on the right
fields; no implicit writes.

---

## Phase 6 — Import from URL

Screen 6, the largest new feature. Last because it depends on the editor existing (approval
fills editor state) and needs new infrastructure.

**New infrastructure: a background service worker.** The manifest currently has none. Cross-
origin fetch cannot run from the page — the page's origin cannot read a foreign site — so
fetching belongs in the background context with widened `host_permissions`.

**Decide scope before writing code** (open question #3): which source domains are in scope,
and whether fetched HTML is cached. A blanket `*://*/*` host permission is a large
escalation and would change the extension's install-time permission prompt; I'd rather
enumerate allowed source domains, or gate on `optional_host_permissions` requested at first
use. **This needs your call.**

**Flow**, per the handoff's encoded decisions: one URL at a time; entry via ⇧⌘I and the popup
queue; a mapping review **before** anything is filled, with per-field accept/reject; nothing
written to Drupal on approval.

**Layout.** Sticky bar: "Import from URL" (EB Garamond 24px), URL input (max 520px), fetch
status ("Fetched · 7 of 11 fields matched"), target type, primary button counting what will
apply ("Fill the editor with 7 fields"). Body grid `1fr 560px`.

Left pane `#F5F5F2`: **live iframe of the source page** with an `#EDEDEA` URL strip and
"SOURCE PAGE" eyebrow; the mapped region outlined `2px solid #1D4F91` at 3px offset when its
field is selected. Right pane `#FAFAF8`: "PROPOSED MAPPING" + accepted count + "Accept all";
one row per field with label, confidence note (`#B94700` when low), Accepted/Skipped toggle,
**editable** value, and a provenance line. Selected row `#EAF2F9`; skipped `#F5F5F2` with
`#9A9A97` value. Then "Images found" (64×48 thumb, filename, dimensions/weight, Teaser /
Featured / Skip; site chrome pre-set to Skip with reason). Then **"Left for you"** — each
unmapped field with why it wasn't guessed. The handoff calls this block the honesty of the
feature; keep it.

**Extraction** targets `<h1>`, the dek element, `<meta name="description">`, `<article>`,
`.byline`, `<time datetime>`, `<img>`. Attempts Title, Subtitle, Summary, Body, images only
— never guesses Topics, Related Content, Menu Placement, or Groups. Low-confidence values
(a byline with no matching author node) default to Skipped.

**Body cleanup must read the site's text-format configuration** (open question #4), not
guess a tag list — otherwise accepted markup is silently stripped on save. If that config
isn't readable, surface the risk in the UI rather than pretending the markup survived.

**After approval:** editor opens with a `#B9D9EB` banner — "IMPORTED" eyebrow, source URL,
"nothing written to Drupal yet", "Back to the mapping". Only accepted fields written.

**A caveat worth stating now:** the left pane is specified as a live iframe, but many sites
send `X-Frame-Options: DENY` or a restrictive `frame-ancestors` CSP and simply will not
render. Region outlining also requires reading into the iframe, which is cross-origin and
blocked. Realistically this needs a fallback — render the fetched, sanitized HTML in a
sandboxed iframe served from the extension origin instead of framing the live URL. I'd
resolve this during Phase 6 design rather than discover it late.

**Exit criteria:** a real external article imports with per-field accept/reject, images
selectable, unmapped fields explained, and approval filling the editor while writing nothing
to Drupal.

---

## Cross-cutting

**State** (per the handoff's State section). Node session, local and restorable:
`contentType`, values by machine name, `railSections{open}`, `accordionOpen`,
`essentialsOnly`, `topics[]`, `relatedItems[{id,type,name}]`, `menuParentMlid`,
`displayTemplate`, `groupFlag`, `groups[]`, `imported{sourceUrl}`,
`mediaFiles{teaser,featured}`, `autosaveAt`. Menu manager: `items[]`, `originalItems`,
`dirtyCount`, `filter`. Content list: `query`, `typeFilter`, `savedView`. Import:
`sourceUrl`, `fetchStatus`, `proposals[]`, `selectedField`, `images[]`, `unmapped[]`.

**Search semantics**, uniform everywhere: case-insensitive substring, applied on keystroke,
no Apply step. Tree and parent-item filters additionally retain ancestors.

**Feature flags.** Every new surface gets a `useSettings.ts` toggle, so anything that
misbehaves on a live site can be switched off without a rebuild.

**Testing.** Each phase lands with fixtures. Phase 4 in particular should be fixture-driven
per content type per host — that is what makes the ten upcoming types cheap.

---

## Decisions I'm recommending, for your sign-off

1. **Derive the field matrix from the DOM; don't hardcode it.** (handoff Q1)
2. **Ship screen 1 only**; defer the accordion and patched-native treatments.
3. **Enumerate import source domains** or use `optional_host_permissions` rather than
   requesting `*://*/*`. (handoff Q3) — **needs your input**
4. **Serve sanitized fetched HTML in a sandboxed extension-origin iframe**, not a live
   iframe of the source URL, because of `X-Frame-Options` and cross-origin read blocks.
5. **Share one `adoptedStyleSheets` stylesheet** across shadow roots instead of inlining
   per root.

## Still blocked on you

- Sign-off on the four AA deviations in Phase 1.
- Live-site confirmation and captured DOM (Phase 0). The admin UI is confirmed identical
  across the three hosts, which removes the per-host concern, but the saved form DOM is
  still needed before Phase 4 can begin.
- Font woff2 files, if headings should render in EB Garamond rather than Georgia.
- **Specialty field list** is inferred in the handoff and needs a real form to confirm
  (handoff Q7).
- **Menu tree at scale** — behavior and performance on the full main menu, and whether the
  manager should be scoped to a subtree (handoff Q8).
- Import source-domain scope (decision 3 above).
