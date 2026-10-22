# Publishing to the Chrome Web Store (unlisted)

## Published — live details

| | |
|---|---|
| **Item ID** | `ebooneiidohdlmcddhnlnnolhjehpcec` |
| **Listing** | https://chromewebstore.google.com/detail/ebooneiidohdlmcddhnlnnolhjehpcec |
| **Visibility** | Unlisted — never appears in store search; the link above is the only way in |
| **Version published** | 0.2.2 |
| **Approved** | 17 September 2026 |

The id is also in `src/lib/updateCheck.ts` as `STORE_ID`, where it does real work: a
build compares `chrome.runtime.id` against it to know whether it is the store copy
(which Chrome updates, and which therefore must not nag) or a hand-loaded one (which
Chrome will never update, and which is told to migrate). Keep the two in step.

**Do not run the store copy and an unpacked copy in the same Chrome profile.** They get
different extension ids, so Chrome treats them as unrelated extensions — but both match
the same Columbia hosts, so both content scripts inject. That means two overlays, two
command palettes and two ⌘K handlers competing on every admin page.

Everything the Developer Dashboard asks for, written out so submission is copy-and-paste
rather than improvisation. Unlisted means the extension does not appear in search or
category browsing — only people with the direct link can install it — but Chrome still
auto-updates every installed copy, which is the entire reason to do this.

## Why bother

Chrome will not auto-update an extension installed with "Load unpacked". That is not a
configuration problem; `update_url` is honoured only for enterprise-policy installs. So
today every user installs a zip by hand and updates it by hand, and the first person to
try it downloaded the wrong zip twice and got an extension that appeared to install and
did nothing.

Publishing here removes the zip, the folder, the "Developer mode" toggle, the
wrong-download failure mode, and the manual update. It also makes `latest.json` and the
in-popup update notifier redundant — see "Afterwards" below.

## Costs, honestly

- **A one-time registration fee**, not per extension and not recurring. Long reported as
  $5, but developer.chrome.com/docs/webstore/register no longer states an amount — treat
  the number at the payment step as authoritative.
- **Every update is reviewed.** Usually hours for something this size; occasionally days.
  You lose the ability to ship a fix in thirty seconds, which is a real trade against
  never explaining installation again.
- **A Google account owns the listing.** Decide whose before paying — see below.

## Decide this before paying

**The developer email address cannot be changed after the account is created.** Google's
registration page says so explicitly: changing it means a new account and re-registering.
So this is the one decision that is expensive to get wrong.

Use a **`columbia.edu` account** if you can, so the listing outlives whoever set it up.

Two caveats, both verified against the current docs:

- **"Private" is not domain-wide by default.** Private visibility limits installation to a
  list of *trusted testers* — individual Google accounts, or Google Groups you own. It is
  described as a pre-launch testing mode. Organization-wide *domain publishing* exists
  separately and only "for Google Workspace domains where the feature is enabled", so it
  depends on a Columbia Workspace admin having turned it on. Do not assume it is available.
- **Managed accounts may block the payment.** Columbia-managed Google accounts often have
  Google Pay restricted, and the fee needs a card. If it fails, that is the likely cause.

Unlisted is the right starting point either way: no listing, installable by anyone with the
URL, and it can be changed later.

**All visibility settings get the same review.** Unlisted does not skip or shorten it.

---

## Listing fields

**Name**

    D7 Studio — Drupal 7 admin interface

**Summary** (132 characters max)

    A faster interface for Columbia's Drupal 7 admin: searchable menus, live content
    filtering, and page imports.

**Description**

    D7 Studio replaces the slowest parts of Drupal 7's administrative interface on
    Columbia sites with a faster one, without changing Drupal itself.

    - Searchable menu parent picker. Drupal renders thousands of menu items in a plain
      dropdown, each shown only by its own title, so two pages with the same name are
      indistinguishable. This shows the full path to each.
    - Menu tree manager. Drag and drop in place of a table of rows and select boxes, with
      search across every item in the menu — including the ones Drupal has not drawn.
    - Content list that filters as you type, with no Apply button and no page reload.
    - Command palette on Cmd-K for jumping between admin tasks.
    - Import a page from another URL into a node form, with a review screen showing what
      it proposes to fill, how confident it is, and what it cannot bring across.
    - Copy a node's cleaned-up public HTML to the clipboard.
    - Optional: connect to Varys, Columbia's content-intelligence service, so that your
      search edits (titles, search descriptions, page addresses, headings, internal links)
      are logged there automatically. It is off until you click Connect to Varys.

    Everything happens in the browser, unless you connect to Varys. The extension fills
    forms in; it never saves or publishes anything on its own — you press Save.

    Its interface runs only on columbia.edu and columbiadoctors.org administrative paths
    (/admin/ and /node/); it does not run on any other page, apart from the Varys notice
    described below. Nothing about you or your pages is sent anywhere unless you click
    Connect to Varys. If you do, a summary of each page you save (its address, the before
    and after of its title, search description, URL alias, headings and internal links, how
    much of the body changed, and up to three new sentences) is sent to Varys; the full body
    text never is. After a save, a small notice saying what Varys did can appear on the page
    you land on, which may be a public page of the same site. See the privacy policy for
    everything that is sent and kept.

**Category:** Workflow & Planning
**Language:** English

## Assets

- **Icon, 128x128:** `public/icons/icon-128.png` (already in the repo)
- **Screenshots — at least one at 1280x800, up to five:** NOT YET MADE. Must be captured
  from a real admin page. Best candidates, in order: the menu tree manager, the content
  list mid-filter, and the import review screen. Avoid anything showing unpublished
  content or a real editor's name.
- **Small promo tile, 440x280 (PNG or JPEG):** listed among the store's graphic assets.
  Cheap to produce from the 128px icon, so plan for it rather than discovering at
  submission that it is wanted.

---

## Permission justifications

The dashboard asks for a written reason per permission, and a vague answer is the most
common cause of a slow review. These are accurate as of the current manifest.

**`storage`**

    Stores the user's feature toggles, their queue of URLs to import, their local drafts
    and copied pages, a cached menu index and the last update-check result, using
    chrome.storage.local. Never chrome.storage.sync. These stay in the browser. If the user
    clicks Connect to Varys, it also stores the Varys key and email and a queue of at most
    50 saves waiting to be sent (each kept at most 7 days) in chrome.storage.local, and a
    few short-lived items in chrome.storage.session, which Chrome clears when the browser
    closes: the form as it first opened (including raw field values, which are never sent),
    saves being followed across the page change, and a 24-hour cache of which sites Varys
    tracks. Disconnect removes all of it. Nothing leaves the browser except what the
    privacy policy lists under "If you connect it to Varys", and only after the user has
    connected.

**`tabs`**

    Reads the active tab's URL to tell the user whether the extension applies to the page
    they are on, and opens admin pages from the popup's quick links and the command
    palette. Once the user has connected to Varys it also follows a tab in two cases,
    comparing only the host and path of its address: a tab with a node form open, until it
    goes to another page of the same site, closes or saves (a detour to another site or to
    the login page does not end it; nothing is sent for this; it lets a Preview or a
    rejected save be compared with the form as it first opened), and the tab a save was made
    in, until that save has finished loading, to learn whether it went through and the
    public address of the page it landed on. It ignores every other tab's address, and
    opens the Varys connect page in a new tab when the user clicks Connect to Varys.

**`scripting`**

    Writes an imported value into the page's CKEditor instance. CKEditor keeps its content
    in its own JavaScript object and only syncs to the underlying textarea on submit, so
    assigning the textarea's value is discarded. Reaching that instance requires running
    in the page's main world, which chrome.scripting provides. The alternative — injecting
    an inline script tag — fails on any site with a Content Security Policy that omits
    'unsafe-inline', which was verified during development.

    The same page-world access also reads a field's current content out of that instance:
    for the Remove span tags button and, once the user has connected to Varys, to measure
    how much of the body changed when a node is saved. It is read in the browser, and the
    full body text is never sent; the privacy policy lists the few things that are.

    Also shows the Varys result notice, only once the user has connected to Varys: after a
    save, a small box saying whether Varys logged it, with Undo or Log it anyway, is
    injected into the page the save landed on. Drupal usually lands on the page's public
    address, outside /admin/ and /node/, where the content script does not run, so the
    extension injects the notice itself. The notice only draws a box; it reads nothing from
    the page.

**`clipboardWrite`**

    The "copy this node's public HTML" feature writes to the clipboard.

**Host permissions — all four, listed exactly as the manifest declares them:**

    *://*.columbia.edu/admin/*
    *://*.columbia.edu/node/*
    *://*.columbiadoctors.org/admin/*
    *://*.columbiadoctors.org/node/*


    The Drupal 7 sites the extension exists to improve. The content scripts that read and
    redraw forms are matched only to those administrative path prefixes, so the extension
    does not run its interface on ordinary pages of those domains. The host permission
    itself is wider than that in practice: Chrome ignores the path of a host permission when
    an extension injects a script through chrome.scripting, so the permission reaches every
    page of those hosts, and the Varys result notice (see scripting above) can appear on a
    site's public pages. Nothing else uses that reach. The wildcard subdomain is required
    because the university runs many Drupal 7 sites across columbia.edu subdomains and they
    are added and renamed regularly.

**Optional host permission — `*://*/*`**

    Used for two things only, each requested at runtime for one specific origin at a time,
    via chrome.permissions.request, immediately after the user's click. It is not granted at
    install, and the extension cannot read any site until a user names it and approves the
    prompt.

    1. Importing a page from an arbitrary URL, requested right after the user clicks that
       URL in their own import queue.
    2. Contacting the Varys server, requested only when you click Connect to Varys. The
       origin is https://varys.fly.dev, and the permission is given back when the user
       clicks Disconnect. Until then the extension contacts Varys in no way.

**`externally_connectable`** (a manifest key, not a permission; it is added to the built
manifest by `vite.config.ts`, not written in `manifest.json`)

    "externally_connectable": { "matches": ["https://varys-wine.vercel.app/*"] }

    Lets one web page, the Varys app at https://varys-wine.vercel.app, call
    chrome.runtime.sendMessage on this extension, once, to hand over the Varys key when the
    user clicks Allow on Varys's connect page. No extension ids are listed, so no other
    extension can message it, and a production build never lists a development origin. The
    extension checks the sender's origin again itself and refuses any other page or any
    message that is not a well-formed key hand-off. It adds no install-time permission
    warning.

**Remote code:** none. All JavaScript is bundled by Vite and served from the extension
package. `tests/packaging.spec.ts` asserts the popup loads no remote script.

## Data use disclosures

Answer the dashboard's questionnaire as follows. Each is accurate; do not soften them.

- **Personally identifiable information:** **Yes**, only once the user connects to Varys.
  The extension stores the email address of the user's Varys account (on this computer,
  and shown in the popup) and identifies the user to Varys, as the person who saved, by the
  key. It does not send the email address itself.
- **Health information:** No
- **Financial information:** No
- **Authentication information:** **Yes**, only once the user connects to Varys. The Varys
  key, which is a credential for the user's Varys account. It is stored locally and is sent
  only to Varys, to authenticate that user's requests.
- **Personal communications:** No
- **Location:** No
- **Web history:** No. The extension does not collect a browsing history. When connected,
  it sends the address of a page the user has just **saved** on a site Varys tracks, not
  pages the user visited. It reads a tab's address only to follow an open node form or a
  save, as described under `tabs`, and sends nothing from that.
- **User activity:** **Yes**, only once the user connects to Varys, and only this: that a
  save was made on a Drupal node form, which button was pressed (Publish, Save draft or
  Save), and when Varys received it. No clicks, keystrokes, mouse position or scrolling are
  recorded.
- **Website content:** **Yes.** The extension reads the content of the Drupal admin form
  on the page, and — only for an origin the user has explicitly approved — the content of
  a page they asked to import.
  - Without the Varys connection, this content is processed in the browser and written into
    the form in front of the user. It is not transmitted anywhere and not stored beyond the
    browser's local storage.
  - Once the user has connected to Varys, on each save on a site Varys tracks the extension
    **transmits to Varys** a summary of the form: the page's address, node id and content
    type; before and after of the title, search title, search description, URL alias,
    headings (H2 and H3) and internal body links; the body's word count; how much of the
    body changed; and up to three new sentences (at most 200 characters each) used only to
    confirm the change went live. The full body text is never sent. It is kept as the
    privacy policy states: a page's edits that never counted as a search edit are deleted
    after 7 days; an undone entry stops counting, is shown as "Undone", and is deleted up to
    30 days after that page's last save; and one that counts stays in Varys's record of
    changes until it is undone or an administrator removes it. People signed in to Varys
    with access to that site can see who saved what; it is given to no one outside Varys.

Then certify all three:

- Not being sold to third parties — true. It is not sold, and the extension sends no user
  data to anyone except Varys, which the user chooses to connect.
- Not being used for purposes unrelated to the single purpose — true.
- Not being used to determine creditworthiness or for lending — true.

**Single purpose statement**

    A faster administrative interface for Drupal 7 websites at Columbia University.

Left unchanged for the Varys connection, which is optional and part of the same workflow
(editing Drupal pages). **Held in reserve:** if review asks how Varys fits the single
purpose, answer with this wording rather than weakening the claim:

    A faster administrative interface for Drupal 7 websites at Columbia University,
    including, if the user chooses, logging their search edits to Varys, Columbia's
    content-intelligence service.

**Privacy policy URL:** required whenever "Website content" is declared. Written, and in
the repository at `docs/PRIVACY.md`. Paste this URL into the dashboard:

    https://github.com/danfox127-dotcom/Drupal-7-skin/blob/main/docs/PRIVACY.md

It is checked against the source by `tests/packaging.spec.ts`: every remote host the code
contacts must appear in the policy (the two Varys hosts included), the local-only storage
claim fails if anything starts using `chrome.storage.sync`, the "If you connect it to
Varys" section and its "off until you connect" wording must stay, and the draft disclosure
must stay.

---

## Steps

1. Register at `https://chrome.google.com/webstore/devconsole`, accept the developer
   agreement and program policies, and pay the one-time fee.
2. Complete **account setup** before anything else: a **publisher name**, which appears
   under the extension's title, and a **verified email address** — Google emails a
   verification link and you must follow it. A physical address is required only for paid
   items, which this is not.
3. `npm run release patch` — bumps, builds, and produces the zip.
4. Upload the zip. Set **Visibility: Unlisted**.
5. Paste the listing fields, permission justifications, and data disclosures above. The
   **Privacy** tab wants the single-purpose statement and the data-use answers; the
   **Distribution** tab wants visibility and countries.
6. Add at least one 1280x800 screenshot and the privacy policy URL.
7. Submit. Expect hours, not minutes.
8. When it is approved, the dashboard gives an install link. That link replaces
   `docs/INSTALL.md` almost entirely.

## Afterwards

**Do not delete the update notifier immediately.** Existing users installed a zip by hand
and Chrome cannot migrate them — they will sit on their current version forever, unaware
the store version exists. Point `latest.json`'s `download` field at the store link and
publish one final zip release whose notes say "install from the store instead". Once the
handful of manual installs have moved, `src/lib/updateCheck.ts`, `latest.json`, and the
popup's update banner can all go.

**Keep the zip pipeline.** `scripts/release.mjs` still builds the artifact the store wants,
and a zip remains the fallback if a review ever blocks an urgent fix.

**Then revisit `file://`.** It was removed from `content_scripts.matches` for this
submission. If a local-file workflow is ever genuinely needed, it belongs behind
`optional_permissions`, requested at the moment of use — not granted to every install.
