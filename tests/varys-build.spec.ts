import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where a BUILD points at Varys, checked by actually building.
 *
 * The pure resolver is covered in tests/varys-connection.spec.ts. What it cannot show is
 * that the build really uses it: that `define` reaches the code, and that nothing else in
 * the environment gets in around it. `scripts/release.mjs` runs `npm run build` and never
 * a test, so for a release this is the only place the claim "a production build is
 * production whatever the environment says" is ever checked against a real build.
 *
 * Each build goes to a temporary directory, never dist/, which the extension tests load.
 */

interface Built {
  manifest: { externally_connectable?: { matches?: string[]; ids?: string[] } };
  /** Every JavaScript file in the build, joined. */
  js: string;
}

function build(mode: 'production' | 'development', env: Record<string, string>): Built {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'd7-varys-build-'));
  try {
    execFileSync(
      process.execPath,
      [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build',
        '--mode', mode, '--outDir', out, '--emptyOutDir'],
      {
        cwd: ROOT,
        // The test runner sets NODE_ENV=test, which would change what React is bundled.
        env: { ...process.env, NODE_ENV: 'production', ...env },
        stdio: 'pipe',
      },
    );

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.js')) files.push(full);
      }
    };
    walk(out);

    return {
      manifest: JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')),
      js: files.map(f => fs.readFileSync(f, 'utf8')).join('\n'),
    };
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

test.describe('a build and the Varys environment', () => {
  test.setTimeout(180_000);

  test('a production build ignores a hostile environment', () => {
    /**
     * What a developer with VITE_VARYS_API exported, or kept in a gitignored .env.local,
     * would otherwise ship. Both variables, and a second origin that is not localhost,
     * since "no localhost" is not the same as "only the production hosts".
     */
    const { manifest, js } = build('production', {
      VITE_VARYS_API: 'http://localhost:8000',
      VITE_VARYS_APP_ORIGINS: 'http://localhost:3000,https://hostile-app.example',
    });

    expect(manifest.externally_connectable).toEqual({ matches: ['https://varys-wine.vercel.app/*'] });
    expect(JSON.stringify(manifest)).not.toMatch(/localhost|hostile/);
    expect(js).not.toMatch(/localhost|hostile/);
    // And what it uses instead is really in the code, not just absent from it.
    expect(js).toContain('https://varys.fly.dev');
    expect(js).toContain('https://varys-wine.vercel.app');
  });

  test('a production build with a hostile API alone is still production', () => {
    // The two variables are independent; each is checked on its own.
    const { manifest, js } = build('production', { VITE_VARYS_API: 'https://hostile-api.example' });
    expect(manifest.externally_connectable).toEqual({ matches: ['https://varys-wine.vercel.app/*'] });
    expect(js).not.toContain('hostile-api.example');
    expect(js).toContain('https://varys.fly.dev');
  });

  test('a development build points at the local Varys', () => {
    // Empty strings, not absent: the process environment outranks .env files, so a
    // developer's own .env.local cannot turn the defaults into something else here.
    const { manifest, js } = build('development', { VITE_VARYS_API: '', VITE_VARYS_APP_ORIGINS: '' });

    expect(manifest.externally_connectable).toEqual({ matches: ['http://localhost:3000/*'] });
    expect(js).toContain('http://localhost:8000');
    expect(js).toContain('http://localhost:3000');
  });

  test('a development build can be pointed elsewhere by the environment', () => {
    const { manifest, js } = build('development', {
      VITE_VARYS_API: 'http://localhost:9000',
      VITE_VARYS_APP_ORIGINS: 'http://localhost:4000',
    });

    expect(manifest.externally_connectable).toEqual({ matches: ['http://localhost:4000/*'] });
    expect(js).toContain('http://localhost:9000');
    expect(js).toContain('http://localhost:4000');
  });
});
