# Infra

Host setup for the Mac: the local stack and `tailscale serve` routes now; Proton Bridge supervision now; pf and llama-server later (#29, #70). Never commit secrets here; `infra/secrets` is denied to agents.

## Local stack (#374)

One command starts the gate, core and web, with the serve routes, so `https://<host>.ts.net:8443/` works:

```bash
pnpm stack:dev      # gate and core under node --watch, web under next dev; output prefixed by name
pnpm stack:prod     # turbo run build, then gate, core and next start; no watchers
pnpm stack:stop     # stops what either mode started, then confirms no listener is left on the ports
pnpm stack:status   # each process, who listens on its port, its health check, and the serve routes
```

Start checks first that ports 3000, 8789 and 8788 are free, and names the pid holding any that is not. It then applies the serve routes on :8443 (routes on other ports are left alone), and starts gate, core and web in that order, each once the one before answers. In the foreground, Ctrl-C stops all three; `--background` returns once they answer, and `pnpm stack:stop` stops them. Stop leaves the serve routes in place.

`--no-serve` skips the serve routes: backends only, so the UI does not work from the tailnet origin.

The tailnet host is read from `tailscale status --json`. Data, sockets and pid files live under `~/Library/Application Support/eido-dev` (pid files in `run/`), and one log per process under `~/Library/Logs/eido-dev`. The typed config is `infra/stack/config.ts`; every value is overridable by env, with no secrets: `EIDO_TAILNET_HOST`, `EIDO_EDGE_PORT`, `EIDO_WEB_PORT`, `EIDO_CORE_PORT`, `EIDO_GATE_PHONE_PORT`, `EIDO_STACK_DIR`, `EIDO_STACK_LOG_DIR`, and the gate and core variables listed in `OVERRIDES`. The llama, Gmail and Bridge variables are passed through from your environment and never set by the stack.

The WebAuthn origin is `https://<host>:8443`. The gate accepts an origin with a port once #375 lands; until then set `EIDO_WEBAUTHN_ORIGIN=https://<host>` to start it.

## `tailscale serve` routes (ADR 0004)

Eido is served on its own HTTPS port, 8443, at `https://<host>.ts.net:8443`: `/` to Next on `127.0.0.1:3000`, `/api/core` to core on `127.0.0.1:8789` (core's default; 8787 belongs to another app on the host), `/api/gate` to the gate's phone listener on `127.0.0.1:8788`. Routes on other ports belong to other apps and are never read for problems or changed.

```bash
pnpm --filter @eido/infra serve-routes plan     # print the tailscale commands; changes nothing
pnpm --filter @eido/infra serve-routes check    # exactly the three routes on 8443, funnel off for it
pnpm --filter @eido/infra serve-routes apply    # add the three routes with --bg, then check
pnpm --filter @eido/infra serve-routes measure  # with the backends stopped: what path and Host each receives
```

Each command takes `--port`, `--web-port`, `--core-port` and `--gate-port` to override the defaults.

## Proton Bridge LaunchAgent (#68)

Eido reads and drafts Proton mail through Proton Bridge's local IMAP and SMTP. launchd keeps Bridge running in CLI mode with no window as the job `com.eido.proton-bridge` in the `gui/<uid>` domain: `KeepAlive` true, `ThrottleInterval` 10 s, `ProcessType` Standard, logs in `~/Library/Logs/eido/proton-bridge.{out,err}.log`. The plist holds no password, port or environment.

```bash
pnpm --filter @eido/infra bridge plan       # print the plist and the launchctl command; changes nothing
pnpm --filter @eido/infra bridge install    # write ~/Library/LaunchAgents/com.eido.proton-bridge.plist and bootstrap it
pnpm --filter @eido/infra bridge status     # state, pid, runs, last exit; exit 1 unless running
pnpm --filter @eido/infra bridge health     # read the IMAP and SMTP greetings; exit 1 on any failure
pnpm --filter @eido/infra bridge uninstall  # bootout, then remove the plist
```

`install` and `plan` take `--bridge PATH` when Bridge is not at `/Applications/Proton Mail Bridge.app/Contents/MacOS/bridge`. Bridge's own "start at login" setting writes a second LaunchAgent (`Proton Mail Bridge.plist`); turn it off in Bridge's settings, or two Bridges fight over the ports.

### First run

1. Install Bridge from Proton's official release. Run `bridge --help` and confirm `--cli` and `--noninteractive` exist in this version.
2. Log in once, interactively, before `install`: run `bridge --cli`, then `login` and follow the prompts, including two-factor. Run `info` to read the Bridge-generated IMAP and SMTP username and password, and the ports. Quit with `exit`. (Do not run this while the job is loaded: one Bridge at a time.)
3. Store the Bridge password in the vault (Keychain adapter #67, or the dev vault). It never goes in the plist, the repo, a script, a log or a command line.
4. `pnpm --filter @eido/infra bridge install`.
5. Set the gate's variables (no password among them): `EIDO_BRIDGE_HOST=127.0.0.1` (Bridge's fixed host), `EIDO_BRIDGE_IMAP_PORT` and `EIDO_BRIDGE_SMTP_PORT` from `info`, `EIDO_BRIDGE_USERNAME`, and the certificate pin from the next section. Core's `EIDO_PROTON_USERNAME` is the same address. Defaults are 1143 and 1025, but Bridge takes the next free port, so read them from `info` and never assume them.
6. Run `pnpm --filter @eido/infra bridge health` with the same variables exported. It reads the greeting on both ports without sending a credential. It expects STARTTLS (Bridge's default); with implicit TLS switched on it reports an unexpected greeting.

### Certificate pin

Bridge's certificate is self-signed. Export it from Bridge's settings ("Export TLS certificates") or with `cert export` in `bridge --cli`. Keep only the public certificate in a gate-owned file, never Bridge's exported private key. Compute the digest with `openssl x509 -in bridge-cert.pem -outform DER | shasum -a 256` and set `EIDO_BRIDGE_CERT_PATH` and `EIDO_BRIDGE_CERT_SHA256` (ADR 0003). Bridge regenerates the certificate when it is within 31 days of expiry and may after an upgrade: re-export, recompute and restart the gate each time. The gate refuses a certificate that does not match the pin.

### Upgrades

Record the Bridge version you tested (`bridge --version`) in the PR or runbook notes. Bridge's launcher auto-updates itself, which changes the tested version under you: record whether auto-update is left on. After an upgrade, `bridge status`, re-read the ports from `info`, re-export the certificate, then `bridge health`.

### Security notes

- Bridge listens on `127.0.0.1` only. Check with `lsof -nP -iTCP -sTCP:LISTEN | grep -i bridge`, and confirm from another tailnet device that the ports do not answer. Do not route them through `tailscale serve`.
- Bridge keeps the Proton refresh token and mailbox password in the owner's login keychain (entry `bridge-v3`). The data-plane user (#70) must not be able to read that keychain; check this once that user exists.

### Reboot

A LaunchAgent starts at login, not at boot. With FileVault on, after a power loss nothing in the user session, Bridge included, starts until someone logs in (see #29).

### Not verified by the tests

The tests cover plist generation, launchctl arguments, the health check and the command flow with an injected runner. A real install, `kill -9` recovery time, an hour with the screen asleep, the login steps, loopback and tailnet reachability and the keychain note are owner steps on the Mac.
