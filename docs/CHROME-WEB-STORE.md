# Publishing to the Chrome Web Store (unlisted)

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

    Everything happens in the browser. The extension fills forms in; it never saves or
    publishes anything on its own — you press Save.

    Runs only on columbia.edu and columbiadoctors.org administrative paths (/admin/ and
    /node/). It does nothing on any other page, including the public side of those sites.

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

    Stores the user's feature toggles and their queue of URLs to import, using
    chrome.storage.local. Nothing leaves the browser.

**`tabs`**

    Reads the active tab's URL to tell the user whether the extension applies to the page
    they are on, and opens admin pages from the popup's quick links and the command
    palette.

**`scripting`**

    Writes an imported value into the page's CKEditor instance. CKEditor keeps its content
    in its own JavaScript object and only syncs to the underlying textarea on submit, so
    assigning the textarea's value is discarded. Reaching that instance requires running
    in the page's main world, which chrome.scripting provides. The alternative — injecting
    an inline script tag — fails on any site with a Content Security Policy that omits
    'unsafe-inline', which was verified during development.

**`clipboardWrite`**

    The "copy this node's public HTML" feature writes to the clipboard.

**Host permissions — all four, listed exactly as the manifest declares them:**

    *://*.columbia.edu/admin/*
    *://*.columbia.edu/node/*
    *://*.columbiadoctors.org/admin/*
    *://*.columbiadoctors.org/node/*


    The Drupal 7 sites the extension exists to improve. Scoped to the two administrative
    path prefixes rather than the whole host, so ordinary pages on those domains are not
    matched. The wildcard subdomain is required because the university runs many Drupal 7
    sites across columbia.edu subdomains and they are added and renamed regularly.

**Optional host permission — `*://*/*`**

    Required only for importing a page from an arbitrary URL, and requested at runtime for
    one specific origin at a time, via chrome.permissions.request, immediately after the
    user clicks that URL in their own import queue. It is not granted at install. The
    extension cannot read any site until a user names it and approves the prompt.

**Remote code:** none. All JavaScript is bundled by Vite and served from the extension
package. `tests/packaging.spec.ts` asserts the popup loads no remote script.

## Data use disclosures

Answer the dashboard's questionnaire as follows. Each is accurate; do not soften them.

- **Personally identifiable information:** No
- **Health information:** No
- **Financial information:** No
- **Authentication information:** No
- **Personal communications:** No
- **Location:** No
- **Web history:** No
- **User activity:** No
- **Website content:** **Yes.** The extension reads the content of the Drupal admin form
  on the page, and — only for an origin the user has explicitly approved — the content of
  a page they asked to import. This content is processed in the browser and written into
  the form in front of the user. It is not transmitted anywhere and not stored beyond the
  browser's local storage.

Then certify all three:

- Not being sold to third parties — true, it is not sold or transmitted at all.
- Not being used for purposes unrelated to the single purpose — true.
- Not being used to determine creditworthiness or for lending — true.

**Single purpose statement**

    A faster administrative interface for Drupal 7 websites at Columbia University.

**Privacy policy URL:** required whenever "Website content" is declared. Written, and in
the repository at `docs/PRIVACY.md`. Paste this URL into the dashboard:

    https://github.com/danfox127-dotcom/Drupal-7-skin/blob/main/docs/PRIVACY.md

It is checked against the source by `tests/packaging.spec.ts`: every remote host the code
contacts must appear in the policy, the local-only storage claim fails if anything starts
using `chrome.storage.sync`, and the draft disclosure must stay.

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
