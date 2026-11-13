# 0010: Core checks the caller's role from a signed assertion

Status: accepted (#613). Core's verifier is built; the web app's issuer is #720.

## Context

Auth0 roles (`docs/auth0-setup.md`, #370) are enforced by `apps/web/proxy.ts` and `requirePermission` (#371), and both run inside Next. The browser sends every action straight to `/api/core/*`, which `tailscale serve` routes past Next (ADR 0004). Core has no sign-in, so once an assistant has a page (#382), anyone on the tailnet with an assistant sign-in could call a core mutation the role lacks. Gate writes stay safe: they need the owner's passkey signature.

## Options

1. **Route core-backed actions through Next route handlers** that call `requirePermission`, and make core refuse anything not from the web server. ADR 0004 rejected this: an extra hop, every route mirrored, and a second session layer. It also needs core to tell "from Next" from "from the browser", which takes a shared secret in core's environment.
2. **Core verifies the caller's role itself** from an assertion the web app signs. Chosen.

Rejected for option 2: trusting `Tailscale-User-Login`. It names a tailnet identity, not the Auth0 role, and ADR 0004 keeps it informational.

## Decision

- The web app, which holds the Auth0 session, signs a role assertion with an Ed25519 private key only it holds: `base64url(payload).base64url(signature)`, payload `{ sub, role, permissions, exp }`. `permissions` is what `ROLE_PERMISSIONS` gives the role, so the role-to-permission map stays in one place (`apps/web/lib/auth/permissions.ts`).
- The browser carries it as the cookie `eido_core_role` (`Path=/api/core; HttpOnly; Secure; SameSite=Strict`), short-lived and renewed by the web app while the Auth0 session lives.
- Core holds only the public key (`EIDO_CORE_ROLE_PUBLIC_KEY`, base64 SPKI, on the data plane's environment allowlist). It can check an assertion, never make one, so core still holds no secret.
- When the key is set, every state-changing request (anything but GET, HEAD, OPTIONS) needs a valid, unexpired assertion that lists a permission the route accepts (`packages/core/src/api/caller-role.ts`, the `ROUTE_PERMISSIONS` table). No or invalid assertion: 401. Missing permission: 403. A state-changing route with no row is refused for everyone, so a new route is closed until it is added to the table.
- When the key is unset (single-owner mode, no Auth0), core behaves as before. There is no assistant in that mode.
- Reads are not restricted: the tailnet still decides who may read. Restricting reads by role is a separate decision and issue.

| Route                                                                                    | Permission (any of)            |
| ---------------------------------------------------------------------------------------- | ------------------------------ |
| `PATCH /profile`, `PUT /default-entity`, `/entities*`, `PUT\|DELETE /entity-assignments` | `profile:update`               |
| `POST /connectors/simplefin/sync`, `PUT /connectors/simplefin/assignments`               | `connector:update`             |
| `POST /ask`                                                                              | `ask:query`                    |
| `POST /replies/draft`                                                                    | `draft:create`                 |
| `POST /intents`                                                                          | `document:update`, `ask:query` |
| `POST /obligations/:id/(done\|resolve\|reopen)`                                          | `obligation:resolve`           |
| `PUT /documents/:sha/type`, `POST /extractions/:id/confirm`                              | `document:update`              |

## Consequences

- A forged, edited, expired or missing assertion cannot change anything in core, even by calling `/api/core/*` directly. Tests in `packages/core/src/api/caller-role.test.ts` show the refusal over HTTP.
- Until the web app issues the assertion (#720) and `EIDO_CORE_ROLE_PUBLIC_KEY` is set, core does not enforce roles. Set the key only together with the issuer, or the owner's own actions get 401.
- An assertion is bearer for its lifetime: a revoked assistant keeps core access until `exp`. Keep `exp` to minutes.
