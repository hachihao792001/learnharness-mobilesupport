# Remote Access & Mobile PWA — implementation status

Living log of the fork work. The plan was agreed with the owner on 2026-11-27. Baseline: [BASELINE_TEST_RESULTS.md](BASELINE_TEST_RESULTS.md). Upstream edits: [UPSTREAM_MODIFICATIONS.md](UPSTREAM_MODIFICATIONS.md).

## Decisions taken with the owner
| Topic | Decision |
|---|---|
| Remote auth | Allowed Tailscale identity **and** a device pairing cookie |
| Serve port | dedicated HTTPS `:8443`; a conflict stops setup and is reported |
| Allowed identity | only this PC's Tailscale owner login |
| Remote scope | learning features; credentials, providers, subscriptions, Claude Code, prompts, global settings writes, theme and plugin management stay desktop-only; dictation allowed; agent file access follows the desktop setting |
| Mobile layout | only in a browser narrower than 768px; the Electron window never changes |
| Phone attachments | images only, through the existing `images` field of `POST /api/chat` |
| Drafts | saved only in remote browsers |
| On quit | remove the :8443 entry; re-add it on next launch if Remote Access is on |
| Pairing | URL + copy button; 8-character code valid 5 minutes; no QR |
| Pairing lifetime | 90 days, revocable |
| Git | `upstream` remote (fetch only); `feature/remote-access` → `feature/mobile-pwa`; no push without approval |
| Node | portable Node 26.13.1 in `D:\tools\node26` |

## Phase 0 — audit and baseline ✅
- Added the `upstream` remote (push disabled) and created `feature/remote-access`.
- Baseline recorded on a clean tree: typecheck ✅, lint ✅ (1 existing warning), build ✅, build-server ✅, smoke-server ✅, tests 5443/5516 with 62 failures that already existed (all from the Windows environment).
- Read the Next 16 docs for proxy and checked the Node-runtime proxy loading in the installed Next.
- Wrote `docs/BASELINE_TEST_RESULTS.md` and `docs/FORK_ARCHITECTURE.md`.

## Phase 1 — Remote access infrastructure ✅ (mocked); real machine ⏳
- New `electron/remote-access/`: tailscale-cli, serve-config, store, manager, ipc, setup.
- Hooks: `electron/main.cjs` (+10), `electron/preload.cjs` (+14).
- Tests: `tests/remote-access-tailscale.test.ts`, `tests/remote-access-manager.test.ts`.

## Phase 2 — Remote security ✅ (mocked); real machine ⏳
- New `src/remote-access/`: policy-store, gate, route-policy, proxy-hooks, pair-handler, device-label.
- New routes: `app/api/remote-access/pair`, `app/remote/pair`.
- Desktop Settings → Remote Access (`components/settings/remote-access-section.tsx`).
- Hooks: `src/server/desktop-access.ts`, `proxy.ts`, `src/server/index.ts`, `components/settings/settings-dialog.tsx`.
- Tests: `tests/remote-access-gate.test.ts` (the ten mandatory security cases and a pairing round trip over the real IPC protocol) and `tests/remote-access-route-coverage.test.ts`.
- Upstream tests updated (reviewed surface changes): `desktop-api`, `desktop-platform`, `file-path-preload`.
- Docs: `REMOTE_ACCESS_ARCHITECTURE.md`, `REMOTE_ACCESS_SECURITY.md`, `UPSTREAM_MODIFICATIONS.md`.

### Phase 1–2 verification (Node 26.13.1, Windows 11)
| Check | Result |
|---|---|
| Full test suite | 5577 tests: 5504 pass, **62 fail = exactly the baseline set** (no new failure, none lost), 11 skipped |
| Fork tests | `remote-access-tailscale` + `remote-access-manager` 35/35, `remote-access-gate` 21/21, `remote-access-route-coverage` 5/5 |
| Typecheck | clean |
| Lint | clean apart from the 1 existing warning |
| Build / build-server / smoke-server | pass |
| Real Next runtime (standalone server in desktop mode, curl) | local pages 200 and unchanged; `/api` without secret 403 and with secret 200 (unchanged); remote-looking requests (Serve host, Tailscale header, forged identity on loopback) answered by the gate (503 with no policy, so it fails closed); streamed document route refused through `apiRequestRefusal`; desktop window cannot pair itself (403); `_next/static` not proxied |

Problems found and fixed during verification:
- `main.cjs` hook used `new URL()` eagerly; upstream's vm-based tests have no `URL` global. It now passes the URL string.
- A request carrying the valid desktop secret through a LAN host name must keep passing (`browser-api-access` test). The proxy checks the secret before classifying a request as remote.
- Two more upstream assertions said pages are not proxied (`desktop-api`, `plugin-document-proxy`). They were updated as reviewed matcher changes (see UPSTREAM_MODIFICATIONS.md).
- A missing `Host` (only in tests) now falls back to the URL host, like upstream's `subscriptionRequestOrigin`.

## Phase 3 — Responsive frontend ✅ (branch `feature/mobile-pwa`)
- New: `app/mobile.css`, `components/mobile/*` (shell, bottom bar, sheet, long press, graph node list, phone images, drafts, notices, reconnect hook), `scripts/fork/seed-mobile-fixture.ts`, `scripts/fork/smoke-mobile.mjs`, `tests/mobile-support.test.tsx`.
- Hooks: `app/layout.tsx`, `components/chat.tsx`, `components/composer.tsx` (see UPSTREAM_MODIFICATIONS.md).
- Verification:
  - `mobile-support` 15/15;
  - full suite 5592 tests: 5518 pass, 63 fail = the 62 baseline failures + 1 transient Windows `EPERM` on a temp-folder rename in `core-plugin-build`, which passed 5/5 when rerun alone and has no fork code in its path;
  - typecheck clean; lint shows only the existing warning; build and build-server pass.
- **smoke-mobile in real Chrome: 83/83 checks** at 360×800, 390×844, 412×915, 768×1024 and 1280×800, plus the Electron agent at 360px.
- Bugs found by the real-browser run and fixed:
  1. The bottom bar hid whenever the composer had focus, and the chat focuses it on load. It now needs a real keyboard: focus plus a shrunken visible height.
  2. The "draft restored" notice sat over the composer and swallowed the first tap. Notices now show at the top.

## Phase 4 — PWA ✅
- New:
  - `app/manifest.ts`, `public/sw.js`, `public/offline.html`;
  - `public/icons/*`, rendered from `build/icon-flat.svg` by `scripts/fork/build-pwa-icons.mjs`;
  - `components/pwa/pwa-support.tsx`: registration, update prompt, install button / iOS hint, offline banner;
  - `tests/pwa.test.ts`.
- `app/layout.tsx`: `appleWebApp`, the Apple icon, `themeColor` and the `PwaSupport` mount.
- Verified:
  - `pwa` 9/9: the real `sw.js` in a sandbox caches only `/_next/static`, fonts, icons and the offline page, never pages or `/api`; it deletes old versions and waits for "Reload".
  - smoke-mobile in real Chrome: manifest served, worker active and controlling, offline banner, the offline page when the server is really stopped, cache contents static-only, no worker in the Electron window.

## Phase 5 — Session sync ✅ (shipped with Phase 3)
- `use-remote-stream-recovery.ts` re-attaches through the existing `turnInFlight` + stream replay. It is read-only and never resends.
- `use-remote-composer-draft.ts` keeps unconfirmed text, and phone images are cleared only on acceptance.
- No new contracts and no new concurrency system: server locks and 409 answers are used as they are.

## Phase 6–7 — Hardening, upstream sync, CI ✅
- `docs/UPSTREAM_SYNC.md`.
- `scripts/fork/upstream-audit.mjs` + `upstream-touchpoints.json`. It is read-only and finds fork-modified upstream files from git itself. `tests/upstream-audit.test.ts` (2/2) runs it on a scratch repo with a real conflict, a new route and dependency changes.
- `.github/workflows/fork-remote-access.yml`, a new file:
  - fork tests and the upstream tests the fork changed, on ubuntu, windows and macos;
  - the phone smoke test in real Chrome on ubuntu.

  It has not run on GitHub yet; nothing was pushed.
- `start.bat` (`npm run dev`, arguments passed on), tested in its own window, plus the README note.

### Final verification (all phases, Node 26.13.1, Windows 11)
| Check | Result |
|---|---|
| Full test suite | **5603 tests: 5530 pass, 62 fail = exactly the baseline set** (no new failure), 11 skipped |
| Fork tests | remote-access 61, mobile-support 15, pwa 9, upstream-audit 2: all pass |
| Typecheck | 0 errors |
| Lint | 0 errors, the 1 existing warning |
| `npm run build`, `build-server`, upstream `smoke-server` | pass |
| `smoke-mobile` (real Chrome, 5 sizes + Electron agent + server stopped) | **90/90 checks** |
| Real Next runtime gate probe (curl, desktop mode) | as expected (Phase 2 table above) |
| `start.bat` in its own window | serves `/`, the manifest and `sw.js`; stopped cleanly |

## Real-machine check ✅ (approved by the owner, 2026-11-27)
Setup:
- The unpacked Windows build (`electron-builder --win --x64 --dir`) was started with `--user-data-dir=D:\tools\lh-e2e\userdata`. The owner's installed LearnHarness and its data were never used.
- Its desktop window was driven over a local DevTools port, 9447. 9333 belongs to HopToDesk and was left alone.
- A separate headless Chrome played the phone over `https://company-cpu.tail14bb89.ts.net:8443`.

Results:
- Header capture on :8444 (foreground serve; `{}` again afterwards); details in REMOTE_ACCESS_SECURITY.md.
- **All checks passed** after two fixes, listed in the security doc: the absolute pairing redirect, and keeping route caching headers on passed requests.
- Lifecycle on the real tailnet: enable, verify and self-probe; off then refused (ECONNREFUSED); on again with the old pairing valid; app restart re-pointed the entry at the new port; quit removed it.
- Final `tailscale serve status`: `{}`.

Observation (upstream, not changed): `/api/events` sends its first bytes with the 25-second ping, so `EventSource` reports "open" after up to 25 s. The direct loopback request behaves the same; events still arrive.

## Remaining issues / risks
- **Stale Serve entry after a crash** until the next launch (documented in the security doc).
- **Settings on the phone still shows desktop-only controls** (provider keys, subscriptions, prompt editing). Saving them is refused server-side with "Only available on the desktop app."; it is safe but clumsy. Follow-up: hide those sections in a remote browser.
- Phone attachments are images only; PDFs and other files still need the desktop.
- `npm test` cannot run on Windows as written (POSIX env prefix, command-line length). Tests run with `node --import tsx --test "<glob>"`.
