# Backup restore drill

How to prove a backup restores, and the record of each drill. Setup, schedule and retention are in the Backup section of `infra/README.md`. Run this on the Mac, against the real stores, restoring into a scratch directory. Nothing below touches the live data, and nothing records file contents: only pass or fail, counts and timings.

## Data-at-rest boundary

Per [ADR 0007](../docs/adr/0007-data-at-rest-boundary.md), Eido's data-at-rest boundary rests on:

1. **FileVault 2 full disk encryption**: protects data at rest on host storage when the host Mac is powered off or locked.
2. **Restic repository encryption (AES-256-CTR + Poly1305)**: protects all backup snapshots and off-host repository copies; keyed by a high-entropy passphrase stored in the owner's macOS Keychain (`eido-backup` account `restic`). On a split host the daemon that runs the backup is root and cannot read that Keychain, so it reads a copy of the passphrase from a root-only file (see "Split host").
3. **POSIX file permissions (`0700` directories, `0600` files)**: prevents cross-user access on the running host.

There is no application-level database encryption (SQLCipher) on the live SQLite stores. While the Mac is booted and logged in, protection against unauthorized local access relies on host user account isolation and the gate process boundary, not on-disk cryptographic locks. Restore scratch directories (`~/eido-restore-scratch`) hold unencrypted copies of the data while present and must be removed after verification.

## Restic passphrase

The restic passphrase (Keychain service `eido-backup`, account `restic`) lives only in the login Keychain of the host. A restore after losing the host, or after a Keychain reset, needs it, so the operator must also keep a copy of it off the host. This is a required setup step: record the passphrase somewhere that survives the loss of this Mac before relying on the backups. Without that copy the repository cannot be decrypted. Do not store it in the repository, the backup drive's plain files or any file under this checkout.

## Split host (the #70 plane)

Once the plane is applied (`infra/plane-split.md`), the databases are `/Library/Application Support/Eido/gate/eido-control.db` (`_eidogate`, directory 0700) and `/Library/Application Support/Eido/data/eido-data.db` plus `blobs/` (`_eidodata`, directory 0700). The owner's nightly LaunchAgent cannot read either, so a root LaunchDaemon, `com.eido.plane.backup`, runs the same pipeline (staged `VACUUM INTO` copies, restic, retention, last-success stamp) and runs it as root, once at load and every 24 hours. Each staged copy keeps its source's owner and mode, and restic stores them, so a snapshot holds `eido-control.db` as `_eidogate` 0600 and `eido-data.db` as `_eidodata` 0600.

Who can read the snapshots: root, and the owner, who holds the passphrase and the backup drive. `_eidogate` and `_eidodata` cannot: the repository, the passphrase file (`/Library/Application Support/Eido/backup/restic-password`, root 0600 inside a root 0700 directory) and the staging directory are root only. The backup never gives the gate's control database to the data-plane user or the reverse. The plaintext staged copies are removed after each run; the snapshots are encrypted by restic.

Set up, once. Nothing here is run by an agent:

1. Print the script and read it. It checks the plane exists, creates the root-only `backup` directory, the log directory and an empty passphrase file, and installs the plist:

   ```bash
   node --disable-warning=ExperimentalWarning infra/backup/bin.ts plane > /tmp/eido-plane-backup.sh
   sudo sh /tmp/eido-plane-backup.sh
   ```

   `backup plane` reads `EIDO_BACKUP_REPO` and takes `--node <path>` (default: the node running the command). The plane's copy of the checkout, `/Library/Application Support/Eido/app`, is what the daemon runs, so re-apply the plane script after changing `infra/backup`.

2. Copy the passphrase into the root-only file. This is a deviation from ADR 0007's Keychain-only storage, needed because a root daemon cannot read your login Keychain. The off-host copy of the passphrase (above) is still required:

   ```bash
   security find-generic-password -s eido-backup -a restic -w | sudo tee '/Library/Application Support/Eido/backup/restic-password' >/dev/null
   ```

3. Load the daemon and watch its log (`/Library/Logs/Eido/backup/backup.log`, readable by admin users):

   ```bash
   sudo launchctl bootstrap system /Library/LaunchDaemons/com.eido.plane.backup.plist
   tail /Library/Logs/Eido/backup/backup.log
   ```

4. Retire your own LaunchAgent: `launchctl bootout gui/$(id -u)/com.eido.backup; rm -f ~/Library/LaunchAgents/com.eido.backup.plist`. `backup plist` refuses when `EIDO_BACKUP_PLANE=split`.

The gate's backup status and `backup check` read the stamp at `/Library/Logs/Eido/backup-last-success` (0644, so `_eidogate` can read it). Check and restore on a split host need root and `EIDO_BACKUP_PLANE=split`, which selects the plane's paths and the passphrase file:

```bash
sudo env PATH="$PATH" EIDO_BACKUP_PLANE=split EIDO_BACKUP_REPO="$EIDO_BACKUP_REPO" \
  "$(command -v node)" --disable-warning=ExperimentalWarning infra/backup/bin.ts check
```

### Restore on a split host

Restore as root into a root-only scratch directory, so the restored files keep their owners and modes, then verify and compare before touching the live directories:

```bash
sudo mkdir -m 0700 /var/root/eido-restore
sudo env PATH="$PATH" EIDO_BACKUP_PLANE=split EIDO_BACKUP_REPO="$EIDO_BACKUP_REPO" \
  "$(command -v node)" --disable-warning=ExperimentalWarning infra/backup/bin.ts restore /var/root/eido-restore
R='/var/root/eido-restore/Library/Application Support/Eido'
sudo stat -f '%Su:%Sg %Sp %N' "$R/backup/staging/eido-control.db" "$R/backup/staging/eido-data.db"
```

Expected: the `PASS` lines of step 2 below, then `_eidogate:_eidogate -rw------- .../eido-control.db` and `_eidodata:_eidodata -rw------- .../eido-data.db`. To put them back, stop the plane daemons, replace the databases and blobs preserving owners, remove the stale `-wal` and `-shm` files, and load the daemons again:

```bash
sudo launchctl bootout system/com.eido.plane.core; sudo launchctl bootout system/com.eido.plane.gate
P='/Library/Application Support/Eido'
sudo rm -f "$P"/gate/eido-control.db-wal "$P"/gate/eido-control.db-shm "$P"/data/eido-data.db-wal "$P"/data/eido-data.db-shm
sudo cp -p "$R/backup/staging/eido-control.db" "$P/gate/eido-control.db"
sudo cp -p "$R/backup/staging/eido-data.db" "$P/data/eido-data.db"
sudo rsync -a "$R/data/blobs/" "$P/data/blobs/"
sudo launchctl bootstrap system /Library/LaunchDaemons/com.eido.plane.gate.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.eido.plane.core.plist
sudo rm -rf /var/root/eido-restore
```

The restore scratch directory holds plaintext copies of both databases; remove it when done.

## Steps (single-user host)

All commands from the repo root. `EIDO_BACKUP_REPO` must be set to the repository path, and the backup drive plugged in.

1. See what is there, and note the snapshot id and time you will restore:

   ```bash
   RESTIC_REPOSITORY="$EIDO_BACKUP_REPO" \
   RESTIC_PASSWORD_COMMAND='/usr/bin/security find-generic-password -s eido-backup -a restic -w' \
   restic snapshots --host eido
   ```

2. Restore the latest snapshot into a new scratch directory and verify it:

   ```bash
   node --disable-warning=ExperimentalWarning infra/backup/bin.ts restore ~/eido-restore-scratch
   ```

   The command refuses a directory that already holds files. It prints the snapshot id, its time and how long the restore took, then one `PASS` or `FAIL` line each for:
   - `PRAGMA integrity_check` on `eido-data.db` and on `eido-control.db`;
   - the audit hash chain in `eido-control.db`, verified from seq 1;
   - every restored blob: its SHA-256 equals its content-hash file name, and it sits in the matching two-character directory.

   It exits 0 only when every line is `PASS`. To re-verify a directory you restored by other means, run `backup verify <dir>`.

3. To show versioning, restore an older snapshot (needs two or more) and compare:

   ```bash
   node --disable-warning=ExperimentalWarning infra/backup/bin.ts restore ~/eido-restore-older --snapshot <older-id>
   ```

4. Delete the scratch directories when done (`rm -rf ~/eido-restore-scratch ~/eido-restore-older`). They hold plaintext copies of the data.

Checks to run once at setup, and note in the log below:

- Encrypted: `RESTIC_PASSWORD=wrong restic -r "$EIDO_BACKUP_REPO" snapshots` fails with a wrong-password error, and `security find-generic-password -s eido-backup -a restic` finds the passphrase while `grep -r` of the repo, the plist and the repo checkout finds none.
- Live databases not stopped: run `backup run` while the stack is up (`pnpm stack:status` healthy before and after).
- Drive absent: unmount the drive, run `backup run` and `backup check`; both exit 1 with a log line naming the missing drive, and nothing is written to the internal disk.

## After a real restore

1. On a split host use "Restore on a split host" above. Otherwise put the restored `eido-data.db`, `eido-control.db` and `blobs/` where `infra/stack/config.ts` says (`EIDO_DATA_DIR`, `EIDO_GATE_DATA_DIR`) with the stack stopped. In the restore directory they sit under their original absolute paths; the databases are under the staging directory name `backup-staging`.
2. Re-authorize Google and re-run Bridge login: Keychain items are not backed up.
3. Re-fetch model weights by the pin in `infra/model.lock` (#29).
4. The gate refuses authority until its control-state anchor matches the restored database (ADR 0005); follow that recovery.

## Drill log

Record each drill here: date, snapshot id, time taken, and the result of each check.

No drill has been recorded yet. The first one is an owner step on the Mac (acceptance criteria of #30 that need the live host).
