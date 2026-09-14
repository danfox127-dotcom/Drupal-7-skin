# Installing D7 Studio

For someone who has not used GitHub before. No terminal, no accounts, nothing to build.
About five minutes.

You need Google Chrome (or Edge — same steps). The extension is not in the Chrome Web
Store, so it installs from a folder on your computer. That is normal and supported; it
just takes a few more clicks.

---

## Step 1 — Download the right file

Open this page: **[the latest release](../../releases/latest)**

Scroll down to the **Assets** section and click:

```
d7-studio-extension-0.2.0.zip
```

The version number will be higher over time. That is the file you want.

> ### The one thing that goes wrong
>
> On the main GitHub page there is a green **Code** button with a **Download ZIP** option.
> **Do not use it.** It gives you the extension's *source code*, which Chrome cannot run.
>
> The frustrating part is that Chrome does not tell you. It accepts the folder, shows the
> extension in your list as enabled, and then does nothing whatsoever — no error, no
> warning, no overlay on Drupal pages.
>
> If you already did this, you will see an extension named **"DO NOT LOAD - build first,
> then load dist/"** in your list. Remove it and come back to Step 1. Nothing is broken;
> you just have the wrong file.

## Step 2 — Unzip it

Double-click the downloaded `.zip`.

- **Mac:** you get a folder next to the zip, named the same thing.
- **Windows:** right-click the zip, choose **Extract All…**, then **Extract**.

Open the folder and confirm you see a file called **`manifest.json`** sitting right there
alongside a folder called `assets`. If instead you see another folder that you have to
open first, use that inner folder in Step 4 — Chrome needs the folder that directly
contains `manifest.json`.

**Put this folder somewhere permanent** — Documents, not Downloads. Chrome reads it from
this location every time it starts. If you delete it or empty your Downloads folder, the
extension stops working.

## Step 3 — Open Chrome's extensions page

Copy this into Chrome's address bar and press Enter:

```
chrome://extensions
```

In the **top right** of that page, turn on **Developer mode**. Three buttons appear at the
top left.

## Step 4 — Load the folder

1. Click **Load unpacked** (top left)
2. Navigate to the folder from Step 2
3. Select the folder itself — do **not** open it and pick a file inside
4. Click **Select** / **Open**

A card appears reading **D7 Admin Proxy UI**.

## Step 5 — Check it worked

On the extension's card, look for the line reading **service worker**.

- Just **service worker** — working.
- **service worker (Inactive)** — you loaded the wrong folder. Go back to Step 1.

Now visit any page on a Columbia Drupal 7 site under `/admin/` or `/node/` — for example a
node edit form. The interface should appear. Click the extension's icon in the toolbar for
quick links and settings.

If you see nothing, reload the page once. Chrome does not apply a newly installed
extension to tabs that were already open.

---

## Keeping it up to date

The extension checks for new versions on its own and tells you when one exists. Chrome
cannot update a folder-installed extension automatically, so updating is manual — and it
is the same steps you just did:

1. Download the new zip from **[the latest release](../../releases/latest)**
2. Unzip it
3. **Replace** the old folder with the new one, keeping the same location and name
4. Back on `chrome://extensions`, click the **reload** icon (↻) on the extension's card

Replacing the folder in place matters. If you load the new folder from a new location,
Chrome treats it as a second, separate extension and you end up running both.

---

## If something is wrong

**"Manifest file is missing or unreadable"** — you selected a folder that does not directly
contain `manifest.json`. Look one level deeper, or one level up.

**The card says "DO NOT LOAD"** — the source zip, from the green Code button. Remove it and
start at Step 1.

**Installed, but nothing appears on Drupal pages** — three things to check, in order:

1. Reload the Drupal page. Already-open tabs do not get a new extension.
2. Confirm the URL contains `/admin/` or `/node/`. The extension deliberately ignores
   every other page, including the site's home page.
3. Confirm the card says **service worker** and not **service worker (Inactive)**.

**It disappeared after restarting Chrome** — the folder moved, was renamed, or was deleted.
Chrome needs it to stay where it was when you loaded it.

**A red "Errors" button on the card** — click it and send the text to whoever maintains
this. That is a real bug, not an install problem.
