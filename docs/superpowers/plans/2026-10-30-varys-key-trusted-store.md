# Varys Key in Worker-Only Storage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Varys key to storage that only the extension's own contexts can open, so the scripts it runs inside Drupal pages cannot read it. Move every existing user's key across once, without disconnecting them. Make the worker answer page requests only about the page the asking tab is on.

**Architecture:** A small key-value store over IndexedDB in the extension's origin (`src/lib/varys/trustedStore.ts`) replaces `chrome.storage.local` for the connection record. `connection.ts` reads and writes only that store. Before its first read in each worker lifetime, `connection.ts` runs a once-per-profile move of any 0.7.x record out of `chrome.storage.local`. A pure check, `pageIsSenders`, ties every Varys page request to the sender's own tab URL.

**Tech Stack:** TypeScript, IndexedDB (no wrapper library), Chrome MV3 service worker, Playwright (`chromium` unit project; `extension` project with the built `dist/`), esbuild for in-page test bundles.

**Spec:** No separate spec. The design was agreed with the owner on 2026-10-30, after the security scan of 0.7.1, and the **Design** section below is the authority.

## Design

- **Why:** `chrome.storage.local` is exposed to content scripts by default. Chrome's storage reference says so, and `setAccessLevel` can only restrict the WHOLE area. Our content scripts legitimately read settings, the pending notice and the menu cache from that area, so restricting it is not an option. A renderer exploit on a Columbia admin tab can therefore read the key today. Page JavaScript cannot, because content scripts run in an isolated world.
- **Where the key goes:** IndexedDB in the extension's own origin. A content script's `indexedDB` is the PAGE's origin, so it cannot open this database, and site isolation keeps it out of the page's renderer process.
- **Alternatives rejected:**
  - `storage.session` is cleared when the browser closes, so every person would reconnect daily.
  - `storage.sync` uploads to the Google account, and the privacy policy promises it is never used.
  - Encrypting the key inside `storage.local` keeps the same trust boundary and adds key-management code.
- **The move (once per profile):** it runs before the first connection read in each worker lifetime, and eagerly at worker start.
  - The marker is the key `legacyConnectionMigrated` in the trusted store.
  - With the marker present: delete any `varysConnection` in `chrome.storage.local` unread.
  - With no marker:
    1. Read `chrome.storage.local.varysConnection`.
    2. If it is a valid record AND the trusted store holds no connection, copy it across.
    3. Set the marker. This happens only after a successful copy.
    4. Delete the local record.
  - A failure leaves the local record and no marker, so the next worker start retries. Meanwhile the person reads as not connected. **Nothing is ever read as a credential from `chrome.storage.local` again.**
  - Why that last rule matters: content scripts can WRITE that area too. Trusting it would let a compromised page repoint the extension at another account, which is the attack `mayReplaceConnection` exists to stop.
- **Binding requests to their page:** `varysSiteTracked`, `varysSuggestions`, `varysGenerateSuggestions`, `varysDrafts` and `varysDraft` are answered only when the sender meets all of these:
  - it is the top frame of a tab;
  - its URL is https;
  - its URL is on the same bare host (`bareHost`) as the request's `pageUrl`, which must be https too.

  Same bare host, not the same origin: a panel on `cuimc.columbia.edu` legitimately asks about the public page on `www.cuimc.columbia.edu` (see `publicAddress.ts`).
  - When the check fails, nothing is sent to Varys and the worker logs a warning.
  - The answer is the existing "not tracked" shape: `{ tracked: false }` for `varysSiteTracked`, and `{ ok: true, answer: { status: 'not_tracked' } }` for the other four.
  - No new user-facing copy: our own content scripts never send a mismatch.
- **Accepted consequences:**
  - If the browser evicts the extension's IndexedDB, the person reads as not connected and reconnects. It never reads as someone else.
  - Downgrading to 0.7.x after updating shows "not connected" until the person reconnects. The store does not offer downgrades.
- **Version:** 0.7.2, released after 0.7.1 is approved and live.

## Global Constraints

- No new dependencies. IndexedDB is used directly.
- No user-facing copy changes, except `docs/PRIVACY.md` and `docs/CHROME-WEB-STORE.md`.
- After the move, no code path reads `varysConnection` from `chrome.storage.local` as a credential.
- `getConnection()` / `setConnection()` keep their names and return types. The worker's 17 call sites do not change.
- Database name `d7studio-trusted`, version `1`, object store `kv`. Keys: `varysConnection` (the existing `CONNECTION_KEY`) and `legacyConnectionMigrated`.
- Tests never reach a real Varys: use the existing `stubVarys` / route stubs.
- The extension project runs with `--workers=1`.
- Commits end with the trailer `Co-Authored-By:` naming the model that wrote them.
- Push, merge, tag, GitHub release and store upload are the controller's or owner's, never a subagent's.
- Branch `fix/varys-key-trusted-store`, cut from `fix/sec-deps` (or from `main` once 0.7.1 is merged), in a sibling worktree `~/Documents/GitHub/Drupal-7-skin-trusted-key`. Line numbers below are as of `fix/sec-deps` at `973277d`.

## Review Focus

1. **A 0.7.1 user updating while connected.** They must stay connected, with the same key and email. Covered by the Task 2 unit test "a 0.7 connection … is moved once" and by Task 5's manual upgrade check.
2. **The move failing part-way** (an IndexedDB write throws). The old record must survive for the next try, and the person must read as not connected rather than as a stale or wrong connection. Task 2 test: "a failed move keeps the old record…".
3. **Something writes `varysConnection` into `chrome.storage.local` after the move.** It must never be used. Task 2 test: "a record written … after the move is never read". Task 3 extension test: "a key left in chrome.storage.local is never used".
4. **A trusted store that already holds a connection, alongside a leftover local record** (the marker write failed after the copy). The trusted record wins. Task 2 test: "a connection already in the trusted store is not replaced".
5. **The panel on a bare host asking about the `www.` public page.** It must still work. Task 4 unit case: `cuimc.columbia.edu` sender, `www.cuimc.columbia.edu` page → true.

---

### Task 1: The trusted store

**Files:**
- Create: `src/lib/varys/trustedStore.ts`
- Test: `tests/varys-trusted-store.spec.ts` (chromium project)

**Interfaces:**
- Produces:
  - `TRUSTED_DB = 'd7studio-trusted'`, `TRUSTED_DB_VERSION = 1`, `TRUSTED_STORE = 'kv'`.
  - `interface TrustedStore { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; remove(key: string): Promise<void> }`. `get` resolves `undefined` for an absent key. `set` and `remove` resolve when their transaction COMMITS (`oncomplete`), not when the request succeeds.
  - `trustedStore: TrustedStore`, the IndexedDB implementation. It creates `kv` in `onupgradeneeded`, memoizes the open database, and drops the memo on `close`/`versionchange` so the next call reopens.

- [ ] **Step 1: Write the failing tests.** Bundle `trustedStore.ts` with esbuild into a page that has a real origin, because IndexedDB is unavailable on `data:` URLs: `page.route('https://store.test/**', r => r.fulfill({ contentType: 'text/html', body: '<html></html>' }))`, then `page.goto('https://store.test/')`. Tests:
  - `'a value written is read back as a copy'`: `set('a', { x: 1 })`, then `get('a')` deep-equals `{ x: 1 }`.
  - `'an absent key reads as undefined'`.
  - `'remove forgets a value'`.
  - `'a write has committed when set resolves'`: after `set('a', 1)` resolves, a SEPARATE raw `indexedDB.open(TRUSTED_DB, TRUSTED_DB_VERSION)` reads `1` from `kv`.
- [ ] **Step 2: Run them and confirm they fail.** `npx playwright test --project=chromium tests/varys-trusted-store.spec.ts`. Expected: the module is not found.
- [ ] **Step 3: Implement `src/lib/varys/trustedStore.ts`** per the Interfaces block.
- [ ] **Step 4: Run them and confirm they pass**, then run the whole chromium project: `npx playwright test --project=chromium`.
- [ ] **Step 5: Commit.** `feat(varys): a key-value store only the extension's own contexts can open`

### Task 2: The connection lives in the trusted store, and 0.7.x records move once

**Files:**
- Modify: `src/lib/varys/connection.ts`. The header comment at 1–13 must say where the key now lives and why. `getConnection` and `setConnection` are at 120–153.
- Test: `tests/varys-connection.spec.ts`, the block `'the stored connection'` at 122+.

**Interfaces:**
- Consumes: `TrustedStore`, `trustedStore` (Task 1).
- Produces:
  - `MIGRATED_KEY = 'legacyConnectionMigrated'`.
  - `getConnection(store: TrustedStore = trustedStore): Promise<VarysConnection | null>`. It awaits `migrateLegacyConnection(store)` first; if that rejects, it logs a `console.warn` and returns `null`. Then it reads `store.get(CONNECTION_KEY)` with the existing validation.
  - `setConnection(c: VarysConnection | null, store: TrustedStore = trustedStore): Promise<void>`.
  - `migrateLegacyConnection(store: TrustedStore = trustedStore, local: Pick<chrome.storage.StorageArea, 'get' | 'remove'> = chrome.storage.local): Promise<void>`. It follows the Design steps, memoized per store object in a `WeakMap`, and the memo entry is deleted when the run rejects.

- [ ] **Step 1: Write the failing tests.**
  - Keep the existing in-memory `chrome.storage.local` fake.
  - Add a `fakeStore()` factory returning `{ store: TrustedStore, data: Map }`, plus a variant whose `set` throws on its first call. Pass a fresh fake store into every call.
  - Convert the five existing tests to the fake store. The validation tests keep their assertions.
  - Replace `'is stored under its own key, apart from the settings'` with `'is kept in the trusted store, never in chrome.storage.local'`. After `setConnection(connection, s.store)`: `s.data.get(CONNECTION_KEY)` equals `connection`, the local fake is empty, and `getConnection(s.store)` equals `connection`.
  - Add these tests:
    - `'a 0.7 connection in chrome.storage.local is moved once, then removed'`. Set the local fake's `varysConnection = connection`. Then `getConnection(s.store)` equals `connection`, local is empty, and `s.data.get(MIGRATED_KEY) === true`.
    - `'a record written to chrome.storage.local after the move is never read'`.
      - Migrate an empty profile.
      - Write local `varysConnection = { ...connection, key: 'vxk_' + 'b'.repeat(43), email: 'attacker@example.com' }`.
      - `getConnection(s.store)` is `null`.
      - A NEW `TrustedStore` object over the same `data` (a new worker start) also returns `null`, and removes the local record.
    - `'a connection already in the trusted store is not replaced'`. Trusted holds A, local holds B, and there is no marker. `getConnection` returns A; local is empty and the marker is set.
    - `'a damaged 0.7 record is dropped, not moved'`. Local holds `{ ...connection, key: 'abc' }`. `getConnection` returns `null`; local is empty and the marker is set.
    - `'a failed move keeps the old record for the next try, and reads as not connected meanwhile'`. Use the store whose first `set` throws.
      - The first `getConnection` returns `null`; local still holds the record; no marker.
      - The second `getConnection` returns `connection`; local is empty.
- [ ] **Step 2: Run them and confirm they fail.** `npx playwright test --project=chromium tests/varys-connection.spec.ts`
- [ ] **Step 3: Implement it in `connection.ts`.**
- [ ] **Step 4: Run them and confirm they pass**, then `npx tsc --noEmit -p tsconfig.json` and the whole chromium project.
  - The `extension` project is EXPECTED to fail from here until Task 3. Its fixtures still seed the key into `chrome.storage.local`, which the worker no longer reads.
  - Do not "fix" that here. Task 3 moves the fixtures.
- [ ] **Step 5: Commit.** `fix(varys): keep the key in the trusted store and move a 0.7 key there once`

### Task 3: The worker moves the key at start; tests and disclosures follow it

**Files:**
- Modify: `src/background/index.ts`. Add `void migrateLegacyConnection().catch(err => console.warn('[D7 Studio] Varys: could not move the stored key yet', err));` at module top level, before `chrome.runtime.onMessageExternal.addListener` (~1192).
- Modify: `tests/extension.test.ts`:
  - the `settings` fixture (174–184);
  - `storedConnection` (3706–3714);
  - the `stored(context, 'varysConnection')` uses (e.g. 4441);
  - the eight `worker(context).evaluate(() => chrome.storage.local.get('varysConnection'))` reads (5014, 5026, 5039, 5093, 5129, 5335, 5385, 5400);
  - `asContentScript` (4157–4182).
- Modify: `docs/PRIVACY.md` 367–371 and `docs/CHROME-WEB-STORE.md` 154–157. Both should say the key and email are kept in the extension's own database (IndexedDB), which only the extension's background script and its own pages can open, and which the scripts it runs inside Drupal pages cannot read. The queue and notice stay in `chrome.storage.local`.

**Interfaces:**
- Consumes: `migrateLegacyConnection`, `MIGRATED_KEY` (Task 2); `TRUSTED_DB`, `TRUSTED_DB_VERSION`, `TRUSTED_STORE` (Task 1). Tests import them from `src`.
- Produces these test helpers:
  - The `settings` fixture writes a `varysConnection` field (a record, or `null` to delete) into the trusted store through the extension page's own `indexedDB`. It creates `kv` on upgrade, exactly as Task 1 does. Every other field still goes to `chrome.storage.local`.
  - `trustedConnection(context, extensionId): Promise<unknown>` reads the record the same way. It replaces all 13 reads; `stored.varysConnection.expired` becomes `(await trustedConnection(...) as any)?.expired`.
  - `inContentScript(page, context, extensionId, expression: string): Promise<unknown>`, the CDP world lookup factored out of `asContentScript`. `asContentScript` then calls it.

- [ ] **Step 1: Write the two new failing tests** in the Varys connection describe:
  - `'the key is out of reach of the scripts the extension runs in Drupal pages'`.
    - Hand off `KEY` through the real connect flow.
    - Open `EDITOR_FORM`.
    - `inContentScript(..., 'chrome.storage.local.get(null).then(JSON.stringify)')` does not contain `KEY`.
    - `inContentScript(..., 'indexedDB.databases().then(d => d.map(x => x.name))')` does not contain `TRUSTED_DB`.
    - `trustedConnection` matches `{ key: KEY, email: EMAIL }`.
  - `'a key left in chrome.storage.local is never used'`.
    - From the extension page, write `chrome.storage.local.set({ varysConnection: connected })` directly. Do not use `settings`.
    - Opening the popup shows the not-connected state (`OFF_COPY` visible, no "Connected to Varys as").
- [ ] **Step 2: Build and run the two tests; confirm they fail.** `npm run build && npx playwright test --project=extension --no-deps --workers=1 -g "out of reach|never used"`. Expected: the key is found in `chrome.storage.local`, and the popup shows "Connected".
- [ ] **Step 3: Add the worker's top-level move call, and switch the fixture and reads to the trusted store.**
- [ ] **Step 4: Update the two docs.** `npx playwright test --project=chromium tests/packaging.spec.ts` must stay green.
- [ ] **Step 5: Rebuild and run the whole extension project; it must be green.** `npm run build && npx playwright test --project=extension --no-deps --workers=1`. Run it on a quiet machine: this suite is load-sensitive, and a failure is re-run alone before it is believed.
- [ ] **Step 6: Commit.** `fix(varys): the worker moves the key at start; tests and the privacy policy follow it`

### Task 4: Varys page requests name the sender's own page

**Files:**
- Modify: `src/lib/varys/submissions.ts`. Add `pageIsSenders` beside `isTrackedSite` (~331).
- Modify: `src/background/index.ts`. Guard the five handlers at 1293–1311.
- Test: `tests/varys-submissions.spec.ts`, `tests/extension.test.ts`.

**Interfaces:**
- Produces `pageIsSenders(pageUrl: unknown, sender: { url?: string; frameId?: number; tab?: { id?: number } }): boolean`. It is true only when all of these hold:
  - `pageUrl` is a string;
  - `sender.tab?.id` is defined;
  - `sender.frameId === 0`;
  - both URLs parse with protocol `https:`;
  - their `bareHost`s are equal.

- [ ] **Step 1: Write the failing tests.**
  - Unit test `'a page request names the page its sender is on'`, one assertion per case:
    - same URL → true;
    - `https://cuimc.columbia.edu/node/5/edit` sender with `https://www.cuimc.columbia.edu/news/foo` page → true;
    - another host → false;
    - `http:` page or `http:` sender → false;
    - `frameId: 3` → false;
    - no `tab` → false;
    - a non-string `pageUrl` → false;
    - an unparseable URL → false.
  - Extension test `'a page request about another site than the tab's is refused, and nothing reaches Varys'`.
    - Use `settings({ varysConnection: connected, nodeEditor: false })` and `stubVarys(context, varysUp())`.
    - Open `https://vagelos.columbia.edu/node/23110/edit`, which is untracked.
    - Ask all five types about `${HOST}/node/23110`, which is tracked: `varysSiteTracked` → `{ tracked: false }`; the other four → `{ ok: true, answer: { status: 'not_tracked' } }`.
    - `calls` holds no `/api/extension/suggestions` or `/api/extension/drafts` path.
- [ ] **Step 2: Rewrite the three existing cross-host tests** so they still test the UNTRACKED path rather than passing on the new refusal: 4869 (`varysSiteTracked` about vagelos), 4993 (`'an untracked host sends nothing'`) and 5304 (`'an untracked host sends nothing about its drafts'`). Each opens its tab on `https://vagelos.columbia.edu/node/23110/edit` and asks about a vagelos URL.
- [ ] **Step 3: Confirm the new tests fail.**
  - `npx playwright test --project=chromium tests/varys-submissions.spec.ts -g "names the page"`: the export is missing.
  - The extension test, after `npm run build`: today the drafts are sent.
- [ ] **Step 4: Implement `pageIsSenders`, and guard each of the five handlers** before any gate runs. On refusal: `console.warn('[D7 Studio] Varys: a page request named a page other than its own, so nothing was sent.')` and the refusal answer from the Design section.
- [ ] **Step 5: Run the chromium project and `tsc`; rebuild and run the whole extension project.** All must be green.
- [ ] **Step 6: Commit.** `fix(varys): answer page requests only about the page the asking tab is on`

### Task 5: Release 0.7.2 (after 0.7.1 is live)

- [ ] **Step 1: Bring the branch onto the released 0.7.1 line.** Merge or rebase onto `main` after 0.7.1 is merged, then rerun the chromium project, `tsc` and the extension project.
- [ ] **Step 2: Do the manual upgrade check.** This is the only test of a real in-place update. It signs into the real Varys, so the owner does it, or the controller with the owner's OK.
  1. Build 0.7.1's `dist/`, load it unpacked, and connect to Varys.
  2. Replace `dist/` with this branch's build, then press Reload on the card in `chrome://extensions`. The extension ID and storage are kept.
  3. The popup still reads "Connected to Varys as …".
  4. A Columbia `node/add/page` lists drafts.
  5. In DevTools for that tab's content-script context, `chrome.storage.local.get(null)` shows no `varysConnection`.
- [ ] **Step 3: Write the release entry in `docs/WHATS-NEW.md`** in plain words ("Your Varys connection is now kept where pages can't reach it. You stay connected."). Then the controller runs `node scripts/release.mjs patch --notes "…"` and the two commands it prints.
- [ ] **Step 4: After the Chrome Web Store approves it**, update "Version published" in `docs/CHROME-WEB-STORE.md`.
