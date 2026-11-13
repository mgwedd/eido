# Infra

Host setup for the Mac: the local stack, `tailscale serve` routes, Proton Bridge supervision, nightly backups, host checks and the pinned llama-server; pf later (#70). Never commit secrets here; `infra/secrets` is denied to agents.

End-to-end check on an iPhone: `infra/device-smoke.md`.

Connecting and reconnecting Gmail and the Proton connectors on the Mac: `infra/connectors.md` (#98).

## Local stack (#374)

### First run: one command (#648)

On a fresh clone, run these two commands on the Mac, as the owner. The first needs only Node 24 or newer (the check names the version to install when it is older; it cannot install Node itself). It makes `pnpm` runnable by enabling corepack when pnpm is missing, and when that fails it prints the one command to run (`npm install --global pnpm@<pinned version>`):

```bash
node infra/prereq/bin.ts
pnpm stack:bootstrap
```

It sets nothing by hand: no environment variable is exported, and it can be run again at any step. In order it

1. runs `pnpm install --frozen-lockfile`;
2. installs the pinned llama-server build (`llama fetch --build-only`), with no model;
3. runs `stack:setup`: creates the gate keychain (asks for its password in the terminal), asks for the unset settings and writes `stack.env`;
4. starts the prod stack in the background (a build, then gate, core and web, with the serve routes);
5. on macOS, registers the login agent `com.eido.stack` (`stack:install`), so the stack starts at every login;
6. prints a single-use enrolment code and the first-run page, `https://<host>.ts.net:8443/enroll`.

Open that page on your phone and enter the code to enrol the first passkey. The code works once and expires after ten minutes. Whoever runs the command has a shell on the Mac, which is the proof of presence (ADR 0009, Decision 4); the gate adds no listener for it. The code is printed in the terminal rather than served on a localhost page, because a localhost page brings back the loopback listener and its port-shared cookie that ADR 0009 removed.

Once a passkey exists, `stack:bootstrap` issues no code. A new phone or a lost one is `pnpm stack:gate enrol-code` (recovery), or the Admin page.

Everything after the first passkey is in the app, under Admin: the model download and switching, connectors, the Tailscale check, settings and the doctor checks. The stack starts without a model; inference is off until one is downloaded there. `stack:bootstrap` does not do any of that. On Windows and Linux there is no login agent yet (#455): after step 4, start the stack again with `pnpm stack:prod --background` after a restart.

`pnpm stack:setup` alone (steps 3 and the code) and the commands below remain for later runs.

One command starts the gate, core and web, with the serve routes, so `https://<host>.ts.net:8443/` works:

```bash
pnpm stack:dev      # gate and core under node --watch, web under next dev; output prefixed by name
pnpm stack:prod     # turbo run build, then gate, core and next start; no watchers
pnpm stack:stop     # stops what either mode started, then confirms no listener is left on the ports
pnpm stack:status   # each process, who listens on its port, its health check, and the serve routes
pnpm stack:doctor   # read-only checks: each ok, warn or fail with one fix command; exits 1 on a fail
pnpm stack:gate connect|enrol-code|passkeys [args]   # a gate CLI with the gate environment the stack gives the gate
```

Start runs doctor's blocking checks first and starts nothing on a failure. It then checks that ports 3000, 8789 and 8788 are free, and names the pid holding any that is not. It then applies the serve routes on :8443 (routes on other ports are left alone), and starts gate, core and web in that order, each once the one before answers. In the foreground, Ctrl-C stops all three; `--background` returns once they answer, and `pnpm stack:stop` stops them. Stop leaves the serve routes in place.

`--no-serve` skips the serve routes: backends only, so the UI does not work from the tailnet origin.

The tailnet host is read from `tailscale status --json`. On macOS, data, sockets and pid files live under `~/Library/Application Support/eido-dev` (pid files in `run/`), and one log per process under `~/Library/Logs/eido-dev`. The typed config is `infra/stack/config.ts`; every value is overridable by env, with no secrets: `EIDO_TAILNET_HOST`, `EIDO_EDGE_PORT`, `EIDO_WEB_PORT`, `EIDO_CORE_PORT`, `EIDO_GATE_PHONE_PORT`, `EIDO_STACK_DIR`, `EIDO_STACK_LOG_DIR`, and the gate and core variables listed in `OVERRIDES`. The llama, push, Gmail, Drive, Bridge and development-vault variables are passed through from your environment or `stack.env` when set, and never invented by the stack.

### Start at login (#629, macOS)

```bash
pnpm stack:install     # writes and loads the LaunchAgent com.eido.stack; it starts the stack now and at every login
pnpm stack:uninstall   # boots the agent out and removes its plist; the stack keeps running until pnpm stack:stop
```

The agent runs the stack supervisor (`infra/stack/supervisor-main.ts --start-stack`). The supervisor first runs `stack boot`, which starts the prod stack in the background unless a stack process already runs, and then serves its socket. launchd restarts the supervisor when it exits, after 10 seconds, so a start that fails at login (Tailscale not up yet, say) is tried again. The stack's processes run in their own process groups and outlive a supervisor restart. The stack sets `EIDO_GATE_SUPERVISOR_SOCKET` to `run/supervisor.sock` so the gate can relay the supervisor to the web Admin page (#659): the stack status, doctor and model list with a session, and start, stop, restart and model use or fetch with a step-up. Only core and llama can be started or stopped from there. A gate run without the variable reports the supervisor as unavailable.

The plist is `~/Library/LaunchAgents/com.eido.stack.plist` and the supervisor logs to `~/Library/Logs/eido-dev/stack.out.log` and `stack.err.log`. It passes on `PATH` and `EIDO_STACK_DIR` from the shell that ran `stack:install`; every other setting comes from `stack.env`, so run `stack:install` again after changing `PATH` or the stack dir. `pnpm stack:status` ends with the agent's state from `launchctl print`. `pnpm stack:stop` stops the stack while the agent stays loaded, and says that the next login or supervisor restart starts it again. Windows (a Task Scheduler task) is #455.

The web Admin page can turn start at login on and off too (#664), through the supervisor's `GET` and `POST /login-item` (a step-up to change it). On writes the same plist as `stack:install` but does not load it, so launchd runs it at the next login and no second supervisor starts beside the running one; `stack:status` then reads "installed but not loaded". Off removes the plist and boots the agent out, unless the loaded agent is the supervisor answering, which keeps running until logout. Off macOS the supervisor refuses with `unsupported` and the gate answers 501 `unsupported_platform`.

### Settings: `stack.env` (#625)

`stack.env` in the stack dir (`~/Library/Application Support/eido-dev/stack.env` on macOS) holds the stack's non-secret settings as `KEY=value` lines. `pnpm stack:setup` writes it; treat it as written by the system rather than by hand. Every stack command loads it, and a variable set in your environment wins over the same key in the file. It must be a regular file with mode 0600, and only these keys are accepted, so a typo or a secret fails with the key's name:

- the stack's own overrides (`OVERRIDES` in `infra/stack/config.ts`, except `EIDO_STACK_DIR`, which says where the file lives);
- the settings passed to the gate (`PASS_THROUGH.gate`: the VAPID subject and push window, the Gmail and Drive client ids, the Bridge settings, and the development vault);
- the settings passed to core (`PASS_THROUGH.core`: the llama host, port and chat template arguments), the llama paths in `infra/llama/config.ts`, and `EIDO_LLAMA_MODEL`.

Secrets never go in it: tokens and passwords live in the gate's vault. `infra/stack/settings.ts` is the typed store (`readStackSettings`, `getStackSetting`, `writeStackSetting`, `validateSettings`), and `infra/stack/doctor.ts` returns each check as `{ id, platforms, status, summary, fix: { action, text } }` for a setup UI to use.

### Doctor

`pnpm stack:doctor` checks node against `engines` and node_modules, Tailscale and its MagicDNS host, the key names in `apps/web/.env.local` (never their values) and that `APP_BASE_URL` includes `https://<host>:8443`, the gate keychain (a regular file, mode 0600, unlocked), the VAPID subject (warn), the llama pin and `/health`, the Gmail client ids (warn), and that the ports are free or held by the running stack. `--no-serve` skips Tailscale and the `APP_BASE_URL` check.

### Windows and Linux

Setup, doctor, settings and `stack:gate` run on Windows and Linux too. The stack dir is `%LOCALAPPDATA%\eido-dev` (logs in `logs\`) on Windows and the XDG data dir on Linux; the gate's sockets are named pipes on Windows. There is no keychain off macOS: setup sets the development file vault (`EIDO_DEV_VAULT=1` and `EIDO_GATE_VAULT_FILE`), and doctor warns that a production vault there is #455. Windows has no mode bits, so the 0600 check on `stack.env` is skipped there, with a doctor note pointing at #455. Starting and stopping the stack on Windows, and starting it at login, are not supported yet.

The WebAuthn origin is `https://<host>:8443`. The gate accepts an origin with a port once #375 lands; until then set `EIDO_WEBAUTHN_ORIGIN=https://<host>` to start it.

## `tailscale serve` routes (ADR 0004)

Eido is served on its own HTTPS port, 8443, at `https://<host>.ts.net:8443`: `/` to Next on `127.0.0.1:3000`, `/api/core` to core on `127.0.0.1:8789` (core's default; 8787 belongs to another app on the host), `/api/gate` to the gate's phone listener on `127.0.0.1:8788`. Routes on other ports belong to other apps and are never read for problems or changed.

```bash
pnpm --filter @eido/infra serve-routes plan     # print the tailscale commands; changes nothing
pnpm --filter @eido/infra serve-routes check    # exactly the three routes on 8443, funnel off for it
pnpm --filter @eido/infra serve-routes apply    # add the three routes with --bg, then check
pnpm --filter @eido/infra serve-routes measure  # with the backends stopped: what path and Host each receives
```

Each command takes `--port`, `--web-port`, `--core-port` and `--gate-port` to override the defaults.

## Backup (#30)

A nightly encrypted, versioned [restic](https://restic.net) backup of both SQLite files and the blob store to a local drive. restic is a binary you install (`brew install restic`); nothing here adds it as a dependency. The step-by-step restore drill is `infra/backup-restore.md`.

```bash
node --disable-warning=ExperimentalWarning infra/backup/bin.ts run      # what the LaunchAgent runs
node --disable-warning=ExperimentalWarning infra/backup/bin.ts check    # exit 1 if the newest snapshot is over 36 hours old, or the drive is absent
node --disable-warning=ExperimentalWarning infra/backup/bin.ts restore <new-empty-dir> [--snapshot <id>]
node --disable-warning=ExperimentalWarning infra/backup/bin.ts verify <restored-dir>
node --disable-warning=ExperimentalWarning infra/backup/bin.ts plist    # prints the LaunchAgent; installs nothing
```

(`pnpm --filter @eido/infra backup <command>` runs the same entry point.)

What a run does, in order: checks the drive is mounted and holds an initialised repository (it never creates one and never writes anywhere else); takes a consistent copy of `eido-data.db` and `eido-control.db` into a staging directory with `VACUUM INTO` (one read transaction over the WAL, so the live databases keep running) and runs `PRAGMA integrity_check` on each copy; has restic back up the copies and `blobs/`; applies retention and prunes; removes the staging copies; writes the time to `~/Library/Logs/eido/backup-last-success`. Any failure logs one `ERROR` line, exits 1 and leaves the old timestamp alone.

Paths come from one place: `infra/backup/config.ts` reads the data directories from the stack config (`infra/stack/config.ts`), so `EIDO_DATA_DIR`, `EIDO_GATE_DATA_DIR` and `EIDO_STACK_DIR` move the backup with the stack. The blob store is `<EIDO_DATA_DIR>/blobs`. The two backup-only settings are `EIDO_BACKUP_REPO` (required: an absolute path on the backup drive, for example `/Volumes/EidoBackup/restic`) and `EIDO_BACKUP_LOG_DIR` (default `~/Library/Logs/eido`).

### One-time setup

1. Create the passphrase in the login Keychain and keep an offline copy (a password manager or paper in a safe place; without it the backups cannot be read):

   ```bash
   security add-generic-password -s eido-backup -a restic -w     # prompts for the passphrase
   ```

2. Initialise the repository on the drive:

   ```bash
   export EIDO_BACKUP_REPO=/Volumes/EidoBackup/restic
   RESTIC_REPOSITORY="$EIDO_BACKUP_REPO" \
   RESTIC_PASSWORD_COMMAND='/usr/bin/security find-generic-password -s eido-backup -a restic -w' \
   restic init
   ```

3. Render, check and load the LaunchAgent (this is the owner's step; the repo never loads it):

   ```bash
   node --disable-warning=ExperimentalWarning infra/backup/bin.ts plist > ~/Library/LaunchAgents/com.eido.backup.plist
   plutil -lint ~/Library/LaunchAgents/com.eido.backup.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.eido.backup.plist
   launchctl kickstart gui/$(id -u)/com.eido.backup      # run once now instead of waiting for 03:15
   tail ~/Library/Logs/eido/backup.log
   ```

   The agent runs at 03:15 every night (a Mac that is asleep runs it on wake). The plist holds the repository path, the data-path overrides you had set when you rendered it, and `PATH`; never the passphrase. Re-render it after moving the repo or changing Node.

   restic reads the passphrase from the Keychain through `RESTIC_PASSWORD_COMMAND`. A LaunchAgent can read a login-keychain item only while the login keychain is unlocked, which it is after you log in. To use `RESTIC_PASSWORD` or `RESTIC_PASSWORD_FILE` instead, set it in your shell; the job never overrides one that is set.

### Retention

`restic forget --prune` runs after each backup over Eido's snapshots only (host `eido`, tag `eido-nightly`): the last 7 daily, 4 weekly and 6 monthly snapshots are kept. The numbers are `RETENTION` in `infra/backup/config.ts`.

### Not backed up

- Keychain items: Google tokens, the Bridge password, the backup passphrase. After a restore, re-authorize Google and re-run Bridge login. Keep the passphrase's offline copy.
- Model weights: re-fetched by the pin in `infra/model.lock` (#29).
- The control-state anchor (ADR 0005) lives in the Keychain, so it is not in the snapshot. A restored `eido-control.db` without its matching anchor is refused by the gate until supervised recovery, per ADR 0005.
- The research compartment, cloud or off-site copies, and SQLCipher database encryption are out of scope.

### Failure signals

A failed run logs `ERROR run: ...` to `~/Library/Logs/eido/backup.log` and exits 1. `backup check` exits 1 when the drive is absent, the repository has no snapshot, or the newest is over 36 hours old, so it is safe to wire into anything that watches exit codes. Showing a failure beyond the log and `check` (for example on the Today page) is an open question in #30; no UI is built for it here.

## Host checks and llama-server (#29)

`pnpm --filter @eido/infra host check` checks that FileVault is on and Tailscale is running; it only reads. `pnpm --filter @eido/infra llama <verify|launch|check-template|install|status|…>` runs `llama-server` on `127.0.0.1` from the pin in `infra/model.lock`, and refuses to start when the binary or model does not match it. The runbook, with the recorded results and how to update the pin, is `infra/llama-server.md`.

## Proton Bridge LaunchAgent (#68)

Eido reads and drafts Proton mail through Proton Bridge's local IMAP and SMTP. launchd keeps Bridge running in CLI mode with no window as the job `com.eido.proton-bridge` in the `gui/<uid>` domain: `KeepAlive` true, `ThrottleInterval` 10 s, `ProcessType` Standard, logs in `~/Library/Logs/eido/proton-bridge.{out,err}.log`. The plist holds no password, port or environment.

```bash
pnpm --filter @eido/infra bridge plan       # print the plist and the launchctl command; changes nothing
pnpm --filter @eido/infra bridge install    # write ~/Library/LaunchAgents/com.eido.proton-bridge.plist and bootstrap it
pnpm --filter @eido/infra bridge status     # state, pid, runs, last exit; exit 1 unless running
pnpm --filter @eido/infra bridge health     # read the IMAP and SMTP greetings; exit 1 on any failure
pnpm --filter @eido/infra bridge uninstall  # bootout, then remove the plist
```

`install` and `plan` take `--bridge PATH` when Bridge is not at `/Applications/Proton Mail Bridge.app/Contents/MacOS/bridge`. Bridge's own "start at login" setting writes a second LaunchAgent (`Proton Mail Bridge.plist`); turn it off in Bridge's settings, or two Bridges fight over the ports.

### First run

1. Install Bridge from Proton's official release. Run `bridge --help` and confirm `--cli` and `--noninteractive` exist in this version.
2. Log in once, interactively, before `install`: run `bridge --cli`, then `login` and follow the prompts, including two-factor. Run `info` to read the Bridge-generated IMAP and SMTP username and password, and the ports. Quit with `exit`. (Do not run this while the job is loaded: one Bridge at a time.)
3. Store the Bridge password in the vault with `pnpm stack:gate connect proton-mail` and `connect proton-calendar` (`infra/connectors.md`). It never goes in the plist, the repo, a script, a log or a command line.
4. `pnpm --filter @eido/infra bridge install`.
5. Set the gate's variables (no password among them): `EIDO_BRIDGE_HOST=127.0.0.1` (Bridge's fixed host), `EIDO_BRIDGE_IMAP_PORT` and `EIDO_BRIDGE_SMTP_PORT` from `info`, `EIDO_BRIDGE_USERNAME`, and the certificate pin from the next section. Core's `EIDO_PROTON_USERNAME` is the same address. Defaults are 1143 and 1025, but Bridge takes the next free port, so read them from `info` and never assume them.
6. Run `pnpm --filter @eido/infra bridge health` with the same variables exported. It reads the greeting on both ports without sending a credential. It expects STARTTLS (Bridge's default); with implicit TLS switched on it reports an unexpected greeting.

### Certificate pin

Bridge's certificate is self-signed. Export it from Bridge's settings ("Export TLS certificates") or with `cert export` in `bridge --cli`. Keep only the public certificate in a gate-owned file, never Bridge's exported private key. Compute the digest with `openssl x509 -in bridge-cert.pem -outform DER | shasum -a 256` and set `EIDO_BRIDGE_CERT_PATH` and `EIDO_BRIDGE_CERT_SHA256` (ADR 0003). Bridge regenerates the certificate when it is within 31 days of expiry and may after an upgrade: re-export, recompute and restart the gate each time. The gate refuses a certificate that does not match the pin.

### Upgrades

Record the Bridge version you tested (`bridge --version`) in the PR or runbook notes. Bridge's launcher auto-updates itself, which changes the tested version under you: record whether auto-update is left on. After an upgrade, `bridge status`, re-read the ports from `info`, re-export the certificate, then `bridge health`.

### Security notes

- Bridge listens on `127.0.0.1` only. Check with `lsof -nP -iTCP -sTCP:LISTEN | grep -i bridge`, and confirm from another tailnet device that the ports do not answer. Do not route them through `tailscale serve`.
- Bridge keeps the Proton refresh token and mailbox password in the owner's login keychain (entry `bridge-v3`). The data-plane user (#70) must not be able to read that keychain; check this once that user exists.

### Reboot

A LaunchAgent starts at login, not at boot. With FileVault on, after a power loss nothing in the user session, Bridge included, starts until someone logs in (see #29).

### Not verified by the tests

The tests cover plist generation, launchctl arguments, the health check and the command flow with an injected runner. A real install, `kill -9` recovery time, an hour with the screen asleep, the login steps, loopback and tailnet reachability and the keychain note are owner steps on the Mac.
