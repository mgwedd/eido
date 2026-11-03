# Auth0 setup for the web app

The web app (`apps/web`) asks each person to sign in with Auth0 before it shows any page. The tailnet stays the network boundary; sign-in adds a check on the person and gives them a role. Passkey Unlock (#32) still gates approvals in the gate, so sign-in sits on top of it, not in place of it.

This doc rebuilds the tenant from scratch with the `auth0` CLI (tested with 1.38). Replace the placeholders:

| Placeholder              | Meaning                                                          |
| ------------------------ | ---------------------------------------------------------------- |
| `TENANT`                 | the tenant domain, for example `eido-prod.us.auth0.com`          |
| `HOST.ts.net`            | the Mac's tailnet name, the origin `tailscale serve` uses (#178) |
| `CLIENT_ID`              | the "Eido" application's client ID, printed in step 2            |
| `owner@example.test`     | the owner's real address (never committed)                       |
| `assistant@example.test` | each assistant's real address (never committed)                  |

## 1. Tenant

Eido uses its own tenant, not astrea-labs-prod. That keeps astrea users out of Eido and gives the two products separate allow-lists, so no Action has to tell the clients apart.

```bash
auth0 login                      # once, as a tenant admin
auth0 tenants use TENANT
```

## 2. Application

A regular web app named "Eido". The callback and logout URLs list both origins the app is served on: the tailnet origin and `http://localhost:3000` for development.

```bash
auth0 apps create --name Eido --type regular \
  --callbacks "http://localhost:3000/auth/callback,https://HOST.ts.net:8443/auth/callback" \
  --logout-urls "http://localhost:3000,http://localhost:3000/,https://HOST.ts.net:8443,https://HOST.ts.net:8443/" \
  --web-origins "https://HOST.ts.net:8443" \
  --reveal-secrets --json
```

Note the `client_id` and `client_secret` from the output, then turn on refresh-token rotation with an expiry:

```bash
auth0 api patch "clients/CLIENT_ID" --data '{
  "token_endpoint_auth_method": "client_secret_post",
  "grant_types": ["authorization_code", "refresh_token"],
  "refresh_token": {
    "rotation_type": "rotating",
    "expiration_type": "expiring",
    "token_lifetime": 7776000,
    "idle_token_lifetime": 2592000,
    "infinite_token_lifetime": false,
    "infinite_idle_token_lifetime": false
  }
}'
```

## 3. Connections: email one-time code, sign-ups off

Passwordless email with a six-digit code, not a magic link, so a mail scanner that follows links can't use the sign-in up. Sign-ups are off.

```bash
auth0 api post connections --data '{
  "name": "email",
  "strategy": "email",
  "enabled_clients": ["CLIENT_ID"],
  "options": {
    "disable_signup": true,
    "brute_force_protection": true,
    "totp": { "length": 6, "time_step": 300 },
    "email": {
      "syntax": "liquid",
      "from": "{{ application.name }} <no-reply@your-domain>",
      "subject": "Your Eido sign-in code",
      "body": "<p>Your Eido sign-in code is <strong>{{ code }}</strong>. It expires in 5 minutes.</p>"
    }
  }
}'
```

Turn sign-ups off on every other connection too, and take the Eido client off them. For the default database connection:

```bash
auth0 api get connections --query "strategy=auth0" | jq -r '.[] | .id'
auth0 api patch "connections/CONNECTION_ID" --data '{"options": {"disable_signup": true}}'
auth0 api patch "connections/CONNECTION_ID/clients" --data '[{"client_id": "CLIENT_ID", "status": false}]'
```

Mail goes out through your own SMTP provider (Branding → Email Provider), so codes don't come from Auth0's rate-limited test sender.

### Google (current tenant only)

The live tenant also enables `google-oauth2` (scopes `email`, `profile`) for the Eido client, linked into the owner's user, so the owner can sign in with Google as well. This is a deliberate exception to "no other connection". A social connection cannot turn sign-ups off: an unknown Google account still gets a user record on first sign-in, and the post-login Action below denies it. The web app then gives it no role. If you don't need Google, leave it out.

## 4. Invite-only Actions

Two Actions deny anyone the owner did not invite. Both read `app_metadata.invited`, which only the owner sets, from the CLI.

`invite-only-signup`, on `pre-user-registration`, refuses to create a user who is not invited. It is a second check behind `disable_signup`.

```bash
auth0 actions create --name invite-only-signup --trigger pre-user-registration --runtime node22 \
  --code 'exports.onExecutePreUserRegistration = async (event, api) => {
  if (event.user.app_metadata && event.user.app_metadata.invited === true) return;
  api.access.deny("not_invited", "Eido accounts are by invitation only.");
};'
auth0 actions deploy ACTION_ID
auth0 api patch "actions/triggers/pre-user-registration/bindings" --data '{
  "bindings": [{ "ref": { "type": "action_name", "value": "invite-only-signup" }, "display_name": "invite-only-signup" }]
}'
```

`invite-only-login`, on `post-login`, denies a sign-in by any user who is not invited. It also covers connections that cannot turn sign-ups off, such as Google.

```bash
auth0 actions create --name invite-only-login --trigger post-login --runtime node22 \
  --code 'exports.onExecutePostLogin = async (event, api) => {
  if (event.user.app_metadata && event.user.app_metadata.invited === true) return;
  api.access.deny("Eido accounts are by invitation only.");
};'
auth0 actions deploy ACTION_ID
auth0 api patch "actions/triggers/post-login/bindings" --data '{
  "bindings": [{ "ref": { "type": "action_name", "value": "invite-only-login" }, "display_name": "invite-only-login" }]
}'
```

Verify both bindings. Each must list its Action:

```bash
auth0 api get actions/triggers/pre-user-registration/bindings
auth0 api get actions/triggers/post-login/bindings
```

## 5. Users

The owner creates every user from the CLI. Eido has no in-app invite flow and holds no Management API (M2M) credential. Create each user with `invited` set in the same request, so the pre-registration Action lets it through:

```bash
auth0 api post users --data '{
  "connection": "email",
  "email": "owner@example.test",
  "email_verified": true,
  "app_metadata": { "invited": true }
}'
```

Repeat for each assistant. To remove someone, take them off the env lists (step 7) and block or delete the user in Auth0.

## 6. Login page: dark theme and custom text

New Universal Login, identifier first, in Eido's dark palette:

```bash
auth0 api patch prompts --data '{"universal_login_experience": "new", "identifier_first": true}'

auth0 api post branding/themes --data '{
  "displayName": "Eido",
  "colors": {
    "page_background": "#020817",
    "widget_background": "#020817",
    "widget_border": "#1E293B",
    "header": "#F8FAFC",
    "body_text": "#F8FAFC",
    "input_labels_placeholders": "#94A3B8",
    "input_filled_text": "#F8FAFC",
    "input_background": "#020817",
    "input_border": "#1E293B",
    "primary_button": "#F8FAFC",
    "primary_button_label": "#0F172A",
    "secondary_button_border": "#1E293B",
    "secondary_button_label": "#F8FAFC",
    "links_focused_components": "#CBD5E1",
    "icons": "#94A3B8",
    "error": "#F87171",
    "success": "#16A34A"
  },
  "borders": {
    "button_border_radius": 6,
    "button_border_weight": 1,
    "buttons_style": "rounded",
    "input_border_radius": 6,
    "input_border_weight": 1,
    "inputs_style": "rounded",
    "widget_corner_radius": 8,
    "widget_border_weight": 1,
    "show_widget_shadow": false
  },
  "page_background": {
    "background_color": "#020817",
    "page_layout": "center",
    "background_image_url": ""
  },
  "widget": {
    "logo_position": "center",
    "logo_url": "",
    "logo_height": 32,
    "header_text_alignment": "left",
    "social_buttons_layout": "bottom"
  },
  "fonts": {
    "font_url": "",
    "reference_text_size": 16,
    "links_style": "normal",
    "title": {
      "bold": true,
      "size": 150
    },
    "subtitle": {
      "bold": false,
      "size": 87.5
    },
    "body_text": {
      "bold": false,
      "size": 87.5
    },
    "buttons_text": {
      "bold": true,
      "size": 87.5
    },
    "input_labels": {
      "bold": false,
      "size": 87.5
    },
    "links": {
      "bold": true,
      "size": 87.5
    }
  }
}'

auth0 api put prompts/login-id/custom-text/en --data '{
  "login-id": {
    "title": "Sign in to Eido",
    "description": "Enter your email and we will send you a one-time code.",
    "buttonText": "Continue",
    "emailPlaceholder": "Email address"
  }
}'
```

With sign-ups off on every enabled connection, Universal Login shows no sign-up link.

## 7. Web app environment

Seven variables, in `apps/web/.env.local` (gitignored; keep it mode 600). `apps/web/.env.example` lists them.

| Variable                | Value                                                                           |
| ----------------------- | ------------------------------------------------------------------------------- |
| `AUTH0_DOMAIN`          | `TENANT`                                                                        |
| `AUTH0_CLIENT_ID`       | the Eido client ID                                                              |
| `AUTH0_CLIENT_SECRET`   | the Eido client secret                                                          |
| `AUTH0_SECRET`          | `openssl rand -hex 32`; encrypts the session cookie                             |
| `APP_BASE_URL`          | every origin, comma-separated: `http://localhost:3000,https://HOST.ts.net:8443` |
| `EIDO_OWNER_EMAIL`      | exactly one address                                                             |
| `EIDO_ASSISTANT_EMAILS` | comma-separated addresses; may be empty                                         |

The SDK treats a comma-separated `APP_BASE_URL` as an allow-list: it takes each request's origin from the `Host` and `X-Forwarded-*` headers that `tailscale serve` sets and uses it only if it is on the list. Every origin on the list needs its `/auth/callback` in step 2.

These are the web app's own sign-in secrets, not connector credentials. Only `apps/web` reads them. Core and the gate never see them, and core's environment allowlist (ADR 0003) does not change.

The app refuses to start (`instrumentation.ts`) if `EIDO_OWNER_EMAIL` is missing or is more than one address, if an entry is not an email address, or if one address is on both lists.

## 8. Roles and access

`apps/web/lib/auth/roles.ts` turns the session's email into a role. The email must be verified. It is trimmed, lowercased and compared with the two lists: the owner's address gives `owner`, an assistant's gives `assistant`, anything else gives no role.

`apps/web/lib/auth/access.ts` maps pages to roles. It is default-deny, so a page not on the map is the owner's only. The owner may open every page. Today, Queue and Unlock show or sign approvals, so all three are the owner's; the assistant has no pages yet (their workspace is #382). Anyone signed in without access gets a 403 page with a sign-out button.

`apps/web/proxy.ts` enforces this on every request except `/healthz`, `/auth/*`, `/_next/static`, `/_next/image`, the favicon, the PWA manifest and icons, and the service worker files.

What sign-in does not cover: on the tailnet origin, `tailscale serve` sends `/api/gate/*` and `/api/core/*` straight to the gate and core, not through Next, so the proxy never sees those requests. The gate's own checks still guard it there. Every approval route needs the gate's passkey session cookie (`eido_gate_session`, from Unlock), and every decision needs the owner's passkey signature. The Auth0 cookie means nothing to the gate (see the gate test "401s … with only the web app's sign-in cookie").

## 9. Check it by hand

1. Signed out, open `/queue`. You land on Universal Login, with no sign-up link. `curl -i http://localhost:3000/healthz` answers `204` without a session.
2. Sign in as the owner with the emailed code. You come back to `/queue`, and every page opens.
3. Unlock with the passkey, then approve an item. Without Unlock, the gate answers `401`.
4. Sign in as an assistant. Every page answers `403` with a sign-out button.
5. Sign in with an address that isn't invited. Universal Login refuses it and offers no sign-up, because the connection has sign-ups off. To check the second line on its own, open Actions → `invite-only-signup` → Test in the dashboard and run it with an event whose `user.app_metadata` is empty: it returns a deny. Run step 4's binding check too.
6. Sign out from the sidebar or the 403 page. You return to Universal Login, and the next page load asks you to sign in again.
