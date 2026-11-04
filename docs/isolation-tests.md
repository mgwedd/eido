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

- The gate and data-plane users, file ownership and modes, the data-plane and parser sandbox profiles and the pf rules from the #70 runbook in `infra/`.
- The gate running, so its intent socket, control socket and proxy listen, and llama-server running on its loopback port.
- A gate keychain file the gate user can write while the check runs (see the Keychain question on #70).
- A checkout of this repo, and Node, readable by both users (the probes run `scripts/check-isolation-live.ts` and `packages/core/src` as each user).
- An admin account with `sudo`. The script runs as root only to start its children with `sudo -u`; it never changes users, Keychain settings or pf rules.

### Run

```sh
sudo node scripts/check-isolation-live.ts \
  --gate-user <gate user> --data-user <data-plane user> \
  --intent-socket <gate intent socket path> --control-socket <gate control socket path> \
  --control-db <path to eido-control.db> --gate-keychain <gate keychain path> \
  --proxy-port <gate proxy port> --llama-port <llama-server port> \
  --parser-profile <parser sandbox profile path> \
  --public-host <a public hostname> --public-ip <a public IPv4 address>
```

User names, paths, ports, the public hostname and the public IP come from the arguments; the script names none. `--timeout-ms` (default 3000) bounds each connect.

### What each probe proves

Each probe runs as the data-plane user. Every probe marked blocked runs again as the gate user with `--as-gate` (the `.control` line): it must succeed there, so a blocked result cannot come from a broken probe, a wrong path or a stopped service.

| Probe             | As the data-plane user                                                                                                                                                                                         | Control as the gate user                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `dns`             | Resolving `--public-host` through the system resolver fails.                                                                                                                                                   | Resolves.                                  |
| `tcp-public`      | A TCP connect to `--public-ip` port 443 fails.                                                                                                                                                                 | Connects.                                  |
| `loopback-canary` | A TCP connect to a canary port the gate user opened on 127.0.0.1 fails, and the canary listener sees no connection.                                                                                            | Connects, and the listener sees it.        |
| `intent-socket`   | Connecting to the gate's intent API socket succeeds (allowed).                                                                                                                                                 | (none: allowed)                            |
| `proxy`           | Connecting to the gate's proxy port on 127.0.0.1 succeeds (allowed).                                                                                                                                           | (none: allowed)                            |
| `llama`           | Connecting to the llama-server port on 127.0.0.1 succeeds (allowed).                                                                                                                                           | (none: allowed)                            |
| `keychain`        | Reading a canary generic password in the gate keychain fails.                                                                                                                                                  | Reads it, and its digest matches.          |
| `control-db`      | Reading a canary file created next to `eido-control.db` with the real file's mode, owned by the gate user, fails with permission denied (`EACCES` or `EPERM`).                                                 | Reads it, and its digest matches.          |
| `control-socket`  | Connecting to the gate's control socket fails with permission denied.                                                                                                                                          | Connects.                                  |
| `parser`          | The #43 hostile network fixture (`packages/core/src/parsers/hostile/network.test-support.ts`), run under `sandbox-exec -f <parser profile>`, cannot connect to the canary port, and the listener sees nothing. | Without the sandbox, the fixture connects. |

The parser probe leaves out the in-process no-network preload on purpose, so the result is the OS fence's alone. Parser tokens are covered by the `keychain` and `control-db` probes: the parser runs as the data-plane user and its environment is empty (portable test).

### Canaries and secrets

A child running as the gate user creates the canaries and holds them for the run: the loopback listener, a generic password with a random service name and a random value in the gate keychain, and a file of random bytes named `.eido-isolation-canary-<random>.db` next to `eido-control.db`. Only SHA-256 digests leave that child; probes compare digests and never print a value. The output carries probe names and error codes only.

The canaries are removed when the run ends, when it fails, and on Ctrl-C (the child cleans up when its stdin closes or on SIGINT, SIGTERM or SIGHUP). If a canary cannot be removed, the run prints `FAIL cleanup` and exits 1; remove it by hand with `security delete-generic-password -s <service> <keychain>` and `rm` of the canary file. The canary value is passed to `security` on its command line, so another local user could see it in the process list for that moment; it is random and grants nothing.

### Refusals

- The run refuses to start without root, and refuses to run as the gate user.
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
PASS control-db (EACCES)
PASS control-db.control
PASS control-socket (EACCES)
PASS control-socket.control
PASS parser (BLOCKED)
PASS parser.control
```

The codes in brackets depend on how the OS refuses (a pf drop times out, a sandbox denial is `EPERM`, a refused connect is `ECONNREFUSED`); any refusal passes except for `control-db` and `control-socket`, which must be permission denied.

### When a probe fails

| Line                                                                 | Meaning and what to do                                                                                                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FAIL <probe>: reached as the data-plane user`                       | The fence is open. Check the pf rule and sandbox profile for that path in the #70 runbook, fix them, and rerun. Do not ship parsing or connectors until it passes.                         |
| `FAIL <probe>: the canary listener saw N connection(s)`              | A connection got through even though the probe reported failure. Treat it as an open fence.                                                                                                |
| `FAIL <probe>: refused with <code>, not permission denied`           | The path is wrong or the file or socket is missing, so ownership was not tested. Check the argument and that the gate is running.                                                          |
| `FAIL <probe>: the data-plane user cannot reach an allowed endpoint` | The data plane cannot talk to the gate, its proxy or llama-server. Check the service is running and the allow rule for that endpoint.                                                      |
| `FAIL <probe>.control: the gate user could not do it either`         | The probe is broken, the target is down, or the gate user lacks access. Fix that first: the matching blocked result proves nothing until its control passes.                               |
| `FAIL <probe>: the probe did not run`                                | The child could not start or print a result: check both users can read the checkout and Node, and that `sudo -u` works non-interactively as root.                                          |
| `FAIL setup` / `FAIL cleanup`                                        | The canaries could not be created or removed. For Keychain codes, check the gate keychain is unlocked and writable by the gate user. After a cleanup failure, remove the canaries by hand. |

### Recording a run

Paste the output of one passing run into the PR that lands the #70 enforcement and into a comment on #70, with the date and macOS version (`sw_vers -productVersion`). Paste only the probe lines: no hostnames, paths, user names or IP addresses.
