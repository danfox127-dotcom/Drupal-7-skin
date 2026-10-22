import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.json'
import { resolveVarys } from './src/lib/varys/config'

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

/** The Varys app as `npm run dev` serves it. Only ever added to a non-production build. */
const DEV_VARYS_APP_ORIGIN = 'http://localhost:3000'

export default defineConfig(({ mode }) => {
  /**
   * Which web pages may message the extension, for the Varys connect hand-off.
   *
   * A production build names the Varys app and nothing else; tests/packaging.spec.ts
   * pins that to the exact list and bans localhost. A development build adds the local
   * app. Declaring this key raises no install or update permission warning: it takes
   * no permission, and only lets the listed pages call chrome.runtime.sendMessage.
   * (Measured, not assumed: chrome.management.getPermissionWarningsByManifest returns
   * the same three warnings for this manifest with and without the key.)
   *
   * It must agree with what the code compares a sender against, so the same list is
   * written back into VITE_VARYS_APP_ORIGINS below (`define`). Otherwise a development
   * build would let the local app through Chrome and then refuse it in the worker.
   * loadEnv is needed because this file runs in Node, where import.meta.env does not
   * exist.
   */
  const { appOrigins } = resolveVarys(loadEnv(mode, process.cwd(), 'VITE_'))
  const connectable = mode === 'production'
    ? appOrigins
    : [...new Set([...appOrigins, DEV_VARYS_APP_ORIGIN])]

  return {
    define: {
      'import.meta.env.VITE_VARYS_APP_ORIGINS': JSON.stringify(connectable.join(',')),
    },
    plugins: [
      react(),
      crx({
        manifest: {
          ...manifest,
          name: EXTENSION_NAME,
          externally_connectable: { matches: connectable.map(origin => `${origin}/*`) },
        },
      }),
    ],
    build: {
      // Vite emits <link rel="modulepreload" crossorigin> for the popup's chunks.
      // Extension pages load them in a different credentials mode, so Chrome
      // discards the preload ("cross-world extension resource mismatch") and
      // refetches. Assets are local to the extension, so preloading gains
      // nothing — disable it rather than warn on every popup open.
      modulePreload: false,
    },
  }
})
