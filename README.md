# Eido

<img width="1035" height="727" alt="Screenshot 2026-10-18 at 5 06 48 PM" src="https://github.com/user-attachments/assets/b81ae418-718e-4daf-9dcd-e2e5d457fc2a" />

A private, local-first executive assistant for your Mac. It reads your mail, calendar and files, proposes actions, and does nothing external until you approve it with a passkey.

- **Local inference.** The model runs on your machine. Nothing is sent to a hosted model.
- **One door for writes.** Only the gate (`packages/gate`) holds credentials and executes external writes, and every write needs a signed approval.
- **Reachable from your devices.** The web app runs on the Mac behind Tailscale, with no public surface.

> Status: early build. The web app is a bootstrap page; features are tracked as GitHub issues (start with the MVP epic, #5). Host hardening (vault, service supervision, sandboxing) is built Mac-first.

## How approvals work

Eido proposes an action as an intent. Low-risk, reversible actions run automatically and can be undone. Anything else waits in the approval queue until you sign it with a passkey, and only then does the gate execute it. Every step is recorded in an append-only audit log.

## Quickstart

Requires Node 24 (`.node-version`) and pnpm 10 (pinned by `packageManager`; run `corepack enable`).

```bash
pnpm install --frozen-lockfile
pnpm --filter @eido/web dev      # web app at http://localhost:3000
pnpm turbo run typecheck lint test
pnpm verify                      # everything CI runs: tests plus boundary, allowlist, secret, exact-version and format checks
```

## Run it on your Mac

The steps below set up the whole stack on the Mac that will host Eido. Run them yourself in a terminal at the repo root, on an up-to-date `main`. Secrets are typed at prompts only: never put one on a command line, in a file or in a log. Details and the optional steps (backup, other accounts) are in [infra/README.md](infra/README.md) and [infra/connectors.md](infra/connectors.md).

### Before you start

- A Mac with FileVault on, Tailscale signed in with MagicDNS and HTTPS certificates enabled for the tailnet, and the Xcode command line tools (`xcode-select -p`).
- Node 24 and pnpm 10, as in the quickstart.
- A new password for the gate keychain, saved in your password manager. Step 3 asks for it.
- The phone that will hold your passkey, on the same tailnet.
- 12 to 22 GB of free disk for the model, depending on the profile you pick.

### Core stack

1. Check the prerequisites and fix anything it names:

   ```bash
   node infra/prereq/bin.ts
   ```

2. Check the host baseline (read only). Expect `ok:` lines for FileVault and Tailscale. A MagicDNS failure is fixed with `tailscale set --accept-dns=true`.

   ```bash
   pnpm --filter @eido/infra host check
   ```

3. Bootstrap. This installs dependencies, builds llama.cpp, creates the gate keychain, writes `stack.env`, starts the stack, installs the `com.eido.stack` LaunchAgent and prints a single-use passkey enrolment code.

   ```bash
   pnpm stack:bootstrap
   ```

   It asks for the gate keychain password, a contact address for web push (`EIDO_PUSH_VAPID_SUBJECT`, a `mailto:` value) and the Gmail client IDs (press Enter to skip them). The enrolment code expires after 10 minutes.

4. Confirm web (3000), core (8789), the gate (8788) and the supervisor are running:

   ```bash
   pnpm stack:status
   ```

5. Run the doctor and fix what it reports. If `apps/web/.env.local` sets any `AUTH0_*` key, it requires all six of `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_SECRET`, `APP_BASE_URL` (`https://<host>.ts.net:8443`) and `EIDO_OWNER_EMAIL`.

   ```bash
   pnpm stack:doctor
   ```

6. Check the `tailscale serve` routes. Expect the routes on :8443 to match and Funnel to be off.

   ```bash
   pnpm --filter @eido/infra serve-routes check
   ```

7. Enrol your passkey: on the phone, open the printed `https://<host>.ts.net:8443/enroll` and type the code. `pnpm stack:gate enrol-code` issues a new code if it expired, and `pnpm stack:gate passkeys` lists what is enrolled.

The stack now runs and starts at login. Download the model from the Admin page.

### Proton Mail and Calendar

1. Install Proton Mail Bridge in `/Applications` and turn its own "start at login" setting off.
2. Log in once in Bridge's CLI. At its prompt run `login`, then `info` (note the username, ports and Bridge password it prints), then `exit`.

   ```bash
   "/Applications/Proton Mail Bridge.app/Contents/MacOS/bridge" --cli
   ```

3. In Admin, review and pin `proton-mail` and `proton-calendar`, signing with your passkey.
4. Install the Bridge LaunchAgent:

   ```bash
   pnpm --filter @eido/infra bridge plan
   pnpm --filter @eido/infra bridge install
   ```

5. Store the Bridge password in the gate vault. Each command asks for it at a prompt.

   ```bash
   pnpm stack:gate connect proton-mail
   pnpm stack:gate connect proton-calendar
   ```

6. Add the settings to `~/Library/Application Support/eido-dev/stack.env` (no password among them), then restart with `pnpm stack:stop` and `pnpm stack:prod`:

   ```
   EIDO_BRIDGE_HOST=127.0.0.1
   EIDO_BRIDGE_IMAP_PORT=<from info>
   EIDO_BRIDGE_SMTP_PORT=<from info>
   EIDO_BRIDGE_USERNAME=<from info>
   EIDO_PROTON_USERNAME=<the same address>
   ```

7. Pin Bridge's certificate. Export the public certificate from Bridge's settings to `bridge-cert.pem`, compute its digest, add `EIDO_BRIDGE_CERT_PATH` (an absolute path) and `EIDO_BRIDGE_CERT_SHA256` to `stack.env`, and restart again.

   ```bash
   openssl x509 -in bridge-cert.pem -outform DER | shasum -a 256
   ```

8. Check. Bridge must listen on 127.0.0.1 only.

   ```bash
   pnpm --filter @eido/infra bridge health
   pnpm --filter @eido/infra bridge status
   lsof -nP -iTCP -sTCP:LISTEN | grep -i bridge
   ```

### Undo

`pnpm stack:stop` then `pnpm stack:uninstall` stops the stack and removes its LaunchAgent; neither removes the serve routes or the keychain. `pnpm --filter @eido/infra bridge uninstall` removes the Bridge agent.

## Layout

```
packages/schemas       JSON Schema source of truth for intents and extractions
packages/gate          tokens, policy, executor, audit (strict dependency allowlist)
packages/core          connectors, sync, index, context assembly, inference queue
packages/ui            shadcn/ui components (presentational)
packages/eslint-config shared ESLint config
packages/typescript-config shared tsconfig bases
apps/web               Next.js + shadcn/ui PWA, dark by default
apps/helper            Eido Helper (Swift, EventKit): placeholder
services/              Python services for later waves: placeholder
infra/                 launchd, pf, Tailscale, llama-server: placeholder
fixtures/              test fixtures, including the boundary-violation fixture
docs/adr/              architecture decision records
scripts/               repo checks (gate allowlist, secret scan, boundary fixture, exact versions)
```

## Contributing

Work is issue-driven and worktree-driven: pick an issue, assign yourself, and work in your own worktree. Read [AGENTS.md](AGENTS.md) and the rules in `.claude/rules/` first. Commits and PR titles follow Conventional Commits.

Turborepo telemetry: set `TURBO_TELEMETRY_DISABLED=1` in CI, and run `pnpm turbo telemetry disable` on your machine.

Add shadcn components with `pnpm dlx shadcn@latest add <component> -c apps/web`.

## License

Source-available, not open source. You can download and run official releases and read the code; forking and redistribution are not permitted. See `LICENSE` and `NOTICE`.
