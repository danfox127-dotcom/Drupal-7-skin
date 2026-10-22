/**
 * Decides, at build time, which Varys a build talks to. Used by vite.config.ts and the
 * specs, and NEVER imported by the extension's own code: it names the development
 * addresses, which must not be in a production bundle.
 *
 * - A PRODUCTION build is always the production hosts. The environment is not consulted,
 *   because `scripts/release.mjs` runs `npm run build` and no test: a developer with
 *   VITE_VARYS_API=http://localhost:8000 exported, or kept in a gitignored .env.local,
 *   would otherwise ship a release that talks to localhost and lets localhost hand it a
 *   key, with nothing to catch it.
 * - Any other mode is DEVELOPMENT: the local app and API by default, which
 *   VITE_VARYS_API and VITE_VARYS_APP_ORIGINS (comma-separated) may override.
 */

import { PRODUCTION_API, PRODUCTION_APP_ORIGINS } from './config';

const DEVELOPMENT_API = 'http://localhost:8000';
const DEVELOPMENT_APP_ORIGINS = ['http://localhost:3000'];

export interface VarysHosts {
  /** The API origin, no trailing slash. */
  api: string;
  /** App origins. The first is where Connect opens the connect page. */
  appOrigins: string[];
}

/**
 * An http(s) origin, or null. Values are reduced to origins because both are used to build
 * match patterns by appending "/*": a trailing slash would make that "//*", and a path
 * would make a pattern for part of the site. `new URL('javascript:x').origin` is the
 * string "null", hence the scheme check.
 */
function toOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

export function resolveVarys(
  mode: string,
  env: Record<string, string | undefined> | undefined,
): VarysHosts {
  // Copies, so nothing a caller does to the result can rewrite the constants.
  if (mode === 'production') return { api: PRODUCTION_API, appOrigins: [...PRODUCTION_APP_ORIGINS] };

  const api = toOrigin(env?.VITE_VARYS_API) ?? DEVELOPMENT_API;
  const apps = (env?.VITE_VARYS_APP_ORIGINS ?? '')
    .split(',')
    .map(toOrigin)
    .filter((o): o is string => o !== null);

  return { api, appOrigins: apps.length > 0 ? [...new Set(apps)] : [...DEVELOPMENT_APP_ORIGINS] };
}

/**
 * A second lock behind resolveVarys: throws if a production build resolved to anything
 * but the production hosts, so the build stops instead of shipping them.
 */
export function assertProductionVarys(hosts: VarysHosts): void {
  const matches = hosts.api === PRODUCTION_API
    && hosts.appOrigins.length === PRODUCTION_APP_ORIGINS.length
    && hosts.appOrigins.every((origin, i) => origin === PRODUCTION_APP_ORIGINS[i]);

  if (!matches) {
    throw new Error(
      'A production build must talk to the production Varys and nothing else. It resolved to '
      + `API ${JSON.stringify(hosts.api)} and app origins ${JSON.stringify(hosts.appOrigins)}; `
      + `expected ${JSON.stringify(PRODUCTION_API)} and ${JSON.stringify(PRODUCTION_APP_ORIGINS)}.`,
    );
  }
}
