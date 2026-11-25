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

  The command writes the same vault the gate reads. Google's client ids live in the gate's environment only. By default, a single `EIDO_GOOGLE_CLIENT_ID` configures `gmail`, `gmail-read`, and `drive`, and reuses the stored client secret across targets in the gate vault. Optional per-target overrides (`EIDO_GMAIL_CLIENT_ID`, `EIDO_GMAIL_READ_CLIENT_ID`, `EIDO_DRIVE_CLIENT_ID`) take precedence when set, allowing read/write separation across distinct Google Cloud OAuth clients; the gate runs the Google sign-in itself.

- **The gate must be running.** The command asks the gate for connector health before it prompts for anything. If the gate is not reachable, or the connector is not pinned, it stops and nothing is stored.
- **The connector must already be pinned.** Pin its reviewed manifest first; this command does not pin. On a fresh install, in this order:
  1. Nothing to place: every connector's reviewed manifest is committed in `packages/schemas/manifests/` and the gate offers it. Only a SimpleFIN daily budget below the default needs a placed file (`pnpm --silent --filter @eido/core connector-manifest simplefin | EIDO_GATE_DATA_DIR=<gate data dir> pnpm --filter @eido/gate reviewed-manifest -`, see `docs/gate-signed-control-changes.md`).
  2. In the Admin page (or on the phone), open Connectors, choose Review and pin on the Not pinned card, and sign with the passkey.
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

The Google OAuth client is a **Web application** client in Google Cloud. Its client id is the gate's `EIDO_GOOGLE_CLIENT_ID` (or the target override `EIDO_GMAIL_CLIENT_ID`). Add one authorized redirect URI to it, the gate's callback on the Mac's tailnet name:

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

### Scopes and why a grant stops working (#39)

This comes from Google's documentation, read on 2026-11-16 (#39). It is not a measurement: the day-by-day refresh checks below have not been run yet.

Google classes the scopes Eido asks for as follows:

| Scope            | Used by                  | Class      |
| ---------------- | ------------------------ | ---------- |
| `gmail.modify`   | `gmail` (compose client) | Restricted |
| `gmail.readonly` | `gmail-read`             | Restricted |
| `drive.readonly` | `drive`                  | Restricted |

Every Gmail scope Eido needs is Restricted, so Google shows the unverified-app warning on the consent screen, and an unverified app is capped at 100 new users over the project's life. For one personal account the cap does not matter. Whether a restricted-scope app that is never shipped needs a security assessment is not stated in Google's pages. Drive could avoid the warning with the non-sensitive `drive.file` scope; whether to switch is an open question in #39.

A refresh token stops working, and the gate then sees `invalid_grant`, when:

- you revoke Eido's access in your Google account;
- the token is unused for six months;
- you change the Google account's password (for a token with Gmail scopes);
- more than 100 refresh tokens exist for the account and client id, which silently invalidates the oldest;
- an admin policy blocks it (`admin_policy_enforced`);
- the consent screen is in Testing status, where a test user's authorization, refresh token included, expires after seven days.

Not confirmed yet, and what the #812 measurements settle: whether a Web client in production status has no seven-day expiry for these scopes without verification; whether a token issued during Testing keeps expiring after you publish (assume you must connect once more); and whether restricted scopes work for your own account in an unverified app with no extra steps.

#### Google console

Do this once, in the Google Cloud console, signed in as the Google account Eido reads:

1. Create or pick a project. Under APIs and Services, enable the Gmail API and the Google Drive API.
2. Under OAuth consent screen (Google Auth platform), set the audience. Note the publishing status shown there, `Testing` or `In production`, because the result depends on it. Add your own address as a test user while it is in Testing.
3. Under Credentials, create an OAuth client of type **Web application**. Add the authorized redirect URI from the Gmail section above. Put its client id in the gate's `EIDO_GOOGLE_CLIENT_ID`; the first `connect` asks for the client secret.
4. Run `pnpm stack:gate connect gmail` and `pnpm stack:gate connect gmail-read`, then `pnpm stack:gate connect drive`.

#### Refresh checks (#812)

The checks run on day 0 (the day you connect) and on days 1, 8, 14 and 30 after it. Each time, ask the running gate to check Gmail. This runs the connector's health probe and prints connector health, never mail:

```bash
curl --fail --silent --show-error --unix-socket "$EIDO_GATE_CONTROL_SOCKET" \
  --request POST http://localhost/connectors/gmail/connected
```

Run it as the gate user, with the gate's control socket path. Record in #39 one dated row per check, with the client type (Web application), the consent screen status, and the connector's health and reason. There is no way to read Google's HTTP status or error code from this: the gate reduces it to `auth_failed` for `invalid_grant` and to `handshake_failed`, `timeout` or `unavailable` for the rest. The pass condition for the pass-overall box in #812 is that a revoked grant shows Gmail as `auth_failed` and disabled on `/connectors`, with an audit row, and nothing crashes. The gate checks both clients, so a pass means both grants worked; for a failure, the result does not say which client's grant failed, and you reconnect with `connect gmail` and `connect gmail-read` in turn.

For the control run, repeat the checks on a second Web client whose consent screen stays in Testing, and record when it first answers `auth_failed`. The expected result is the first failure after day 7. To point Gmail at that client, set the gate's `EIDO_GMAIL_CLIENT_ID` to its client id and run `pnpm stack:gate connect gmail`; afterwards, unset it and connect again with the real client.

Record statuses, reasons and dates only. Paste no token, client secret, authorization code or address.

## The Gmail read client

Gmail has two Google clients. The compose client (`connect gmail`, `gmail.modify`) makes the gate's writes. The read client makes core's reads through the gate's read proxy. By default, both share the single `EIDO_GOOGLE_CLIENT_ID` client and reuse the stored secret. To separate read and write clients into distinct Google Cloud OAuth clients, set `EIDO_GMAIL_READ_CLIENT_ID` (and optionally `EIDO_GMAIL_CLIENT_ID`) with the same redirect URI.

`connect gmail-read` is the same sign-in as `connect gmail`, with these differences:

- It asks for the `gmail.readonly` permission. Leave the Gmail box ticked on the consent screen; without it the gate refuses the grant.
- It stores the refresh token and the client secret under the Gmail **read** client. The compose client's grant is left as it was. The first connect asks for the read client's secret only when no shared secret is in the vault; later reconnects reuse the stored one.
- The gate checks Gmail with both clients: the compose client's profile read, and one pinned profile read through the proxy with the read client. Gmail is healthy only when both work. The gate must run with `EIDO_GOOGLE_CLIENT_ID` (or `EIDO_GMAIL_READ_CLIENT_ID`) and `EIDO_GATE_EGRESS_PORT` set, or it has no read check.

When Google revokes either grant, the gate disables Gmail with `auth_failed`. Run the connect command for the client whose grant was revoked; Gmail is re-enabled once both checks pass.

## Drive

Drive is a read connector: core reads it through the gate's read proxy, and the gate holds its read client's grant. The client is a **Web application** OAuth client in Google Cloud, with the same redirect URI; its client id is the gate's `EIDO_DRIVE_CLIENT_ID`.

`connect drive` is the same sign-in as Gmail, with these differences:

- It asks for the `drive.readonly` permission. Leave the Drive box ticked on the consent screen; without it the gate refuses the grant.
- It stores the refresh token and the client secret under the Drive **read** client. The first connect asks for the secret only when no shared secret is stored; later reconnects reuse the stored one.
- The gate checks Drive with one pinned read through the proxy, `changes/startPageToken`. The gate must run with `EIDO_GOOGLE_CLIENT_ID` (or `EIDO_DRIVE_CLIENT_ID`) and `EIDO_GATE_EGRESS_PORT` set, or it has no Drive check and the command reports that it could not check Drive.

When Google revokes the grant, the gate disables Drive with `auth_failed`. Run `pnpm stack:gate connect drive` again; Drive is re-enabled once the check passes.

## The read proxy

Core's connectors read through the gate's egress proxy, which adds the read client's token to each pinned read. The gate starts the proxy when a read client is configured:

- `EIDO_GOOGLE_CLIENT_ID` (or `EIDO_GMAIL_READ_CLIENT_ID` for Gmail reads, `EIDO_DRIVE_CLIENT_ID` for Drive);
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

SimpleFIN allows 24 requests a day and 90 days per request. The manifest's daily limit defaults to that; set `EIDO_SIMPLEFIN_REQUESTS_PER_DAY` when building the manifest (`connector-manifest simplefin`) to pin a lower one (the committed copy the Admin page pins declares 24, so place this one first). When the limit is spent the proxy answers `daily_limit` and core waits for the next day.

### What to record (#547, #812)

The code assumes the claim host, the request limit and the range below; the tests prove the code matches them, not that SimpleFIN does. After the first real connect and sync, write one dated comment in #812 (SimpleFIN section) with:

- [ ] the claim host: the setup token was claimed from `bridge.simplefin.org` and from no other host (`simplefin-claim.ts`);
- [ ] the daily limit: SimpleFIN allows 24 requests a day, as `simplefin/config.ts` assumes. Read the request count and limit in the connector's health on `/connectors` after a few syncs, and record whether SimpleFIN refused anything before 24;
- [ ] the range: a read of 90 days is accepted, as `simplefin/config.ts` assumes. Record any range error;
- [ ] the accounts response: accounts and transactions sync with no schema error, as `simplefin/client.test.ts` assumes. Record the number of accounts and whether any failed to parse;
- [ ] the connector's health and reason after the first sync, and the number of accounts waiting for an entity.

File every mismatch as a `bug` issue. Paste no setup token, no access URL, no account name, balance or transaction. Counts, status codes and dates only. The token can also be entered from the Admin page (#661); say in the comment which of the two you used.

## Apple Calendar

Core reads Apple calendars through the gate's read-only EventKit API (#749, #751); the gate runs the Eido Helper, and core never sees a credential. Nothing writes to the calendar on this path.

Core environment:

- `EIDO_APPLE_CALENDARS`: `*` reads every calendar the Helper lists; otherwise a comma-separated list of EventKit calendar ids. Unset or empty, core does not read Apple calendars.

Every five minutes core reads each enabled calendar from 14 days ago to 180 days ahead and indexes its events under source `apple-eventkit`. A successful read replaces that calendar's events in that window, so an event moved out of the window leaves the index until the window reaches its new time. A read that reports skipped items, or returns items core cannot index (another calendar's event, a repeated id, an id too long to cite), adds the rest and removes nothing; the log counts both. A failed read changes nothing. Each calendar read is listed as an account on the Profile page, named `Apple Calendar: <title>`; its events go to the assigned entity, else to the default entity, and are not stored while neither exists.

### Live check (#766)

Run this once on the Mac, against a synthetic calendar and a synthetic reminder list that you create for it and delete afterwards. Use invented titles only. Record counts and pass or fail in #766. Do not paste calendar or reminder titles, notes, locations or ids from your own calendars. Setup, permission and pinning are in `apps/helper/README.md`; do those first.

1. **Create the data.** In Calendar.app, add a calendar named `Eido synthetic`. In Reminders.app, add a list named `Eido synthetic`. Put no real events or reminders in them.
2. **Check the connector.** As the gate user, ask the running gate to check it. The reply is connector health only, never contents:

   ```bash
   curl --fail --silent --show-error --unix-socket "$EIDO_GATE_CONTROL_SOCKET" \
     --request POST http://localhost/connectors/apple-eventkit/connected
   ```

   Pass: `apple-eventkit` is healthy. Record the health and its reason.

3. **Find the calendar id.** Run the Helper by hand and read the output on screen. It lists every calendar on the Mac, so do not paste it. Copy the id of `Eido synthetic` only:

   ```bash
   echo '{"operation":"list_calendars","args":{}}' | "$HOME/Library/Application Support/eido-dev/helper/eido-helper"
   ```

   Use the path where you installed the Helper. Do the same with `list_reminder_lists` for the reminder list's id.

4. **Read only that calendar.** Set core's `EIDO_APPLE_CALENDARS` to that one id and restart core. Add one synthetic event inside the window, starting tomorrow. After the next sync (up to five minutes), core's log, `~/Library/Logs/eido-dev/core.log` on the default stack, has an `apple_calendar_synced` line for that calendar. Pass: `fetched` and `ingested` are both 1, and no other calendar appears in the log. Events are stored only when an entity exists (see above); with none, `ingested` is 0. Record the counts.
5. **Overlapping events (#774).** Add a synthetic event that started 15 days ago and ends tomorrow. Run `list_events` by hand as in step 3, with `{"operation":"list_events","args":{"calendarId":"<id>","start":"<14 days ago, ISO 8601 with a timezone>","end":"<180 days ahead, same form>"}}`, and count the events without reading them. Pass: the count includes the long event. After the next sync, `ingested` includes it. Delete that event in Calendar.app and wait for the next sync. Pass: the `apple_calendar_synced` line shows `retired` 1.
6. **Reading reminders (#764).** Add one synthetic reminder due tomorrow to the synthetic list. Run `{"operation":"list_reminders","args":{"listId":"<id>","completedSince":"<now, ISO 8601 with a timezone>"}}` by hand as in step 3, and count the items. Pass: the count is 1. Record the count only.
7. **Writes.** A write needs a signed approval for an `apple.*` intent and its audit row. The Helper can create and update events and create and complete reminders; it has no delete operation, and no delete intent exists. Today nothing in the app proposes these intents: the core Apple facade has no consumer outside its tests. Until one exists, the event, reminder and approval criteria in #766 cannot be run through the app, and this runbook has no steps for them. Do not run the Helper's write operations by hand as a substitute; that skips the signed approval the check is about.
8. **Clean up.** Delete the synthetic calendar and list in Calendar.app and Reminders.app, unset `EIDO_APPLE_CALENDARS` or point it back at the calendars you want, and restart core.

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
- the Google sign-in started from a second device on the tailnet, such as the phone (#622);
- live Apple Calendar and Reminders checks on a synthetic calendar (#766);
- seeing the result on `/connectors`.

The checklists for these live in #812 (Google, SimpleFIN and Proton, with real accounts), #811 (the Mac host) and #766 (Apple). The sections above say what to record for each. Record statuses, error codes, counts and dates only.
