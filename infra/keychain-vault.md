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

Set the gate's `EIDO_GATE_KEYCHAIN_PATH` to that path. Credential enrollment is
Mac-side work (#98), through the gate's vault interface. The web app never receives
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
