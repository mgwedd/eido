# Infra

Host setup for the Mac: the local stack and `tailscale serve` routes now; launchd, pf and llama-server later (#29, #70). Never commit secrets here; `infra/secrets` is denied to agents.

## Local stack (#374)

One command starts the gate, core and web, with the serve routes, so `https://<host>.ts.net:8443/` works:

```bash
pnpm stack:dev      # gate and core under node --watch, web under next dev; output prefixed by name
pnpm stack:prod     # turbo run build, then gate, core and next start; no watchers
pnpm stack:stop     # stops what either mode started, then confirms no listener is left on the ports
pnpm stack:status   # each process, who listens on its port, its health check, and the serve routes
```

Start checks first that ports 3000, 8789 and 8788 are free, and names the pid holding any that is not. It then applies the serve routes on :8443 (routes on other ports are left alone), and starts gate, core and web in that order, each once the one before answers. In the foreground, Ctrl-C stops all three; `--background` returns once they answer, and `pnpm stack:stop` stops them. Stop leaves the serve routes in place.

`--no-serve` skips the serve routes: backends only, so the UI does not work from the tailnet origin.

The tailnet host is read from `tailscale status --json`. Data, sockets and pid files live under `~/Library/Application Support/eido-dev` (pid files in `run/`), and one log per process under `~/Library/Logs/eido-dev`. The typed config is `infra/stack/config.ts`; every value is overridable by env, with no secrets: `EIDO_TAILNET_HOST`, `EIDO_EDGE_PORT`, `EIDO_WEB_PORT`, `EIDO_CORE_PORT`, `EIDO_GATE_PHONE_PORT`, `EIDO_STACK_DIR`, `EIDO_STACK_LOG_DIR`, and the gate and core variables listed in `OVERRIDES`. The llama, Gmail and Bridge variables are passed through from your environment and never set by the stack.

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
