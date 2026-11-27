# Gate and data-plane split on the Mac (#70)

The gate and the data plane (core) run as two hidden macOS users, each under its own LaunchDaemon. A third hidden user runs the document parser broker, which core reaches over a socket only core may open (#818). A sandbox profile and a per-user pf anchor fence the data plane's and the parser's network, and a second anchor limits the gate user to the hosts the reviewed connector manifests name (#471). This runbook covers creating the split, checking it, updating it and removing it. Only the owner runs these commands; agents never run them.

`node --import ./infra/ts-hooks.ts infra/host/bin.ts plane plan` reads the host as you (dscl, `stack.env`, `tailscale status`) and prints a `/bin/sh` script. It changes nothing. You read the script, then run it with `sudo sh`. `plane remove` works the same way.

## What it creates

| Item                                    | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gate user and group                     | `_eidogate`, uid and gid 451 (`--first-id` moves every id)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Data-plane user and group               | `_eidodata`, uid and gid 452                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Socket group                            | `_eidoipc`, gid 453, members `_eidogate` and `_eidodata`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Parser user and group                   | `_eidoparse`, uid and gid 454, home `/Library/Application Support/Eido/home/parser` (0700). Not in `_eidoipc`, so the gate's sockets and both planes' data stay closed to it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Parser scratch                          | `/Library/Application Support/Eido/parser`, `_eidoparse`, 0700 (`EIDO_PARSER_SCRATCH_DIR`): documents in flight only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Parser socket                           | `/Library/Application Support/Eido/parser-run`, `_eidoparse:_eidodata`, 0750. `parser.sock` takes the directory's group and the broker makes it 0660, so only `_eidodata` (core) can connect. The path goes to the broker and to core as `EIDO_PARSER_SOCKET`.                                                                                                                                                                                                                                                                                                                                                                                                      |
| Gate data (`eido-control.db`)           | `/Library/Application Support/Eido/gate`, `_eidogate`, 0700                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Data-plane data (`eido-data.db`, blobs) | `/Library/Application Support/Eido/data`, `_eidodata`, 0700                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Sockets                                 | `/Library/Application Support/Eido/run`, `_eidogate:_eidoipc`, 0750. The data-plane socket is 0660 and the control socket 0600 (ADR 0003), so only the gate's data-plane socket is open to `_eidodata`.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Gate keychain                           | `/Library/Application Support/Eido/home/gate/Library/Keychains/eido/eido.keychain-db`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| App copy                                | `/Library/Application Support/Eido/app`, `root:wheel`, not writable by either user. The copy leaves out `infra/secrets`, `.env*` files (except `.env.example`), `eval-local` and `*.db` files. The gate launcher `gate-launcher.zsh` is left out of the copy, so `--delete` never removes it; it is rewritten after the copy (any file or link at that path removed first), `root:wheel` 0555.                                                                                                                                                                                                                                                                      |
| Sandbox profiles                        | `/Library/Application Support/Eido/policy/core.sb` (core) and `parser.sb` (the broker and its parse children: no network but binding `parser.sock`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| pf anchor                               | `com.apple/eido.plane`, from `/Library/Application Support/Eido/policy/eido-plane.pf`: the `_eidodata` rules, then a block of every TCP and UDP packet for the `_eidoparse` uid. `/etc/pf.conf` is not edited.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Gate egress anchor                      | `com.apple/eido.egress`, from `/Library/Application Support/Eido/policy/eido-egress.pf`, with the host list `eido-egress.hosts`. See `infra/llama-server.md`, "Outbound allowlist".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Daemons                                 | `com.eido.plane.pf` (root, reloads the anchor every 5 minutes), `com.eido.plane.egress` (root, adds the hosts' addresses to the egress table every 5 minutes), `com.eido.plane.gate` (root, runs only the gate launcher, which drops to `_eidogate` before it starts the gate), `com.eido.plane.parser` (`_eidoparse`, under `sandbox-exec -f parser.sb`, with the no-network preload), `com.eido.plane.core` (`_eidodata`, under `sandbox-exec -f core.sb`)                                                                                                                                                                                                        |
| Logs                                    | `/Library/Logs/Eido/{gate,data,parser,pf}` (the egress job logs to `pf/egress.err.log`). `gate` is `root:admin` 0750: launchd opens the gate's logs as root, and the gate writes them only through the descriptors launchd hands it. Apply removes anything there that is not a plain file with one link, and makes the log files `root:admin` 0640.                                                                                                                                                                                                                                                                                                                |
| Supervisor socket                       | ACL entries give `_eidogate` search on your home down to `run/supervisor/` in your stack dir, and read and write on `supervisor.sock` through an entry inherited only in that directory. The rest of `run/` stays closed to it. `_eidodata` gets none.                                                                                                                                                                                                                                                                                                                                                                                                              |
| Session bridge (opt in)                 | `<Eido dir>/bridge` (`root:wheel` 0755) holds root-owned copies of `eido-helper` and the file helper. `~/Library/LaunchAgents/com.eido.plane.bridge.plist` runs `eido-helper --bridge` in your login session (Aqua only) with a minimal environment and no secrets. Its socket is `bridge.sock` in `run/session-bridge/` of your stack dir (you, 0700); ACL entries give `_eidogate` search on your home down to that directory and read and write on the socket through an entry inherited only there. `_eidodata`, `_eidoparse` and `_eidoipc` get none. The gate daemon gets `EIDO_SESSION_BRIDGE_SOCKET` (the socket) and `EIDO_SESSION_BRIDGE_UID` (your uid). |

What core may reach: the gate's data-plane socket, the parser's socket, `127.0.0.1` on the gate's egress proxy port (`--egress-port`) and on the llama-server port (`EIDO_LLAMA_PORT`), and inbound connections on its own port. The sandbox denies all other network, DNS included, and denies reads of the gate's data dir and home. pf blocks every new outbound TCP connection and all UDP from `_eidodata`, except to those two loopback ports.

What the parser may reach: nothing. `parser.sb` denies all network, DNS included, and allows only binding and accepting on `parser.sock`. pf blocks every TCP and UDP packet of `_eidoparse`, loopback included, so a parse child cannot reach the egress proxy or llama-server either. The broker starts with `--import ./src/parsers/no-network.ts`, as its test does.

## Before you start

- Node must live outside `/Users`, because neither service user can read your home. Use Homebrew's node (`/opt/homebrew/bin/node`), or pass `--node <path>`.
- Run from your main checkout on an up-to-date `main`. The plan copies it to the app dir.
- `stack.env` needs mode 0600 when it exists. The plan reads `EIDO_TAILNET_HOST` and `EIDO_LLAMA_PORT` from it, the same way the stack does.
- Your own `com.eido.stack` agent also starts a gate and core under your user, on the same ports. Stop it before you apply (`pnpm stack:stop`, from your main checkout, while `stack.env` still has no `EIDO_STACK_PLANE`), then hand the ports to the plane with [Run web and the supervisor beside the plane](#run-web-and-the-supervisor-beside-the-plane) below.

- To make the session bridge (#827), build the Helper (`apps/helper`) and the file helper (`docs/local-files.md`, `pnpm install:file-helper`, which prints `EIDO_FILE_HELPER_SHA256`), and have your list of approved file roots ready (see "Approved file roots" below). The bridge is opt in: see "Session bridge".

## Create

```sh
cd ~/dev/eido
node --import ./infra/ts-hooks.ts infra/host/bin.ts plane plan --egress-port <gate egress proxy port> > ~/eido-plane.sh
less ~/eido-plane.sh        # every command it will run, as root
sudo sh ~/eido-plane.sh
```

If the uids or gids are taken, the plan stops and names the account that holds them. Pass a free `--first-id` (401 to 496).

To make the session bridge in the same run, add the four `--bridge-*` flags to `plane plan` (see "Session bridge").

Then create the gate keychain and its unlock item with `host keychain set` (see "Set and rotate the gate keychain passphrase" below).

## Gate keychain unlock at start

The gate daemon is a root job (#823, decided in #780). launchd runs `/bin/zsh -f "/Library/Application Support/Eido/app/gate-launcher.zsh"`, a fixed script the plan generates. It is owned by root, mode 0555, in the root-owned app copy, so the gate user cannot change it. It:

1. Sets `ulimit -c 0` and `EIDO_GATE_KEYCHAIN_UNLOCK=stdin`.
2. Reads the generic password with service `com.eido.gate.keychain-unlock` from `/Library/Keychains/System.keychain` with `security find-generic-password -w`, run as root with only `HOME=/var/root` in its environment.
3. Pipes it straight into the gate's stdin. The passphrase is never in a shell variable, an argument, the environment, a file or a log.
4. Drops to `_eidogate` with `chroot -u _eidogate -g _eidogate -G _eidogate,_eidoipc /`, which sets exactly those groups, and execs the gate in the same process. The gate keeps the job's environment and working directory.

Because launchd runs the job as root, it opens `gate.out.log` and `gate.err.log` as root. Their directory is root's and not writable by `_eidogate`, so the gate cannot replace a log with a link to a file root would then append to. `zsh -f` still reads `/etc/zshenv`; that file is root-owned system state, outside anything the gate can write.

If the item is missing or root cannot read it, the launcher writes `eido gate launcher: the System keychain item com.eido.gate.keychain-unlock is missing or unreadable; starting the gate with no passphrase, so it stays locked` to `gate.err.log` and starts the gate with empty stdin. The gate then refuses the empty passphrase and reports itself locked (#822).

The item holds the gate keychain passphrase as plain text, written by `host keychain` below. `security find-generic-password -w` prints data that is not printable as hex, and the gate would get the hex, so the script accepts printable ASCII only.

Live check (owner, after the item is set; e2e in #811): reboot, do not log in, then check that `gate.err.log` has no launcher message and the gate reads a synthetic token.

## Set and rotate the gate keychain passphrase

`host keychain <set|rotate|repair>` prints a zsh script and changes nothing (#824). Read it, then run it with `sudo zsh -f`. Run the generator as yourself: it takes the paths from the plane layout and refuses root.

```sh
cd ~/dev/eido
node --import ./infra/ts-hooks.ts infra/host/bin.ts keychain set > ~/eido-keychain.zsh
less ~/eido-keychain.zsh
sudo zsh -f ~/eido-keychain.zsh
rm ~/eido-keychain.zsh
```

The script asks for the passphrase at its own hidden prompt, `New gate keychain passphrase:` (repair: `Gate keychain passphrase (from your password manager):`), then `Type it again:`. It hands the passphrase to `security` on stdin only, so it is never in an argument, the environment, the shell history or a file. Save it in your password manager first. It must be 1 to 256 printable ASCII characters.

- `set`, once, after the plan: checks that the keychain does not exist yet and the item is absent, creates `eido.keychain-db` as `_eidogate`, makes it mode 0600, turns auto-lock off, writes the item `com.eido.gate.keychain-unlock` to the System keychain as root, and restarts the gate (`launchctl kickstart -k system/com.eido.plane.gate`).
- `rotate`: reads the current passphrase from the item, asks for a new one, changes the keychain password first, then the item, then restarts the gate. If the item cannot be written, it changes the keychain password back, so both still hold the old passphrase.
- `repair`: for a lost or stale item. It checks the passphrase you type against the keychain (a change to the same password, which fails on a wrong one), then writes the item and restarts the gate.

After each run, `/Library/Application Support/Eido/gate/gate.log` gets `keychain_unlocked` when the gate unlocked the keychain, or `keychain_unlock_failed` with a reason. Every failure message says what state the run left and what to run next. Recovery for each half-done state, and what it means that root can read the item, are in `infra/keychain-vault.md`, "Gate keychain passphrase". The live run (set and rotate once, the gate unlocks after each) is #811.

## Run web and the supervisor beside the plane

With the plane applied, your `com.eido.stack` agent stops running a gate and core and runs only web and the supervisor. Set split mode and reinstall the agent:

```sh
printf 'EIDO_STACK_PLANE=split\n' >> "$HOME/Library/Application Support/eido-dev/stack.env"   # under $EIDO_STACK_DIR if you set it
pnpm stack:install
pnpm stack:status
```

`stack.env` keeps its mode 0600 when you append to it. `stack:install` loads the agent, which starts web with `EIDO_GATE_PHONE_HOST=127.0.0.1` and `EIDO_GATE_PHONE_PORT` set to the gate's phone port, so web talks to `com.eido.plane.gate`. `stack:status` and `stack:doctor` then report `com.eido.plane.gate` and `com.eido.plane.core` from `launchctl print system/<label>` and their loopback health URLs, and name one that is not installed, not loaded or stopped. `stack:stop` stops web and says it leaves the plane's daemons alone; the supervisor lists the daemons but never starts or stops them.

In split mode `stack:setup`, `stack:bootstrap` and `stack:gate` refuse, because they act on a gate under your own account (#795).

## Verify

1. Users and groups:

   ```sh
   id _eidogate; id _eidodata; id _eidoparse
   dscl . -read /Groups/_eidoipc GroupMembership
   ```

   `_eidogate` and `_eidodata` are in `_eidoipc`, none of the three is in `admin`, and the members are exactly `_eidogate _eidodata`. `id _eidoparse` lists only the group `_eidoparse`.

2. Ownership and modes:

   ```sh
   sudo ls -le "/Library/Application Support/Eido" "/Library/Application Support/Eido/run"
   sudo ls -l "/Library/Application Support/Eido/gate" "/Library/Application Support/Eido/data"
   ```

   `gate` is `_eidogate` 0700 and `data` is `_eidodata` 0700. `gate-data-plane.sock` is `srw-rw----` `_eidogate _eidoipc`. `gate-control.sock` is `srw-------`.

   Then the parser: `sudo ls -le "/Library/Application Support/Eido/parser-run"` shows `parser.sock` as `srw-rw----` `_eidoparse _eidodata` and no ACL entry. `parser` and `home/parser` are `_eidoparse` 0700.

3. Supervisor socket ACL: `ls -le ~/Library/"Application Support"/eido-dev/run/supervisor/supervisor.sock` (or `$EIDO_STACK_DIR/run/supervisor`) shows `user:_eidogate allow read,write` and no entry for `_eidodata`. `ls -lde ~/Library/"Application Support"/eido-dev/run` shows no `_eidogate` entry with `file_inherit`, and `sudo -u _eidogate ls ~/Library/"Application Support"/eido-dev/run` is refused.

   With the session bridge: `ls -lde ~/Library/"Application Support"/eido-dev/run/session-bridge` shows `user:_eidogate allow search` and one `user:_eidogate allow read,write,file_inherit,only_inherit`, and no entry for `_eidodata`, `_eidoparse` or `_eidoipc`. `ls -le` of `bridge.sock` inside it shows `user:_eidogate allow read,write`. `launchctl print gui/$(id -u)/com.eido.plane.bridge | grep state` shows `running`.

4. pf and the profiles:

   ```sh
   sudo pfctl -s info | head -1                          # Status: Enabled
   sudo pfctl -a com.apple/eido.plane -sr                # the block rules for users 452 and 454
   sandbox-exec -f "/Library/Application Support/Eido/policy/core.sb" /usr/bin/true && echo parses
   sandbox-exec -f "/Library/Application Support/Eido/policy/parser.sb" /usr/bin/true && echo parses
   ```

   Then the gate's egress allowlist: the checks in `infra/llama-server.md`, "Outbound allowlist".

5. Daemons under the right users:

   ```sh
   sudo launchctl print system/com.eido.plane.egress | grep -E 'last exit code'   # 0
   sudo launchctl print system/com.eido.plane.gate | grep -E 'state|username'   # username = root: the launcher's job
   sudo launchctl print system/com.eido.plane.parser | grep -E 'state|username'
   sudo launchctl print system/com.eido.plane.core | grep -E 'state|username'
   ps -o user=,command= -U _eidogate,_eidodata,_eidoparse
   ps -o user=,command= -U root | grep gate-launcher   # nothing: the launcher has become the gate
   ```

   The `ps` line for the gate is `_eidogate` running node, not root.

6. Denied actions, as each user:

   ```sh
   sudo -u _eidodata cat "/Library/Application Support/Eido/gate/eido-control.db"      # Permission denied
   sudo -u _eidodata nc -U "/Library/Application Support/Eido/run/gate-control.sock"   # Permission denied
   sudo -u _eidodata touch "/Library/Application Support/Eido/gate/x"                  # Permission denied
   sudo -u _eidogate touch "/Library/Application Support/Eido/data/x"                  # Permission denied
   sudo -u _eidogate nc -U "/Library/Application Support/Eido/parser-run/parser.sock"  # Permission denied
   sudo -u _eidoparse nc -U "/Library/Application Support/Eido/run/gate-data-plane.sock" # Permission denied
   sudo -u _eidoparse cat "/Library/Application Support/Eido/data/eido-data.db"        # Permission denied
   ```

7. The live isolation script (`docs/isolation-tests.md`). Run it from the app copy, which the gate, data-plane and parser users can all read:

   ```sh
   cd "/Library/Application Support/Eido/app"
   sudo /opt/homebrew/bin/node scripts/check-isolation-live.ts \
     --gate-user _eidogate --data-user _eidodata \
     --intent-socket "/Library/Application Support/Eido/run/gate-data-plane.sock" \
     --control-socket "/Library/Application Support/Eido/run/gate-control.sock" \
     --control-db "/Library/Application Support/Eido/gate/eido-control.db" \
     --gate-keychain "/Library/Application Support/Eido/home/gate/Library/Keychains/eido/eido.keychain-db" \
     --proxy-port <gate egress proxy port> --llama-port <llama-server port> \
     --parser-profile "/Library/Application Support/Eido/policy/parser.sb" \
     --parser-socket "/Library/Application Support/Eido/parser-run/parser.sock" \
     --data-db "/Library/Application Support/Eido/data/eido-data.db" \
     --data-profile "/Library/Application Support/Eido/policy/core.sb" \
     --public-host <a public hostname> --public-ip <a public IPv4 address>
   ```

   With `--data-profile` the script runs every data-plane probe as `_eidodata` under `sandbox-exec -f core.sb`, as the data plane runs, except the one that delivers a parse job. DNS goes through mDNSResponder, which per-user pf cannot see, so only `core.sb` denies it: without the flag the `dns` probe reports reached.

   The parser probes do not wrap anything in `parser.sb` by hand. The script reads the installed `parser.sb` as text (`--parser-profile`) and starts a probe broker, the production broker, as `_eidoparse` under that profile on a probe socket next to `parser.sock` in `parser-run`. It then sends one parse job per target from `_eidodata`, and the broker starts the parse child as the daemon does. `--parser-socket` is the daemon's `parser.sock`: the script checks that `_eidodata` can connect to it, and the profile must name it exactly once. `--data-db` is `eido-data.db`: `_eidodata` must be able to open it, and the parse child must not. The data and parser users must be able to read the app copy and Node. Every probe must pass.

8. Reboot, then repeat steps 4, 5 and 7.

## Session bridge

The gate runs as `_eidogate`, outside your login session, so it reaches EventKit, Things and your approved file roots through the session bridge (#827, decided in #781): `eido-helper --bridge`, run by a LaunchAgent as you, serving a Unix socket only the gate may open. The bridge is opt in. `plane plan` with none of the four flags below makes no bridge and leaves `EIDO_SESSION_BRIDGE_SOCKET` unset for the gate; with all four it makes the bridge and sets both variables.

```sh
node --import ./infra/ts-hooks.ts infra/host/bin.ts plane plan --egress-port <port> \
  --bridge-helper <path to eido-helper> \
  --bridge-file-helper <path to the file helper> \
  --bridge-file-helper-sha256 <EIDO_FILE_HELPER_SHA256> \
  --bridge-file-roots <absolute path of your approved-roots list> > ~/eido-plane.sh
```

The plan stops when a flag is missing, a path is relative or not a file, a file is writable by group or others, or the hash is not 64 lowercase hex digits. `--bridge-file-helper` may be a symbolic link such as `current`: the plan copies it to a real file, which the bridge needs (it refuses a link at the last component with `file_helper_mismatch`), and the script checks the copy against the hash before anything starts. Keep the list at `--bridge-file-roots` yourself: owned by you, mode `600` (see "Approved file roots").

What the script makes, in this order (`<Eido dir>` is `/Library/Application Support/Eido`):

The sudo script uses your account for changes under your home. It creates the supervisor and bridge socket directories, changes their ACLs and the ancestor ACLs, creates the LaunchAgents and bridge log directories, and installs and loads the plist as you. Removal also unloads the agent and cleans up its plist, logs, socket directory and ACLs as you. The helper copies and system daemons are installed as root.

1. `<Eido dir>/bridge`, `root:wheel` 0755, with `eido-helper` and `eido-file-helper` copied in as `root:wheel` 0755, so neither can be replaced from your account or the gate's.
2. The socket directory `run/session-bridge/` in your stack dir, owned by you, 0700, then the ACL entries: `_eidogate` `allow search` on each directory from your home down to it (an entry the supervisor already holds is not added twice), and `_eidogate allow read,write,file_inherit,only_inherit` on the socket directory. The bridge makes a new `0600` socket at every start, so access comes from that inherited entry, never from an ACL on the socket itself. No entry grants write on a directory: the gate refuses a socket, or any directory above it, that another principal can write (`EIDO_SESSION_BRIDGE_UID`, see [the Helper README](../apps/helper/README.md)).
3. The LaunchAgent plist `~/Library/LaunchAgents/com.eido.plane.bridge.plist` (owned by you, 0644). The script lints a temporary plist with `plutil` and moves it into place, then runs `launchctl bootout` and `launchctl bootstrap gui/<your uid>`. It limits loading to the Aqua session, so the bridge starts at login and stops at logout. Its arguments are `<Eido dir>/bridge/eido-helper --bridge --socket <socket> --peer-user _eidogate --things-scripts <Eido dir>/app/packages/gate/src/internal/things/scripts --file-helper <Eido dir>/bridge/eido-file-helper --file-helper-sha256 <hash> --file-roots <your list>`. Its environment is `PATH=/usr/bin:/bin:/usr/sbin:/sbin` and nothing else. Logs go to `~/Library/Logs/eido-dev/bridge.{out,err}.log`.

The gate daemon starts with both variables, through the gate launcher, which keeps the job's environment.

The bridge refuses to start while the socket path still accepts connections, so a second `plane plan` run restarts it (`bootout`, then `bootstrap`) rather than starting a second one.

After the first run, grant EventKit access to the installed binary, in your own session: `"<Eido dir>/bridge/eido-helper" --authorize`. macOS ties the grant to that exact path and binary, so repeat it when the plan installs a changed Helper.

### The file helper's copy directory

The bridge never runs the binary at `--file-helper`; it runs a private copy it makes at start, in the copy directory (#905). The LaunchAgent does not pass `--file-helper-copy-dir`, so the bridge uses its default: your per-user cache directory, `confstr(_CS_DARWIN_USER_CACHE_DIR)`, under `/var/folders`. That is the choice [The file helper's private copy](../apps/helper/README.md#the-file-helpers-private-copy) names as meeting the requirements, and it needs no setup. The requirements, which hold for any directory you pass instead:

- A directory (not a symbolic link) owned by you, with no group or other write bit; every directory above it owned by root or you and writable by no one else unless sticky.
- A local volume that honours ownership and allows exec: not a network volume, not `noexec`, and not an external disk with "Ignore ownership on this volume" set.

A directory that fails them stops the bridge at start with `file_helper_copy_unsafe` or `file_helper_copy_failed`, visible in `bridge.err.log`. If the copy is missing or changed later, file ops answer `unavailable` until the bridge restarts: `launchctl kickstart -k gui/$(id -u)/com.eido.plane.bridge`.

Live checks (owner; e2e in #811): the socket ACL and that a peer other than `_eidogate` is refused, the bridge starting at login and stopping at logout, and Things, EventKit and file writes working from `_eidogate`.

## Approved file roots

The session bridge reaches only the file roots the owner approved (#865). The owner keeps the list in a JSON file they own, mode `600`, and the bridge reads it once at start from `--file-roots <absolute path>`; the format is under "Approved file roots" in [apps/helper/README.md](../apps/helper/README.md). Without the flag, or with an empty list, every file op from the gate is refused. The bridge refuses to start on a list that is group or other writable, not owned by the owner, a symbolic link, or malformed. The LaunchAgent that `plane plan` installs passes the flag from `--bridge-file-roots`. After changing the list, restart the bridge: `launchctl kickstart -k gui/$(id -u)/com.eido.plane.bridge`.

To approve a new root, in this order:

1. Get the directory's canonical path. `realpath <dir>` resolves symbolic links, and the path must be spelled in the case it has on disk, because the bridge compares it with the path the OS reports for the opened directory. Get its device and inode with `stat -f '%d %i' <canonical path>`; the list needs both.
2. Add `{"path": "<canonical path>", "dev": "<device>", "ino": "<inode>"}` to the list file, keeping its mode `600`.
3. Restart the bridge, which reads the list only at start: `launchctl kickstart -k gui/$(id -u)/com.eido.plane.bridge`.
4. Approve the folder in the web UI. The gate's request for a root the list does not name is refused with `root_not_approved`.

## Back up

The owner's nightly backup cannot read the plane's data dirs. A root LaunchDaemon, `com.eido.plane.backup`, backs up both from the plane; set it up and restore from it as described under "Split host" in [backup-restore.md](backup-restore.md).

## Update

After pulling a new `main`, or after changing `stack.env`, the egress port or the llama port, run the plan again and apply it. The script is idempotent: it rewrites the users' attributes, the group members, the modes, the app copy, the profiles, the anchors, the host list and the plists, then restarts the five daemons. Without the `--bridge-*` flags it leaves an installed session bridge as it is; with them it reinstalls the helper copies, the plist and the ACL entries and restarts the agent. A connector manifest added or changed on `main` reaches the egress host list only through this step.

```sh
node --import ./infra/ts-hooks.ts infra/host/bin.ts plane plan --egress-port <port> > ~/eido-plane.sh
sudo sh ~/eido-plane.sh
```

Run it twice and diff `sudo pfctl -a com.apple/eido.plane -sr`, `sudo pfctl -a com.apple/eido.egress -sr`, `id _eidogate`, `id _eidoparse` and `ls -le` (also of the session bridge's directory, with the bridge) between the runs: they match.

## Remove

```sh
node --import ./infra/ts-hooks.ts infra/host/bin.ts plane remove > ~/eido-plane-remove.sh
less ~/eido-plane-remove.sh
sudo sh ~/eido-plane-remove.sh
```

This boots out and deletes the five daemons (core first, then the parser), flushes both anchors, removes the ACL entries, deletes the users and groups that exist, and removes the policy files, the app copy, the run dir and every parser path (home, scratch, socket dir and logs), so nothing of `_eidoparse` is left. It also boots out the session bridge agent and deletes its plist and logs, the helper copies, and the socket directory with its ACL entries, whether or not the bridge was installed; without `plane remove` the bridge stays installed. It keeps the gate's and data plane's data, the gate keychain and the logs. The script ends by printing the `sudo rm -rf` command that deletes them, once you have backed them up. pf stays enabled; `sudo pfctl -d` disables it if nothing else uses it.

To go back to the single-user stack, remove the `EIDO_STACK_PLANE=split` line from `stack.env` and run `pnpm stack:install`.

## Open follow-ups

- #777: the isolation script's data-plane probes under `core.sb`.
- #811: the live checks for the parser user: the nested sandbox, pf `user` rules for a third uid on loopback, DNS under `parser.sb`, and no reach from a parse child to the proxy or llama-server.
- #822: the gate reports locked when it starts without a passphrase.
- #781: Things, EventKit and file-root writes from the gate user.
- #783: the supervisor socket in a directory of its own.
