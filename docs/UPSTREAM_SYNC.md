# Keeping the fork in sync with upstream

Upstream LearnHarness (`amosblomqvist/learnharness`) owns the learning engine. This fork adds Remote Access, the phone layout and the PWA on top. Bring upstream changes in regularly, with a human reviewing every merge.

## Remotes (already set up)

```sh
git remote -v
# origin    https://github.com/hachihao792001/learnharness-mobilesupport.git (fetch/push)
# upstream  https://github.com/amosblomqvist/learnharness.git (fetch)
# upstream  DISABLED (push)          ← pushing to upstream is impossible by mistake
```

On a fresh clone of the fork:

```sh
git remote add upstream https://github.com/amosblomqvist/learnharness.git
git remote set-url --push upstream DISABLED
```

## Branches

| Branch | Use |
|---|---|
| `main` | the stable fork; what you run |
| `feature/remote-access`, `feature/mobile-pwa` | the fork's feature work (merged into `main` once reviewed) |
| `upstream-sync` | temporary: one upstream update at a time, merged into `main` after review |

Never rebase or force-push a branch that is already on GitHub. Bring upstream in by **merging**.

## Step by step

1. **Fetch** (changes nothing locally):
   ```sh
   git fetch upstream --tags
   ```
2. **See what changed and where it touches the fork:**
   ```sh
   node scripts/fork/upstream-audit.mjs            # report on stdout
   node scripts/fork/upstream-audit.mjs --out docs/upstream-audit.md
   ```
   The report lists:
   - new upstream commits;
   - upstream changes to files the fork **modified** (likely merge conflicts);
   - changes to the APIs, startup, auth, streaming, persistence and build files the fork **relies on**;
   - added or removed API routes, which need a decision in `src/remote-access/route-policy.ts`;
   - dependency changes;
   - the tests to run.

   It only reads git; it never merges.
3. **Merge on a sync branch:**
   ```sh
   git switch main
   git switch -c upstream-sync
   git merge --no-ff upstream/main      # or a release tag: git merge --no-ff v0.8.0
   ```
4. **Resolve conflicts.** Every fork change in an upstream file is a small hunk marked `Fork:` (`git grep -n "Fork:"`). For each conflicted file, take upstream's version and re-apply the hunk described in [UPSTREAM_MODIFICATIONS.md](UPSTREAM_MODIFICATIONS.md).
   - `proxy.ts`: keep upstream's function body and matcher entries. Re-add the fork lines at the top of `proxy()` and the third matcher entry.
   - `src/server/desktop-access.ts`: keep `&& !remoteAPIRequestAllowed(request, env)` on the desktop branch of `apiRequestRefusal`.
   - `electron/main.cjs`: re-add the require and the single `setUpRemoteAccess({...})` call after the server-start branch in `main()`.
   - `electron/preload.cjs`: re-add the `remoteAccess` group.
   - `app/layout.tsx`: re-add the mobile CSS import, `viewport`, the `<head>` script, `<MobileShell />`, `<PwaSupport />` and the PWA metadata.
   - `components/chat.tsx`, `components/composer.tsx`, `components/settings/settings-dialog.tsx`: re-add the one-line hooks.
   - Upstream tests the fork edited: keep upstream's new assertions and re-apply the fork's reviewed changes.
5. **New API routes:** `tests/remote-access-route-coverage.test.ts` fails until each new route and method is listed in `src/remote-access/route-policy.ts`. Until then the gate already refuses it for phones (deny by default). Decide per route: a learning feature → `"remote"`; credentials, provider, global settings or machine control → `"local-only"`.
6. **Run the compatibility checks** (below). Compare failures with [BASELINE_TEST_RESULTS.md](BASELINE_TEST_RESULTS.md).
7. **Review, then merge** `upstream-sync` into `main` with `--no-ff`. Push only when you decide to.
8. If the merge changed `package.json`'s version, the next fork release starts again at `-mobile.1` on the new base (`v<new version>-mobile.1`, see FORK_RELEASE.md). Keep the `if:` guard on upstream's `release.yml`.
9. If a fork hook is no longer needed (upstream gained an extension point), remove it and update UPSTREAM_MODIFICATIONS.md.

## Compatibility checks after every upstream merge

The project expects Node 26. On Windows, run tests through Node's own globbing (the npm script's command line is too long for Windows):

```sh
npm ci && npm run plugins:setup
npm run typecheck
NODE_ENV=test node --import tsx --test "tests/*.test.ts" "tests/*.test.tsx"
npm run lint
npm run build && node scripts/build-server.mjs && node scripts/smoke-server.mjs
node scripts/fork/smoke-mobile.mjs
```

What these prove:

| Check | Proves |
|---|---|
| Full test suite (upstream's own tests) | learning engine, agent runtime, providers, persistence and API contracts unchanged |
| `tests/remote-access-*.test.ts` | the ten security cases, pairing and Serve handling; Remote Access stays optional (off = desktop unchanged) |
| `tests/desktop-*.test.ts`, `tests/file-path-preload.test.ts` | Electron start-up, the desktop secret and the preload surface |
| `tests/mobile-support.test.tsx`, `tests/pwa.test.ts` | phone features and caching rules |
| `smoke-server` | the packaged server boots and serves |
| `smoke-mobile` | the phone layout in real Chrome; the Electron window keeps the desktop layout |

A passing TypeScript build is **not** proof of compatibility. Run the tests above.

## Spotting breaking upstream changes
The audit flags upstream edits to the contracts the fork depends on:
- `POST /api/chat` input shape (`src/core/input-events.ts`): phone images use `text.images`;
- `GET /api/chats/[id]` / `stream` and `/api/jobs` `turnInFlight`: reconnecting;
- `/api/events` (`components/server-events.tsx`): resync;
- `src/server/desktop-access.ts`, `proxy.ts`, `electron/desktop-api.cjs`: the auth model;
- `electron/main.cjs` server start-up, port and IPC: Remote Access;
- the Settings dialog, sidebar and composer markup (`data-testid` hooks used by `app/mobile.css`).

If one changed, read the diff before merging.
