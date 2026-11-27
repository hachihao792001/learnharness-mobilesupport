# Upstream modifications

Every change this fork makes to a file that upstream LearnHarness (`amosblomqvist/learnharness`) owns. Keep this list current: it is the conflict checklist for every upstream merge (see [UPSTREAM_SYNC.md](UPSTREAM_SYNC.md)). Each hook is kept to a few lines that call fork modules, so a conflict is small and its fix is obvious.

Fork base: upstream `e3cfff6` (v0.7.0).

Search tip: every fork hunk in an upstream file is marked with a `Fork:` comment (`git grep -n "Fork:"`).

## Summary

| Upstream file | Phase | Lines | Why |
|---|---|---|---|
| `electron/main.cjs` | 1 | +10 | Start Remote Access after the server is up |
| `electron/preload.cjs` | 1 | +14 | `window.lh.remoteAccess` for desktop Settings |
| `src/server/desktop-access.ts` | 2 | +2, 1 changed | Let a gate-approved remote request through `apiRequestRefusal` |
| `proxy.ts` | 2 | +8, 1 changed | Run the remote gate on pages as well as `/api` |
| `src/server/index.ts` | 2 | +2 | Export the pair handler through the barrel `app/` must use |
| `components/settings/settings-dialog.tsx` | 2 | +9, 2 changed | Remote Access section in desktop Settings |
| `tests/desktop-api.test.ts` | 2 | +2, 1 changed | Matcher now includes pages (assertion updated) |
| `tests/desktop-platform.test.ts` | 1 | 1 changed | Reviewed preload key list gains `remoteAccess` |
| `tests/file-path-preload.test.ts` | 1 | 1 changed | Same reviewed key list |
| `tests/plugin-document-proxy.test.ts` | 2 | +1, 1 changed | Matcher now includes non-API paths (assertion updated) |
| `app/layout.tsx` | 3–4 | +17, 2 changed | Phone stylesheet, viewport + theme colour, pre-paint browser mark, `MobileShell` and `PwaSupport` mounts, Apple web-app metadata |
| `README.md` | 7 | +7 | "Use at your own risk" warning at the top; short "This fork" section (links, `start.bat`). Conflicts only if upstream edits the first or last lines |
| `components/chat.tsx` | 3/5 | +8, 2 changed | Remote-only hooks: draft saving, phone images, re-attach after reconnect |
| `components/composer.tsx` | 3 | +8, 2 changed | Phone image button in a remote browser's session composer |

## Details

### `electron/main.cjs`
- **Change:** `require("./remote-access/setup-remote-access.cjs")`, plus one `setUpRemoteAccess({...})` call right after the dev/packaged server branch in `main()`.
- **Why:** Remote Access must know the server's loopback port and its IPC child, and it must register an IPC handler that uses main's own trusted-window check. Only `main.cjs` has these.
- **Alternatives considered:** wrapping `startServer` or monkey-patching `ipcMain`. Both are harder to read and break more easily.
- **Expected conflicts:** low. Upstream edits near the end of the `if (!devUrl) … else …` block in `main()` will touch the same area.
- **How to remove:** delete the require and the call; the `electron/remote-access/` folder can then be deleted.
- **No `URL` at call time:** the call passes the plain `url` string (`appURL`), and the setup module parses it. Upstream tests run `main()` in a `vm` context without a `URL` global, and upstream code only parses `url` lazily inside handlers.
- **Dev mode:** the call registers only the `lh:remote-access:control` handler (it answers `{ available: false }`). No quit/resume listeners are added, so the dev-startup tests' single `before-quit` listener count is unchanged.

### `electron/preload.cjs`
- **Change:** a `remoteAccess` group (status/enable/disable/startPairing/cancelPairing/revokeDevice/onChange) in the existing `contextBridge.exposeInMainWorld("lh", …)` object.
- **Why:** the preload may only `require("electron")` (enforced by `tests/file-path-preload.test.ts`), so the bridge cannot live in another file. It sends fixed `{ op }` objects only; main validates every op.
- **Alternatives considered:** a second `exposeInMainWorld` name. The reviewed tests assert the single name `"lh"`, so this would also need test changes and adds a second global.
- **Expected conflicts:** low, unless upstream reorders the bridge object.

### `src/server/desktop-access.ts`
- **Change:** `apiRequestRefusal` in desktop mode now refuses only when the desktop secret is missing **and** `remoteAPIRequestAllowed(request, env)` is false. Import of that function added.
- **Why:** one hook covers both callers: `proxy.ts` and the streamed plugin-document route (`src/server/plugin-transport.ts`), which skips the proxy on purpose.
- **Safety:** `remoteAPIRequestAllowed` returns false unless the server is in desktop mode, the request is classified remote, and the full gate (enabled, exact host, owner identity, paired device, same-origin write, route allowed) passes. Browser-only mode never reaches it.
- **Expected conflicts:** medium if upstream reworks this function; the fix is to keep the extra `&& !remoteAPIRequestAllowed(...)` condition on the desktop branch.

### `proxy.ts`
- **Change:**
  1. If the request has **no valid desktop secret** and `isRemoteAccessRequest(request)`, return `remoteAccessProxyResponse(request)` (synchronous). The secret still decides first, as upstream's `browser-api-access` test requires (a secret-bearing request through a LAN host name passes).
  2. Non-`/api` paths return `NextResponse.next()` before the upstream API logic.
  3. A third matcher entry: `"/((?!api$|api/|_next/static/).*)"`.
- **Why:** page routes (for example `/chat/[id]`) server-render full transcripts, and upstream's proxy only covered `/api`. Remote page requests must be gated too. Local page requests take step 2 and behave exactly as before. Both upstream matcher entries are unchanged.
- **Kept synchronous:** upstream tests call `proxy(...)` and read `.status` directly.
- **Expected conflicts:** medium if upstream edits `proxy()`; keep the two fork lines at the top of the function.

### `src/server/index.ts`
- **Change:** one appended line: `export { remoteAccessPairResponse } from "../remote-access/pair-handler.ts";`
- **Why:** the ESLint architecture rule lets `app/` import only `@/src/core` and `@/src/server`. The pair route follows the same rule as every upstream route.
- **Expected conflicts:** low (end of file).

### `components/settings/settings-dialog.tsx`
- **Change:**
  - an import of `RemoteAccessSection` and `useRemoteAccessAvailable`
  - `SmartphoneIcon` added to the lucide import
  - `| "remote-access"` in `SectionId`
  - a conditional nav entry (only when `window.lh.remoteAccess` exists, i.e. the desktop window)
  - one render branch
- **Why:** the Settings sections are a fixed list with a hard-coded render chain; there is no registry to add to.
- **Expected conflicts:** medium. This file changes often upstream; each hunk is small and marked.

### `app/layout.tsx`
- **Change:**
  - `import "./mobile.css"`;
  - a `viewport` export (`viewportFit: "cover"`, `interactiveWidget: "resizes-content"`);
  - a `<head>` with one inline script (`MARK_BROWSER_SCRIPT`), which adds `lh-browser` to `<html>` in any browser but never in the Electron window;
  - `<MobileShell />` and `<PwaSupport />` rendered inside `AppShell` after `{children}`;
  - in `metadata`, `appleWebApp` and `icons.apple`; in `viewport`, `themeColor` (the manifest link comes from `app/manifest.ts` by itself).
- **Why:** the phone layout must apply before first paint, and never in the Electron window. A CSS media query alone cannot tell them apart; the user agent can. `MobileShell` must sit inside `AppShell` to reach the sidebar and settings-dialog contexts. The viewport options are ignored by desktop browsers and Electron.
- **Expected conflicts:** medium if upstream reworks the root layout. Re-add the four pieces.

### `components/chat.tsx`
- **Change:**
  - imports;
  - `useRemoteComposerDraft(chatId, textRef, applyText)` and `useImageTargetChat(chatId)` after `recordComposerText`;
  - `images: []` → `images: pickedImagesForChat(chatId)` in `prepareText`'s text input;
  - `clearPickedImages(chatId)` inside its `accepted()`;
  - `useRemoteStreamRecovery(chatId, attachToRunningTurn, isStreaming)` after the `turn-started` handler.
- **Why:** drafts, phone images and reconnecting all need the chat's own refs and callbacks. Each hook does nothing outside a remote browser, and `pickedImagesForChat` returns `[]` when nothing was picked, so the desktop path is unchanged.
- **Expected conflicts:** medium, because this file changes often upstream. The hunks are one line each.

### `components/composer.tsx`
- **Change:**
  - imports;
  - `ChatSessionComposer` reads `useRemoteImageAttach()`, counts picked images in `canSend`, and passes `remoteImageAttach` to `Composer`;
  - `Composer` gains an optional `remoteImageAttach` prop (default `false`) that swaps `AttachFilesButton` for `RemoteImageAttachButton`.
- **Why:** only the session composer of a chat page sends text input with images; home, new-session and plugin composers keep the desktop button.

### Tests changed (upstream-owned test files)
- `tests/desktop-api.test.ts`: the old assertion that `/chat/new` is **not** matched by the proxy is now that it **is** matched, plus a new assertion that a local page request passes through untouched (`x-middleware-next: 1`).
- `tests/plugin-document-proxy.test.ts`: the loop that asserted `/`, `/chat/new`, `/apix` and `/api-other/...` are **not** matched now asserts they are. Non-API paths go through the proxy, and local ones pass untouched. Every API assertion in that file is unchanged and still passes, including the exclusion of the streamed document endpoint.
- `tests/desktop-platform.test.ts`, `tests/file-path-preload.test.ts`: the reviewed list of preload bridge keys gains `"remoteAccess"`. These tests exist to make every new renderer surface a reviewed change; this is that review.

## Fork-only files (no upstream conflict possible)
- `electron/remote-access/*.cjs`
- `src/remote-access/*.ts`
- `app/api/remote-access/pair/route.ts`
- `app/remote/pair/route.ts`
- `components/settings/remote-access-section.tsx`
- `tests/remote-access-*.test.ts`, `tests/mobile-support.test.tsx`
- `app/mobile.css`, `components/mobile/*`
- `scripts/fork/seed-mobile-fixture.ts`, `scripts/fork/smoke-mobile.mjs`, `scripts/fork/build-pwa-icons.mjs`, `scripts/fork/upstream-audit.mjs`, `scripts/fork/upstream-touchpoints.json`
- `app/manifest.ts`, `components/pwa/*`, `public/sw.js`, `public/offline.html`, `public/icons/*`
- `tests/pwa.test.ts`, `tests/upstream-audit.test.ts`
- `.github/workflows/fork-remote-access.yml` (a separate file, so `ci.yml` stays upstream's)
- `start.bat`
- `docs/MOBILE_PWA.md`, `docs/UPSTREAM_SYNC.md`
- `docs/FORK_ARCHITECTURE.md`, `docs/UPSTREAM_MODIFICATIONS.md`, `docs/BASELINE_TEST_RESULTS.md`, `docs/REMOTE_ACCESS_*.md`
