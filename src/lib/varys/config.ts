/**
 * Where Varys is, as far as the extension's own code is concerned.
 *
 * The values are fixed at BUILD time. vite.config.ts resolves them (see ./resolve.ts) and
 * writes them into `import.meta.env.VITE_VARYS_API` and `VITE_VARYS_APP_ORIGINS` with
 * `define`, so this file reads exactly what the build decided and nothing from the
 * environment around it. A released extension can only talk to the hosts it was built with.
 *
 * A production build is always the two production hosts below, whatever is exported or
 * written in a .env file; only a development build can point elsewhere. Outside a Vite
 * build (the specs, which import this directly) there is no `import.meta.env`, and the
 * fallback is production, the safe direction.
 *
 * Every host named in src/ must also be named in docs/PRIVACY.md, which
 * tests/packaging.spec.ts enforces by scanning string literals.
 */

/** The Varys API origin in a production build, no trailing slash. */
export const PRODUCTION_API = 'https://varys.fly.dev';

/** The Varys web app origins in a production build. The first is where Connect opens. */
export const PRODUCTION_APP_ORIGINS: readonly string[] = ['https://varys-wine.vercel.app'];

// Optional chaining, because outside a Vite build `import.meta.env` does not exist.
const api: string | undefined = import.meta.env?.VITE_VARYS_API;
const apps: string | undefined = import.meta.env?.VITE_VARYS_APP_ORIGINS;

/** The Varys API origin, no trailing slash. */
export const VARYS_API: string = api || PRODUCTION_API;

/** Origins of the Varys web app. The first is where the connect page is opened. */
export const VARYS_APP_ORIGINS: string[] = apps
  ? apps.split(',').filter(origin => origin !== '')
  : [...PRODUCTION_APP_ORIGINS];
