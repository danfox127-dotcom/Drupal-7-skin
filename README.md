# Drupal-7-skin
Use this browser extension to make it easier to navigate drupal 7

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

`npm test` runs the Playwright suite against the fixtures in `tests/fixtures/`.
The `file://*/*` content-script match in the manifest exists for those fixtures — if
you want the extension to run on local HTML files manually, enable **Allow access to
file URLs** on the extension's details page.
