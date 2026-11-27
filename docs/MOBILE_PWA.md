# Phone layout, PWA and reconnecting

How LearnHarness works on a phone opened at the Remote Access address ([REMOTE_ACCESS_ARCHITECTURE.md](REMOTE_ACCESS_ARCHITECTURE.md)). The same Next.js frontend is used: there is no separate app and no copied business logic.

## Rules
- **Phone layout:** a **browser** narrower than **768px**. The Electron window never gets it, at any size.
  - A tiny `<head>` script (`MARK_BROWSER_SCRIPT`) adds `html.lh-browser` before first paint, in any browser but never in Electron.
  - Every rule in `app/mobile.css` sits under that class and the 767px media query.
- **Remote-only behaviour** (`isRemoteBrowser()`: not Electron, host not loopback):
  - drafts saved on the phone;
  - phone image attachments;
  - re-attaching to a running turn after a reconnect;
  - the service worker, install and offline UI.

  The desktop app and local browser tabs keep upstream behaviour.

## Phone layout (Phase 3)

| Piece | Where | How |
|---|---|---|
| Bottom bar: Learn · Graph · Activity · Settings | `components/mobile/mobile-shell.tsx` | Learn opens the **existing** sessions sidebar as a drawer. Graph goes to `/`; a second tap opens a searchable node list. Activity shows the existing `ActivitySection` in a sheet. Settings opens the existing dialog, full screen |
| **80% size**, matching the 80% browser zoom the owner tested on a phone: a root font size of 80% scales spacing and boxes (rem); each fixed px text size is overridden; the reading size (set inline by Appearance) is scaled on `<body>`. The bottom bar (56px) and text fields (16px, no iOS zoom) stay full size. CSS `zoom` was rejected: in Chrome it puts measured coordinates 20% off (graph taps, menus) | `app/mobile.css` | Measured: rendered text sizes equal true 80% browser zoom |
| Drawer, full-screen settings, safe areas, 16px fields (no iOS zoom), menus capped to the screen | `app/mobile.css` | CSS on stable upstream hooks (`aside.sidebar-motion`, `data-testid="settings-dialog"`) |
| Keyboard | `mobile-shell.tsx`, `viewport.interactiveWidget = "resizes-content"` | The bar hides only when a field has focus **and** the visible height shrinks (focus alone happens on page load). The layout shrinks with the keyboard, so the composer stays above it |
| Long press = right-click menus | `long-press-context-menu.ts` | A still finger for 650 ms sends the existing `contextmenu` (session rows, folders, graph nodes). Android's own long-press menu event is not doubled |
| Graph | unchanged canvas (d3-zoom already does touch pan and pinch) + `graph-node-list.tsx` | Search propositions by name or statement, read the statement, open the sessions that touched it |
| Phone images | `remote-images.ts`, `remote-image-attach-button.tsx` | Native picker or camera. Images are re-encoded as JPEG (at most 2048px, which also converts HEIC), at most 4 per message, sent in the **existing** `images` field of `POST /api/chat`, and cleared only when the server accepts the message |
| Unsent text | `use-remote-composer-draft.ts` | Saved per chat in the phone's `localStorage` every second and when the tab hides; restored into an empty composer with a notice. Upstream clears the composer only after the server accepts a message, so a saved draft is exactly the unconfirmed text |

Other files (PDFs, code) cannot be attached from the phone; the desktop path chips need the desktop.

## Reconnecting (Phase 5)
Existing contracts only (see FORK_ARCHITECTURE.md):
- The server owns the turn. A phone that disconnects never stops it.
- `use-remote-stream-recovery.ts` runs when the phone comes back `online`, when the tab becomes visible, on `pageshow`, and when `/api/events` reconnects. It reads `GET /api/jobs?chatId=`; if `turnInFlight` is set and nothing is streaming, it calls the chat's own `attachToRunningTurn()`, and `GET /api/chats/[id]/stream` replays the whole running turn.
- **It never sends input again.** If a send's outcome is unknown, the text stays in the composer (and in the saved draft) with a notice to check the transcript first. Server locks and 409 answers are used as they are.
- After an Electron restart, the phone's pairing cookie still works: devices live in `userData`, and Serve is re-pointed at the new port on launch.

## PWA (Phase 4)

| Piece | File |
|---|---|
| Manifest (`/manifest.webmanifest`): standalone, start `/`, theme `#141414`, icons 192/512/maskable | `app/manifest.ts` |
| Icons rendered from `build/icon-flat.svg` (`node scripts/fork/build-pwa-icons.mjs`) | `public/icons/` |
| Apple touch icon and `appleWebApp` metadata | `app/layout.tsx` |
| Service worker | `public/sw.js` |
| Registration, update prompt, install button / iOS hint, offline banner | `components/pwa/pwa-support.tsx` |
| Offline page (static, no data) | `public/offline.html` |

### Caching rules (`public/sw.js`)
- **Cached:** `/_next/static/*` (file names change with every build), `/fonts/*`, `/icons/*`, the offline page. The cache is named `lh-static-<app version>`, and older versions are deleted on activate.
- **Never cached:** pages (they hold transcripts), `/api/*`, streams, session images, plugin assets. Pages are always fetched; with no network the offline page is shown.
- **Updates:** a new worker waits. The page shows "A new version of LearnHarness is ready · Reload", and only that tap makes it take over and reload. The worker is registered with `updateViaCache: "none"`, and the remote gate sends `no-store`.

### Installing
- **Android, Chrome:** open the Remote Access address, pair, then tap **Install** in the banner (or ⋮ → *Install app*).
- **iPhone/iPad, Safari:** pair, then **Share → Add to Home Screen**. A one-time hint says so.
  - Depending on the iOS version, the installed app may not share Safari's cookies. If it opens the pairing page, pair once more inside the installed app.
- Other browsers may not offer installing; the site still works in the browser tab.
- The installed app is the same site: it needs Tailscale connected and the computer awake, with LearnHarness and Remote Access on.

## Tests
- `tests/mobile-support.test.tsx`: browser marking, remote detection, long press, image store, drafts, reconnecting, node list filter, composer button switch.
- `tests/pwa.test.ts`: the real service worker in a sandbox (what it may and may not cache, offline page, version clean-up, update hand-over), and the manifest with its icons.
- `scripts/fork/smoke-mobile.mjs`: real Chrome at 360×800, 390×844, 412×915, 768×1024 and 1280×800, plus an Electron-agent window at 360px.
  - It checks layout, overflow, composer position, the keyboard, the drawer, long press, sheets, settings, draft restore and the graph list, and saves screenshots.
  - Chrome maps `lh-remote.test` to 127.0.0.1 and treats it as secure, so remote-only features run without Tailscale or a phone.
