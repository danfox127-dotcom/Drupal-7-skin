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
- Imported images are listed and can be labelled, but aren't uploaded automatically
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
