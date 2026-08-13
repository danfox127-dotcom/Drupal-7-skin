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

## Loading the extension in Chrome

The `manifest.json` in the repo root is a **source** manifest for `@crxjs/vite-plugin`.
Chrome cannot load it directly — it points at `.tsx` files. You must build first and
load the generated `dist/` folder.

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

The `file://*/*` content-script match lets the extension run on local HTML files; the
tests no longer need it. To use it manually, enable **Allow access to file URLs** on the
extension's details page.
