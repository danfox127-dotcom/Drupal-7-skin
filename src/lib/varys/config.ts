/**
 * Where Varys is.
 *
 * Production by default, and overridable at BUILD time for development:
 *
 *   VITE_VARYS_API=http://localhost:8000 npm run dev
 *
 * A build reads nothing at runtime, so a released extension can only ever talk to the
 * hosts it was built with. Every host named here must also be named in docs/PRIVACY.md,
 * which tests/packaging.spec.ts enforces by scanning string literals in src/.
 *
 * The app origins are decided in vite.config.ts and written back into
 * VITE_VARYS_APP_ORIGINS there, so the manifest's externally_connectable and the list
 * the worker checks a sender against are one list. A development build adds the local
 * app to it; a production build never does.
 *
 * Values are reduced to ORIGINS (scheme, host, port), because both are used to build
 * match patterns by appending "/*". A trailing slash would make that "//*", and a path
 * would make a pattern for part of the site, which Chrome grants as something narrower
 * than what the code then assumes it has.
 */

const PRODUCTION_API = 'https://varys.fly.dev';
const PRODUCTION_APP_ORIGINS = ['https://varys-wine.vercel.app'];

/** An http(s) origin, or null. `new URL('javascript:x').origin` is the string "null". */
function toOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Pure, and taking the environment as an argument, because two callers have no
 * `import.meta.env`: vite.config.ts runs in Node, and the specs import this directly.
 */
export function resolveVarys(
  env: Record<string, string | undefined> | undefined,
): { api: string; appOrigins: string[] } {
  const api = toOrigin(env?.VITE_VARYS_API) ?? PRODUCTION_API;

  const apps = (env?.VITE_VARYS_APP_ORIGINS ?? '')
    .split(',')
    .map(toOrigin)
    .filter((o): o is string => o !== null);

  return { api, appOrigins: apps.length > 0 ? [...new Set(apps)] : PRODUCTION_APP_ORIGINS };
}

// Optional chaining, because outside a Vite build `import.meta.env` does not exist.
const resolved = resolveVarys({
  VITE_VARYS_API: import.meta.env?.VITE_VARYS_API,
  VITE_VARYS_APP_ORIGINS: import.meta.env?.VITE_VARYS_APP_ORIGINS,
});

/** The Varys API origin, no trailing slash. */
export const VARYS_API: string = resolved.api;

/** Origins of the Varys web app. The first is where the connect page is opened. */
export const VARYS_APP_ORIGINS: string[] = resolved.appOrigins;
