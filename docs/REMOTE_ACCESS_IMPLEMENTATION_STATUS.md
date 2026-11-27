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

## Remaining issues / risks
- **Real-machine check pending owner approval.** It covers what Host / X-Forwarded-* / identity headers Serve 1.104.5 really sends, enable/disable on the real tailnet, and pairing a browser through the ts.net URL. It runs with an isolated profile (`--user-data-dir`), because this PC also has a real LearnHarness install.
- **Stale Serve entry after a crash** until the next launch (documented in the security doc).
- `npm test` cannot run on Windows as written (POSIX env prefix, command-line length). Tests run with `node --import tsx --test "<glob>"`.
