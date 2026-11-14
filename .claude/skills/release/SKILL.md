---
name: release
description: Manual release and deploy checklist for Eido (no automation exists). Use when asked to cut a release, tag a version, build and pin the file helper, or deploy a new build to the owner's Mac.
---

# Release (manual)

No release pipeline exists (removed in f2d1137; `CHANGELOG.md` stops at v0.0.1). Nothing is signed or published. A release is: green `main`, an optional version and tag, a file-helper rebuild and pin, and a manual deploy on the owner's Mac. Do not invent workflows or publish steps. Steps marked owner are never run by an agent.

## 1. Preflight

- Clean tree at current `origin/main`, in a worktree (`.claude/rules/git-workflow.md`).
- `pnpm install --frozen-lockfile`, then `pnpm verify --full` (the CI run; it includes `check:invariants`).
- From `packages/gate/native/file-helper`: `cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked`
- Latest `CI` run on `main` is green, including every `gate tests` and `file helper` job: `gh run list --branch main --limit 3`.

## 2. Version and tag (only if the owner wants one)

TODO(owner): are versions and tags still wanted, and what scheme? Root `package.json` is `0.0.1`; `check:versions` covers dependency pins, not this.

If wanted: bump `package.json`, add a `## [x.y.z] - date` entry to `CHANGELOG.md` by hand, and land both in a PR titled `chore(release): vX.Y.Z`. Tag the merge commit (`git tag -a vX.Y.Z <sha> -m "vX.Y.Z"`) and push the tag only when asked. Never mark a change breaking on your own judgement.

## 3. File helper build and pin (owner, on the gate host)

Skip when nothing under `packages/gate/native/file-helper` changed. See `docs/local-files.md`, ADR 0006, #463.

```sh
pnpm install:file-helper /absolute/gate-owned/bin
```

Builds with `cargo build --release --locked`, copies the binary into a directory only the gate user can write (mode 0700; refused if group or others can write) and prints `EIDO_FILE_HELPER_PATH` and `EIDO_FILE_HELPER_SHA256`. Set both in the gate's configuration; the gate refuses a stale pin, so re-run after every helper or toolchain change. On Windows, set gate/admin-only ACLs on the directory by hand. TODO(owner): confirm an unchanged toolchain reproduces the same hash.

## 4. Deploy (owner, on the Mac; `infra/README.md`)

1. `git pull` on `main` (or the chosen tag), then `pnpm install --frozen-lockfile`.
2. `pnpm stack:doctor` (read-only; exits 1 on a fail). Fix failures first.
3. `pnpm stack:stop`, then `pnpm stack:prod --background`. With the `com.eido.stack` LaunchAgent (`pnpm stack:install`) the supervisor also starts the stack at login and after a supervisor restart.
4. If the serve routes changed: `pnpm --filter @eido/infra serve-routes plan`, then `apply`, then `check`.
5. If backup code changed, re-render the backup LaunchAgent (`infra/README.md`, Backup, one-time setup step 3).
6. TODO(owner): no documented rollback. Only mechanism: check out the previous commit and repeat steps 1 to 3. Databases are not versioned with the code, so confirm a fresh backup first (`infra/backup-restore.md`).

## 5. Post-deploy checks

- `pnpm stack:status` and `pnpm stack:doctor`: no fails.
- `pnpm --filter @eido/infra serve-routes check`: exactly the three routes on 8443, funnel off.
- On the phone, open `https://<host>.ts.net:8443/` and run `infra/device-smoke.md`.
- `pnpm --filter @eido/infra backup check` (newest snapshot under 36 hours).
- Logs: `~/Library/Logs/eido-dev/` (stack), `~/Library/Logs/eido/` (backup).
- `sudo node scripts/check-isolation-live.ts` is a by-hand live check (`docs/isolation-tests.md`), not part of `pnpm verify`. TODO(owner): run it per deploy?
