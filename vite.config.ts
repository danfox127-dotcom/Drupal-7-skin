import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.json'

/**
 * The real extension name, applied only to the BUILT manifest.
 *
 * manifest.json in the repo root is a source manifest for @crxjs/vite-plugin: its
 * entry points are `.ts` and `.tsx`, which Chrome cannot execute. Loading that folder
 * fails in the worst possible way — Chrome accepts the manifest, shows the extension as
 * enabled with no error, and registers no service worker, so it sits there inert. Someone
 * downloaded the GitHub source zip, loaded it twice, and got exactly that: a card that
 * looked installed and did nothing.
 *
 * So the source manifest's own `name` is a warning string, and the product name is
 * reattached here. Load the wrong folder now and chrome://extensions names the mistake.
 *
 * Consequence worth knowing: editing `name` in manifest.json changes the warning, NOT the
 * shipped name. Change it here. tests/packaging.spec.ts asserts both halves.
 */
const EXTENSION_NAME = 'D7 Admin Proxy UI'

export default defineConfig({
  plugins: [
    react(),
    crx({ manifest: { ...manifest, name: EXTENSION_NAME } }),
  ],
  build: {
    // Vite emits <link rel="modulepreload" crossorigin> for the popup's chunks.
    // Extension pages load them in a different credentials mode, so Chrome
    // discards the preload ("cross-world extension resource mismatch") and
    // refetches. Assets are local to the extension, so preloading gains
    // nothing — disable it rather than warn on every popup open.
    modulePreload: false,
  },
})
