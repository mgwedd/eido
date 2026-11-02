# 0004: Web transport through `tailscale serve`

Status: accepted (#178). The serve measurements below are still to be taken on the Mac.

## Context

The phone PWA and the Mac browser reach three things: the Next shell, core's API (#86, #153) and the gate's phone listener (#85, #99). They need one HTTPS origin the service worker can treat as same-origin (`apps/web/public/sw-routing.js`), without a second session layer and without CORS.

## Decision

`tailscale serve` is the only edge. It terminates HTTPS on the node's `*.ts.net` name and splits one origin by path, each route to a loopback target:

| Path        | Target                  | Backend                                    |
| ----------- | ----------------------- | ------------------------------------------ |
| `/`         | `http://127.0.0.1:3000` | Next: shell, service worker, manifest      |
| `/api/core` | `http://127.0.0.1:8789` | core's API, no auth                        |
| `/api/gate` | `http://127.0.0.1:8788` | the gate's phone listener: passkey session |

- **Eido has its own HTTPS port, 8443.** The origin is `https://<host>.ts.net:8443`. The issue text assumed port 443; that is superseded, because the host runs other tailnet apps that `tailscale serve` exposes on 443, and Eido must not collide with them.
- **No other route on Eido's port.** Never the gate's admin or enrolment routes (#78): those listen Mac-local only. Routes on other ports belong to other apps and are left alone.
- **Funnel stays off** for Eido's port. Funnel on another port exposes that app, not Eido's backends, which listen on loopback only.
- **Applied and checked by `infra/tailscale`.** `pnpm --filter @eido/infra serve-routes apply` runs `tailscale serve --bg --https=8443 --set-path=<path> http://127.0.0.1:<port>` once per route (`--bg` makes serve resume after a reboot or `tailscale down`/`up`), then checks `tailscale serve status --json` and `tailscale funnel status --json`. `check` does the check alone. Both read only Eido's port: they fail on any route there other than the three, on a target other than the expected one, on a port that is not plain HTTPS, on a foreground serve session holding the port, and on funnel for the port. `apply` changes nothing while such a route or funnel is present. The port is one flag (`--port`, default 8443), as are the three target ports.

## A separate origin per port

An origin is scheme, host and port, so `https://<host>.ts.net:8443` is a different origin from whatever runs on 443 of the same host:

- The service worker, its scope and caches, `localStorage`, IndexedDB and the same-origin policy are Eido's alone.
- The WebAuthn origin includes the port: the gate's `EIDO_WEBAUTHN_ORIGIN` is `https://<host>.ts.net:8443`. The RP ID is the host name without a port, so passkeys for that RP ID are not separated by port.
- Cookies are scoped by host, not by port (RFC 6265). The gate's session cookie (`Path=/api/gate; HttpOnly; Secure; SameSite=Strict`, #99) would also be sent to a request for `/api/gate` on another port of the same host. Only the gate reads it; another app on the host would see it only for that path, and those apps are the owner's own.

## Trust model

- The tailnet is trusted for core reads and profile writes. Core has no auth and no per-request Unlock; it relies on the tailnet and a loopback bind, and answers only its configured Host headers (421 otherwise, #153).
- Approvals, the audit log and settings need the gate's passkey session (WebAuthn, #15; 12-hour session, #99).
- `Tailscale-User-Login` is informational: no auth depends on it.

## What each backend binds to

Serve proxies only to `http://127.0.0.1` targets, so each backend binds loopback TCP. A Unix socket is not an option for the phone listener.

- Next: `127.0.0.1:3000`.
- Core: `EIDO_CORE_HOST=127.0.0.1`, `EIDO_CORE_PORT=8789` (core's default). 8787 belongs to another app on the host, which also serves it through `tailscale serve`, so it is not an Eido default (#372).
- Gate phone listener: `EIDO_GATE_PHONE_HOST=127.0.0.1`, `EIDO_GATE_PHONE_PORT=8788`. The listener has no default port; 8788 is the script's default.
- Core's `EIDO_CORE_BASE_PATH` and `EIDO_CORE_ALLOWED_HOSTS`, and the gate's `EIDO_GATE_PHONE_BASE_PATH` and `EIDO_GATE_PHONE_ALLOWED_HOSTS`, follow from the measurements below.

## Serve behaviour (to be measured)

The serve docs give the mount-path matching rule as Go `ServeMux` but do not say whether the prefix is stripped or which `Host` arrives. These are not yet measured; this section is filled in, and the results posted on #153 and #85, once `pnpm --filter @eido/infra serve-routes measure` has run on the Mac with the routes applied. It starts loopback echo servers on the three targets in place of the backends, requests each route through the origin, and prints a table with the node name replaced by `<host>`.

- Whether serve strips the path prefix (does core see `/profile` or `/api/core/profile`?): not yet measured.
- Which `Host` header each backend receives: not yet measured.
- Whether `Tailscale-User-Login` reaches the backends: not yet measured.

## Rejected

- **Next route handlers or server actions proxying core and the gate.** An extra hop, a second session layer, every route mirrored, and the WebAuthn assertion passes through code that does not need it.
- **The browser calling backends on separate origins.** Needs credentialed CORS, which core forbids, and breaks the service worker's same-origin rule.
- **A new fronting process.** Rebuilds what serve does, and either merges the two planes or holds sessions.
- **Sharing port 443 with other apps on the host.** Eido's `/` would collide with another app's `/`, and Eido's routes would share an origin (service worker scope, storage) with it.
