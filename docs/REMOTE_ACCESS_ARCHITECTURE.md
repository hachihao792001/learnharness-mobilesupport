# Remote Access — architecture

Use the desktop LearnHarness from a phone over Tailscale. The existing Electron-hosted Next server is reused as-is: it stays on `127.0.0.1`, no second server is started, and Tailscale Serve is the only thing on the network. Security model: [REMOTE_ACCESS_SECURITY.md](REMOTE_ACCESS_SECURITY.md).

## Request path

```
Phone ─HTTPS─▶ https://<machine>.<tailnet>.ts.net:8443  (Tailscale Serve, run by tailscaled)
                    │ adds Tailscale-User-Login / -Name; strips client copies
                    ▼
              http://127.0.0.1:<random server port>   (the existing standalone Next server)
                    │
                    ▼
              proxy.ts ──▶ remote request? ──yes──▶ remote gate (src/remote-access/gate.ts)
                             │ no                          │ allowed → NextResponse.next() (route headers kept)
                             ▼                             │ refused → 303 pair page / 401 / 403 / 415 / 503
                     upstream behaviour                    ▼
                     (desktop secret on /api)        the normal page or API route
```

## Pieces

| Where | File | What it does |
|---|---|---|
| Electron main | `electron/remote-access/tailscale-cli.cjs` | Finds `tailscale` (fixed install paths first, then absolute PATH entries) and runs only fixed argument arrays: `status --json`, `serve status --json`, `serve --bg --https=8443 http://127.0.0.1:<port>`, `serve --https=8443 off` |
| | `serve-config.cjs` | Reads the Serve JSON: is :8443 free, a single `/` loopback proxy, or something else (never touched) |
| | `remote-access-store.cjs` | `userData/remote-access.json` (atomic write, 0600): `enabled`, `serveEntryOwned`, paired devices (token **hashes** only) |
| | `remote-access-manager.cjs` | On/off, reconcile at start and after wake-up, remove on quit, pairing codes, devices, policy snapshot |
| | `remote-access-ipc.cjs` | Renderer channel `lh:remote-access:control` (op whitelist) and server channel `lh:remote-access` (`snapshot` / `pair` / `seen`, plus `changed` pushes) |
| | `setup-remote-access.cjs` | The single call `main.cjs` makes |
| Preload | `electron/preload.cjs` | `window.lh.remoteAccess` (fixed ops only) |
| Next server | `src/remote-access/policy-store.ts` | The policy snapshot from main (on `globalThis`, shared by the proxy and route bundles in the one Node process); fails closed |
| | `gate.ts` | Remote/local classification and every check (host, identity, origin, content type, pairing cookie, route policy) |
| | `route-policy.ts` | Deny-by-default table of what a paired phone may call |
| | `proxy-hooks.ts` | The functions `proxy.ts` and `desktop-access.ts` call |
| | `pair-handler.ts`, `device-label.ts` | The pair route's work |
| Routes | `app/api/remote-access/pair/route.ts` | `POST {code}` → pairing cookie |
| | `app/remote/pair/route.ts` | Plain-HTML pairing page (outside the app shell) |
| UI | `components/settings/remote-access-section.tsx` | Desktop Settings → Remote Access (desktop window only) |

## Why these choices
- **Gate in `proxy.ts` and `apiRequestRefusal`.** Next 16 runs `proxy.ts` on the Node.js runtime, loaded with a plain `require` in the same process (`next/dist/server/next-server.js` `loadNodeMiddleware`), so it shares `process` and `globalThis` with the routes. The one route that skips the proxy (streamed plugin documents) calls `apiRequestRefusal`, which carries the same hook.
- **Synchronous gate.** Upstream's `proxy()` is synchronous and its tests rely on that. The policy is pushed by main on every change and requested once when the gate module loads, so it is normally present. If it is not, the answer is 503 "still starting".
- **What counts as "remote".** Next fills `x-forwarded-host/-port/-proto/-for` on *every* request (`next/dist/server/base-server.js`), so the classifier looks at values, not presence. A request is remote when it has a Tailscale identity header, a non-loopback `Host`, or a non-loopback `X-Forwarded-Host` / `X-Forwarded-For`, or any `Forwarded` header.
- **One dedicated port, 8443.** LearnHarness owns only `<machine>:8443`, so it can coexist with anything else served on the machine.
- **The token never reaches the server's memory as plain policy.** Main generates it, returns it once over IPC for the `Set-Cookie`, and keeps only the hash.

## Lifecycle

| Event | What happens |
|---|---|
| Turn on (Settings) | server running? → `tailscale` found → backend `Running`, not a tagged device, HTTPS certs on, owner login known → :8443 free or ours → record ownership → `serve --bg …` → re-read and verify → policy pushed → HTTPS probe of `/remote/pair` from this PC (a failure is only a warning) |
| Turn off | policy pushed as off **first** (gate closes) → remove our :8443 entry → verify it is gone |
| App start | if on: re-point our entry at the new random port (remove + add). If off but we still own an entry (crash): remove it |
| PC wakes up (`powerMonitor` `resume`) | same as app start |
| App quit (`before-quit`, process `exit`) | `serve --https=8443 off` synchronously (3 s cap); ownership written synchronously |
| Server child exits | the IPC link disposes; the manager reports `server-not-running` on the next action |
| Network loss / Tailscale reconnect | nothing to do on the PC: Serve config lives in tailscaled. Phones reconnect (see the mobile docs) |
| Dev mode (`LH_DEV_URL`) | not available: no server child, no IPC; Settings shows "only in the installed desktop app" |

## Commands used (Tailscale 1.104.5, verified against `tailscale serve --help` and tailscale.com/kb/1242, /kb/1312)

```
tailscale status --json
tailscale serve status --json
tailscale serve --bg --https=8443 http://127.0.0.1:<port>
tailscale serve --https=8443 off
```

Port proxying does not need an Administrator console on Windows (kb/1312: only file/directory serving does).
