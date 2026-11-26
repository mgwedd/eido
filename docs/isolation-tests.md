# Isolation tests (Wave 1)

Two Wave 1 invariants keep the planes apart: the data plane holds no credentials and has no network except the gate's proxy, its intent API and the llama-server port; and parsers have no network and no tokens. They are checked twice:

- **Portable tests** run in CI on every push (`pnpm turbo run test` and the repo checks). They use real processes, sockets and listeners, but one OS user.
- **The live-host script** (`scripts/check-isolation-live.ts`) runs by hand on the Mac, after the users, sandbox profiles and pf rules from #70 exist. It checks what only the OS can enforce.

A failing test in either blocks the phase gate.

## Portable tests

| Group                             | Test (file: name)                                                                                                                                                                                                                                                                                                                       | What it proves                                                                                                                                                                                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data-plane environment and config | `packages/core/src/planes/planes.test.ts`: `isolation: the data plane gets only its allowlisted variables and no control DB path`, `isolation: the long-lived data plane runs without the variables its parent held`, `isolation: the data-plane source has no handle to, or path for, the gate's control DB`                           | Started by `spawnPlanes` with a parent holding synthetic token variables and control DB paths, the data plane's environment has only its allowlist, no token-like name, and no path to `eido-control.db` or the control socket; no data-plane source names the control DB. |
| Data-plane listener               | `packages/gate/src/internal/api.test.ts`: `isolation: every write-ish or control route answers 404 and leaves the control database unchanged`                                                                                                                                                                                           | Approvals, audit reads, the audit chain, enrolment codes, passkeys, connector connect, file roots and every intent write answer 404 on the data-plane socket, and the control DB is byte-for-byte unchanged.                                                               |
| Parser child                      | `packages/core/src/parsers/parse-document.test.ts`: `isolation: the parse child cannot open a network connection or resolve a name`, `isolation: the parse child starts with no credential, proxy or token variable, even when the parent has them`; `packages/core/src/parsers/no-network.test.ts`: `isolation: the preload blocks %s` | A hostile parser's `fetch`, `net.connect`, `http.request` and DNS lookups all fail, and the test's own loopback listener sees zero connections; the child's environment is empty although the parent holds synthetic tokens and proxy variables.                           |
| Dependency boundary               | `//#check:deps` and `//#check:deps-fixture` (`.dependency-cruiser.mts`, `fixtures/boundary-violation`)                                                                                                                                                                                                                                  | Nothing outside the gate imports gate internals or the vault; the gate imports no data-plane code and no parser library. The fixture proves each rule fires.                                                                                                               |

`scripts/check-invariant-tests.ts` (`pnpm check:invariants`, run by CI and `pnpm verify`) fails when any of these named tests is renamed or removed.

Run them:

```sh
pnpm turbo run test --filter=@eido/core --filter=@eido/gate
pnpm turbo run //#check:deps-fixture //#check:invariants
```

The portable tests use the no-network preload in the parse child; that is defense in depth. The OS fence is what the live script checks.

## Live-host script

### Prerequisites

- The gate, data-plane and parser users, file ownership and modes, the data-plane and parser sandbox profiles and the pf rules from the #70 runbook, `infra/plane-split.md`, with the parser plane (#818) applied: the `_eidoparse` user, the installed `parser.sb` and the parser run dir. Its Verify section has this command with the paths it creates.
- The gate running, so its intent socket, control socket and proxy listen, llama-server running on its loopback port, and the parser daemon (`com.eido.plane.parser`) running, so its socket exists.
- `eido-data.db` present, since the data plane has created it.
- A gate keychain file the gate user can write while the check runs (see the Keychain question on #70).
- A checkout of this repo, and Node, readable by the gate, data-plane and parser users (the probes run `scripts/check-isolation-live.ts` and `packages/core/src` as each user, and the probe broker runs them as `_eidoparse`).
- An admin account with `sudo`. The script runs as root only to start its children with `sudo -u`; it never changes users, Keychain settings or pf rules.

### Run

```sh
sudo node scripts/check-isolation-live.ts \
  --gate-user <gate user> --data-user <data-plane user> \
  --intent-socket <gate intent socket path> --control-socket <gate control socket path> \
  --control-db <path to eido-control.db> --gate-keychain <gate keychain path> \
  --proxy-port <gate proxy port> --llama-port <llama-server port> \
  --parser-profile <installed parser.sb path> --parser-socket <parser daemon socket path> \
  --data-db <path to eido-data.db> --data-profile <core sandbox profile path> \
  --public-host <a public hostname> --public-ip <a public IPv4 address> \
  --stack-dir <your stack dir>
```

User names, paths, ports, the public hostname and the public IP come from the arguments; the script names none, apart from the parser user, which it takes from `infra/host/parser-plane.ts`. `--timeout-ms` (default 3000) bounds each connect.

`--data-profile` is the core sandbox profile (`core.sb`, written by the #70 runbook). Pass it on a split host: the data plane runs under that profile, and name resolution goes through mDNSResponder, a root daemon that per-user pf cannot block, so only the profile denies it. Without the flag the probes run as the data-plane user with no sandbox and `dns` reports `reached`. With it, every data-plane probe starts as `sudo -u <data user> /usr/bin/sandbox-exec -f <profile> node ...`, including the one that delivers a parse job to the probe broker. The gate-user controls never run under a profile.

`--parser-profile` is the parser sandbox profile as installed on the host (`parser.sb`, written by the parser plane, #818), read as text. `--parser-socket` is the production parser broker's socket, the path that profile allows (`<root>/parser-run/parser.sock`). `--data-db` is `eido-data.db`.

`--stack-dir` is the owner's stack dir, the one that holds `run/supervisor/supervisor.sock` (`$EIDO_STACK_DIR`, by default `~/Library/Application Support/eido-dev`; give the path in full, since `sudo` does not carry your `HOME`). Pass it on a split host: it turns on the two supervisor probes below. Without it the script prints `SKIP supervisor-socket: no --stack-dir given` and `SKIP run-dir-files: no --stack-dir given`, which do not fail the run but leave that fence unchecked. The supervisor must be running, so its socket exists.

### What each probe proves

Each probe in this table runs as the data-plane user, under the core sandbox profile when `--data-profile` is given. Every probe marked blocked runs again as the gate user with `--as-gate` (the `.control` line): it must succeed there, so a blocked result cannot come from a broken probe, a wrong path or a stopped service.

| Probe             | As the data-plane user                                                                                                                                                             | Control as the gate user            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `dns`             | Resolving `--public-host` through the system resolver fails.                                                                                                                       | Resolves.                           |
| `tcp-public`      | A TCP connect to `--public-ip` port 443 fails.                                                                                                                                     | Connects.                           |
| `loopback-canary` | A TCP connect to a canary port the gate user opened on 127.0.0.1 fails, and the canary listener sees no connection.                                                                | Connects, and the listener sees it. |
| `intent-socket`   | Connecting to the gate's intent API socket succeeds (allowed).                                                                                                                     | (none: allowed)                     |
| `proxy`           | Connecting to the gate's proxy port on 127.0.0.1 succeeds (allowed).                                                                                                               | (none: allowed)                     |
| `llama`           | Connecting to the llama-server port on 127.0.0.1 succeeds (allowed).                                                                                                               | (none: allowed)                     |
| `keychain`        | Reading a canary generic password in the gate keychain fails.                                                                                                                      | Reads it, and its digest matches.   |
| `keychain-add`    | Adding a new generic password, under a service name no item has, to the gate keychain fails (#724).                                                                                | Adds it.                            |
| `keychain-modify` | Overwriting (`add-generic-password -U`) a second canary item, created by the gate user in the gate keychain, fails (#724).                                                         | Overwrites it.                      |
| `control-db`      | Reading a canary file created next to `eido-control.db` with the real file's mode, owned by the gate user, fails with permission denied (`EACCES` or `EPERM`).                     | Reads it, and its digest matches.   |
| `control-socket`  | Connecting to the gate's control socket fails with permission denied.                                                                                                              | Connects.                           |
| `data-db`         | Opening `--data-db` for reading succeeds (allowed): the data plane has its own database, and this is the witness for `parser-data-db`.                                             | (none: allowed)                     |
| `parser-socket`   | Connecting to the parser daemon's socket (`--parser-socket`) succeeds (allowed): the data user can deliver documents, and nobody else can (socket mode 0660, group the data user). | (none: allowed)                     |

#### Parser probes through the broker (#820)

The parse child is probed the way production starts it, not by wrapping a child in `parser.sb` by hand. `parser.sb` is the broker's sandbox: the LaunchDaemon `com.eido.plane.parser` runs the broker (`packages/core/src/parsers/broker-main.ts`, #817) as `_eidoparse` under it, and the broker starts each parse child inside that sandbox. pf drops all TCP and UDP for the `_eidoparse` uid. The probe goes through the same chain:

1. The script starts a probe broker: `sudo -n -u _eidoparse -- /usr/bin/sandbox-exec -p <installed parser.sb> node ... scripts/isolation-parser-broker.ts`. It is the production broker (`startBroker`) loaded with the same core hooks and no-network preload as the daemon. It differs from the daemon in two things only: its socket is a probe socket (`probe-<random>.sock`, in the production socket's directory, so the same owner, group and modes apply; the profile text has the daemon's socket path swapped for it) and its parse child is `scripts/isolation-parser-child.ts`, which tries a target instead of parsing a document. The daemon itself never runs an attack.
2. As the data-plane user, the script sends one probe parse job per target over that socket with core's `createBrokerClient`, as core delivers a document. The document names one target.
3. The broker starts its parse child. The child starts a grandchild without the no-network preload, which models native code or an OCR engine that the preload cannot stop, so the result is the OS fence's alone. The grandchild tries the target (a TCP connect, a unix socket connect or opening a file) and reports reached or the errno name.
4. The report returns as the text of the ordinary parse result. The script classifies it: a parse that failed or a malformed report is `the probe did not run`, a connect or open that succeeded is `reached` (the probe fails), a refusal is blocked with its errno name.

| Probe                  | The parse child must not                                                                          | Witness (must reach it first)                      |
| ---------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `parser-loopback`      | connect to the canary port the gate user opened on 127.0.0.1; the listener must see no connection | `loopback-canary.control` (the gate user connects) |
| `parser-proxy`         | connect to the gate's egress proxy on 127.0.0.1                                                   | `proxy` (the data-plane user connects)             |
| `parser-llama`         | connect to the llama-server port on 127.0.0.1                                                     | `llama` (the data-plane user connects)             |
| `parser-intent-socket` | connect to the gate's intent socket; the refusal must be permission denied (`EACCES` or `EPERM`)  | `intent-socket` (the data-plane user connects)     |
| `parser-data-db`       | open `eido-data.db` for reading, without reading it; the refusal must be permission denied        | `data-db` (the data-plane user opens it)           |

A refused connect proves nothing when the target is down, so each probe has a witness: an unfenced user reaches the same target in the same run. A broker probe has no gate-user control of its own; when its witness did not reach the target it fails with `so the probe proves nothing`, which points at the dead target and not at the fence. The probes that need a permission refusal also fail on `ENOENT` or a timeout, so a wrong path cannot pass.

What a pass means: with the production sandbox, user and pf rules, a parse child that tries to reach the egress proxy, the llama port, the gate's intent socket or the data DB is refused, and the probe job still came back over the broker socket, so the delivery path works. The acceptance check for the parser plane (#778) is this: the parse child cannot reach the proxy or the llama port. A pass says nothing about the parser's output or its libraries.

#### Keychain write probes

`keychain` shows the data-plane user cannot read the gate keychain; `keychain-add` and `keychain-modify` show it cannot write to it either, which is what the checkpoint (`eido.control-checkpoint.v1`, ADR 0005) needs: a process that can write the control DB and WAL must not be able to update the item that anchors them. Each runs `security add-generic-password` against `--gate-keychain` with a random value that is never printed. `keychain-add` has no `-U`, so it can only create; `keychain-modify` has `-U` and targets the canary item, so it can only overwrite. Both name only service names this script generated (`eido-isolation-canary-<random>-add` and `-modify`): a probe refuses any other name before it runs `security`, so no real item is ever touched. A data-plane result of blocked is `security` exiting non-zero, whatever the code; the `.control` lines, where the gate user adds and overwrites, show the keychain path, the unlock state and the probe are sound. The gate keychain must be unlocked and writable by the gate user while the check runs, or the controls fail.

#### Supervisor socket probes (`--stack-dir`)

These two probe the gate user, not the data-plane user: the plane split (#70) gives the gate user an ACL path to the owner's supervisor socket and to nothing else in the stack's run dir (#783). Each runs once, as the gate user with `--as-gate`, never under a sandbox profile, and prints its name with no `.control` line. Both are judged as the gate user's: `supervisor-socket` fails when it cannot connect, `run-dir-files` fails when it can read.

| Probe               | As the gate user                                                                                                                                                                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supervisor-socket` | Connecting to `<stack dir>/run/supervisor/supervisor.sock` succeeds (allowed).                                                                                                                                                                                                                                  |
| `run-dir-files`     | Opening for reading every regular file below `<stack dir>/run`, outside `supervisor/`, fails with permission denied (`EACCES` or `EPERM`). The files are listed by the root process, since the gate user cannot list the directory, and include a canary file the run creates there (see Canaries and secrets). |

`run-dir-files` reports the first refusal that is not permission denied, such as `ENOENT`, and fails on it, so a wrong path cannot pass for a denial. It has no `.control` line: the root process creates the canary and the gate user is expected to be refused, so a broken probe shows as a non-permission code, not as a pass. Sockets and links in the run dir are not opened, since opening a socket fails whatever its permissions.

Under `--data-profile`, `control-db` and `control-socket` pass when either the file or socket permissions or the profile deny the access, since the profile denies the gate's directories and every non-allowed socket. Step 6 of the #70 runbook checks the permissions on their own, as `_eidodata` without a profile.

The broker probes attempt the target from a grandchild that leaves out the in-process no-network preload on purpose, so the result is the OS fence's alone. Parser tokens are covered by the `keychain` and `control-db` probes and by `parser-data-db` and `parser-intent-socket`: the parser runs as `_eidoparse`, not as the data-plane user or the gate user, and its environment is empty (portable test).

### Canaries and secrets

A child running as the gate user creates the canaries and holds them for the run: the loopback listener, a generic password with a random service name and a random value in the gate keychain, a second generic password, `eido-isolation-canary-<random>-modify`, for `keychain-modify` to try to overwrite, and a file of random bytes named `.eido-isolation-canary-<random>.db` next to `eido-control.db`. The service `eido-isolation-canary-<random>-add` is created by no one: `keychain-add` tries to create it, and the gate control does. Only SHA-256 digests leave that child; probes compare digests and never print a value. The output carries probe names and error codes only.

With `--stack-dir`, the root process also creates `.eido-isolation-canary-<random>` in `<stack dir>/run`, mode 0600 and owned like the run dir, holding random bytes. It stands for a file the stack writes there after the ACLs were applied, so the gate user must not inherit access to it. The canary is removed when the run ends, when it fails and on Ctrl-C; a canary that cannot be removed prints `FAIL cleanup`, and you remove the file by hand.

The canaries are removed when the run ends, when it fails, and on Ctrl-C (the child cleans up when its stdin closes or on SIGINT, SIGTERM or SIGHUP). If a canary cannot be removed, the run prints `FAIL cleanup` and exits 1; remove it by hand with `security delete-generic-password -s <service> <keychain>` for each of the three services (`<service>`, `<service>-modify`, `<service>-add`; the last exists after a run, since the gate control created it) and `rm` of the canary file. The cleanup treats an `-add` item that is not there as removed (`security` exit 44). The canary value is passed to `security` on its command line, so another local user could see it in the process list for that moment; it is random and grants nothing.

### Refusals

- The run refuses to start without root, and refuses to run as the gate user.
- The supervisor probes run as the gate user, so they go through the same refusal: a probe child as the gate user needs `--as-gate`, and `--as-gate` runs as the gate user only.
- A probe refuses to run as the gate user without `--as-gate`, refuses `--as-gate` from any other user, and refuses any user but the data-plane user otherwise. A probe run by the wrong user by mistake cannot pass for a data-plane result.

### Expected output

One line per probe, then a line per control; the exit code is 0 only if every line is `PASS`:

```
PASS dns (ENOTFOUND)
PASS dns.control
PASS tcp-public (ETIMEDOUT)
PASS tcp-public.control
PASS loopback-canary (ECONNREFUSED)
PASS loopback-canary.control
PASS intent-socket
PASS proxy
PASS llama
PASS keychain (SECURITY_EXIT_51)
PASS keychain.control
PASS keychain-add (SECURITY_EXIT_1)
PASS keychain-add.control
PASS keychain-modify (SECURITY_EXIT_1)
PASS keychain-modify.control
PASS control-db (EACCES)
PASS control-db.control
PASS control-socket (EACCES)
PASS control-socket.control
PASS data-db
PASS parser-socket
PASS parser-loopback (EPERM)
PASS parser-proxy (EPERM)
PASS parser-llama (EPERM)
PASS parser-intent-socket (EACCES)
PASS parser-data-db (EACCES)
PASS supervisor-socket
PASS run-dir-files (EACCES)
```

The codes in brackets depend on how the OS refuses (a pf drop times out, a sandbox denial is `EPERM`, a refused connect is `ECONNREFUSED`); any refusal passes (the `keychain` probes report whatever `security` exited with) except for `control-db`, `control-socket`, `run-dir-files`, `parser-intent-socket` and `parser-data-db`, which must be permission denied. The `parser-*` broker probes have no `.control` line; their witnesses are the probes above them.

### When a probe fails

| Line                                                                                                         | Meaning and what to do                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FAIL <probe>: reached as the data-plane user`                                                               | The fence is open. Check the pf rule and sandbox profile for that path in the #70 runbook, fix them, and rerun. Do not ship parsing or connectors until it passes.                                                                                                                                                                                                                                   |
| `FAIL <probe>: the canary listener saw N connection(s)`                                                      | A connection got through even though the probe reported failure. Treat it as an open fence.                                                                                                                                                                                                                                                                                                          |
| `FAIL <probe>: refused with <code>, not permission denied`                                                   | The path is wrong or the file or socket is missing, so ownership was not tested. Check the argument and that the gate is running.                                                                                                                                                                                                                                                                    |
| `FAIL <probe>: the data-plane user cannot reach an allowed endpoint`                                         | The data plane cannot talk to the gate, its proxy or llama-server. Check the service is running and the allow rule for that endpoint.                                                                                                                                                                                                                                                                |
| `FAIL <probe>.control: the gate user could not do it either`                                                 | The probe is broken, the target is down, or the gate user lacks access. Fix that first: the matching blocked result proves nothing until its control passes.                                                                                                                                                                                                                                         |
| `FAIL <probe>: the probe did not run`                                                                        | The child could not start or print a result: check both users can read the checkout and Node, and that `sudo -u` works non-interactively as root. For a `parser-*` probe the code names why: `PARSE_<reason>` (the broker refused or failed the job: check the checkout is readable by `_eidoparse`), `NO_ANSWER`, `NO_REPORT` or `BAD_REPORT` (the parse child ended without a well-formed report). |
| `FAIL <parser probe>: reached from the parse child`                                                          | The parse child got through to the proxy, the llama port, the intent socket, the canary or the data DB. The fence around `_eidoparse` is open: check the pf rules for its uid and `parser.sb` in the #70 runbook and rerun. Do not ship parsing until it passes.                                                                                                                                     |
| `FAIL <parser probe>: <witness> did not reach the target ... so the probe proves nothing`                    | The target is down or unreachable even for an unfenced user, so a refusal says nothing about the fence. Start the proxy, llama-server or the gate, or fix `--data-db`, and rerun.                                                                                                                                                                                                                    |
| `FAIL parser-broker: the probe broker did not start (<code>)`                                                | The `parser-*` probes print `SKIP` after this line. Check `--parser-profile` is the installed `parser.sb` and names `--parser-socket` exactly once, that its run dir exists, that `sudo -n -u _eidoparse` works, and that `_eidoparse` can read the checkout and Node.                                                                                                                               |
| `FAIL supervisor-socket: the gate user cannot reach it (<code>)`                                             | The supervisor is not running (`ENOENT`, `ECONNREFUSED`), or the gate user's ACL path to it is missing (`EACCES`). Start it, then check step 3 of the #70 runbook.                                                                                                                                                                                                                                   |
| `FAIL run-dir-files: reached as the gate user`                                                               | The gate user can read a file in the run dir: an ACL entry on the run dir is inherited by the files in it. Remove it and rerun; step 3 of the #70 runbook shows the entries.                                                                                                                                                                                                                         |
| `FAIL run-dir-files: refused with <code>, not permission denied`                                             | A listed file is gone or the path is wrong, so permission was not tested for it. Rerun; if it repeats, check `--stack-dir` points at the stack dir the supervisor uses.                                                                                                                                                                                                                              |
| `FAIL run-dir-files: the run dir could not be read or given a canary`                                        | The root process could not list `<stack dir>/run` or create the canary there: check `--stack-dir`.                                                                                                                                                                                                                                                                                                   |
| `FAIL keychain-add: reached as the data-plane user` / `FAIL keychain-modify: reached as the data-plane user` | The data-plane user wrote to the gate keychain: its file is readable and writable by that user, or the keychain is shared with it. Fix the file's owner and mode (#70 runbook) and rerun. The canary items are removed by the run's cleanup.                                                                                                                                                         |
| `FAIL keychain-add.control: the gate user could not do it either` / `FAIL keychain-modify.control: ...`      | The gate user could not write to the gate keychain: check `--gate-keychain`, that it is unlocked and writable by the gate user, and that the canary item exists. The blocked result above proves nothing until this passes.                                                                                                                                                                          |
| `FAIL setup` / `FAIL cleanup`                                                                                | The canaries could not be created or removed. For Keychain codes, check the gate keychain is unlocked and writable by the gate user. After a cleanup failure, remove the canaries by hand.                                                                                                                                                                                                           |

### Recording a run

The Mac-host checklist is #811 (end-to-end checks that need `sudo` on the owner's Mac). Paste the output of one passing run into a dated comment there, with the macOS version (`sw_vers -productVersion`), and record the result in the runbook file named in the checklist item. Paste only the probe lines: no hostnames, paths, user names or IP addresses. The `keychain-add`, `keychain-add.control`, `keychain-modify` and `keychain-modify.control` lines are the evidence for the checkpoint isolation item (#724); `infra/control-checkpoint.md` keeps its "Not verified here" note until that run is recorded.
