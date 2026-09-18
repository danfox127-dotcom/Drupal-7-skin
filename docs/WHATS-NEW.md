# What this extension does — a plain-language guide

Written for someone who has never touched the code. If you administer content on
`columbiadoctors.org`, `vagelos.columbia.edu`, `cuimc.columbia.edu`, or any other Columbia
Drupal 7 site, this is for you.

---

## In one paragraph

Drupal 7's admin screens are slow to work in: five tabs on a node form, a six-item block of
collapsed settings, a 36-checkbox topic list, a filter form that needs an *Apply* click, and
a menu manager that loses your place the moment you search. This extension overlays a
modern interface on top of those same screens. It does not replace Drupal, and it does not
save anything on its own — it fills in Drupal's own form fields and lets Drupal's own Save
button do the work.

---

## Installing it

```bash
npm install
npm run build
```

Then in Chrome:

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Choose the **`dist`** folder — not the project folder

Select `dist` itself. Loading the project folder fails, because Chrome can't read the
source files directly; `dist` is the built version.

After any code change, run `npm run build` again and click the **↻** arrow on the
extension's card.

---

## What you get

### On any admin page

**Command palette — press ⌘K.** A search box for jumping around: create a News item, go to
the menu manager, copy a page's public HTML. Type a few letters, press Enter. Escape closes
it.

### On the content list (`/admin/content`)

The table is replaced with one that **filters as you type** — no *Apply* button. Content
types appear as chips you can click, alongside saved views like *Unpublished drafts*. Each
row has its own Edit / View / Copy HTML buttons instead of a bulk dropdown. `J` and `K` move
down and up, Enter opens the highlighted row.

If it can't read your site's content table, it leaves Drupal's original table alone rather
than showing you an empty one.

### On the main menu (`/admin/structure/menu/manage/main-menu`)

Drag rows to reorder, or use the arrow buttons. The important part is the **filter**: when
you search for a page, its parent pages stay visible, so you never lose track of where
something sits in the hierarchy. A counter shows how many changes you've made, and
**Revert** puts everything back. Nothing is saved until you press **Save menu**.

### On node add/edit forms — optional, off by default

A two-pane editor: writing on the left, everything else in a panel on the right. It replaces
the five-tab layout.

**This one is switched off until you turn it on.** It replaces an entire editing form, so
it's opt-in rather than something you inherit by surprise.

Highlights:

- **Topics** — search instead of scrolling 36 checkboxes; your picks appear as removable
  chips, and the first one you choose automatically becomes the Primary Topic
- **Menu placement** — type to filter every possible parent page at any depth, with a
  breadcrumb confirming where the page will land
- **A local draft** saves in the extension every few seconds. It is *local only* — nothing
  reaches Drupal until you press **Save draft to Drupal** or **Publish**
- If someone else saved the page while you were working, you're told and asked what to do,
  rather than silently overwriting their work
- Fields you rarely touch (ID, Classes, Style, Target…) are tucked behind **"Show N
  rarely-used fields"**, still there when you need them

Some widgets are Drupal's own, moved into the panel rather than rebuilt: image pickers,
Related Content autocompletes, Paragraphs. That's deliberate — you get Drupal's real Browse
button, media library and type-to-select behaviour, exactly as before.

### Import from URL — for migrations

Paste an external page's address into the extension popup. It fetches the page, proposes
which parts map to which fields, and shows you the source alongside its proposal. You accept
or reject each field individually, and edit any value before accepting.

It only attempts Title, Subtitle, Summary, Body, Date, Byline and images. It deliberately
does **not** guess Topics, Related Content, Menu Placement or Groups, and tells you why for
each. A byline it can't match to a real author defaults to *skipped*.

Approving fills the form. **It writes nothing to Drupal** — you still press Save.

### Copy and paste a whole page between sites — for migrations

The bigger version of the same idea, for when the page you are duplicating already exists
on another Columbia Drupal site.

1. Open the old page's **edit** form. Press `⌘K` and choose
   **"Copy this page for pasting on another site"**.
2. Go to the new site, open the form you want to fill — `/node/add/page`, or any node
   form. Press `⌘K` and choose **"Paste the copied page into this form"**.
3. A review opens listing every field it can fill, with the value it proposes and how
   confident it is. Everything is **accepted by default** — the point is to stop you
   retyping — so read down it and skip anything that looks wrong. You can edit any value
   before filling.
4. Press **Fill this form**, check the result, then press Drupal's own **Save**.

What it handles that plain copy-paste cannot:

- **Topics and other term lists** are matched by the term's *name*, not its ID, so they
  work even though the two sites number their terms differently. A term the new site does
  not have is named and left out rather than guessed at.
- **Related Conditions, Treatments and Specialties** are checked against the new site
  before being written, using the site's own autocomplete. A reference it cannot confirm
  is left out, so the form still saves.
- **Groups** are matched by name, and left **blank** when there is no match.
- Fields the new content type does not have are listed under **Left for you** with the
  reason, rather than silently dropped.
- **Structured content items** come across too, including `text` and `faq`. Each one is
  recreated by asking Drupal to add an item of the right type and then filling it in, so
  a Page with five content items arrives with five content items rather than five gaps.
  There is no special handling per type — an item is just a set of fields — so the rarer
  types come across as well whenever their fields are ordinary ones.

  Two things to know about content items. The extension has to work out what *type* each
  existing item is; where it has to infer that from the item's field names rather than
  read it directly, the review says so and asks you to check. And a type the new site
  does not offer at all cannot be recreated — those are listed with their values for you
  to rebuild, which for the rare types is the honest outcome.

What it deliberately leaves alone:

- **Publish status.** A pasted page is never published. Save it as a draft, check it, then
  press Publish.
- **Menu placement**, because the new site's menu structure is different.
- **The URL alias** and the original author and date.
- **Images.** They cannot be copied: an attached file is identified by a number that only
  means something on the site it came from, and these forms have no file-upload box to put
  bytes into. Instead the review lists every image the old page used, with its filename and
  a direct link, and a tick-box to track which you have re-attached. Attach them with
  Drupal's own Browse button.

The popup shows what you currently have copied, so a copy from last week does not surprise
you. It keeps the last five.

---

## The settings

Click the extension icon. Each feature has a switch:

| Setting | Default | What it does |
|---|---|---|
| Menu Parent Combobox | On | Searchable parent picker on the plain Drupal form |
| HTML Content Export | On | "Copy public HTML" button on node edit pages |
| Menu Tree Manager | On | The modern main-menu screen |
| Command Palette | On | ⌘K |
| Modern Content List | On | The `/admin/content` replacement |
| **Two-Pane Node Editor** | **Off** | The full editing overlay |
| Log Form Schema | Off | Diagnostic — see below |

---

## If something looks wrong

**Turn the feature off and reload.** Every feature is a switch, and Drupal's original screen
is always underneath, untouched.

**To report a problem usefully**, turn on **Log Form Schema**, open the page that's
misbehaving, and press ⌥⌘I to open the console. Paste what appears next to `[D7 Studio]`.
That block lists every field the extension found and how it classified each one, which is
usually enough to identify the cause immediately.

**One thing that trips people up:** `chrome://extensions` has an **Errors** page that never
clears itself. Warnings from weeks ago sit there looking current. Every message the
extension logs now starts with the time it happened — `[D7 Studio 09:10:29]` — so you can
tell old from new. Press **Clear all** and reproduce the problem to see only what's current.

---

## Things it deliberately does not do

Worth knowing, so they don't look like faults:

- **It never saves for you.** Every write goes into Drupal's own form fields, and Drupal's
  own Save button submits them.
- **It doesn't upload files.** Image fields use Drupal's own picker, moved into the panel.
- **It doesn't guess taxonomy on import.** Topics and Related Content are editorial
  judgement, so it leaves them to you and says so.
- **It gives up rather than guessing.** If a page's structure isn't recognised, the original
  Drupal screen is left in place.

---

## Known gaps

- The editor has only been validated against News forms so far; Page is less tested
- Images are never uploaded automatically, by either the importer or the page copier —
  they are listed with their URLs for you to re-attach
- Content items are recreated one at a time through Drupal's own "Add another item",
  which is a request to the site per item — a page with ten of them takes a few seconds
- A content item of a type the new site does not have cannot be recreated; it is listed
  with its values so you can rebuild that one by hand
- Import always targets News; to import into a Page, open a Page form first
- Headings render in Georgia rather than EB Garamond until the font files are added

---

## For developers

`docs/D7-STUDIO-PLAN.md` has the full technical record: the six build phases, every design
deviation and why, and the open questions. `npm test` runs 250 tests; if the browser version
doesn't match, use:

```bash
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm test
```
