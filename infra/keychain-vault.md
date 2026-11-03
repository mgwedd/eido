# Gate Keychain vault

On macOS, set `EIDO_GATE_KEYCHAIN_PATH` to an absolute path to an existing,
unlocked keychain owned by the gate user. The file must be a regular file with no
group or other permissions (mode 0600). Symlinks, missing files, other owners,
locked keychains, and native failures fail closed. The adapter never searches the
default/login keychain or falls back to a file vault.

Gmail OAuth credentials, the Bridge password, and Web Push keys use the same vault
selection. The stack passes this setting only to the gate. Do not combine it with
`EIDO_GATE_VAULT_FILE` or `EIDO_DEV_VAULT=1`. Development file storage still needs
both of those development settings.

## Provisioning

Run these commands interactively as the gate identity chosen in #70. The security
tool prompts for the new keychain password; do not put it in command arguments,
scripts, environment variables, logs, or the repository.

```sh
umask 077
mkdir -p "$HOME/Library/Keychains/eido"
chmod 700 "$HOME/Library/Keychains/eido"
security create-keychain "$HOME/Library/Keychains/eido/eido.keychain-db"
chmod 600 "$HOME/Library/Keychains/eido/eido.keychain-db"
security unlock-keychain "$HOME/Library/Keychains/eido/eido.keychain-db"
```

Set the gate's `EIDO_GATE_KEYCHAIN_PATH` to that path. Credentials are enrolled on
the Mac with `pnpm --filter @eido/gate connect <connector>` (#98), through the gate's
vault interface; the runbook is `infra/connectors.md`. The web app never receives
the credentials. The helper disables Keychain interaction, so a locked keychain
returns an error instead of displaying a password dialog in a background process.

The gate user's provisioning and headless unlock mechanism remain #70. This change
does not create a macOS user, install a launch agent, store an unlock password, or
deploy to the host. After a FileVault reboot, the chosen session and keychain must
be unlocked before credentials are available.

## Storage and boundary

Each credential is a generic-password item with service `com.eido.gate.vault` and
account `JSON.stringify([connector, kind, client])`. The data is the secret's
UTF-16LE bytes, preserving all JavaScript strings.
Writes are limited to 256 KiB of encoded secret bytes so a stored value always fits
the helper's bounded read-back response. Every native add, lookup,
update, and delete explicitly uses `kSecAttrSynchronizable = false` and the one
configured keychain. No iCloud synchronization is enabled.

The built-in JavaScriptObjC bridge calls Security.framework. Only fixed helper
source appears in process arguments; credential requests and results use private
pipes. Native stderr and error text are never forwarded. No dependency, install
script, Swift helper, gate allowlist change, or boundary exception is required.
The gate UID is the process isolation boundary: #70 must keep the data-plane user
from reading the gate user's keychain.

## Validation

```sh
pnpm turbo run typecheck lint test --filter=@eido/gate --filter=@eido/infra
pnpm verify --full
```

On macOS, `keychain-vault.native.test.ts` runs the shared vault contract against
fresh throwaway keychains and deletes them afterward. It also checks native
attributes, private file permissions, locked/missing keychains, binary-safe secret
round trips, and the real worker's process arguments. It never opens the login
keychain. Native tests explicitly skip on other platforms; adapter, subprocess,
configuration, and wiring tests still run there.

Before deploying with #70, verify from a second real macOS user that a synthetic
item in the gate user's dedicated keychain cannot be read. Record the attempted
command and denial, without the password or item value. That cross-user check and
the final unlock procedure have not been verified by this implementation's tests.

## Profile audit pseudonyms

The configured gate vault also holds the 256-bit profile audit key (#204), even when no connector is enabled. With no vault configured, profile audit requests return 503; profile changes in core roll back. Other gate routes remain available. Key initialization failures log only `profile_audit_unavailable`; restore vault access and restart the gate to retry initialization. A key that disappears during a running process also blocks subsequent profile audit writes.

`EIDO_PROFILE_AUDIT_EPOCH` defaults to `1`. The vault account uses connector `eido-profile-audit:<epoch>`, kind `api_key`, client `none`. The secret is 32 random bytes encoded as lowercase hex. First use creates and reads back the secret before recording its SHA-256 fingerprint in `profile_audit_keys` in the control database. That table holds only epoch names and fingerprints, never the key. A key left in the vault by an interrupted first initialization is reused. Run one gate process per control database; vault and SQLite updates are separate operations, so an initialization conflict fails closed rather than replacing a registered key.

For each new profile audit row, HMAC-SHA-256 covers the JSON tuple `["eido.profile-audit.v1", epoch, role, incomingDigest]`, where role is `subject`, `before`, or `after`. Null before/after values stay null. Tags are `hmac:v1:<epoch>:<full-key-fingerprint>:<hex-HMAC>`. The target is the subject tag; the detail hash covers only the action and tagged values. The endpoint still accepts hashes only and returns only the audit sequence number. Ledger audit rows keep their existing format.

To rotate deliberately, stop the gate, set a new unique `EIDO_PROFILE_AUDIT_EPOCH` (1–64 letters, digits, underscores or hyphens), then restart with the same vault. The new epoch gets a fresh key; previous epoch keys, metadata and append-only audit rows remain intact. Do not reuse an epoch name to replace a lost key. Identical subjects correlate within an epoch; rotation intentionally changes their tags.

If the vault loses or changes an initialized epoch's key, the gate refuses profile audit writes. Restore that exact key from an owner-held secure recovery copy, or deliberately rotate to a new epoch. Never remove the fingerprint marker to bypass the refusal. Keychain credentials are excluded from the database backup: a database restore does not restore these keys. Without an old epoch key its tags cannot be recomputed, although the audit hash chain remains verifiable. Historical unkeyed rows remain readable and guessable; this change does not protect them retroactively. Protection applies to a log-only reader without vault or socket access, as stated in ADR 0003.
