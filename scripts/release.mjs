#!/usr/bin/env node
/**
 * Cuts a release: bump, build, zip, and publish the file the notifier reads.
 *
 * Distribution is a zip that someone unzips and loads unpacked, because Chrome will not
 * auto-update an unpacked extension — see src/lib/updateCheck.ts. So the one thing that
 * must never drift is the version: the running build reports
 * chrome.runtime.getManifest().version, and latest.json is what it compares against. If
 * those are edited by hand in two places they will disagree, and a disagreement here is
 * invisible — either nobody is ever told about an update, or everybody is told forever.
 *
 * Usage:
 *   node scripts/release.mjs patch|minor|major|<explicit version> [--notes "..."] [--dry-run]
 *
 * Does NOT push or create a GitHub release. It stages the files and prints the two
 * commands to run, so the irreversible steps stay a human decision.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'danfox127-dotcom/Drupal-7-skin';

const read = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));
const write = (rel, data) =>
  writeFileSync(path.join(ROOT, rel), `${JSON.stringify(data, null, 2)}\n`);

function bump(version, kind) {
  // Explicit version wins, so a release can jump (e.g. 0.9.0 -> 1.0.0) without arithmetic.
  if (/^\d+(\.\d+){0,3}$/.test(kind)) return kind;

  const [major, minor, patch] = version.split('.').map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown bump "${kind}". Use patch, minor, major, or a version.`);
}

const args = process.argv.slice(2);
const kind = args[0];
const dryRun = args.includes('--dry-run');
const notesIndex = args.indexOf('--notes');
const notes = notesIndex === -1 ? '' : (args[notesIndex + 1] ?? '');

if (!kind || kind.startsWith('--')) {
  console.error('Usage: node scripts/release.mjs patch|minor|major|<version> [--notes "..."] [--dry-run]');
  process.exit(1);
}

const pkg = read('package.json');
const manifest = read('manifest.json');

if (pkg.version !== manifest.version) {
  // Refuse rather than pick one: if they have already drifted, which is correct is a
  // judgement call, and guessing it silently is how the notifier starts lying.
  console.error(
    `package.json (${pkg.version}) and manifest.json (${manifest.version}) disagree.\n` +
    'Set them to the same value before releasing.'
  );
  process.exit(1);
}

const next = bump(pkg.version, kind);
const zipName = `d7-studio-extension-${next}.zip`;
const tag = `v${next}`;

console.log(`${pkg.version} -> ${next}`);
if (notes) console.log(`notes: ${notes}`);

if (dryRun) {
  console.log('\n--dry-run: nothing written.');
  process.exit(0);
}

// 1. Version, in both places, from one source.
write('package.json', { ...pkg, version: next });
write('manifest.json', { ...manifest, version: next });

// 2. Build from the bumped manifest, so the zip reports the new version.
console.log('\nbuilding...');
execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });

// 3. Zip the built output with manifest.json at the archive root, which is what
//    "Load unpacked" needs after unzipping.
console.log(`\npackaging ${zipName}...`);
execFileSync('zip', ['-qr', path.join(ROOT, zipName), '.', '-x', '.*'], {
  cwd: path.join(ROOT, 'dist'),
  stdio: 'inherit',
});

// 4. The file the running extension polls. Written LAST, and deliberately not pushed
//    here: publishing it before the zip exists at that URL would advertise a download
//    that 404s.
write('latest.json', {
  version: next,
  notes: notes || `Version ${next}`,
  download: `https://github.com/${REPO}/releases/download/${tag}/${zipName}`,
});

console.log(`
Written: package.json, manifest.json, latest.json, ${zipName}

Two steps left, both irreversible, so they are yours to run:

  gh release create ${tag} ${zipName} --title "${tag}" --notes ${JSON.stringify(notes || tag)}
  git add -A && git commit -m "release: ${tag}" && git push

Order matters. Create the release FIRST so the download link in latest.json resolves,
then push latest.json — otherwise every installed copy is told to fetch a 404.
`);
