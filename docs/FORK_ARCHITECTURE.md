# Fork architecture

This fork (`hachihao792001/learnharness-mobilesupport`) adds **Remote Access over Tailscale**, a **mobile layout** and an **installable PWA** to upstream LearnHarness (`amosblomqvist/learnharness`). Upstream stays the source of truth for the learning engine. The fork adds modules and keeps its edits to upstream files small and listed in [UPSTREAM_MODIFICATIONS.md](UPSTREAM_MODIFICATIONS.md).

## Git state at the start (audit, 2026-11-27)

| Item | Finding |
|---|---|
| Branch | `main`, clean working tree |
| `origin` | `https://github.com/hachihao792001/learnharness-mobilesupport.git` |
| `upstream` | missing. Added as `https://github.com/amosblomqvist/learnharness.git` (from `package.json` `homepage` and `git ls-remote`, whose HEAD `e3cfff6` equals the fork's `main`). Push URL set to `DISABLED`, so it is fetch-only |
| Fork-specific commits | none: `main` == `upstream/main` == `e3cfff6` (v0.7.0) |
| Tags | upstream release tags `v0.1.0` … `v0.7.0` |
| CI | `.github/workflows/ci.yml` (Linux quality job: typecheck, test, lint; standalone build matrix on macOS arm64, Windows x64, Linux x64), `release.yml` (tags `v*`, three-OS packaging), `notify-website.yml` |
| Conventions | `CONTRIBUTING.md`: focused PRs with tests and docs; discuss features first. Commit style is mixed (`fix:`, `perf(chat):`, plain sentences). `AGENTS.md`: read `node_modules/next/dist/docs` first; ask the human about any design decision |
| Branches for this work | `feature/remote-access` (Phases 0–2), then `feature/mobile-pwa` (Phases 3–7), both from `main` |

## Existing application architecture (verified in source)

- **Electron shell** (`electron/main.cjs`): spawns the Next **standalone** server (`.next/standalone/server.js`, shipped unpacked via `extraResources`) as a child process with `ELECTRON_RUN_AS_NODE=1`:
  - `HOSTNAME=127.0.0.1` and a **random free port each launch** (`freePort()`);
  - `LH_DATA_DIR=userData/data`, `LH_AUTH_FILE=userData/auth.json`;
  - `LH_DESKTOP_SERVER=1` and a fresh 64-hex `LH_DESKTOP_API_SECRET`;
  - a Node IPC channel (`stdio [..., "ipc"]`).

  It waits for `GET /`, then opens the window at `http://127.0.0.1:<port>`. Shutdown: `killServer()` on `before-quit`, `exit`, `SIGHUP`. There is no automatic server restart and no `powerMonitor`. Single-instance lock. `electron-updater` in packaged builds.
- **Desktop API capability:** `session.webRequest.onBeforeSendHeaders` adds `x-learnharness-desktop: <secret>` only to `/api` requests from a trusted app window's main frame (`electron/desktop-api.cjs`).
- **Request gate:** `proxy.ts` (Next 16 "proxy", Node runtime) → `apiRequestRefusal` (`src/server/desktop-access.ts`).
  - Desktop mode: every `/api` request needs the secret.
  - Browser-only mode (`next dev`/`next start`, no secret): a host allowlist plus same-origin checks on writes, and **no login**.
  - Pages are not gated.
- **IPC pattern:** one `lh:<feature>:control` invoke channel per feature, checked with `trustedAppWindows` + `trustedSender`. Main ↔ server talk over the child IPC pipe (`subscription-ipc.cjs` ↔ `src/agent/subscription-bridge.ts`), with state on `globalThis`.
- **Server layers:** `app/` (routes and pages, which may import only `@/src/core` and `@/src/server`), `src/server` (transport), `src/agent` (agent runtime, tools, providers), `src/store` (JSON files), `src/core` (pure).
- **Turns and streams:**
  - `POST /api/chat` saves the input first, claims the chat's single turn (a competing turn gets 409), and only acknowledges.
  - `GET /api/chats/[id]/stream` replays the running turn's whole compacted event log, then live events, then `[DONE]`. It has no cursor.
  - Disconnecting never stops the turn.
  - `GET /api/chats/[id]` reports `turnInFlight`.
  - `/api/events` is a notify-only SSE; consumers refetch when it reconnects.
- **Jobs:** `GET /api/jobs?chatId=`, `GET /api/activity`, `POST /api/activity/abort`. Statuses are `running | done | error`; there is no retry endpoint.
- **Persistence:** `LH_DATA_DIR` → `chats/<id>.json`, `jobs/<id>.json`, `graph/*.jsonl|json`, `settings.json`, `prompts/`, `themes/`. Writes are atomic: temp file, fsync, rename.
- **Frontend:**
  - Tailwind v4 with no breakpoints at all; the sidebar is an inline `w-72` aside, settings is a fixed 920×620 dialog, context menus are right-click only.
  - The graph is Canvas 2D + d3-zoom (pinch and pan are supported by the library).
  - Composer drafts are kept in memory only. Attachments are local **path strings** through the Electron bridge (disabled in a plain browser).
  - There is no manifest, icon set, `viewport` export or service worker.
- **Tests:** `node:test` through `tsx`; Electron files are tested by running `main.cjs` in a `vm` with a fake `electron`. There is no e2e harness; browser checks are `puppeteer-core` scripts.

## File ownership

| Class | Meaning | Files |
|---|---|---|
| A | Upstream-owned, unmodified | everything not listed below (learning engine, agent runtime, providers, stores, all other routes and components) |
| B | Upstream-owned, modified by the fork | see [UPSTREAM_MODIFICATIONS.md](UPSTREAM_MODIFICATIONS.md) |
| C | Fork-only | `electron/remote-access/`, `src/remote-access/`, `app/api/remote-access/`, `app/remote/`, `components/settings/remote-access-section.tsx`, `tests/remote-access-*`, `docs/FORK_ARCHITECTURE.md`, `docs/UPSTREAM_*.md`, `docs/BASELINE_TEST_RESULTS.md`, `docs/REMOTE_ACCESS_*.md` (later phases add `components/mobile/`, `components/pwa/`, `app/mobile.css`, `public/sw.js`, `public/icons/`, `scripts/fork/`) |
| D | Generated or dependency-managed | `node_modules/`, `.next/`, `dist/`, `next-env.d.ts` (rewritten by `next build`/`next dev`), `package-lock.json`, `plugins/*/.sdk`, `core-plugins/` |

## Integration points the fork uses

| Point | Used for | Upstream contract relied on |
|---|---|---|
| `main.cjs` after the server is up | start Remote Access | the server child object and its loopback URL |
| child IPC pipe | policy snapshot, pairing | Node `child.send` / `process.on("message")`, the `channel` field convention |
| `proxy.ts` / `apiRequestRefusal` | remote gate | desktop-mode detection by env; `proxy()` stays synchronous |
| `/api/*` routes | phone UI (unchanged contracts) | see the list in `src/remote-access/route-policy.ts` |
| `/api/chats/[id]` + `/stream` + `/api/events` | reconnection (Phase 5) | `turnInFlight`, full replay on subscribe, resync on reconnect |
| `POST /api/chat` `images` | phone image attachments (Phase 3) | base64 PNG/JPEG/WebP/GIF inside the `text` input |
| Settings dialog | Remote Access section | `SECTIONS` + render chain |

## Security boundaries
1. Network: only `tailscaled` (Serve :8443, tailnet only; Funnel never used). The server stays on loopback.
2. Remote gate in the server: exact host, owner identity, paired-device cookie, same-origin writes, and a deny-by-default route list.
3. Desktop window: the existing per-launch secret, unchanged.
4. Electron IPC: renderer ops are whitelisted; the server ↔ main pipe carries fixed ops with validated fields. Neither can pass commands, executables, ports or paths.

Details: [REMOTE_ACCESS_SECURITY.md](REMOTE_ACCESS_SECURITY.md).

## Expected merge conflicts

The files that change often upstream and also carry fork hooks are `components/settings/settings-dialog.tsx` (medium), `proxy.ts` and `src/server/desktop-access.ts` (medium if the auth model changes), and `electron/main.cjs` (low). Later phases add small hooks in `app/layout.tsx` and the chat/composer components. Per-file notes are in UPSTREAM_MODIFICATIONS.md, and `scripts/fork/upstream-audit.mjs` (Phase 7) lists which of these an upstream update touches.

## Extension plan (phases)
- **Phase 1–2 (`feature/remote-access`):** remote access and security, done as described in [REMOTE_ACCESS_ARCHITECTURE.md](REMOTE_ACCESS_ARCHITECTURE.md).
- **Phase 3:** responsive layout in a separate stylesheet. Mobile mode applies only in a browser narrower than 768px, never in the Electron window. Bottom navigation (Learn, Graph, Activity, Settings) reuses the existing sidebar, activity section and settings dialog as drawers and sheets. Long press opens the existing context menus. A graph node list stands in where the canvas is hard to use.
- **Phase 4:** web manifest, icons, a service worker that caches only versioned static assets, and install, update and offline indicators. It registers only in a browser on the remote origin.
- **Phase 5:** reconnection using the existing contracts (refetch `turnInFlight`, reattach to the stream, never resend input), plus drafts kept in the phone's storage.
- **Phase 6–7:** mobile viewport smoke test, the upstream audit script, a fork CI workflow, and UPSTREAM_SYNC.md.
