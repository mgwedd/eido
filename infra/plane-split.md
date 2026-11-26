# Gate and data-plane split on the Mac (#70)

The gate and the data plane (core) run as two hidden macOS users, each under its own LaunchDaemon. A third hidden user runs the document parser broker, which core reaches over a socket only core may open (#818). A sandbox profile and a per-user pf anchor fence the data plane's and the parser's network, and a second anchor limits the gate user to the hosts the reviewed connector manifests name (#471). This runbook covers creating the split, checking it, updating it and removing it. Only the owner runs these commands; agents never run them.

`node --import ./infra/ts-hooks.ts infra/host/bin.ts plane plan` reads the host as you (dscl, `stack.env`, `tailscale status`) and prints a `/bin/sh` script. It changes nothing. You read the script, then run it with `sudo sh`. `plane remove` works the same way.

## What it creates

| Item                                    | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Gate user and group                     | `_eidogate`, uid and gid 451 (`--first-id` moves every id)                                                                                                                                                                                                                                                                                                                                                                                                   |
| Data-plane user and group               | `_eidodata`, uid and gid 452                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Socket group                            | `_eidoipc`, gid 453, members `_eidogate` and `_eidodata`                                                                                                                                                                                                                                                                                                                                                                                                     |
| Parser user and group                   | `_eidoparse`, uid and gid 454, home `/Library/Application Support/Eido/home/parser` (0700). Not in `_eidoipc`, so the gate's sockets and both planes' data stay closed to it.                                                                                                                                                                                                                                                                                |
| Parser scratch                          | `/Library/Application Support/Eido/parser`, `_eidoparse`, 0700 (`EIDO_PARSER_SCRATCH_DIR`): documents in flight only.                                                                                                                                                                                                                                                                                                                                        |
| Parser socket                           | `/Library/Application Support/Eido/parser-run`, `_eidoparse:_eidodata`, 0750. `parser.sock` takes the directory's group and the broker makes it 0660, so only `_eidodata` (core) can connect. The path goes to the broker and to core as `EIDO_PARSER_SOCKET`.                                                                                                                                                                                               |
| Gate data (`eido-control.db`)           | `/Library/Application Support/Eido/gate`, `_eidogate`, 0700                                                                                                                                                                                                                                                                                                                                                                                                  |
| Data-plane data (`eido-data.db`, blobs) | `/Library/Application Support/Eido/data`, `_eidodata`, 0700                                                                                                                                                                                                                                                                                                                                                                                                  |
| Sockets                                 | `/Library/Application Support/Eido/run`, `_eidogate:_eidoipc`, 0750. The data-plane socket is 0660 and the control socket 0600 (ADR 0003), so only the gate's data-plane socket is open to `_eidodata`.                                                                                                                                                                                                                                                      |
| Gate keychain                           | `/Library/Application Support/Eido/home/gate/Library/Keychains/eido/eido.keychain-db`                                                                                                                                                                                                                                                                                                                                                                        |
| App copy                                | `/Library/Application Support/Eido/app`, `root:wheel`, not writable by either user. The copy leaves out `infra/secrets`, `.env*` files (except `.env.example`), `eval-local` and `*.db` files. The gate launcher `gate-launcher.zsh` is left out of the copy, so `--delete` never removes it; it is rewritten after the copy (any file or link at that path removed first), `root:wheel` 0555.                                                               |
| Sandbox profiles                        | `/Library/Application Support/Eido/policy/core.sb` (core) and `parser.sb` (the broker and its parse children: no network but binding `parser.sock`)                                                                                                                                                                                                                                                                                                          |
| pf anchor                               | `com.apple/eido.plane`, from `/Library/Application Support/Eido/policy/eido-plane.pf`: the `_eidodata` rules, then a block of every TCP and UDP packet for the `_eidoparse` uid. `/etc/pf.conf` is not edited.                                                                                                                                                                                                                                               |
| Gate egress anchor                      | `com.apple/eido.egress`, from `/Library/Application Support/Eido/policy/eido-egress.pf`, with the host list `eido-egress.hosts`. See `infra/llama-server.md`, "Outbound allowlist".                                                                                                                                                                                                                                                                          |
| Daemons                                 | `com.eido.plane.pf` (root, reloads the anchor every 5 minutes), `com.eido.plane.egress` (root, adds the hosts' addresses to the egress table every 5 minutes), `com.eido.plane.gate` (root, runs only the gate launcher, which drops to `_eidogate` before it starts the gate), `com.eido.plane.parser` (`_eidoparse`, under `sandbox-exec -f parser.sb`, with the no-network preload), `com.eido.plane.core` (`_eidodata`, under `sandbox-exec -f core.sb`) |
| Logs                                    | `/Library/Logs/Eido/{gate,data,parser,pf}` (the egress job logs to `pf/egress.err.log`). `gate` is `root:admin` 0750: launchd opens the gate's logs as root, and the gate writes them only through the descriptors launchd hands it. Apply removes anything there that is not a plain file with one link, and makes the log files `root:admin` 0640.                                                                                                         |
| Supervisor socket                       | ACL entries give `_eidogate` search on your home down to `run/supervisor/` in your stack dir, and read and write on `supervisor.sock` through an entry inherited only in that directory. The rest of `run/` stays closed to it. `_eidodata` gets none.                                                                                                                                                                                                       |

What core may reach: the gate's data-plane socket, the parser's socket, `127.0.0.1` on the gate's egress proxy port (`--egress-port`) and on the llama-server port (`EIDO_LLAMA_PORT`), and inbound connections on its own port. The sandbox denies all other network, DNS included, and denies reads of the gate's data dir and home. pf blocks every new outbound TCP connection and all UDP from `_eidodata`, except to those two loopback ports.

What the parser may reach: nothing. `parser.sb` denies all network, DNS included, and allows only binding and accepting on `parser.sock`. pf blocks every TCP and UDP packet of `_eidoparse`, loopback included, so a parse child cannot reach the egress proxy or llama-server either. The broker starts with `--import ./src/parsers/no-network.ts`, as its test does.

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

If the uids or gids are taken, the plan stops and names the account that holds them. Pass a free `--first-id` (401 to 496).

Create the gate keychain once, as the gate user, with a passphrase you keep in your password manager:

```sh
sudo -u _eidogate security create-keychain -P \
  "/Library/Application Support/Eido/home/gate/Library/Keychains/eido/eido.keychain-db"
```

## Gate keychain unlock at start

The gate daemon is a root job (#823, decided in #780). launchd runs `/bin/zsh -f "/Library/Application Support/Eido/app/gate-launcher.zsh"`, a fixed script the plan generates. It is owned by root, mode 0555, in the root-owned app copy, so the gate user cannot change it. It:

1. Sets `ulimit -c 0` and `EIDO_GATE_KEYCHAIN_UNLOCK=stdin`.
2. Reads the generic password with service `com.eido.gate.keychain-unlock` from `/Library/Keychains/System.keychain` with `security find-generic-password -w`, run as root with only `HOME=/var/root` in its environment.
3. Pipes it straight into the gate's stdin. The passphrase is never in a shell variable, an argument, the environment, a file or a log.
4. Drops to `_eidogate` with `chroot -u _eidogate -g _eidogate -G _eidogate,_eidoipc /`, which sets exactly those groups, and execs the gate in the same process. The gate keeps the job's environment and working directory.

Because launchd runs the job as root, it opens `gate.out.log` and `gate.err.log` as root. Their directory is root's and not writable by `_eidogate`, so the gate cannot replace a log with a link to a file root would then append to. `zsh -f` still reads `/etc/zshenv`; that file is root-owned system state, outside anything the gate can write.

If the item is missing or root cannot read it, the launcher writes `eido gate launcher: the System keychain item com.eido.gate.keychain-unlock is missing or unreadable; starting the gate with no passphrase, so it stays locked` to `gate.err.log` and starts the gate with empty stdin. The gate then refuses the empty passphrase and reports itself locked (#822).

The item holds the passphrase you gave `create-keychain` above. Setting and rotating it is #824. Store it as plain text: `security find-generic-password -w` prints data that is not printable as hex, and the gate would get the hex.

Live check (owner, after the item is set; e2e in #811): reboot, do not log in, then check that `gate.err.log` has no launcher message and the gate reads a synthetic token.

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

## Back up

The owner's nightly backup cannot read the plane's data dirs. A root LaunchDaemon, `com.eido.plane.backup`, backs up both from the plane; set it up and restore from it as described under "Split host" in [backup-restore.md](backup-restore.md).

## Update

After pulling a new `main`, or after changing `stack.env`, the egress port or the llama port, run the plan again and apply it. The script is idempotent: it rewrites the users' attributes, the group members, the modes, the app copy, the profiles, the anchors, the host list and the plists, then restarts the five daemons. A connector manifest added or changed on `main` reaches the egress host list only through this step.

```sh
node --import ./infra/ts-hooks.ts infra/host/bin.ts plane plan --egress-port <port> > ~/eido-plane.sh
sudo sh ~/eido-plane.sh
```

Run it twice and diff `sudo pfctl -a com.apple/eido.plane -sr`, `sudo pfctl -a com.apple/eido.egress -sr`, `id _eidogate`, `id _eidoparse` and `ls -le` between the runs: they match.

## Remove

```sh
node --import ./infra/ts-hooks.ts infra/host/bin.ts plane remove > ~/eido-plane-remove.sh
less ~/eido-plane-remove.sh
sudo sh ~/eido-plane-remove.sh
```

This boots out and deletes the five daemons (core first, then the parser), flushes both anchors, removes the ACL entries, deletes the users and groups that exist, and removes the policy files, the app copy, the run dir and every parser path (home, scratch, socket dir and logs), so nothing of `_eidoparse` is left. It keeps the gate's and data plane's data, the gate keychain and the logs. The script ends by printing the `sudo rm -rf` command that deletes them, once you have backed them up. pf stays enabled; `sudo pfctl -d` disables it if nothing else uses it.

To go back to the single-user stack, remove the `EIDO_STACK_PLANE=split` line from `stack.env` and run `pnpm stack:install`.

## Open follow-ups

- #777: the isolation script's data-plane probes under `core.sb`.
- #811: the live checks for the parser user: the nested sandbox, pf `user` rules for a third uid on loopback, DNS under `parser.sb`, and no reach from a parse child to the proxy or llama-server.
- #822: the gate reports locked when it starts without a passphrase.
- #824: setting and rotating the `com.eido.gate.keychain-unlock` item.
- #781: Things, EventKit and file-root writes from the gate user.
- #783: the supervisor socket in a directory of its own.
