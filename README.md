# Drupal-7-skin
Use this browser extension to make it easier to navigate drupal 7

## Which sites it runs on

```
*://*.columbiadoctors.org/{admin,node}/*
*://*.columbia.edu/{admin,node}/*
```

The `columbia.edu` wildcard covers **every** Columbia subdomain — `vagelos`, `cuimc`, the
apex domain, and any new Drupal 7 site — with no manifest edit, rebuild, or reload.
`columbiadoctors.org` is a separate TLD, so it is listed explicitly.

Only `/admin/*` and `/node/*` paths match: the wildcard widens the host, not the paths, so
ordinary Columbia pages are untouched. Lookalike domains (`notcolumbia.edu`) and
suffix-spoofs (`columbia.edu.evil.com`) do not match — Chrome anchors `*.` to a real domain
boundary, and `tests/extension.test.ts` asserts it.

To add a site on a different domain, add two patterns to both `host_permissions` and
`content_scripts.matches` in `manifest.json`, rebuild, and reload. The UI itself needs no
per-site configuration — it reads the rendered form, so any Drupal 7 site with the same
admin markup works as-is. The **Log Form Schema** toggle prints what a new site parses.

## Installing it

**If you just want to use the extension, see [docs/INSTALL.md](docs/INSTALL.md).** The
short version:

1. Open **[the latest release](../../releases/latest)**
2. Under **Assets**, download `d7-studio-extension-<version>.zip`
3. Unzip it
4. Go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and
   select the unzipped folder

> **Do not use the green "Code → Download ZIP" button.** That gives you the source, which
> has no `dist/` folder and a manifest pointing at TypeScript. Chrome accepts it, shows the
> extension as enabled, registers no service worker, and does nothing at all — no error
> message to tell you why. If you have an extension installed that is named
> **"DO NOT LOAD"**, that is what happened: remove it and download the release asset.

## Building it from source

Only needed to develop, or to run a build that has not been released yet.

The `manifest.json` in the repo root is a **source** manifest for `@crxjs/vite-plugin`.
Chrome cannot load it — it points at `.ts` and `.tsx` files. Its `name` is deliberately
`"DO NOT LOAD - build first, then load dist/"` so that loading the wrong folder says so;
`vite.config.ts` reattaches the real name to the built manifest. Change the shipped name
there, not here.

```bash
npm install
npm run build
```

Then in Chrome:

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the **`dist/`** folder — not the repo root

For iterative development, `npm run dev` writes the same `dist/` folder and adds
hot reload; keep the unpacked extension pointed at `dist/` and it will pick up changes.

## Testing

```bash
npm run build   # the extension tests load dist/, so build first
npm test
```

The suite serves the fixtures in `tests/fixtures/` at real Drupal-shaped URLs on a host
the manifest matches, so the content script's URL guards and the `host_permissions`
patterns are both genuinely exercised.

If `npx playwright install` has not been run, or the installed Chromium does not match
the version this Playwright expects, point `CHROME_PATH` at an existing browser instead
of downloading one:

```bash
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm test
```

The content script used to also match `file://*/*`, so it would run on local HTML files.
That was removed when the extension was prepared for the Chrome Web Store: it granted
access to every file on the machine for a capability normal use never touches, and no test
needed it — the suite serves fixtures over https at Drupal-shaped URLs. The chromium-project
specs still open fixtures over `file://`, but they inject the bundle with `addScriptTag`
rather than loading the extension, so they are unaffected.

`tests/packaging.spec.ts` asserts the pattern stays out, and that every content-script
match is restricted to an `/admin/*` or `/node/*` path.
