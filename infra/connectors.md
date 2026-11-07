# Connecting and reconnecting connectors (#98)

A connector is connected on the Mac with this command, or from the Admin page with a passkey signature (Proton and SimpleFIN #661, Google #662; see `docs/gate-signed-control-changes.md`). The credential goes straight into the gate vault. The running gate then checks it and reports the result on `/connectors`.

```bash
pnpm stack:gate connect gmail
pnpm stack:gate connect gmail-read
pnpm stack:gate connect drive
pnpm stack:gate connect proton-mail
pnpm stack:gate connect proton-calendar
pnpm stack:gate connect simplefin
```

The same command connects a connector for the first time and reconnects one later. It exits 0 only when the gate reports the connector healthy.

## Before you start

- **Gate user and environment.** Run the command as the gate user, with the gate's own vault and socket variables:
  - `EIDO_GATE_CONTROL_SOCKET`;
  - `EIDO_GATE_KEYCHAIN_PATH` (see `infra/keychain-vault.md`), or `EIDO_DEV_VAULT=1` with `EIDO_GATE_VAULT_FILE` for development;

  The command writes the same vault the gate reads. Google's client ids live in the gate's environment only (`EIDO_GMAIL_CLIENT_ID`, `EIDO_GMAIL_READ_CLIENT_ID`, `EIDO_DRIVE_CLIENT_ID`); the gate runs the Google sign-in itself.

- **The gate must be running.** The command asks the gate for connector health before it prompts for anything. If the gate is not reachable, or the connector is not pinned, it stops and nothing is stored.
- **The connector must already be pinned.** Pin its reviewed manifest first; this command does not pin. On a fresh install, in this order:
  1. Place the reviewed manifest on the Mac: `pnpm --silent --filter @eido/core connector-manifest gmail | EIDO_GATE_DATA_DIR=<gate data dir> pnpm --filter @eido/gate reviewed-manifest -` (see `docs/gate-signed-control-changes.md`).
  2. On the phone, open Connectors, choose Review and pin on the Not pinned card, and sign with the passkey.
  3. Run `pnpm stack:gate connect gmail`.

## What the command does

1. It checks that the gate is running and that the connector is pinned.
2. It takes the credential:
   - **Gmail and Drive:** a Google sign-in in the browser, run by the gate (below).
   - **Proton:** the Bridge password at a prompt.
   - **SimpleFIN:** a setup token at a prompt, claimed for an access URL (below).
3. It writes the credential to the gate vault. The credential is never printed, logged, passed in arguments or the environment, or written to a file.
4. It asks the gate, over the control socket, to check the connector now:
   - a connector disabled because its credential was refused is re-enabled for the check;
   - a backoff is lifted, so the check runs at once.

   The gate records the result in connector health. It writes one audit row, `connector.connected`, that holds only a hash of the outcome.

5. It prints `<connector>: healthy`, or the health and its reason, for example `gmail: open (auth_failed)`.

A connector disabled for manifest drift or a missing signed pin is not re-enabled. Fix the pin first, then connect again.

## Gmail

The Google OAuth client is a **Web application** client in Google Cloud. Its client id is the gate's `EIDO_GMAIL_CLIENT_ID`. Add one authorized redirect URI to it, the gate's callback on the Mac's tailnet name:

```text
https://<mac>.<tailnet>.ts.net:8443/api/gate/connect/google/callback
```

The stack supervisor sets the gate's `EIDO_GOOGLE_REDIRECT_URI` to this address from the web app's URL. It must be `https`, on the web app's origin, with no query, and end in `/connect/google/callback`; the gate refuses to start otherwise. Without it, Google sign-in is off and the Admin page and the command both say so.

Start the sign-in from either place:

- **Admin page**, on the phone or the Mac: Connectors, then Connect on the Google client. The passkey signs the start (`connector_oauth:<client>`); the signed payload names the client id, never the secret.
- **Command** on the Mac: `pnpm stack:gate connect gmail`.

The first connect asks for the client secret, which is not shown as you type. The gate holds it in memory until Google's answer checks out and only then stores it in the vault; later reconnects reuse the stored one.

The sign-in:

1. The gate makes a PKCE pair and a single-use `state`, and keeps them in memory for 10 minutes. A gate restart ends every pending sign-in.
2. The browser opens Google's consent page. Sign in and grant the Gmail permission. Leave the Gmail box ticked on the consent screen; without it the gate refuses the grant.
3. Google redirects the browser to the gate's callback. The gate:
   - takes the `state` once; an unknown, used or expired one changes nothing;
   - exchanges the code with its PKCE verifier;
   - stores the refresh token, and the new client secret if there was one, in the vault;
   - drops any cached access token, so its next call uses the new grant;
   - checks the connector and audits `connector.oauth.connected` with hashes only.
4. The browser lands on the Admin page's connector list with the outcome. The command, which polls the gate, prints the connector's health.

A Google error, a refused code, a missing refresh token, an unticked permission or a timeout stores nothing. Start again.

The browser can be on any device on the tailnet, so there is no port to forward over SSH.

### Reconnecting

When Google revokes the grant, the gate disables Gmail and `/connectors` shows it with the reason `auth_failed`. Run `pnpm stack:gate connect gmail` again. The new refresh token replaces the old one, and Gmail is re-enabled once the check passes.

## The Gmail read client

Gmail has two Google clients. The compose client (`connect gmail`, `gmail.modify`) makes the gate's writes. The read client makes core's reads through the gate's read proxy. It is a second **Web application** OAuth client in Google Cloud, with the same redirect URI; its client id is the gate's `EIDO_GMAIL_READ_CLIENT_ID`.

`connect gmail-read` is the same sign-in as `connect gmail`, with these differences:

- It asks for the `gmail.readonly` permission. Leave the Gmail box ticked on the consent screen; without it the gate refuses the grant.
- It stores the refresh token and the client secret under the Gmail **read** client. The compose client's grant is left as it was. The first connect asks for the read client's secret; later reconnects reuse the stored one.
- The gate checks Gmail with both clients: the compose client's profile read, and one pinned profile read through the proxy with the read client. Gmail is healthy only when both work. The gate must run with `EIDO_GMAIL_READ_CLIENT_ID` and `EIDO_GATE_EGRESS_PORT` set, or it has no read check.

When Google revokes either grant, the gate disables Gmail with `auth_failed`. Run the connect command for the client whose grant was revoked; Gmail is re-enabled once both checks pass.

## Drive

Drive is a read connector: core reads it through the gate's read proxy, and the gate holds its read client's grant. The client is a **Web application** OAuth client in Google Cloud, with the same redirect URI; its client id is the gate's `EIDO_DRIVE_CLIENT_ID`.

`connect drive` is the same sign-in as Gmail, with these differences:

- It asks for the `drive.readonly` permission. Leave the Drive box ticked on the consent screen; without it the gate refuses the grant.
- It stores the refresh token and the client secret under the Drive **read** client. The first connect asks for the secret; later reconnects reuse the stored one.
- The gate checks Drive with one pinned read through the proxy, `changes/startPageToken`. The gate must run with `EIDO_DRIVE_CLIENT_ID` and `EIDO_GATE_EGRESS_PORT` set, or it has no Drive check and the command reports that it could not check Drive.

When Google revokes the grant, the gate disables Drive with `auth_failed`. Run `pnpm stack:gate connect drive` again; Drive is re-enabled once the check passes.

## The read proxy

Core's connectors read through the gate's egress proxy, which adds the read client's token to each pinned read. The gate starts the proxy when a read client is configured:

- `EIDO_GMAIL_READ_CLIENT_ID` for Gmail reads, `EIDO_DRIVE_CLIENT_ID` for Drive;
- `EIDO_GATE_EGRESS_PORT`, the proxy's port on `127.0.0.1`. It is required with a read client and refused without one;
- the same vault variables as above.

Point core at it with `EIDO_GMAIL_PROXY_URL=http://127.0.0.1:<EIDO_GATE_EGRESS_PORT>`.

When an access token is missing or refused, the proxy refreshes it once from the stored refresh token and retries the read once. When Google answers `invalid_grant`, or refuses a fresh token, the gate disables the connector with `auth_failed`. It audits that with a hash of the error class only. A refresh that fails for another reason answers `token_refresh_failed` and leaves the connector enabled.

With a read client configured, `connected` checks the connector with one pinned read through the proxy:

- Drive reads `changes/startPageToken`.
- Gmail reads the profile. With both the compose and the read client configured, Gmail is healthy only when both work.

## Proton Mail and Proton Calendar

Both Proton connectors use the one Bridge password, read with `info` in `bridge --cli` (see "Proton Bridge LaunchAgent" in `infra/README.md`). The command asks for it without showing it as you type, and stores it in the gate vault.

Changing the Bridge certificate pin from the Admin page deletes the stored password first; enter it again after the stack restarts. Each connector is checked separately. After a new Bridge password, run the command for both `proton-mail` and `proton-calendar`, so that each is checked and, if it was disabled, re-enabled.

## SimpleFIN

SimpleFIN is a read-only bank connector (#51). Core reads accounts and transactions through the gate's egress proxy; nothing writes to the bank.

1. In SimpleFIN Bridge (`bridge.simplefin.org`), create a setup token for Eido.
2. Run `pnpm stack:gate connect simplefin` and paste the token at the prompt. It is not shown.
   - The command claims the token once, from `bridge.simplefin.org` only, and stores the returned access URL in the gate vault. The access URL is the credential: only the gate reads it.
   - A claimed token cannot be claimed again. If the claim fails after Bridge accepted it, create a new token.
3. The gate turns the access URL into a Basic header on each pinned read, and counts the reads against the manifest's daily limit.

Gate environment:

- `EIDO_GATE_SIMPLEFIN=1` turns the connector on;
- `EIDO_GATE_EGRESS_PORT`, the proxy's port, as for the other read connectors.

Core environment:

- `EIDO_SIMPLEFIN_PROXY_URL=http://127.0.0.1:<EIDO_GATE_EGRESS_PORT>`; without it core does not sync SimpleFIN;
- `EIDO_SIMPLEFIN_MAX_RANGE_DAYS`, the longest window one read asks for (default 90).

Assign each SimpleFIN account an entity in Settings, under SimpleFIN accounts. Until an account has one, none of its transactions are stored, and connector health says how many accounts need one. Assigning an entity to an account that has already synced reads its older transactions once (one request, back as far as `EIDO_SIMPLEFIN_MAX_RANGE_DAYS`), when the daily budget allows.

SimpleFIN allows 24 requests a day and 90 days per request. The manifest's daily limit defaults to that; set `EIDO_SIMPLEFIN_REQUESTS_PER_DAY` when building the manifest (`connector-manifest simplefin`) to pin a lower one. When the limit is spent the proxy answers `daily_limit` and core waits for the next day.

## Reading the result

- The command's last line is the gate's verdict.
- The same health shows on `/connectors` in the web app, which reads it from the gate. It shows healthy once the check passes.
- When the check fails, the line gives the reason:
  - `auth_failed`: the credential was refused; run connect again.
  - `handshake_failed`, `timeout` or `unavailable`: the upstream could not be reached; the gate retries with backoff.

## Not verified by the tests

The tests run the whole flow with a fake token endpoint, an in-memory vault and a gate on a test socket, with no network.

These steps are the owner's, on the Mac:

- a real Google consent, for the Gmail compose client, the Gmail read client and Drive;
- a real Bridge password;
- a real SimpleFIN setup token and read (#547);
- the SSH port forward;
- seeing the result on `/connectors`.
