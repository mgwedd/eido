# Infra

Host setup for the Mac: the local stack and `tailscale serve` routes now; launchd, pf and llama-server later (#29, #70). Never commit secrets here; `infra/secrets` is denied to agents.

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

Eido is served on its own HTTPS port, 8443, at `https://<host>.ts.net:8443`: `/` to Next on `127.0.0.1:3000`, `/api/core` to core on `127.0.0.1:8787` (the stack passes `--core-port 8789`), `/api/gate` to the gate's phone listener on `127.0.0.1:8788`. Routes on other ports belong to other apps and are never read for problems or changed.

```bash
pnpm --filter @eido/infra serve-routes plan     # print the tailscale commands; changes nothing
pnpm --filter @eido/infra serve-routes check    # exactly the three routes on 8443, funnel off for it
pnpm --filter @eido/infra serve-routes apply    # add the three routes with --bg, then check
pnpm --filter @eido/infra serve-routes measure  # with the backends stopped: what path and Host each receives
```

Each command takes `--port`, `--web-port`, `--core-port` and `--gate-port` to override the defaults.
