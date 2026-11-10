# Backup restore drill

How to prove a backup restores, and the record of each drill. Setup, schedule and retention are in the Backup section of `infra/README.md`. Run this on the Mac, against the real stores, restoring into a scratch directory. Nothing below touches the live data, and nothing records file contents: only pass or fail, counts and timings.

## Data-at-rest boundary

Per [ADR 0007](../docs/adr/0007-data-at-rest-boundary.md), Eido's data-at-rest boundary rests on:

1. **FileVault 2 full disk encryption**: protects data at rest on host storage when the host Mac is powered off or locked.
2. **Restic repository encryption (AES-256-CTR + Poly1305)**: protects all backup snapshots and off-host repository copies; keyed by a high-entropy passphrase stored in the owner's macOS Keychain (`eido-backup` account `restic`).
3. **POSIX file permissions (`0700` directories, `0600` files)**: prevents cross-user access on the running host.

There is no application-level database encryption (SQLCipher) on the live SQLite stores. While the Mac is booted and logged in, protection against unauthorized local access relies on host user account isolation and the gate process boundary, not on-disk cryptographic locks. Restore scratch directories (`~/eido-restore-scratch`) hold unencrypted copies of the data while present and must be removed after verification.

## Restic passphrase

The restic passphrase (Keychain service `eido-backup`, account `restic`) lives only in the login Keychain of the host. A restore after losing the host, or after a Keychain reset, needs it, so the operator must also keep a copy of it off the host. This is a required setup step: record the passphrase somewhere that survives the loss of this Mac before relying on the backups. Without that copy the repository cannot be decrypted. Do not store it in the repository, the backup drive's plain files or any file under this checkout.

## Steps

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

1. Put the restored `eido-data.db`, `eido-control.db` and `blobs/` where `infra/stack/config.ts` says (`EIDO_DATA_DIR`, `EIDO_GATE_DATA_DIR`) with the stack stopped. In the restore directory they sit under their original absolute paths; the databases are under the staging directory name `backup-staging`.
2. Re-authorize Google and re-run Bridge login: Keychain items are not backed up.
3. Re-fetch model weights by the pin in `infra/model.lock` (#29).
4. The gate refuses authority until its control-state anchor matches the restored database (ADR 0005); follow that recovery.

## Drill log

Record each drill here: date, snapshot id, time taken, and the result of each check.

No drill has been recorded yet. The first one is an owner step on the Mac (acceptance criteria of #30 that need the live host).
