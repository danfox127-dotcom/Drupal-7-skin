# Privacy Policy — D7 Studio (D7 Admin Proxy UI)

**Last updated:** 16 September 2026
**Applies to:** the "D7 Admin Proxy UI" Chrome extension, all versions from 0.2.2

## The short version

This extension collects nothing, transmits nothing about you, and has no server. It
reads the administrative page you have open, stores your own settings and drafts on your
own computer, and makes network requests only to the site you are already using and to
one fixed URL that tells it whether a newer version exists.

There is no analytics, no telemetry, no tracking, no advertising, and no third-party
service of any kind. The source is public and can be read at
<https://github.com/danfox127-dotcom/Drupal-7-skin>.

## What it reads

**The Drupal administrative page you have open.** The extension only runs on addresses
matching `*://*.columbia.edu/admin/*`, `*://*.columbia.edu/node/*`, and the same two
paths on `*://*.columbiadoctors.org`. On every other page — including the public side of
those same sites — it does not run at all. On the pages where it does run, it reads the
form and page content in order to redraw the interface. That reading happens in your
browser and the result stays there.

**A page you explicitly ask it to import.** If you add a URL to the import queue and
click it, the extension fetches that page so it can propose values for the Drupal form in
front of you. Before this happens Chrome asks your permission for that specific website,
and you have to approve it. The extension holds no standing permission to read other
sites: the `*://*/*` entry in its manifest is an *optional* permission, requested one
origin at a time at the moment you use it, and never granted at install.

That fetch is made **without cookies or credentials**, so it retrieves the page as an
anonymous visitor would and cannot reach anything private on the source site.

## What it stores, and where

Everything is stored using `chrome.storage.local`, which keeps data **on this computer
only**. The extension does not use `chrome.storage.sync`, so nothing is copied to your
Google account or to any other device.

| What | Why |
|---|---|
| Your feature toggles | So your settings persist between sessions |
| Your import queue — the list of URLs you added | So a batch survives closing the popup |
| A cached index of a site's menu items (titles and paths) | So searching a large menu does not re-fetch it every visit |
| The result of the last update check | So the popup can tell you a new version exists |
| **Local drafts of nodes you are editing** | See below |

### About drafts

When the **Two-Pane Node Editor** is enabled — it is off by default and you must switch
it on — the editor keeps a local draft of the field values you are working on, keyed by
the site and node id. This is so that closing a tab does not lose your work.

Two things worth being clear about:

- **Drafts are local only.** They are never sent anywhere. Only pressing "Save draft to
  Drupal" or "Publish" writes anything to the website, and those actions use Drupal's own
  form, as if you had clicked its buttons yourself.
- **Drafts contain the content you typed**, which may include unpublished material. They
  stay in your browser's local storage until the draft is discarded or the extension is
  removed. If you share a computer, treat them the way you would treat an unsaved
  document.

## What leaves your computer

Exactly three kinds of request, and no others:

1. **Requests to the Drupal site you are already logged into**, to read a page's public
   HTML or to load the full list of a menu's items. These go to the same site you are
   already using, and are the same requests your browser would make if you visited those
   pages yourself.
2. **A request to a page you asked to import**, only after you approved that specific
   site, and sent without cookies.
3. **One request to check for updates**, to this fixed address:

       https://raw.githubusercontent.com/danfox127-dotcom/Drupal-7-skin/main/latest.json

   This is a plain GET for a small JSON file. It sends no information about you, your
   browsing, or the pages you have open — it only asks "what is the newest version".
   GitHub, like any web server, will see the IP address the request came from. This
   happens when the browser or the extension starts, not continuously.

Nothing else is contacted. No data about you, your pages, your drafts, or your Drupal
content is transmitted to the author of this extension or to anyone else. There is no
server to transmit it to.

## Clipboard

The "copy this node's public HTML" feature writes to your clipboard when you click it.
The extension does not read your clipboard.

## Data sharing and sale

None. No data is collected, so none is shared, sold, transferred, or used for advertising,
credit assessment, or lending. Nothing is used for any purpose unrelated to the
extension's single purpose: providing a faster administrative interface for Drupal 7
websites at Columbia University.

## How to remove everything

Removing the extension from `chrome://extensions` deletes all of its local storage,
including settings, the import queue, cached menus, and any saved drafts. Nothing is left
behind, and nothing exists elsewhere to delete.

## Children

The extension is a tool for staff administering university websites. It is not directed
at children and collects no information from anyone.

## Changes to this policy

Changes will be committed to this file in the public repository, so its full history is
visible at
<https://github.com/danfox127-dotcom/Drupal-7-skin/commits/main/docs/PRIVACY.md>.

## Contact

Open an issue at <https://github.com/danfox127-dotcom/Drupal-7-skin/issues>, or contact
the maintainer through the Chrome Web Store listing.
