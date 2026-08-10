import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.json'

export default defineConfig({
  plugins: [
    react(),
    crx({ manifest }),
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
