# Infra

Host setup for the Mac: `tailscale serve` routes now; launchd, pf and llama-server later (#29, #70). Never commit secrets here; `infra/secrets` is denied to agents.

## `tailscale serve` routes (ADR 0004)

Eido is served on its own HTTPS port, 8443, at `https://<host>.ts.net:8443`: `/` to Next on `127.0.0.1:3000`, `/api/core` to core on `127.0.0.1:8787`, `/api/gate` to the gate's phone listener on `127.0.0.1:8788`. Routes on other ports belong to other apps and are never read for problems or changed.

```bash
pnpm --filter @eido/infra serve-routes plan     # print the tailscale commands; changes nothing
pnpm --filter @eido/infra serve-routes check    # exactly the three routes on 8443, funnel off for it
pnpm --filter @eido/infra serve-routes apply    # add the three routes with --bg, then check
pnpm --filter @eido/infra serve-routes measure  # with the backends stopped: what path and Host each receives
```

Each command takes `--port`, `--web-port`, `--core-port` and `--gate-port` to override the defaults.
