# Remote Access — security

Remote Access lets the owner use the desktop LearnHarness from a phone through Tailscale Serve. This document is the threat model and the list of controls. Architecture: [REMOTE_ACCESS_ARCHITECTURE.md](REMOTE_ACCESS_ARCHITECTURE.md).

## What is being protected

| Asset | Where it is |
|---|---|
| Learning records: transcripts, graph, notes | `userData/data` (pages and `/api`) |
| Spending: model calls cost the owner's API credit or subscription | `/api/chat`, steer, side chats, jobs |
| Provider credentials (API keys, OAuth) | `auth.json`, `*-credentials.json` (desktop only) |
| Files on the PC | the agent's file tools follow the desktop **file access** setting |
| Control of the desktop app and Tailscale | Electron main process |

## Trust boundaries

```
Phone browser ──HTTPS (tailnet, WireGuard)──▶ tailscaled (Tailscale Serve, :8443)
                                                │  plain HTTP on loopback
                                                ▼
                         Next server (127.0.0.1:<random port>, child of Electron)
                           ├─ proxy.ts → remote gate (src/remote-access/gate.ts)
                           └─ IPC pipe ◀──▶ Electron main (electron/remote-access/)
Desktop window ──(x-learnharness-desktop secret)──▶ same Next server
```

- The server stays bound to `127.0.0.1`. Nothing new listens on the network; only `tailscaled` accepts tailnet connections.
- **Funnel is never used.** Remote Access refuses to set up if Funnel is on for :8443, so the service is not reachable from the internet.
- Serve terminates TLS with the tailnet's certificate for `<machine>.<tailnet>.ts.net`.

## Who might attack, and what stops them

### A. Other people or devices on the tailnet
- **Other users of the same tailnet, or users of other tailnets who accepted a share of this PC.** Serve sends their identity in `Tailscale-User-Login`. The gate allows **only the login this PC is signed in with** (read from `tailscale status` when Remote Access turns on); every other login gets 403.
- **Tagged devices** (servers, CI). Serve sends no identity for them, so a missing `Tailscale-User-Login` gets 403.
- **The owner's own other devices** pass identity, but still need **pairing** (below).

### B. Programs on this PC (forged headers)
Serve forwards to loopback, so the server cannot tell a Serve request from any local program that writes the same headers. Without more, any local program (or another Windows user on the same PC) could fake `Tailscale-User-Login` while Remote Access is on.

- **Control: device pairing.** Every remote request except the pairing page and static assets must carry the `__Host-lh-remote` cookie: `<deviceId>.<token>`, with 32 random bytes in the token.
  - Main stores only the token's SHA-256. The server gets the hashes in its policy snapshot and compares them in constant time.
  - A local program does not know any token, so faked headers get the pairing page (303) or 401.
- **Pairing code.** It is shown only in the desktop window (trusted Electron IPC):
  - 8 characters from a 32-letter alphabet (≈ 10¹² values), single use, valid for 5 minutes;
  - locked after 5 wrong tries;
  - accepted only together with the owner's Tailscale identity.

  A local program could reach the pair route with faked headers, but it would have to guess a live code in 5 tries.
- **Residual risk:** malware running as the same OS user can read `userData` files and process memory anyway. That was already outside upstream's model ("the desktop secret is not an OS-user malware boundary").

### C. Malicious websites (in the phone's or the PC's browser)
- **CSRF:** every remote write (POST/PUT/PATCH/DELETE) must have:
  - `Origin` exactly `https://<machine>.<tailnet>.ts.net:8443`, and `Sec-Fetch-Site: same-origin` when the browser sends it;
  - a body of `application/json` or `multipart/form-data`. `text/plain` and form-encoded bodies get 415.

  The pairing cookie is also `SameSite=Strict`. `OPTIONS` is refused (no CORS is ever granted).
- **DNS rebinding:** the `Host` header (and `X-Forwarded-Host`, if present) must be exactly the Serve name and port. Requests that reach the loopback port under another name are refused.
- **The `Host` and `X-Forwarded-*` headers are never treated as proof of identity.** They only decide whether a request is *remote*; identity comes from Tailscale plus the pairing cookie.

### D. A lost or stolen phone
- Revoke the device in desktop Settings → Remote Access. Pairings also expire after **90 days**.
- Turning Remote Access off blocks every device at once; the gate closes before the Serve entry is removed.
- The phone also needs the owner's Tailscale session, which can be cut off in the Tailscale admin console.

## What a paired phone can and cannot do

**Deny by default:** `src/remote-access/route-policy.ts` lists every API route and method. Anything not listed (including new upstream routes) is local-only, and `tests/remote-access-route-coverage.test.ts` fails until each route has a decision.

| Allowed remotely | Desktop only (403 "Only available on the desktop app.") |
|---|---|
| Pages, chat send/stream/steer/stop, sessions, side chats | API keys (`/api/keys/*`) |
| Graph: view, edit, notes import upload, positions, folders | Custom provider (`/api/custom-provider`) |
| Activity and jobs, including abort | Subscriptions (`/api/subscriptions/*`) |
| Images and artifacts, markdown export | Claude Code status (`/api/claude-code`) |
| Plugin views, plugin assets and calls, document conversion | Prompt editing (`/api/settings/prompts/*`) |
| Model list, per-chat model choice (`PUT /api/chats/[id]/settings`) | All global settings writes (`PUT /api/settings/*`, incl. agent file access) |
| `GET /api/settings` (read only), themes list, dictation token | Theme and plugin management, model catalog refresh |

Never sent to the phone:
- raw API keys: `/api/keys` is blocked, and upstream already masks keys everywhere;
- pairing tokens: `Set-Cookie` only, and the cookie is HttpOnly;
- token hashes and other devices' details.

Not exposed to the phone at all: Electron debugging, host process control, update management, Tailscale control. These exist only as Electron IPC, which only the trusted desktop window can call.

### Agent file access (accepted, documented)
A remote chat runs the same agent as a desktop chat. The agent's file tools follow the desktop **file access** setting (unrestricted by default; credential files and `.env*` are always denied). A paired phone therefore can ask the agent to read files on this PC, just as the desktop user can. The phone **cannot change** that setting (`PUT /api/settings/agent` is desktop-only). To limit it, set file access to restricted folders in desktop Settings → Agent.

## Caching and storage
- The gate's own refusals and redirects get `Cache-Control: no-store`. Responses it lets through keep the route's caching headers: dynamic pages already send `private, no-cache, no-store`, and streams send `no-cache, no-transform`. Overriding them dropped `no-transform`, so gzip buffered SSE; the real-machine check found this.
- The PWA service worker (Phase 4) caches only versioned static assets (`/_next/static`, fonts, icons). It never caches pages, `/api`, streams, images or anything private.
- Remote composer drafts are kept in the phone's `localStorage` (Phase 3), on the phone only.

## Lifecycle risks
- **Stale Serve entry after a crash.** Quitting removes the :8443 entry, but a crash or power loss leaves it pointing at a dead loopback port until the next launch fixes it (it re-points or removes its own entry on startup). If another program grabs that exact port in between, tailnet users could reach it, but only owner-identity requests arrive and the gate is not there to check them. This window is accepted and documented; turn Remote Access off before uninstalling.
- **Ownership:** LearnHarness only touches `<machine>:8443`. It records that it created the entry *before* creating it. It refuses to touch the port if anything else is there (another target, a TCP forward, extra paths, Funnel, a foreground session), and it never runs `tailscale serve reset`.
- **Policy not yet received:** if the server has no policy from main (just started), remote requests get 503 "still starting", never "allowed".

## Verified by tests
`tests/remote-access-gate.test.ts` runs the ten mandatory cases through the real `proxy()`, `apiRequestRefusal()` and pair route:
1. forged Tailscale headers sent straight to the loopback port;
2. a non-owner identity, even with a valid cookie;
3. a missing identity;
4. a local program faking the exact Serve headers without a pairing;
5. cross-origin and form-like writes;
6. desktop-only APIs, including encoded and case-changed paths;
7. traversal-style paths;
8. no credential in any response;
9. unexpected Host / X-Forwarded-Host;
10. everything refused after Remote Access is turned off.

It also runs one full pairing round trip over the real IPC protocol, against the real Electron-side manager.

## Verified on the real machine (Tailscale 1.104.5, 2026-11-27)
A one-minute foreground `tailscale serve --https=8444` to a header echo server recorded exactly what Serve forwards:
- `Host: company-cpu.tail14bb89.ts.net:8444`: the browser's host is **kept**.
- `X-Forwarded-For: 100.66.94.38`, the real tailnet client address. A client-sent `X-Forwarded-For: 6.6.6.6` was **replaced**. `X-Forwarded-Host` and `X-Forwarded-Proto: https` are also set.
- `Tailscale-User-Login: hachihao792001@gmail.com`. A client-sent forged login was **stripped and replaced**. `Tailscale-User-Name` is RFC 2047-encoded (`=?utf-8?q?...?=`); the login is plain ASCII, which is what the gate compares. Serve also adds `Tailscale-Headers-Info`.
- The backend's socket address is `127.0.0.1` (tailscaled connects on loopback).

So a **tagged** device, which gets no identity header, still arrives with a non-loopback `Host` and `X-Forwarded-For`. It is classified remote and refused for missing identity.

The full check against the packaged app, on an isolated profile, passed on the real tailnet:
- pairing, including refusal of a missing code and of a wrong code;
- phone layout, HttpOnly/Secure/SameSite=Strict cookie;
- learning APIs 200, desktop-only APIs 403, `text/plain` write 415;
- cross-origin POST with a valid cookie 403;
- a local program faking every Serve header on the loopback port, without a pairing, 401;
- upstream's local 403 unchanged;
- SSE and turn streams work through Serve, uncompressed;
- service worker on the real HTTPS origin;
- off → the address refuses connections; on again → the old pairing still works;
- restart → the entry is re-pointed at the new port; quit → `serve status` is `{}`.

Two bugs found only by this check, now fixed with regression tests:
1. A relative `Location` on the pairing redirect made Next's proxy fail with a 500.
2. The gate's `Cache-Control: no-store` replaced the streams' `no-cache, no-transform`, so gzip could buffer SSE.

Still true: a login with non-ASCII characters could arrive RFC 2047-encoded and would then be refused (fails closed).
