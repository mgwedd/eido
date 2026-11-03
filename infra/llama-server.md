# Mac host and llama-server runbook (#29)

The MVP host is one Mac mini. FileVault is on, the web app is reachable only over Tailscale HTTPS, and `llama-server` serves one pinned model on `127.0.0.1`. The pin lives in `infra/model.lock`. The launcher refuses to start `llama-server` unless the binary and the model file match it.

Every command below runs from the repo root and is read-only unless it says otherwise. None needs `sudo`.

## Host baseline

```bash
pnpm --filter @eido/infra host check   # fdesetup status and tailscale status --json; exit 1 if either fails
```

- **FileVault:** `fdesetup status` printed `FileVault is On.` (recorded 2026-11-02).
- **Tailscale:** `host check` fails while the node is stopped. On 2026-11-02 it printed `Tailscale is not running: BackendState "Stopped"`, so start Tailscale before checking the serve routes.
- **Automatic updates:** recorded on 2026-11-02 from `/Library/Preferences/com.apple.SoftwareUpdate`. These are on:
  - `AutomaticDownload`
  - `CriticalUpdateInstall`
  - `ConfigDataInstall`
  - `AutomaticallyInstallMacOSUpdates`

  The policy for the host is to keep downloads and security responses automatic, but to turn off "Install macOS updates" (System Settings, General, Software Update, Automatic Updates). An update then never reboots the host unattended. Install macOS updates by hand and follow the reboot procedure below. Changing the setting is the owner's step; nothing here changes it.

- **Reboot procedure:** with FileVault on, the Mac stops at the FileVault unlock screen after a reboot or power loss. No LaunchAgent runs until the owner logs in, and that includes `llama-server`, the stack and Proton Bridge (#68). After any reboot:
  1. Unlock at the console or over Screen Sharing.
  2. Log in as the owner.
  3. Run `pnpm --filter @eido/infra host check` and `pnpm --filter @eido/infra llama status`.

  An unattended power loss therefore means downtime until someone unlocks the Mac. `fdesetup authrestart` keeps the unlock for one planned restart only. It needs `sudo` and is the owner's call.

## Tailscale and Funnel

The serve routes and the Funnel check are already scripted (ADR 0004, #178; see `infra/README.md`):

```bash
pnpm --filter @eido/infra serve-routes check   # exactly the three routes on 8443, funnel off for it
```

The web app is served only at `https://<host>.ts.net:8443`. `llama-server` has no serve route and never gets one.

## Pinned model and llama.cpp build

`infra/model.lock` pins:

- **Model:** Gemma 4 26B-A4B instruct, Google's QAT Q4_0 GGUF (`google/gemma-4-26B-A4B-it-qat-q4_0-gguf` at a fixed revision, Apache 2.0), with its size and SHA-256. It is a mixture-of-experts model: 128 experts, 8 active per token, about 4B active parameters.
- **llama.cpp:** release `b11149` (commit `d2e54583c`), with the SHA-256 of `llama-b11149-bin-macos-arm64.tar.gz`.

The MVP starts on this pin. Llama 3.1 8B Q4_0, the earlier stand-in from #69, has no tool-call support in its template (#473). The other candidates are benchmarked during the dogfood week (#532), and #28 makes the final choice.

Default locations (each can be overridden by env, none is a secret):

| What                  | Default                                                                 | Env                     |
| --------------------- | ----------------------------------------------------------------------- | ----------------------- |
| lock file             | `infra/model.lock` in this checkout                                     | `EIDO_MODEL_LOCK`       |
| model directory       | `~/Library/Application Support/eido-dev/models`                         | `EIDO_MODEL_DIR`        |
| `llama-server`        | `~/Library/Application Support/eido-dev/llama.cpp/<build>/llama-server` | `EIDO_LLAMA_SERVER_BIN` |
| port (on `127.0.0.1`) | `8080`, the same variable core reads                                    | `EIDO_LLAMA_PORT`       |

The launcher loads only `<model dir>/<file in the lock>`. It never falls back to another file.

### Install the pinned build and model

1. Download `llama-b11149-bin-macos-arm64.tar.gz` from the llama.cpp `b11149` GitHub release, then check it:
   ```bash
   pnpm --filter @eido/infra llama verify-archive ~/Downloads/llama-b11149-bin-macos-arm64.tar.gz
   ```
2. Extract it so `llama-server` and its libraries sit in `~/Library/Application Support/eido-dev/llama.cpp/b11149/`, then clear the download quarantine on that directory only: `xattr -dr com.apple.quarantine <dir>`.
3. Download the model from the `source` URL in the lock into the model directory.
4. Check both pins:
   ```bash
   pnpm --filter @eido/infra llama verify
   ```
   This runs `llama-server --version` against the build and commit, then hashes the model against the size and SHA-256. Any mismatch exits 1 and names the expected and actual values.

### Commands

```bash
pnpm --filter @eido/infra llama verify          # build and model pin, on demand
pnpm --filter @eido/infra llama launch          # verify, then run llama-server in the foreground (launchd runs this)
pnpm --filter @eido/infra llama check-template  # against a running server: template, rendered prompt, JSON schema
pnpm --filter @eido/infra llama plan            # print the LaunchAgent plist and launchctl command; changes nothing
pnpm --filter @eido/infra llama install         # write ~/Library/LaunchAgents/com.eido.llama-server.plist and bootstrap it
pnpm --filter @eido/infra llama uninstall       # boot it out and remove the plist
pnpm --filter @eido/infra llama status          # launchd's view, who listens on the port, /health
```

`launch` does these steps in order:

1. Verifies the binary and the model; on a mismatch it exits 1 and does not start the server.
2. Starts `llama-server -m <model> --jinja --host 127.0.0.1 --port <port> -c 8192 -fa on --cache-type-k q8_0 --cache-type-v q8_0 -ngl 99 -b 2048 -ub 2048 -t 8 --reasoning off`. These are the flags measured in #69, plus the fixed loopback bind. `--reasoning off` keeps Gemma 4 out of thinking mode: with the default (`auto`) the template injects `<|think|>` into the system turn and a schema-constrained completion comes back with empty content.
3. Waits up to 180 s for `/health`.
4. Checks that `/props` reports a chat template containing the lock's `chat_template_marker`. If not, it stops the server and exits 1.
5. Stays in the foreground. It exits non-zero if the server dies, and on SIGTERM it stops the server and exits 0.

### LaunchAgent

`llama install` writes `com.eido.llama-server` with these settings:

- **Program:** `node infra/llama/bin.ts launch`.
- **Restarts:** `RunAtLoad` and `KeepAlive` are on, with `ThrottleInterval` 10 s, so a bad pin does not spin.
- **Environment:** the resolved settings above.
- **Logs:** `~/Library/Logs/eido/llama-server.out.log` and `.err.log`.

launchd restarts the launcher whenever it exits, and every restart re-verifies the pin. `AbandonProcessGroup` stays at its default (false), so if the launcher dies, launchd also kills its `llama-server` child and no orphan keeps the port.

Install it only after `llama verify` passes; `install` refuses when the binary or model file is missing. The node path written into the plist is the one that ran `install`, so after upgrading node, run `llama install` again.

### Recorded results (2026-11-03, Gemma 4 26B-A4B QAT Q4_0, same Mac)

Launcher on port 18092, outside launchd.

- `llama launch` reported `b11149 (d2e54583c)` and matched the SHA-256; node hashed the 14.4 GB model in 12.6 s on the first run and 17.1 s on the second.
- `/health` answered 2.3 s after start (11.1 s on the first, cold load), and `/props` had `<|turn>model`.
- `llama status`: `port 18092 listens on loopback only`, `/health 200`.
- `llama check-template` printed `ok: chat template`, `ok: rendered prompt`, `ok: JSON-schema request` and `ok: template check passed on b11149 with gemma-4-26B_q4_0-it.gguf`.
- Without `--reasoning off` the same check failed: the rendered prompt had `<|think|>` after `<|turn>system`, and the JSON-schema completion was empty.

The altered-copy, server-killed and launchd runs below were recorded on the Llama pin; the launcher code they exercise is unchanged.

### Recorded results (2026-11-02, Llama 3.1 8B pin, development Mac: M3 Max, 36 GB)

These runs used the launcher on port 18091, outside launchd.

- **Correct file:**
  - `llama launch` reported the build as `b11149 (d2e54583c)` and matched the SHA-256.
  - Node hashed the 6.0 GB model in 4.1 s, from page cache after a recent read (`shasum -a 256` took 14.1 s in #69).
  - The server answered `/health` 1.0 s after it was started, and `/props` had the marker.
  - Hashing runs at every start, so expect a cold start of a few seconds more than this.
- **Altered copy (AC 1):**
  - Setup: an APFS clone of the model (`cp -c`) with one byte changed at offset 1,000,000,000, pointed to by `EIDO_MODEL_DIR`.
  - `llama launch` printed `FAIL: …: sha256 mismatch: expected b4778681efbd6898fe1965e74f810b3b7dfdf6afab01df9c88c1b0e6e9ca122d, actual 6287caa0d1c45eb9e6ccb9a0ebe555d6485b226a78c68ca79e972d271a71284c` and `llama-server was not started`, then exited 1. No `llama-server` process was started.
  - The clone was then deleted.
- **Server killed:** `kill <llama-server pid>` made the launcher print `llama-server exited with code 0` and exit 1, which is the exit launchd restarts on. Port 18091 was free afterwards.
- **`llama status`:** `port 18091 listens on loopback only: llama-server (pid …) on 127.0.0.1`, `/health 200`.
- **Template check (AC 5):** `llama check-template` printed:
  - `ok: chat template`
  - `ok: rendered prompt`
  - `ok: JSON-schema request`
  - `ok: template check passed on b11149 with meta-llama-3.1-8b-instruct-q4_0.gguf`

Not yet recorded, still to do on the host by the owner (#472):

1. **Under launchd:** run `llama install`, then `llama status` (expect `state running`). Then `kill` the `llama-server` pid shown by `lsof -nP -iTCP:8080 -sTCP:LISTEN`. After about 10 s `llama status` should show a new pid and `runs` one higher.
2. **Reachability from another host:**
   - From another tailnet device, `curl -m 5 http://<host>.ts.net:8080/health` and `curl -m 5 http://<tailnet IP>:8080/health` must both fail to connect.
   - From a LAN device, `curl -m 5 http://<LAN IP>:8080/health` must fail too.
   - On the host, `llama status` must show only `127.0.0.1`.

## Chat template check

`llama check-template` runs three checks against a running server:

1. `/props` reports a chat template containing the lock's `chat_template_marker` (`<|turn>model`).
2. `/apply-template` renders the fixed synthetic conversation in `infra/llama/server.ts` (`FIXED_CONVERSATION`: system, user, an assistant tool call, the tool result, an assistant reply, a user turn). The result must equal `infra/llama/fixtures/<model file>.prompt.txt` exactly; on a difference the check names the first differing character.
3. One `/v1/chat/completions` request constrained by a strict JSON schema (four required string fields, no others) must return content that parses and matches the schema.

The reference fixture was written by hand from the Gemma 4 template embedded in the GGUF (`tokenizer.chat_template`), not captured from the server:

- **System message:** the template renders it in its own `<|turn>system` turn.
- **Assistant turns:** each one becomes a `<|turn>model` turn.
- **Tool call:** renders as `<|tool_call>call:get_weather{city:<|"|>Testville<|"|>}<tool_call|>`.
- **Tool result:** goes inline in the same model turn, as `<|tool_response>response:get_weather{value:…}<tool_response|>`.
- **Reply:** the assistant reply after the tool result continues that turn, with no new header.
- **Generation prompt:** with thinking off, it is `<|turn>model\n<|channel>thought\n<channel|>`.
- **`<bos>`:** llama.cpp adds it when it tokenizes, so the fixture leaves it out.

Unlike the earlier Llama 3.1 8B pin, whose template dropped the call itself and rendered an empty assistant turn, this template carries the tool call to the model. The Llama fixture stays in `infra/llama/fixtures/` for the benchmark in #532.

## Updating the pin

Any change of model file or llama.cpp build:

1. Edit `infra/model.lock`: `file`, `source` (at a fixed revision), `size` (`stat -f %z`), `sha256` (`shasum -a 256`), or `llama_cpp_build`, `llama_cpp_commit` (from `llama-server --version`), `llama_cpp_asset` and `llama_cpp_sha256`. Set `chat_template_marker` to a string unique to the new model's template.
2. Write the new reference prompt to `infra/llama/fixtures/<new file>.prompt.txt` by hand from the new model's template, not from the server's output.
3. Run `llama verify`, start the server with `llama launch`, and run `llama check-template` until all three checks pass.
4. Run `llama install` again, so the LaunchAgent's environment picks up the new paths.
5. Update "Recorded results" above with the new build, timings and template result.
6. `pnpm turbo run test --filter=@eido/infra` checks that the committed lock parses to its expected values. Update that test with the new pin.

## Outbound allowlist

Not built yet: default-deny egress needs a system-level change (pf or LuLu) that the owner makes. It is tracked in #471.
