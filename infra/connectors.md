# Connecting and reconnecting connectors (#98)

A connector is connected on the Mac, never through the web app. The credential goes straight into the gate vault. The running gate then checks it and reports the result on `/connectors`.

```bash
pnpm --filter @eido/gate connect gmail
pnpm --filter @eido/gate connect drive
pnpm --filter @eido/gate connect proton-mail
pnpm --filter @eido/gate connect proton-calendar
```

The same command connects a connector for the first time and reconnects one later. It exits 0 only when the gate reports the connector healthy.

## Before you start

- **Gate user and environment.** Run the command as the gate user, with the gate's own vault and socket variables:
  - `EIDO_GATE_CONTROL_SOCKET`;
  - `EIDO_GATE_KEYCHAIN_PATH` (see `infra/keychain-vault.md`), or `EIDO_DEV_VAULT=1` with `EIDO_GATE_VAULT_FILE` for development;
  - `EIDO_GMAIL_CLIENT_ID` for Gmail;
  - `EIDO_DRIVE_CLIENT_ID` for Drive, the same id the gate's read proxy uses (see "The read proxy").

  The command writes the same vault the gate reads.

- **The gate must be running.** The command asks the gate for connector health before it prompts for anything. If the gate is not reachable, or the connector is not pinned, it stops and nothing is stored.
- **The connector must already be pinned.** Pin its reviewed manifest first; this command does not pin.

## What the command does

1. It checks that the gate is running and that the connector is pinned.
2. It takes the credential:
   - **Gmail and Drive:** a Google sign-in in the browser (below).
   - **Proton:** the Bridge password at a prompt.
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

## Reading the result

- The command's last line is the gate's verdict.
- The same health shows on `/connectors` in the web app, which reads it from the gate. It shows healthy once the check passes.
- When the check fails, the line gives the reason:
  - `auth_failed`: the credential was refused; run connect again.
  - `handshake_failed`, `timeout` or `unavailable`: the upstream could not be reached; the gate retries with backoff.

## Not available yet

- **The Gmail read client.** The command connects the Gmail write client (`gmail.modify`) only. Nothing stores the read client's refresh token yet, so reads through the proxy answer `credential_missing` (#529).

## Not verified by the tests

The tests run the whole flow with a fake token endpoint, an in-memory vault and a gate on a test socket, with no network.

These steps are the owner's, on the Mac:

- a real Google consent, for Gmail and for Drive;
- a real Bridge password;
- the SSH port forward;
- seeing the result on `/connectors`.
