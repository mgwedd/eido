# 0007: Data-at-rest boundary: FileVault and encrypted backups without app-level database encryption

Status: accepted
Decided: 2026-11-02
Issue: #325
Related: #29, #30, #62, #66, #70

## Context

Eido stores personal communication history, indexed document bodies, extracted entities, obligations, control approvals, and audit records on the host filesystem. Before porting application-level database encryption from Aletheia (which used SQLCipher with fail-closed unlock and envelope encryption), Eido required a formal evaluation of the threat model to decide whether app-level database encryption is necessary for the MVP and Wave 1, or whether host-level disk encryption combined with encrypted backups satisfies the security invariants.

## Inventory of Persisted Copies

Every copy of user data persisted by Eido on disk:

| Copy / Artifact              | Path / Location                                         | Format         | Current Protection                                           |
| ---------------------------- | ------------------------------------------------------- | -------------- | ------------------------------------------------------------ |
| **Data database & WAL**      | `EIDO_DATA_DIR/eido-data.db` (+ `-wal`, `-shm`)         | SQLite 3       | POSIX `0700` directory; FileVault full-disk encryption       |
| **Control database & WAL**   | `EIDO_GATE_DATA_DIR/eido-control.db` (+ `-wal`, `-shm`) | SQLite 3       | POSIX `0700` directory; FileVault full-disk encryption       |
| **Original document blobs**  | `EIDO_DATA_DIR/blobs/xx/`                               | Raw files      | Content-addressed SHA-256; POSIX `0700`; FileVault           |
| **FTS & Vector indices**     | Inside `eido-data.db` (FTS5 virtual tables)             | SQLite 3       | POSIX `0700`; FileVault                                      |
| **Parser staging & scratch** | `/private/tmp/eido-parsers-*`, `/tmp/`                  | Ephemeral      | Mode `0700`, unlinked on process termination or restart      |
| **Backup repositories**      | `EIDO_BACKUP_REPO` (external disk / NAS)                | Restic repo    | Cryptographically encrypted at rest (AES-256-CTR + Poly1305) |
| **Backup drill restores**    | `~/eido-restore-scratch` (drill only)                   | Directory      | Ephemeral, manually verified and purged (`rm -rf`)           |
| **Secrets & Credentials**    | macOS Keychain                                          | Keychain items | Protected by macOS Secure Enclave and FileVault              |

## Threat Model Comparison

We evaluated FileVault-only versus application-level encryption (SQLCipher) across four primary threat vectors:

### 1. Lost or stolen host hardware (powered off / cold disk)

- **FileVault**: Protected. APFS full-disk encryption utilizes XTS-AES 128/256 tied to hardware keys in Apple's Secure Enclave. Data cannot be read without the host password or recovery key.
- **App-level encryption**: Protected.
- **Verdict**: FileVault provides hardware-enforced protection with zero operational complexity.

### 2. Physical theft or leakage of backup media

- **FileVault**: Irrelevant (backup media resides outside host APFS container).
- **Restic Encrypted Backup**: Protected. Every snapshot is client-side encrypted with AES-256 and Poly1305 using a high-entropy passphrase stored in the owner's macOS Keychain. Without the passphrase, backup blobs are indistinguishable from random noise.
- **Verdict**: Backup security is fully solved at the backup repository layer.

### 3. Multi-user or local cross-user isolation

- **FileVault**: FileVault decrypts the volume upon boot/login; all local accounts share the decrypted volume.
- **POSIX Isolation**: Protected via file mode `0700` on data directories (`EIDO_DATA_DIR`, `EIDO_GATE_DATA_DIR`) and dedicated Unix users (#70). Unprivileged users or services on the same Mac cannot traverse or read Eido directories.
- **App-level encryption**: Redundant with POSIX permissions on a single-tenant host.

### 4. Unlocked-session compromise (process running as Eido user)

- **FileVault**: Plaintext accessible to processes executing under the same user privileges.
- **App-level encryption**: **Ineffective for an always-on assistant daemon**. Eido runs continuous background services (mail sync, proton bridge synchronization, scheduled morning brief generation, proactive triage ticks). Consequently, the database key must either remain resident in daemon memory or be retrieved automatically from the macOS Keychain upon service restart. A malicious process executing in the same user context can inspect process memory (`vmmap`/lldb) or request the key from Keychain.
- **Verdict**: App-level encryption provides negligible security benefit against an attacker who has already obtained code execution within the host user account, while giving a false sense of security.

## Operational Costs & Tradeoffs of App-Level Encryption

Implementing SQLCipher in Eido would impose significant burdens:

1. **Dependency surface & supply chain**: Replaces standard SQLite with custom compiled binaries, conflicting with Turborepo caching, multi-platform CI, and strict gate dependency allowlists.
2. **Query performance**: Introduces page-level decryption overhead on every read/write, heavily degrading performance during large ingestion batches, FTS5 tokenization, and vector similarity scans.
3. **Recovery failure risk**: Key mismatch, corrupted key derivation headers, or desynchronized key states can result in catastrophic, unrecoverable data loss.
4. **FTS and extensions**: Complicates integration with native SQLite extensions (FTS5, `sqlite-vec`).

## Decision

1. **Boundary selection**: Eido relies on **macOS FileVault 2** for data-at-rest encryption on host disks, combined with **Restic AES-256/Poly1305 repository encryption** for backups and **macOS Keychain** for credential secrets.
2. **POSIX enforcement**: Eido enforces strict `0700` directory and `0600` file permissions on all database and blob directories at startup.
3. **No SQLCipher for MVP**: Application-level database encryption is explicitly omitted from MVP and Wave 1.
4. **Honest boundaries**: Documentation, plan checklists, and backup runbooks must accurately document this boundary: when the host Mac is powered on and unlocked, protection against local access rests on OS user isolation and the gate process boundary, not cryptographic database locks.
