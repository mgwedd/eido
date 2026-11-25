# Gate and data-plane split on the Mac (#70)

The gate and the data plane (core) run as two hidden macOS users, each under its own LaunchDaemon. A sandbox profile and a per-user pf anchor fence the data plane's network, and a second anchor limits the gate user to the hosts the reviewed connector manifests name (#471). This runbook covers creating the split, checking it, updating it and removing it. Only the owner runs these commands; agents never run them.

`node --import ./infra/ts-hooks.ts infra/host/bin.ts plane plan` reads the host as you (dscl, `stack.env`, `tailscale status`) and prints a `/bin/sh` script. It changes nothing. You read the script, then run it with `sudo sh`. `plane remove` works the same way.

## What it creates

| Item                                    | Value                                                                                                                                                                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Gate user and group                     | `_eidogate`, uid and gid 451 (`--first-id` moves all three ids)                                                                                                                                                                                                          |
| Data-plane user and group               | `_eidodata`, uid and gid 452                                                                                                                                                                                                                                             |
| Socket group                            | `_eidoipc`, gid 453, members `_eidogate` and `_eidodata`                                                                                                                                                                                                                 |
| Gate data (`eido-control.db`)           | `/Library/Application Support/Eido/gate`, `_eidogate`, 0700                                                                                                                                                                                                              |
| Data-plane data (`eido-data.db`, blobs) | `/Library/Application Support/Eido/data`, `_eidodata`, 0700                                                                                                                                                                                                              |
| Sockets                                 | `/Library/Application Support/Eido/run`, `_eidogate:_eidoipc`, 0750. The data-plane socket is 0660 and the control socket 0600 (ADR 0003), so only the gate's data-plane socket is open to `_eidodata`.                                                                  |
| Gate keychain                           | `/Library/Application Support/Eido/home/gate/Library/Keychains/eido/eido.keychain-db`                                                                                                                                                                                    |
| App copy                                | `/Library/Application Support/Eido/app`, `root:wheel`, not writable by either user. The copy leaves out `infra/secrets`, `.env*` files (except `.env.example`), `eval-local` and `*.db` files.                                                                           |
| Sandbox profiles                        | `/Library/Application Support/Eido/policy/core.sb` (core) and `parser.sb` (no network)                                                                                                                                                                                   |
| pf anchor                               | `com.apple/eido.plane`, from `/Library/Application Support/Eido/policy/eido-plane.pf`. `/etc/pf.conf` is not edited.                                                                                                                                                     |
| Gate egress anchor                      | `com.apple/eido.egress`, from `/Library/Application Support/Eido/policy/eido-egress.pf`, with the host list `eido-egress.hosts`. See `infra/llama-server.md`, "Outbound allowlist".                                                                                      |
| Daemons                                 | `com.eido.plane.pf` (root, reloads the anchor every 5 minutes), `com.eido.plane.egress` (root, adds the hosts' addresses to the egress table every 5 minutes), `com.eido.plane.gate` (`_eidogate`), `com.eido.plane.core` (`_eidodata`, under `sandbox-exec -f core.sb`) |
| Logs                                    | `/Library/Logs/Eido/{gate,data,pf}` (the egress job logs to `pf/egress.err.log`)                                                                                                                                                                                         |
| Supervisor socket                       | ACL entries give `_eidogate` search on your home down to `run/supervisor/` in your stack dir, and read and write on `supervisor.sock` through an entry inherited only in that directory. The rest of `run/` stays closed to it. `_eidodata` gets none.                   |

What core may reach: the gate's data-plane socket, `127.0.0.1` on the gate's egress proxy port (`--egress-port`) and on the llama-server port (`EIDO_LLAMA_PORT`), and inbound connections on its own port. The sandbox denies all other network, DNS included, and denies reads of the gate's data dir and home. pf blocks every new outbound TCP connection and all UDP from `_eidodata`, except to those two loopback ports.

## Before you start

- Node must live outside `/Users`, because neither service user can read your home. Use Homebrew's node (`/opt/homebrew/bin/node`), or pass `--node <path>`.
- Run from your main checkout on an up-to-date `main`. The plan copies it to the app dir.
- `stack.env` needs mode 0600 when it exists. The plan reads `EIDO_TAILNET_HOST` and `EIDO_LLAMA_PORT` from it, the same way the stack does.
- Your own `com.eido.stack` agent also starts a gate and core under your user, on the same ports. Stop it before you apply (`pnpm stack:stop`, from your main checkout, while `stack.env` still has no `EIDO_STACK_PLANE`), then hand the ports to the plane with [Run web and the supervisor beside the plane](#run-web-and-the-supervisor-beside-the-plane) below.

## Create

```sh
cd ~/dev/eido
node --import ./infra/ts-hooks.ts infra/host/bin.ts plane plan --egress-port <gate egress proxy port> > ~/eido-plane.sh
less ~/eido-plane.sh        # every command it will run, as root
sudo sh ~/eido-plane.sh
```

If the uids or gids are taken, the plan stops and names the account that holds them. Pass a free `--first-id` (401 to 497).

Create the gate keychain once, as the gate user, with a passphrase you keep in your password manager:

```sh
sudo -u _eidogate security create-keychain -P \
  "/Library/Application Support/Eido/home/gate/Library/Keychains/eido/eido.keychain-db"
```

Unlocking that keychain while the gate runs under launchd without a login session is still open: #780.

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
   id _eidogate; id _eidodata
   dscl . -read /Groups/_eidoipc GroupMembership
   ```

   Both users are in `_eidoipc`, neither is in `admin`, and the members are exactly `_eidogate _eidodata`.

2. Ownership and modes:

   ```sh
   sudo ls -le "/Library/Application Support/Eido" "/Library/Application Support/Eido/run"
   sudo ls -l "/Library/Application Support/Eido/gate" "/Library/Application Support/Eido/data"
   ```

   `gate` is `_eidogate` 0700 and `data` is `_eidodata` 0700. `gate-data-plane.sock` is `srw-rw----` `_eidogate _eidoipc`. `gate-control.sock` is `srw-------`.

3. Supervisor socket ACL: `ls -le ~/Library/"Application Support"/eido-dev/run/supervisor/supervisor.sock` (or `$EIDO_STACK_DIR/run/supervisor`) shows `user:_eidogate allow read,write` and no entry for `_eidodata`. `ls -lde ~/Library/"Application Support"/eido-dev/run` shows no `_eidogate` entry with `file_inherit`, and `sudo -u _eidogate ls ~/Library/"Application Support"/eido-dev/run` is refused.

4. pf and the profiles:

   ```sh
   sudo pfctl -s info | head -1                          # Status: Enabled
   sudo pfctl -a com.apple/eido.plane -sr                # the block rules for user 452
   sandbox-exec -f "/Library/Application Support/Eido/policy/core.sb" /usr/bin/true && echo parses
   ```

   Then the gate's egress allowlist: the checks in `infra/llama-server.md`, "Outbound allowlist".

5. Daemons under the right users:

   ```sh
   sudo launchctl print system/com.eido.plane.egress | grep -E 'last exit code'   # 0
   sudo launchctl print system/com.eido.plane.gate | grep -E 'state|username'
   sudo launchctl print system/com.eido.plane.core | grep -E 'state|username'
   ps -o user=,command= -U _eidogate,_eidodata
   ```

6. Denied actions, as each user:

   ```sh
   sudo -u _eidodata cat "/Library/Application Support/Eido/gate/eido-control.db"      # Permission denied
   sudo -u _eidodata nc -U "/Library/Application Support/Eido/run/gate-control.sock"   # Permission denied
   sudo -u _eidodata touch "/Library/Application Support/Eido/gate/x"                  # Permission denied
   sudo -u _eidogate touch "/Library/Application Support/Eido/data/x"                  # Permission denied
   ```

7. The live isolation script (`docs/isolation-tests.md`). Run it from the app copy, which both users can read:

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
     --data-profile "/Library/Application Support/Eido/policy/core.sb" \
     --public-host <a public hostname> --public-ip <a public IPv4 address>
   ```

   With `--data-profile` the script runs every data-plane probe (except `parser`, which has its own profile) as `_eidodata` under `sandbox-exec -f core.sb`, as the data plane runs. DNS goes through mDNSResponder, which per-user pf cannot see, so only `core.sb` denies it: without the flag the `dns` probe reports reached. Every probe must pass.

8. Reboot, then repeat steps 4, 5 and 7.

## Update

After pulling a new `main`, or after changing `stack.env`, the egress port or the llama port, run the plan again and apply it. The script is idempotent: it rewrites the users' attributes, the group members, the modes, the app copy, the profiles, the anchors, the host list and the plists, then restarts the four daemons. A connector manifest added or changed on `main` reaches the egress host list only through this step.

```sh
node --import ./infra/ts-hooks.ts infra/host/bin.ts plane plan --egress-port <port> > ~/eido-plane.sh
sudo sh ~/eido-plane.sh
```

Run it twice and diff `sudo pfctl -a com.apple/eido.plane -sr`, `sudo pfctl -a com.apple/eido.egress -sr`, `id _eidogate` and `ls -le` between the runs: they match.

## Remove

```sh
node --import ./infra/ts-hooks.ts infra/host/bin.ts plane remove > ~/eido-plane-remove.sh
less ~/eido-plane-remove.sh
sudo sh ~/eido-plane-remove.sh
```

This boots out and deletes the four daemons, flushes both anchors, removes the ACL entries, deletes the users and groups that exist, and removes the policy files, the app copy and the run dir. It keeps the gate's and data plane's data, the gate keychain and the logs. The script ends by printing the `sudo rm -rf` command that deletes them, once you have backed them up. pf stays enabled; `sudo pfctl -d` disables it if nothing else uses it.

To go back to the single-user stack, remove the `EIDO_STACK_PLANE=split` line from `stack.env` and run `pnpm stack:install`.

## Open follow-ups

- #777: the isolation script's data-plane probes under `core.sb`.
- #778: a no-network fence for parsers (core's parse child inherits `core.sb`).
- #780: headless unlock of the gate keychain.
- #781: Things, EventKit and file-root writes from the gate user.
- #782: backups of the plane's gate and data dirs.
- #783: the supervisor socket in a directory of its own.
