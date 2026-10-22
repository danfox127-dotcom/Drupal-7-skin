import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.json'
import { assertProductionVarys, resolveVarys } from './src/lib/varys/resolve'

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

export default defineConfig(({ mode }) => {
  /**
   * Which Varys this build talks to, and which web pages may message the extension.
   *
   * A production build is the production hosts and nothing else: the environment is not
   * read (resolveVarys), and the build FAILS if it ever resolves to anything different
   * (assertProductionVarys). A development build defaults to the local app and API, and
   * VITE_VARYS_API / VITE_VARYS_APP_ORIGINS may override them. See src/lib/varys/resolve.ts
   * for why: `npm run release` runs this build and no test.
   *
   * The result is written into the code with `define`, so the origins the manifest lists
   * and the origins the worker accepts a sender from are one list by construction.
   * Declaring externally_connectable raises no install or update permission warning: it
   * takes no permission, and only lets the listed pages call chrome.runtime.sendMessage.
   * (Measured, not assumed: chrome.management.getPermissionWarningsByManifest returns the
   * same three warnings for this manifest with and without the key.)
   *
   * loadEnv is needed because this file runs in Node, where import.meta.env does not exist.
   */
  const varys = resolveVarys(mode, loadEnv(mode, process.cwd(), 'VITE_'))
  if (mode === 'production') assertProductionVarys(varys)

  return {
    define: {
      'import.meta.env.VITE_VARYS_API': JSON.stringify(varys.api),
      'import.meta.env.VITE_VARYS_APP_ORIGINS': JSON.stringify(varys.appOrigins.join(',')),
    },
    plugins: [
      react(),
      crx({
        manifest: {
          ...manifest,
          name: EXTENSION_NAME,
          externally_connectable: { matches: varys.appOrigins.map(origin => `${origin}/*`) },
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
