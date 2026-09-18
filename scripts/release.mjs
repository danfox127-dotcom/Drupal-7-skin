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
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'danfox127-dotcom/Drupal-7-skin';

const read = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));
const write = (rel, data) =>
  writeFileSync(path.join(ROOT, rel), `${JSON.stringify(data, null, 2)}\n`);

/**
 * Marker for a release that started but never produced an artifact.
 *
 * Declared up here, with the recovery function, because recoverInterruptedRelease() has
 * to run before package.json is read -- the bump must be computed from the TRUE previous
 * version, not from a stranded one. The first version of this left both below their call
 * site and died with "Cannot access 'LOCK' before initialization", which a deterministic
 * test caught and a timing-dependent one had missed.
 */
const LOCK = path.join(ROOT, '.release-lock.json');

function recoverInterruptedRelease() {
  if (!existsSync(LOCK)) return;

  let lock;
  try {
    lock = JSON.parse(readFileSync(LOCK, 'utf8'));
  } catch {
    // Unreadable marker: say so rather than guessing a version to roll back to.
    console.error(
      `${LOCK} exists but cannot be read. A previous release was interrupted.\n` +
      'Check package.json and manifest.json by hand, then delete the file.'
    );
    process.exit(1);
  }

  const current = read('package.json').version;
  if (current === lock.to) {
    write('package.json', { ...read('package.json'), version: lock.from });
    write('manifest.json', { ...read('manifest.json'), version: lock.from });
    console.log(
      `A previous release of ${lock.to} was interrupted. Rolled package.json and ` +
      `manifest.json back to ${lock.from}.\n`
    );
  }
  rmSync(LOCK, { force: true });
}


/**
 * Strips punctuation a copy-paste drags in.
 *
 * `npm run release patch.` failed with "Unknown bump", because the instruction it was
 * copied from ended a sentence right after the command. The refusal was correct but the
 * cause was invisible, and a release is not the moment to debug your own shell history.
 * Only trailing separators are removed -- anything else still has to be a real argument.
 */
function normaliseKind(raw) {
  return String(raw).trim().replace(/[.,;:]+$/, '');
}

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
const kind = args[0] === undefined ? args[0] : normaliseKind(args[0]);
const dryRun = args.includes('--dry-run');
const allowDirty = args.includes('--allow-dirty');
const notesIndex = args.indexOf('--notes');
const notes = notesIndex === -1 ? '' : (args[notesIndex + 1] ?? '');

if (!kind || kind.startsWith('--')) {
  console.error('Usage: node scripts/release.mjs patch|minor|major|<version> [--notes "..."] [--dry-run] [--allow-dirty]');
  process.exit(1);
}

/**
 * Refuse to build a release from a dirty tree.
 *
 * The zip is built from the WORKING TREE, but step 1 of the printed instructions commits
 * only package.json and manifest.json. So releasing with other changes uncommitted
 * produces a tag pointing at a commit that does not contain the code inside the published
 * zip -- and nothing downstream ever notices, because the zip works fine. It is only
 * discovered much later, by someone trying to reproduce a release from its tag.
 *
 * latest.json is exempt: this script rewrites it, and the instructions commit it last on
 * purpose, so a release cut immediately after another would otherwise refuse itself.
 */
function dirtyPaths() {
  const out = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.replace(/^\S+\s+/, ''))
    .filter(file => file !== 'latest.json');
}

if (!dryRun && !allowDirty) {
  let dirty;
  try {
    dirty = dirtyPaths();
  } catch {
    dirty = [];        // not a git checkout; nothing to protect
  }
  if (dirty.length) {
    console.error(
      'The working tree has uncommitted changes:\n' +
      dirty.map(f => `  ${f}`).join('\n') +
      '\n\nThe zip is built from the working tree, but the release commit only includes\n' +
      'package.json and manifest.json -- so the tag would point at a commit that does not\n' +
      'contain the code in the zip. Commit first, or pass --allow-dirty if you mean it.'
    );
    process.exit(1);
  }
}

recoverInterruptedRelease();

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

/**
 * The version files have to be written BEFORE the build -- the build reads manifest.json,
 * and the point is that the zip reports the new version. That leaves a window where the
 * repo claims a version no artifact exists for, and an interrupted run strands it there:
 * both version files bumped, no zip, latest.json still on the old version. They agree
 * with each other, so the drift check above sees nothing wrong, and a re-run with `patch`
 * bumps AGAIN -- silently skipping a version.
 *
 * Not hypothetical: a build slow enough to hit a two-minute timeout left exactly that,
 * and recovering took an explicit version argument to avoid landing on 0.2.3.
 *
 * The first attempt at a fix was a SIGTERM handler. It does not work, and it is worth
 * recording why: the build runs under execFileSync, which blocks the event loop, so Node
 * cannot run a JS signal handler until that call returns -- by which time the build has
 * either finished or the process is gone. A handler is best-effort at most.
 *
 * So the authority is a marker file on disk, written before the bump and removed only on
 * success. It survives SIGKILL, a pulled plug, and anything else, because it needs no
 * code to run at the moment of death. The next invocation finds it and heals.
 */

let artifactExists = false;

function restoreVersions() {
  if (artifactExists) return;
  write('package.json', pkg);
  write('manifest.json', manifest);
  rmSync(LOCK, { force: true });
}

/**
 * Best-effort only, for the cases where Node does get to run: a failed build (which
 * throws out of execFileSync) or a signal delivered while this process is not blocked.
 * The marker above is what actually guarantees recovery.
 */
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    restoreVersions();
    console.error(`\n${signal} -- version files restored to ${pkg.version}. Nothing was released.`);
    process.exit(130);
  });
}

process.on('uncaughtException', (error) => {
  restoreVersions();
  console.error(`\n${error?.message ?? error}\nVersion files restored to ${pkg.version}.`);
  process.exit(1);
});

// 1. Version, in both places, from one source -- with the marker written FIRST, so an
//    interruption between these two writes is recoverable too.
write('.release-lock.json', { from: pkg.version, to: next });
write('package.json', { ...pkg, version: next });
write('manifest.json', { ...manifest, version: next });

try {
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
} catch (error) {
  restoreVersions();
  console.error(
    `\nBuild or packaging failed, so nothing was released.\n` +
    `Version files restored to ${pkg.version}.\n\n${error?.message ?? error}`
  );
  process.exit(1);
}

// Checked rather than assumed: zip exits 0 on an empty directory, which would leave an
// archive with nothing in it and a release that installs as a broken extension.
if (!existsSync(path.join(ROOT, zipName))) {
  restoreVersions();
  console.error(`\n${zipName} was not produced. Version files restored to ${pkg.version}.`);
  process.exit(1);
}
artifactExists = true;
rmSync(LOCK, { force: true });

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

Three steps left, all irreversible, so they are yours to run — IN THIS ORDER:

  1. git add package.json manifest.json && git commit -m "release: ${tag}" && git push
  2. gh release create ${tag} ${zipName} --title "${tag}" --notes ${JSON.stringify(notes || tag)}
  3. git add latest.json && git commit -m "release: announce ${tag}" && git push

Why three, and why this order:

  - Push BEFORE creating the release. \`gh release create\` puts the tag at the remote
    default branch's HEAD, so releasing first tags whatever was already pushed — not the
    bump you just made.

  - Push latest.json LAST, in its own commit. It is the file installed copies poll, and
    it names a download URL that does not exist until step 2. Publishing it earlier
    points every installed copy at a 404 for as long as the gap lasts.
`);
