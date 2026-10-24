# Privacy Policy — D7 Studio (D7 Admin Proxy UI)

**Last updated:** 22 October 2026
**Applies to:** the "D7 Admin Proxy UI" Chrome extension, all versions from 0.2.2. The
section "If you connect it to Varys" applies only to versions that have a **Connect to
Varys** button; earlier versions have no such connection and send nothing to Varys. What it
says about suggestions applies only to versions that show the Varys suggestions panel in the
edit form; earlier versions never ask Varys for suggestions.

## The short version

This extension collects nothing and transmits nothing about you, unless you connect it to
Varys, and it has no server of its own. It reads the administrative page you have open,
stores your own settings and drafts on your own computer, and makes network requests only
to the site you are already using and to one fixed URL that tells it whether a newer
version exists.

**The one exception is optional, and it is off until you connect it.** If you click
**Connect to Varys**, the extension also sends a summary of each page you save in Drupal, on
a site Varys tracks, to Varys, Columbia's content-intelligence service, so that Varys can
log your search edits. It also sends the public address of a page when you open that page's
edit form, or press **Ask Varys**, so that Varys can offer its suggestions for the page.
Until you click that button, nothing is sent to Varys. The section "If you connect it to
Varys" says exactly what is sent, where it goes, what the extension keeps on your computer,
and how long Varys keeps it.

There is no analytics, no telemetry, no tracking, and no advertising. The source is public
and can be read at <https://github.com/danfox127-dotcom/Drupal-7-skin>.

## What it reads

**The Drupal administrative page you have open.** The extension only runs its interface
and reads forms on addresses matching `*://*.columbia.edu/admin/*`,
`*://*.columbia.edu/node/*`, and the same two paths on `*://*.columbiadoctors.org`. On
every other page — including the public side of those same sites — it does not run its
interface and does not read the page. On the pages where it does run, it reads the form
and page content in order to redraw the interface. That reading happens in your browser and
the result stays there, with one exception: if you have connected the extension to Varys,
a summary of the node form you save is sent to Varys, as described below.

**The Varys suggestions panel, only if you have connected it to Varys.** On the edit form of
a page that already exists, on a site Varys tracks, the extension can draw a small panel of
Varys's suggestions for that page. To show each suggestion beside what the form holds now, it reads the current
values of the form's title, search title and search description fields (and Summary, which
some sites use as the search description) in your browser. That reading stays in your
browser; what is sent when you save is listed below. When you press **Insert at cursor**, it
also asks the body's editor whether it has a cursor, and reads nothing else from the editor.
If the edit form does not show the page's public address, and the list of sites Varys last
gave the extension says this site is one it tracks, it opens that page in the background on
the same site (a request to the Drupal site, not to Varys; it never follows a redirect to
another site) and reads only the address the page gives for itself, so that it asks Varys
about the right page.

**One more place, and only if you have connected it to Varys.** After you save, Drupal
usually sends you on to the page's public address, which is outside those paths. There the
extension can show its small result notice, which says whether Varys logged the save and
offers Undo or Log it anyway. To show it, the extension draws a box on that page; it does
not read the page. It can do this on any page of the `columbia.edu` and
`columbiadoctors.org` hosts above, because Chrome ignores the path of a host permission
when an extension adds something to a page through its scripting API.

**Tabs it follows, and only if you have connected it to Varys.** Chrome tells the extension
when any tab changes address, and it ignores those for every tab it is not following. It
follows a tab in two cases, and in both it looks only at the host and path of the tab's
address (and at whether the form's own address carries a `destination`, which says where
Drupal will send you after saving). A tab with a node form open is followed until it goes
to another page of the same site, closes, or saves; a detour to another site or to the
login page does not end it. Nothing is sent for this, and it is how a Preview, or a save
Drupal rejected, can be compared with the page as it first opened. A tab you pressed Save
in is followed until that save has finished loading, to learn whether it went through and
where it landed; the address it landed on is the page address sent with the save, as listed
below. When you are not connected there is nothing to follow, and it follows nothing.

**A page you explicitly ask it to import.** If you add a URL to the import queue and
click it, the extension fetches that page so it can propose values for the Drupal form in
front of you. Before this happens Chrome asks your permission for that specific website,
and you have to approve it. The extension holds no standing permission to read other
sites: the `*://*/*` entry in its manifest is an *optional* permission, requested one
origin at a time at the moment you use it, and never granted at install.

That fetch is made **without cookies or credentials**, so it retrieves the page as an
anonymous visitor would and cannot reach anything private on the source site.

## What it stores, and where

Your settings, drafts, copied pages and the other items in the table below are stored using
`chrome.storage.local`, which keeps data **on this computer only**.
The extension does not use `chrome.storage.sync`, so nothing is copied to your Google
account or to any other device. If you connect it to Varys it stores a little more, some of
it locally, some of it only for the browser session, and one short marker in the tab itself;
that is listed in its own section below.

| What | Why |
|---|---|
| Your feature toggles | So your settings persist between sessions |
| Your import queue — the list of URLs you added | So a batch survives closing the popup |
| A cached index of a site's menu items (titles and paths) | So searching a large menu does not re-fetch it every visit |
| The result of the last update check | So the popup can tell you a new version exists |
| **Local drafts of nodes you are editing** | See below |
| **Pages you copied to paste onto another site** | See below |
| Only if you connect it to Varys: your Varys key and email, a queue of saves waiting to be sent, and a notice | See "If you connect it to Varys" |

### About drafts

When the **Two-Pane Node Editor** is enabled — it is off by default and you must switch
it on — the editor keeps a local draft of the field values you are working on, keyed by
the site and node id. This is so that closing a tab does not lose your work.

Two things worth being clear about:

- **Drafts are local only.** The draft the editor keeps is never sent anywhere. Only
  pressing "Save draft to Drupal" or "Publish" writes anything to the website, and those
  actions use Drupal's own form, as if you had clicked its buttons yourself. (If you are
  connected to Varys, a save to Drupal is also what Varys is told about, as described
  below. The local draft is not.)
- **Drafts contain the content you typed**, which may include unpublished material. They
  stay in your browser's local storage until the draft is discarded or the extension is
  removed. If you share a computer, treat them the way you would treat an unsaved
  document.

### About copied pages

The **Copy this page for pasting on another site** command reads the node edit form you
have open and stores its field values locally, so you can fill in a form on a different
Drupal site without retyping everything. The popup lists what is currently held, with a
Clear button.

The same cautions as drafts apply, and one more:

- **A copied page contains that page's content**, which may include unpublished material.
  Up to five copies are kept; a sixth pushes out the oldest. They stay in local storage
  until you clear them, until they are pushed out, or until the extension is removed.
- **Copies never leave this computer.** Pasting fills the form in front of you and
  nothing more — you still press Save yourself, using Drupal's own button.
- **Images are not copied.** The extension lists the source page's image filenames and
  URLs so you can re-attach them, because an attached file is identified by a number that
  only means something on the site it came from. No image file is downloaded, uploaded, or
  stored by the extension.

## What leaves your computer

Three kinds of request, and a fourth that exists only if you connect it to Varys:

1. **Requests to the Drupal site you are already logged into**, to read a page's public
   HTML (for the Varys panel, only the address a page gives for itself, as described above),
   to load the full list of a menu's items, or — when pasting a copied page — to
   ask that site whether it has a term or page being referenced, so a value it cannot
   resolve is left blank instead of breaking the form. These go to the same site you are
   already using, and are the same requests your browser would make if you used its own
   autocomplete boxes. A request to any other site is refused.
2. **A request to a page you asked to import**, only after you approved that specific
   site, and sent without cookies.
3. **One request to check for updates**, to this fixed address:

       https://raw.githubusercontent.com/danfox127-dotcom/Drupal-7-skin/main/latest.json

   This is a plain GET for a small JSON file. It sends no information about you, your
   browsing, or the pages you have open — it only asks "what is the newest version".
   GitHub, like any web server, will see the IP address the request came from. This
   happens when the browser or the extension starts, not continuously.
4. **Requests to Varys, only after you click Connect to Varys.** They are described in the
   next section. Until you click it, there are none.

Nothing else is contacted. Unless you connect it to Varys, no data about you, your pages,
your drafts, or your Drupal content is transmitted to anyone: not to the maintainer of
this extension and not to any other party, and the extension has no server of its own to
transmit it to. If you do connect it, the only place anything goes is Varys, and only what
the next section lists.

### One link, which is not a request

If you are running a hand-installed copy, the popup may offer a link to this
extension's page on the Chrome Web Store, at `chromewebstore.google.com`. That is a
link you click, not a request the extension makes: nothing is sent to that address
unless you choose to follow it, and following it is an ordinary browser navigation.
Copies installed from the store do not show it, and do not check for updates at all —
Chrome keeps them current.

## If you connect it to Varys

Varys is the content-intelligence service used by Columbia's web teams, run by the same team
that maintains this extension. It runs on Fly.io (its API), Vercel (its web app) and
Supabase (its database). Data sent to Varys is stored by
Varys and those hosting providers, shown to people signed in to Varys with access to that
site, and given to no one outside Varys. The extension can optionally be connected to it,
so that Varys can log the search edits you make in Drupal (a changed title, search
description, page address, heading or internal link, or a substantial rewrite of the body)
and later check whether they went live. It also lets Varys show you its suggestions for a
page while you edit it: a search title, search description, title and section headings,
which you can use with a click. And on a new page's form it lists the drafts you made in
Varys's Draft Assistant for that site, so that you can fill the new page in from one.

**This is off until you connect it.** Unless you click **Connect to Varys** in the popup,
nothing is sent to Varys, no form is recorded, no suggestions or drafts are asked for, no
tab is followed on its behalf, and nothing is stored for it.

### The two addresses, and how connecting works

- **`https://varys.fly.dev`** is Varys's server (its API). It is the only address the
  extension sends anything to for this feature. Every request carries your key (below) and
  no cookies.
- **`https://varys-wine.vercel.app`** is the Varys web app, where you sign in. The
  extension makes no request to it, apart from opening it in a tab when you click Connect
  to Varys (the address includes the extension's own id, so the page knows which extension
  to hand the key to). The connect page can send one message to the extension, to hand
  over the key, through Chrome's `externally_connectable` feature. Only pages at that exact
  origin can do so, and the extension checks the sender again itself and refuses any other.
  The drafts panel also has an **Open Draft Assistant** link to the web app: an ordinary
  link, which opens only if you click it.

To connect, you click **Connect to Varys**; Chrome asks whether the extension may contact
`https://varys.fly.dev`, which you must approve (this is the optional `*://*/*`
permission, requested for that one address and never granted at install); a Varys page
opens, where you sign in and press **Allow**; and that page gives the extension a **key**.
The key is a long random secret that stands for your Varys account in this browser. Varys
keeps only a hash of it. It expires after 90 days without use.

### What is sent each time you save

When you press a Save button on a Drupal node form, the extension waits for Drupal to
finish saving. If the save went through, and the page is on a site Varys tracks, it sends
one request to `https://varys.fly.dev` containing exactly this:

- **The page's public address**, its Drupal **node id** when it has one, and its **content
  type** (Drupal's machine name for it, such as `news`).
- **The page before your edit** (as the form first opened; empty for a new page) **and
  after it**. Each is limited to the title, the search title (meta title), the search
  description (meta description), the **Summary** field (which some sites use as the search
  description; included when the form has one), the page's web address (its **URL alias**, sent
  as the form holds it, including when Drupal makes it automatically), the body's headings
  (H2 and H3, with their text), the body's links to pages on the same site, and a count of
  the body's words.
- **How much of the body changed**, as one number between 0 and 1.
- **Up to three new sentences** from the body, at most 200 characters each. Varys looks for
  them on the live page to confirm that the change went live, which is the only way to
  confirm an edit that changed nothing but the body.
- **Which fields you filled from Varys**, if any: some of the page title, search title,
  description (Summary, for a new page) and headings, as the suggestions panel described below
  filled them, and the body and Related Profiles, as the drafts panel on a new page filled
  them. Only those six names are sent, and a field you put back with Undo is not listed.
  Varys shows it beside the change.
- **Which button you pressed**: Publish, Save draft, or a plain Save.
- **Who saved it, and when.** The request carries your key, and Varys knows which account
  the key belongs to; the extension does not send your name or email with it. Varys records
  the time it received the save.

**The full body text is never sent.** The body is read in your browser, and only its
headings, links, word count, the measure of how much changed, and those few sentences leave
it. No other field of the form is sent, and neither are images, your Drupal login, or any
cookie.

Other kinds of request go to the same address, each carrying your key and only what is
noted:

- **A list of the sites Varys tracks.** Before sending a save, the address of a page for
  suggestions, or a site's address for drafts, the extension asks Varys which sites it
  tracks, so that nothing is sent about a page on any other site. The answer is cached for
  24 hours in the browser session. If Varys cannot be asked, the save is sent anyway and
  Varys discards it, keeping nothing, when the site is not one it tracks. A page's address
  for suggestions, and a site's for drafts, are different: when the extension has no list
  at all and cannot get one, it sends nothing.
- **Suggestions, when you open a page's edit form.** On the edit form of a page that already
  exists on a site Varys tracks, the extension sends the **page's public address**, in the
  address of the request, to ask for the suggestions Varys already has for that page.
  Nothing from the form goes with it, and nothing is sent for a site Varys does not track.
  A new page's form (an add form) asks for no suggestions; it asks for your drafts instead,
  as described below.
- **Ask Varys.** When you press **Ask Varys** in the panel, the extension sends the page's
  public address, so that Varys can write suggestions for it. While Varys writes them, the
  extension asks again with the same address every few seconds, for up to 3 minutes. Nothing
  from the form is sent for this; Varys writes the suggestions from its own reading of the
  site.
- **Your drafts, when you open a new page's form.** On the form for a new page (an add
  form) on a site Varys tracks, the extension asks Varys for **your** recent drafts for
  that site: the ones you made in Draft Assistant. Only the **site's address** is sent (for
  example `https://www.cuimc.columbia.edu/`, in the address of the request), never anything
  from the form, and Varys answers with your drafts alone. When you pick one, the extension
  sends the same address and that draft's id, to fetch the draft you picked. Nothing is
  asked for an existing page's edit form, or for a site Varys does not track.
- **Undo and Log it anyway.** Pressing either sends the number of that save.
- **Disconnect.** Asks Varys to cancel your key.

Nothing is sent for a save that Drupal rejected (the form came back with an error), for the
Preview, Delete and Cancel buttons, for a save that landed on the login page or on another
site, for a new page whose address the extension cannot work out, or for any save made
while you are not connected. No address is sent for suggestions while you are not connected,
for a page on a site Varys does not track, for an add form, or when the extension cannot
tell which sites Varys tracks. No drafts are asked for while you are not connected, on an
existing page's edit form, for a site Varys does not track, or when the extension cannot
tell which sites Varys tracks.

### What comes back: the suggestions panel

Varys answers a suggestions request with three things and nothing else: its suggestions for
the page (a search title, a search description, a page title and section headings, an
optional clinical review note, and when Varys made them), its own copy of the page's
current title, search title, search description and headings, from Varys's last read of the
page, and the names of any doctors the page's article names, as Columbia's physician
directory has them (the list may be empty). The panel shows the suggestions beside what the form holds now, and shows the headings
from Varys's copy as the headings on the page now. The extension does not store the answer:
it is held in the page only while the panel is open.

- **It fills a form field only when you press Use** (or Add, for a doctor: see below), and
  only the page title, search title or search description (or Summary, when the page's
  description follows it). It never
  presses Save or Publish: you press Save yourself, using Drupal's own button. **Undo** puts
  the old text back, for as long as the field still holds the fill. Using a suggested title
  also touches the page's web address, so that it stays as it is: if Drupal's "Generate
  automatic URL alias" is ticked, it unticks it; it turns the address box on if it was off;
  and, if the box was empty, it puts the page's current web address into it. Undo puts
  those back unless you have typed a different address since. If the extension cannot tell
  the page's current address, it will not change the title.
- **Headings** can be copied to your clipboard, or put into the body as a heading at the
  editor's cursor when you press **Insert at cursor**. That is the only thing the panel
  writes into the body: it puts that heading's text into the body's editor in your browser,
  and reads nothing from the editor but whether it has a cursor. The panel has no Undo for
  it; the editor's own undo reverses it. Insert at cursor is reported with the next save as
  a filled field ("headings"); Copy is not reported.
- **Doctors the article names.** When the form has a Related Profiles field, the panel lists
  each doctor Varys found named in the page's article who is not already in that field, with
  **Add**. Pressing Add looks the name up in the Related Profiles field's own search on the
  Drupal site you are on, as typing the name would (a request to that site, with your Drupal
  login, and to no other), and puts the doctor in a row only when exactly one profile has
  exactly that name; otherwise it adds nobody and says so. Nothing is sent to Varys for it:
  the names came with the suggestions. **Undo** empties the row Add filled, for as long as the
  row still holds it. It never presses Save. An Add is reported with the next save made
  without a reload in between as a filled field ("related_profiles"), unless you put it back
  with Undo; a Preview, or a save Drupal rejects, reloads the form and ends Undo for it.

### What comes back: drafts on a new page

Varys answers the list with each of your drafts' names and when you made them, and nothing
else. When you pick one, it answers with that draft as Draft Assistant left it: the title
you confirmed (if you did), the body with Varys's links, the points for its Overview box, a
Summary, a search title, the doctors the draft names (each with the name Varys matched in
Columbia's physician directory, when it found one), and a count of the tables and images it
could not carry over. The extension does not store any of it: it is held in the page only
while the panel is open.

- **It fills a form field only when you press Fill**, and only the fields you leave ticked:
  the title, the body, Summary, the search title and Related Profiles. It never presses
  Save, Preview or Publish: you press Save yourself, using Drupal's own button. It never
  touches the page's web address or "Generate automatic URL alias"; Drupal makes the address
  when you save. **Undo** beside each field puts back what was there before, for as long as
  the field still holds the fill and the page has not reloaded: what Undo needs is held in
  the page, so a Preview or any Save ends it.
- **The body** is written into the body's editor in your browser. To choose how the Overview
  box looks, the extension first asks the editor whether its content filter keeps the
  site's blue Overview box; if it does not say yes, the box is a plain heading and list.
  Before the fill it reads the body the editor holds and keeps it in memory, in the page, so
  that Undo can put it back; after the fill it reads the body back from the editor, so that
  Undo can tell whether you have changed it since. None of this is stored or sent anywhere.
- **Related Profiles.** For each doctor you leave ticked, the extension looks the name up in
  the Related Profiles field's own search on the Drupal site you are on, as typing the name
  would (a request to that site, with your Drupal login, and to no other), and adds the
  doctor only when exactly one profile has exactly that name. Otherwise it adds nobody and
  says so.
- **The next save made without a reload in between reports what Fill filled**, as listed
  above: the title, the description (for Summary), the search title, the body and Related
  Profiles, leaving out any you put back with Undo. A Preview, or a save Drupal rejects,
  reloads the form: that ends Undo for those fills, and the save after it does not report
  them.

### What the extension keeps on your computer while you are connected

In `chrome.storage.local`, which survives closing the browser:

- **Your Varys key, the email of your Varys account, and when you connected.** The key
  is a credential for your Varys account. Only the extension's background script reads it;
  the popup is told your email and whether the connection has expired, never the key.
- **A queue of saves Varys could not take** (Varys unreachable, or your key expired), so
  they can be sent later: at most 50 saves, each kept for at most 7 days. Each is held
  as it would have been sent, with the email it was made under, and is only ever sent under
  that same person's key.
- **A notice**, when the result could not be shown on the page you landed on: its text, the
  site it is for, and when it was stored. It is shown once on the next admin page of that
  site, then deleted. After an hour it is no longer shown; it stays stored until a newer
  notice replaces it or you disconnect.

In `chrome.storage.session`, which Chrome clears when the browser closes:

- **The form as it first opened**, for each tab with a node form open, including the raw
  values of its fields and its body. These raw values are never sent to Varys. They are
  kept so that a Preview, or a save Drupal rejected, is compared with the page as it was
  rather than with your unsaved edit. With them is what you filled from Varys's suggestions
  on that form (each field's text before and after, whether the web address was kept, and
  whether a heading was inserted), so that Undo still works after a Preview or a rejected
  save; it is never sent to Varys either. They are removed when you go to another page of
  the same site, after a save goes through, or when the tab closes. A detour to another site or
  to the login page keeps them, for the save you make when you come back. Whatever is left
  is cleared when the browser closes.
- **Saves being followed across the page change**: the summary of a save you just made,
  held until the extension knows where Drupal landed and has sent it or queued it. If it
  never sees the save finish (for example, you closed the tab), it sends the save with the
  address the form knew, after a short wait, on a best-effort basis. There is no guarantee
  of when. If the browser closes first, that save is not sent and is not kept.
- **The list of sites Varys tracks**, cached for 24 hours.

In the tab's own `sessionStorage` (which belongs to that tab and lasts only as long as it
does; it is not synced anywhere and is not sent to Varys):

- **A marker that an Ask Varys is waiting**: the page's public address and the time you
  pressed **Ask Varys**. It lets a reload of the page within 3 minutes go on waiting for the
  suggestions instead of asking Varys again. It is removed when Varys answers and is ignored
  once it is 3 minutes old. It holds no key and nothing you typed. Disconnecting does not
  clear it, since it holds only an address and a time and stops counting after 3 minutes.

### How long Varys keeps what it receives

- **A page's edits that never counted as a search edit** (a typo fix, say) are not logged.
  Varys keeps them for 7 days after the last of them, so that **Log it anyway** can still
  use them, and then deletes them. Varys keeps one entry per page per day, so a save that
  does not count on its own but joins an entry that does is kept for as long as that entry.
- **An entry you undo** stops counting: Varys does not measure it, and What's Working shows
  it as "Undone". It is kept for up to 30 days after that page's last save, so that when
  Varys later detects the same change on the live page it dismisses it instead of raising it
  again, and then deleted.
- **A save that counts** is kept in Varys as part of its record of changes made to that
  site. People signed in to Varys with access to the site can see it on its What's Working
  page, with who made it and what changed. It stays until it is undone or an administrator
  removes it.
- **Your key** expires after 90 days without use.
- **Suggestion requests** are not saves: neither opening an edit form nor pressing Ask Varys
  is logged as an edit or appears on What's Working. Ask Varys makes Varys write suggestions
  for that page, which it keeps with that page's other Page Health suggestions, the ones
  Varys's own Page Health screen shows.

After a save, Varys also reads the saved page's public address to check that the change is
live. That request comes from Varys's own servers, not from the extension.

### Disconnecting

Click **Disconnect** in the popup. The extension asks Varys to cancel your key, then
deletes from this computer the key and email, the queue of waiting saves, any notice not
yet shown, the saves and forms it was following, and the cached list of sites, and gives
back its permission to contact Varys. If Varys cannot be reached, the extension still
forgets the key and says so; the key then keeps working on Varys until it is cancelled
there or expires.

You can also disconnect from the Varys side: **Your connections** on Varys's Drupal
extension page cancels a key. This browser keeps its copy until it next tries to use it and
is refused, so use Disconnect in the popup to clear it.

Disconnecting does not delete changes Varys has already logged. **Undo**, from the result
notice right after a save or from What's Working in Varys, makes a change stop counting: it
is shown as "Undone", kept for up to 30 days after that page's last save, and then
deleted.

## Clipboard

The "copy this node's public HTML" feature writes to your clipboard when you click it, and
so does **Copy** beside a heading in the Varys suggestions panel, which copies that heading.
The extension does not read your clipboard.

## Data sharing and sale

The extension sells nothing. Without the Varys connection it shares nothing with anyone: no
data is collected, so none is transferred anywhere. With it, the data described above goes
to Varys, the service you chose to connect, which is run by the team that maintains this
extension. It is stored by Varys and its hosting providers,
shown to people signed in to Varys with access to that site, and given to no one outside
Varys. None of it is used for advertising, credit assessment, or lending, or for any purpose
unrelated to the extension's single purpose: providing a faster administrative interface
for Drupal 7 websites at Columbia University, including, if you choose, logging your search
edits in Varys and showing Varys's suggestions for the page you are editing.

## How to remove everything

Removing the extension from `chrome://extensions` deletes all of its local storage,
including settings, the import queue, cached menus, copied pages, and any saved drafts,
and, if you connected it to Varys, your key and anything waiting to be sent.

If you connected it to Varys, **Disconnect first**. Removing the extension does not tell
Varys to cancel your key, which then stays valid until you cancel it on Varys or it expires
after 90 days unused, and Varys keeps what it has already logged for the periods above. If
you never connected it, nothing is left behind, and nothing exists elsewhere to delete.

## Children

The extension is a tool for staff administering university websites. It is not directed
at children. Apart from the optional Varys connection described above, which staff choose
to turn on, it collects no information from anyone.

## Changes to this policy

Changes will be committed to this file in the public repository, so its full history is
visible at
<https://github.com/danfox127-dotcom/Drupal-7-skin/commits/main/docs/PRIVACY.md>.

## Contact

Open an issue at <https://github.com/danfox127-dotcom/Drupal-7-skin/issues>, or contact
the maintainer through the Chrome Web Store listing.
