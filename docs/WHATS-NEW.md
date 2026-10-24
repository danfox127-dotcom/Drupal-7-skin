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

### Connect to Varys — optional, off until you connect

Varys is Columbia's content-intelligence tool: it keeps track of how our web pages do in
search. This is the one part of the extension that sends anything about your edits
anywhere, so it is **off until you connect it**. Until you click **Connect to Varys**, the
extension sends nothing to Varys.

**What it does once you have connected.** When you save a page on a site Varys tracks, the
extension tells Varys about the save: the page's address; what its title, search title,
search description, Summary, web address, headings and internal links were before and after;
how much of the body changed; up to three new sentences, so Varys can check the change
really went live; which button you pressed; and which fields, if any, you filled in from
Varys's suggestions or one of your drafts (see below). It never sends the full text of the
page. Varys decides whether the save counts as a **search edit** (a change to the title,
search description, URL, headings or internal links, or a substantial rewrite of the body; a
typo fix is not one), and later reads the live page to see whether the change went out.
Changes that count appear on Varys's **What's Working** page, with who made them, so their
effect on search can be read later. `docs/PRIVACY.md` lists everything that is sent and
kept, and for how long.

**To connect:**

1. Click the extension's icon, then **Connect to Varys**. Chrome asks whether the extension
   may contact Varys. Say yes.
2. A Varys page opens. Sign in if it asks you to, then press **Allow**.
3. The extension's menu now reads "Connected to Varys as" and your email address.

**Only the Chrome Web Store copy can connect.** The Varys connect page accepts only the
copy installed from the Chrome Web Store, because it recognises that copy by its fixed id
(and the store has to have the version that includes this feature). A copy loaded from a
folder with *Load unpacked* has a different id, so the page will tell you to install the
store copy instead.

**After that, you work as usual.** Press Save as you always do. When the page you land on has
loaded, a small box appears at the bottom of the screen saying what Varys did with your save.
It stays for about ten seconds, longer while your mouse is on it, and **Dismiss** closes it.
What it can say:

- **"Logged in Varys as …"** (a title and description change, a headings change, an internal
  links change, a new section, a body rewrite, a new page, or a page address change). Your
  save counted. If it should not have, because you were only trying something, press
  **Undo**: it stops counting, and What's Working shows it as "Undone" until Varys deletes
  it.
- **"Not logged in Varys: this didn't look like a search edit."** Varys saw your save and
  decided it did not count, such as a typo fix. If you disagree, press **Log it anyway**.
  The box then says it was logged, and the button becomes **Undo**. Do this while the box is
  there: the button lives only in the box, and Varys keeps a page's edits that never counted
  for just 7 days after the last one.
- **"This site isn't in Varys, so nothing was logged."** Varys does not track this site, so
  nothing was logged. Normally nothing about your save was sent either. The one exception:
  if the extension could not fetch Varys's list of tracked sites, it sends the save anyway,
  and Varys discards it without keeping anything.
- **"Varys couldn't be reached. This save will be sent when it can."** The save waits on your
  computer (up to 50 saves, each for up to a week) and goes out when Varys answers again.
- **"Your Varys connection has expired. Reconnect from the extension menu to log this
  save."** Click the extension's icon and press **Reconnect**. The save is sent once you
  have.

The box needs the extension to follow your save to the page it lands on. If it cannot show
the box there (you closed the tab, or Chrome will not let the extension in), the message
waits and appears, without buttons, on the next admin page of that site you open within the
hour. If the extension never sees the save finish, it sends the save after a short wait
instead, on a best-effort basis, so the box can be late. If the browser is closed before
then, that save is not sent.

**Undo later.** The box goes away, but the change stays on Varys's **What's Working** page,
where **Undo** is also offered: to the person who saved it, and to Varys administrators.

**To disconnect:** click the extension's icon and press **Disconnect**. The extension asks
Varys to cancel its key, deletes the key and anything still waiting to be sent from your
computer, and gives back its permission to contact Varys. If Varys cannot be reached, it
still disconnects here and tells you the key may still work there. You can also disconnect
from Varys itself, under **Your connections** on its Drupal extension page, but this browser
keeps its copy of the key until it next tries to use it, so the extension's own Disconnect
is the one that clears everything. Disconnecting does not delete changes Varys has already
logged; use Undo to make one stop counting (an undone entry is shown as "Undone", and
deleted up to 30 days after that page's last save). A connection nobody uses for 90 days
expires by itself; the menu then says so, and **Reconnect** puts it back.

### Varys's suggestions on the edit form — part of Connect to Varys

Once you have connected, open the edit form of a page that already exists on a site Varys
tracks, and a small panel can appear in the corner of the screen: **Varys · suggestions for
this page**. It shows what Varys suggests for the page's **search result title**, **search
result description**, **title** and **section headings**, each beside what the form holds
right now. Click its title bar to fold it away.

- **If Varys has suggestions, they are shown** (with when it made them, and a clinical
  review note if it flagged one). **If it has not written any yet, press Ask Varys.** That
  usually takes about a minute and the panel says when they are ready; if it is still
  writing after a few minutes it says to check back. If Varys has not read the page yet (it
  reads each site weekly), the panel says so.
- **Use** puts a suggestion into its field. That is all it does: it never saves and never
  publishes, so you still press Save. **Undo** puts the old text back, as long as you have
  not edited the field since. Undo, and the panel's note about the web address, are still
  there after a Preview or a save Drupal sends back with an error; after a save that goes
  through they are gone.
- **A search title keeps the site's name.** If the search title field ends in Drupal's own
  site-name pattern, such as `| [site:name]`, Use keeps that ending after the suggestion, so
  the site's name stays in the search result. The panel shows the title as Use will write it.
- **Using a suggested title keeps the page's web address.** If the address would have
  followed the title, the extension unticks *Generate automatic URL alias* for you, turns the
  address box on if it was off, and, if the box was empty, puts the page's current address
  into it. Undo puts those back, unless you have typed a different address since. If it
  cannot tell what the current address is, it will not change the title.
- **A suggested description** goes into Summary when the page's search description follows
  its Summary (or the form has no search description field), and otherwise into the search
  description field. The panel says which.
- **Headings** are suggestions to read. **Copy** copies one to your clipboard; **Insert at
  cursor** puts it into the body as a heading where your cursor is. Click in the body first:
  with no cursor there, it tells you and inserts nothing. The panel has no Undo for an
  inserted heading; use the editor's own undo.
- The panel also shows the headings the page has now, from Varys's own last read of it, so
  you can compare.
- **When you save, Varys is told which fields you filled from its suggestions** (title,
  search title, description, headings; not one you put back with Undo), and shows "Filled from
  Varys: …" beside the change, so you can later see whether a suggestion that went live
  worked.

**What is sent for this.** When you open the form, the page's public address goes to Varys,
to fetch its suggestions (if the form does not show that address, the extension first reads
the page itself on the same site to learn it); **Ask Varys** sends the same address so that
Varys can write them. Nothing from the form goes with either, and nothing is sent for a site
Varys does not track, for a new page, or while you are not connected. If you press Ask Varys,
the extension keeps a small marker in that browser tab for 3 minutes (the address and the
time), so that reloading the page keeps waiting instead of asking again. `docs/PRIVACY.md`
has the full list.

### Start a new page from a Varys draft — part of Connect to Varys

Once you have connected, open the form for a **new** page (Add content) on a site Varys
tracks. If you have made drafts for that site in Varys's **Draft Assistant**, a panel appears
in the corner of the screen, **Varys · start from a draft**, listing them with when you made
each. **Open Draft Assistant** takes you to Varys to make another.

- **Pick a draft, and the panel shows field by field what it will fill**: the title you
  confirmed in Draft Assistant, the body (opened by the site's blue Overview box with the
  draft's key points, then the draft itself, with how many words, headings, lists and Varys
  links it has), Summary, the search result title and the doctors for Related Profiles. Each
  has a tickbox. A draft with no confirmed title fills no title.
- **Tables and images are not carried over**: if the draft had any, the panel says how many,
  so you can add them in Drupal.
- **A Summary too long for Drupal's Summary field** (over 380 characters) is shown but cannot
  be ticked; write a shorter one.
- **Doctors.** A doctor the draft quotes by the very name Columbia's physician directory has
  starts ticked. One Varys matched only by a likely name ("quoted as …"), or suggested by the
  page's topic, starts unticked, for you to decide. A doctor Varys could not match is listed
  to add by hand. The extension then looks each ticked doctor up in Related Profiles' own
  search on the site and adds them only when exactly one profile has exactly that name;
  otherwise it adds nobody and says why.
- **Fill** writes the ticked fields. If a field already had text, filling replaces it. That
  is all it does: it never saves, previews or publishes, and it leaves the page's web
  address to Drupal, so you still review and press Save. **Undo** beside each field puts back
  what was there, as long as you have not changed the field since. **Undo lasts until the
  page reloads**: a Preview, or a save Drupal sends back with an error, ends it, as the panel
  says after Fill.
- **When you save, Varys is told which fields you filled from the draft** (title,
  description for Summary, search title, body, Related Profiles; not one you put back with
  Undo). Only the next save made without a reload in between reports them: after a Preview
  or a rejected save, they are not reported.

**What is sent for this.** When you open a new page's form, only the site's address goes to
Varys, to list your drafts for it; picking one sends the same address and that draft's id.
Nothing from the form goes with either, and nothing is asked for an existing page's form, for
a site Varys does not track, or while you are not connected. Looking a doctor up asks the
Drupal site you are on, not Varys. The draft is shown in the panel and is not stored.

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

**Connect to Varys** is not in this list. It is its own section of the menu, after the quick
links and before the features, because it involves signing in and a key rather than a
switch, and it is off until you connect.

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
- **It never fills a Varys suggestion on its own.** A suggestion goes into the form only when
  you press **Use** (or **Insert at cursor**, for a heading). **Undo** takes a Use back; a
  heading put in with Insert at cursor is reversed with the editor's own undo, since the
  panel has no Undo for it.
- **It does not send anything to Varys until you connect it**, and even then never the full
  text of a page.
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
- Varys's suggestions panel appears only on the edit form of a page that already exists, not
  on a new page's form, and only for a site Varys tracks
- Insert at cursor puts a heading in only where there is a cursor in the body, and its result
  is not offered an Undo of its own; use the editor's own undo
- Varys's result box depends on the extension following your save to the page it lands on.
  If you close the tab or quit the browser in the middle, the save is sent later on a
  best-effort basis or, if the browser was closed, not at all

---

## For developers

`docs/D7-STUDIO-PLAN.md` has the full technical record: the six build phases, every design
deviation and why, and the open questions. `npm test` runs 250 tests; if the browser version
doesn't match, use:

```bash
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm test
```
