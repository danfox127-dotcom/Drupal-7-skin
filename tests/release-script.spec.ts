import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', 'scripts', 'release.mjs');

/**
 * The release script, exercised in a throwaway repository.
 *
 * This had no tests, and cutting a release is the least forgiving thing in the project:
 * it writes version numbers into three files, builds, and prints instructions that tag a
 * commit. Two bugs in its recovery path were found by hand in one sitting -- a signal
 * handler that could never fire because execFileSync blocks the event loop, and a
 * temporal-dead-zone crash from calling the recovery function above its own const. The
 * second only surfaced because the state was staged deterministically rather than by
 * racing a real build.
 *
 * Everything here runs against a temp directory with a copy of the script, so no test can
 * bump the real repo's version or leave a zip behind.
 */

/** A minimal repo the script will accept: three version files and a git checkout. */
function makeRepo(version = '0.2.2'): string {
  // realpathSync because macOS reports /var, a symlink to /private/var, and git then
  // prints paths that do not match what the test constructed.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'release-test-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'release.mjs'));

  const write = (name: string, data: unknown) =>
    fs.writeFileSync(path.join(dir, name), `${JSON.stringify(data, null, 2)}\n`);
  write('package.json', { name: 'fixture', version });
  write('manifest.json', { manifest_version: 3, name: 'fixture', version });
  write('latest.json', { version, notes: '', download: '' });

  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  return dir;
}

function run(dir: string, args: string[]) {
  try {
    const stdout = execFileSync('node', [path.join(dir, 'scripts', 'release.mjs'), ...args],
      { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: stdout };
  } catch (error: unknown) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const versionOf = (dir: string, file: string) =>
  JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).version;

test('a trailing period from a copy-pasted command still works', () => {
  /**
   * How this surfaced: the instruction it was copied from ended a sentence immediately
   * after the command, so the argument arrived as "patch." and the script refused. The
   * refusal was correct and the cause was invisible.
   */
  const dir = makeRepo();
  const { code, out } = run(dir, ['patch.', '--dry-run']);
  expect(code).toBe(0);
  expect(out).toContain('0.2.2 -> 0.2.3');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('genuine nonsense is still refused', () => {
  // The normaliser strips trailing separators only. It must not turn a typo into a
  // release -- guessing what someone meant is worse than stopping.
  const dir = makeRepo();
  const { code, out } = run(dir, ['ptach']);
  expect(code).not.toBe(0);
  expect(out).toContain('Unknown bump');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a dirty working tree is refused, naming the files', () => {
  /**
   * The zip is built from the working tree, but the release commit includes only
   * package.json and manifest.json -- so releasing dirty tags a commit that does not
   * contain the code in the published zip, and nothing downstream ever notices.
   */
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, 'stray.txt'), 'uncommitted\n');
  const { code, out } = run(dir, ['patch']);
  expect(code).toBe(1);
  expect(out).toContain('stray.txt');
  // Nothing may be written before the refusal.
  expect(versionOf(dir, 'package.json')).toBe('0.2.2');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--allow-dirty overrides the refusal', () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, 'stray.txt'), 'uncommitted\n');
  const { code } = run(dir, ['patch', '--allow-dirty', '--dry-run']);
  expect(code).toBe(0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a modified latest.json alone does not count as dirty', () => {
  // The script rewrites latest.json itself, and the printed instructions commit it last
  // on purpose. Counting it would make a release refuse itself right after another one.
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, 'latest.json'), '{"version":"changed"}\n');
  const { code } = run(dir, ['patch', '--dry-run']);
  expect(code).toBe(0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an interrupted release is rolled back, and does not double-bump', () => {
  /**
   * The exact state a build killed by a timeout left behind: both version files bumped,
   * no zip, latest.json still on the old version. They agree with each other, so the
   * drift check sees nothing wrong -- and a re-run with `patch` bumped AGAIN, skipping a
   * version. Recovering by hand took an explicit version argument.
   */
  const dir = makeRepo('0.2.2');
  for (const file of ['package.json', 'manifest.json']) {
    const json = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    json.version = '0.2.3';
    fs.writeFileSync(path.join(dir, file), `${JSON.stringify(json, null, 2)}\n`);
  }
  fs.writeFileSync(path.join(dir, '.release-lock.json'),
    `${JSON.stringify({ from: '0.2.2', to: '0.2.3' }, null, 2)}\n`);

  const { code, out } = run(dir, ['patch', '--allow-dirty', '--dry-run']);

  expect(code).toBe(0);
  expect(out).toContain('was interrupted');
  // Rolled back to the true previous version...
  expect(versionOf(dir, 'package.json')).toBe('0.2.2');
  expect(versionOf(dir, 'manifest.json')).toBe('0.2.2');
  // ...so patch lands on 0.2.3, not 0.2.4.
  expect(out).toContain('0.2.2 -> 0.2.3');
  expect(fs.existsSync(path.join(dir, '.release-lock.json'))).toBe(false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unreadable marker stops rather than guessing a version', () => {
  // A corrupt marker means a release was interrupted but not which version to roll back
  // to. Picking one silently is how the update notifier starts lying.
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, '.release-lock.json'), 'not json\n');
  const { code, out } = run(dir, ['patch', '--allow-dirty', '--dry-run']);
  expect(code).toBe(1);
  expect(out).toContain('cannot be read');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the drift check still refuses mismatched version files', () => {
  /**
   * Pre-existing behaviour, asserted because the recovery code now runs before it and
   * could mask it: a marker whose `to` does not match would roll back and hide a real
   * hand-edit.
   */
  const dir = makeRepo();
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  m.version = '0.9.9';
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(m, null, 2)}\n`);
  const { code, out } = run(dir, ['patch', '--allow-dirty', '--dry-run']);
  expect(code).toBe(1);
  expect(out).toContain('disagree');
  fs.rmSync(dir, { recursive: true, force: true });
});
