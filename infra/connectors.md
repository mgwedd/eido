# Connecting and reconnecting connectors (#98)

A connector is connected on the Mac, never through the web app. The credential goes straight into the gate vault. The running gate then checks it and reports the result on `/connectors`.

```bash
pnpm --filter @eido/gate connect gmail
pnpm --filter @eido/gate connect gmail-read
pnpm --filter @eido/gate connect drive
pnpm --filter @eido/gate connect proton-mail
pnpm --filter @eido/gate connect proton-calendar
pnpm --filter @eido/gate connect simplefin
```

The same command connects a connector for the first time and reconnects one later. It exits 0 only when the gate reports the connector healthy.

## Before you start

- **Gate user and environment.** Run the command as the gate user, with the gate's own vault and socket variables:
  - `EIDO_GATE_CONTROL_SOCKET`;
  - `EIDO_GATE_KEYCHAIN_PATH` (see `infra/keychain-vault.md`), or `EIDO_DEV_VAULT=1` with `EIDO_GATE_VAULT_FILE` for development;
  - `EIDO_GMAIL_CLIENT_ID` for Gmail;
  - `EIDO_GMAIL_READ_CLIENT_ID` for the Gmail read client, the same id the gate's read proxy uses (see "The read proxy");
  - `EIDO_DRIVE_CLIENT_ID` for Drive, the same id the gate's read proxy uses (see "The read proxy").

  The command writes the same vault the gate reads.

- **The gate must be running.** The command asks the gate for connector health before it prompts for anything. If the gate is not reachable, or the connector is not pinned, it stops and nothing is stored.
- **The connector must already be pinned.** Pin its reviewed manifest first; this command does not pin.

## What the command does

1. It checks that the gate is running and that the connector is pinned.
2. It takes the credential:
   - **Gmail and Drive:** a Google sign-in in the browser (below).
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

The Google OAuth client is a **Desktop app** client in Google Cloud. Its client id is the gate's `EIDO_GMAIL_CLIENT_ID`.

The first connect asks for the client secret, which is not shown as you type. The secret is stored in the vault only once sign-in succeeds; later reconnects reuse the stored one.

The sign-in follows OAuth for native apps (RFC 8252):

1. The command opens a listener on `127.0.0.1`, on a port the system picks.
   - It accepts one callback and then closes.
   - It gives up after 5 minutes.
2. It prints the Google address and opens it in the default browser.
3. Sign in and grant the Gmail permission. Leave the Gmail box ticked on the consent screen; without it the command refuses the grant.
4. Google redirects back to the listener. The command then:
   - checks the request's `state`;
   - exchanges the code with its PKCE verifier;
   - stores the refresh token in the vault;
   - drops any cached access token, so the gate's next call uses the new grant.

A refused or mismatched answer, a Google error, a missing refresh token or a timeout stores nothing. Run the command again.

### Signing in from another computer

The listener is on the Mac's `127.0.0.1`, so the browser must reach that address.

When you run the command over SSH, read the port from the printed address (`redirect_uri=http://127.0.0.1:<port>/…`). Then forward that port from the computer with the browser, and open the printed address there within the 5 minutes:

```bash
ssh -L <port>:127.0.0.1:<port> <mac>
```

### Reconnecting

When Google revokes the grant, the gate disables Gmail and `/connectors` shows it with the reason `auth_failed`. Run `pnpm --filter @eido/gate connect gmail` again. The new refresh token replaces the old one, and Gmail is re-enabled once the check passes.

## The Gmail read client

Gmail has two Google clients. The compose client (`connect gmail`, `gmail.modify`) makes the gate's writes. The read client makes core's reads through the gate's read proxy. It is a second **Desktop app** OAuth client in Google Cloud; its client id is `EIDO_GMAIL_READ_CLIENT_ID`, in both the gate's environment and the command's.

`connect gmail-read` is the same sign-in as `connect gmail`, with these differences:

- It asks for the `gmail.readonly` permission. Leave the Gmail box ticked on the consent screen; without it the command refuses the grant.
- It stores the refresh token and the client secret under the Gmail **read** client. The compose client's grant is left as it was. The first connect asks for the read client's secret; later reconnects reuse the stored one.
- The gate checks Gmail with both clients: the compose client's profile read, and one pinned profile read through the proxy with the read client. Gmail is healthy only when both work. The gate must run with `EIDO_GMAIL_READ_CLIENT_ID` and `EIDO_GATE_EGRESS_PORT` set, or it has no read check.

When Google revokes either grant, the gate disables Gmail with `auth_failed`. Run the connect command for the client whose grant was revoked; Gmail is re-enabled once both checks pass.

## Drive

Drive is a read connector: core reads it through the gate's read proxy, and the gate holds its read client's grant. The client is a **Desktop app** OAuth client in Google Cloud; its client id is `EIDO_DRIVE_CLIENT_ID`, in both the gate's environment and the command's.

`connect drive` is the same sign-in as Gmail, with these differences:

- It asks for the `drive.readonly` permission. Leave the Drive box ticked on the consent screen; without it the command refuses the grant.
- It stores the refresh token and the client secret under the Drive **read** client. The first connect asks for the secret; later reconnects reuse the stored one.
- The gate checks Drive with one pinned read through the proxy, `changes/startPageToken`. The gate must run with `EIDO_DRIVE_CLIENT_ID` and `EIDO_GATE_EGRESS_PORT` set, or it has no Drive check and the command reports that it could not check Drive.

When Google revokes the grant, the gate disables Drive with `auth_failed`. Run `pnpm --filter @eido/gate connect drive` again; Drive is re-enabled once the check passes.

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

Each connector is checked separately. After a new Bridge password, run the command for both `proton-mail` and `proton-calendar`, so that each is checked and, if it was disabled, re-enabled.

## SimpleFIN

SimpleFIN is a read-only bank connector (#51). Core reads accounts and transactions through the gate's egress proxy; nothing writes to the bank.

1. In SimpleFIN Bridge (`bridge.simplefin.org`), create a setup token for Eido.
2. Run `pnpm --filter @eido/gate connect simplefin` and paste the token at the prompt. It is not shown.
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
