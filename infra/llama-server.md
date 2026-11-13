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

## Pinned build and model profiles

`infra/model.lock` pins one llama.cpp build and a set of model profiles:

- **llama.cpp:** release `b11149` (commit `d2e54583c`), with the SHA-256 of each release asset: `llama-b11149-bin-macos-arm64.tar.gz`, `llama-b11149-bin-win-vulkan-x64.zip`, `llama-b11149-bin-win-cpu-arm64.zip`, `llama-b11149-bin-ubuntu-vulkan-x64.tar.gz` and `llama-b11149-bin-ubuntu-arm64.tar.gz`.
- **Profiles:** each `[profile <id>]` names a GGUF file, its `source` URL at a fixed revision, its size and SHA-256, a `chat_template_marker` unique to that model's template, and optional `chat_template_kwargs` and extra `flags`. `default_profile` names the one used when none is chosen.

The curated profiles:

| Profile                     | Model                                                                                                    | Template settings                                             | Verified |
| --------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------- |
| `gemma-4-26b-a4b` (default) | Gemma 4 26B-A4B instruct, Google's QAT Q4_0 GGUF (`google/gemma-4-26B-A4B-it-qat-q4_0-gguf`, Apache 2.0) | `--reasoning off`                                             | yes      |
| `qwen3.6-35b-a3b`           | Qwen3.6 35B-A3B, Unsloth's UD-Q4_K_M GGUF (`unsloth/Qwen3.6-35B-A3B-GGUF`)                               | `{"enable_thinking": false}`                                  | no       |
| `gpt-oss-20b`               | gpt-oss 20B, MXFP4 (`ggml-org/gpt-oss-20b-GGUF`)                                                         | `{"reasoning_effort": "low"}`; reasoning cannot be turned off | no       |

Gemma 4 26B-A4B is a mixture-of-experts model: 128 experts, 8 active per token, about 4B active parameters. gpt-oss 20B is the small-memory floor (about 12 GB). Its harmony template always reasons on the analysis channel; `reasoning_effort` only lowers how much. The markers and thinking settings were read from the chat template embedded in each GGUF (`tokenizer.chat_template`). Any other model can be added for your own use with `llama add` (below).

The MVP starts on the default. Llama 3.1 8B Q4_0, the earlier stand-in from #69, has no tool-call support in its template (#473). The candidates are benchmarked during the dogfood week (#532), and #28 makes the final choice.

### Verified profiles

`launch`, `install` and `use` run only a verified profile. A profile is verified when either:

- model.lock says `verified: true`: it passed `llama check-template` on a real host with the pinned build; or
- this machine has a recorded pass: `llama check-template --model <id>` passed here with this file and build, and wrote `<id> <sha256> <build>` to `<stack dir>/verified-profiles`. A pass for another file hash or another build does not count, so a new pin needs a new pass.

`qwen3.6-35b-a3b` and `gpt-oss-20b` are `verified: true`: each passed `llama check-template` on the host with b11149 (see "Recorded results"), against a reference prompt written by hand from its template. Run the model eval (#28) before relying on one.

### Default locations

Each can be overridden by env; none is a secret.

| What                  | macOS default                                                           | Windows default                                              | Linux default (`$XDG_DATA_HOME`, else `~/.local/share`) | Env                     |
| --------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------- | ----------------------- |
| lock file             | `infra/model.lock` in this checkout                                     | the same                                                     | the same                                                | `EIDO_MODEL_LOCK`       |
| model directory       | `~/Library/Application Support/eido-dev/models`                         | `%LOCALAPPDATA%\eido-dev\models`                             | `<data>/eido-dev/models`                                | `EIDO_MODEL_DIR`        |
| `llama-server`        | `~/Library/Application Support/eido-dev/llama.cpp/<build>/llama-server` | `%LOCALAPPDATA%\eido-dev\llama.cpp\<build>\llama-server.exe` | `<data>/eido-dev/llama.cpp/<build>/llama-server`        | `EIDO_LLAMA_SERVER_BIN` |
| port (on `127.0.0.1`) | `8080`, the same variable core reads                                    | the same                                                     | the same                                                | `EIDO_LLAMA_PORT`       |
| stack directory       | `~/Library/Application Support/eido-dev`                                | `%LOCALAPPDATA%\eido-dev`                                    | `<data>/eido-dev`                                       | `EIDO_STACK_DIR`        |
| active profile        | `EIDO_LLAMA_MODEL` in `<stack dir>/stack.env`, else `default_profile`   | the same                                                     | the same                                                | `EIDO_LLAMA_MODEL`      |

The active profile is, in order: an exported `EIDO_LLAMA_MODEL`, then `EIDO_LLAMA_MODEL` in `stack.env`, then the lock's `default_profile`. The launcher loads only the active profile's file. It never falls back to another file.

The stack directory also holds `profiles.lock` (profiles you added with `llama add`) and `verified-profiles` (the passes recorded on this machine). Neither is committed.

### Install the build and a model

`pnpm stack:bootstrap` already installs the build (`llama fetch --build-only`). The model is downloaded and switched from the Admin page. The commands below are the terminal route to the same thing.

```bash
pnpm --filter @eido/infra llama fetch --build-only       # the build alone
pnpm --filter @eido/infra llama fetch                    # the build and the active profile's model
pnpm --filter @eido/infra llama fetch --model gpt-oss-20b
```

`fetch` downloads only from the URLs in the lock or your profiles file:

1. **Build:** it downloads the platform's release asset to a `.partial` file and checks its SHA-256, deleting it on a mismatch. It unpacks it with the system `tar`, moves the directory holding `llama-server` into `llama.cpp/<build>/`, and on macOS clears the download quarantine on that directory only. Then it checks `llama-server --version` against the build and commit.
2. **Model:** it downloads the file to a `.partial` file, checks the size and SHA-256, and moves it into place only when both match. On a mismatch it deletes the download.

What is already installed and matches is left alone, so a rerun only re-verifies. `fetch` never replaces a file that is there and does not match: move it away first. A profile with a local `path` (for example an Ollama blob) is checked, never downloaded.

To install by hand instead, download the asset, check it with `llama verify-archive <path>`, extract it into the build directory, clear the quarantine with `xattr -dr com.apple.quarantine <dir>`, download the model from its `source` URL into the model directory, and run `llama verify`.

### Swap the model

```bash
pnpm --filter @eido/infra llama list                   # each profile: on disk, verified, added, default, active
pnpm --filter @eido/infra llama fetch --model qwen3.6-35b-a3b
pnpm --filter @eido/infra llama check-template --model qwen3.6-35b-a3b   # once, while nothing else serves the port
pnpm --filter @eido/infra llama use qwen3.6-35b-a3b
```

`use` refuses a profile that is not on disk or not verified. It sets `EIDO_LLAMA_MODEL` in `stack.env` through the shared stack settings store (mode 0600, the same file `pnpm stack:setup` writes) and keeps every other setting. Then, when the LaunchAgent is installed, it restarts it with `launchctl kickstart -k`; the new launcher verifies and loads the new profile. An `EIDO_LLAMA_MODEL` exported in your shell still wins over the file, and `use` says so. Core needs no change: it talks to whichever model serves the port, and the profile's `chat_template_kwargs` become the server's defaults through `--chat-template-kwargs`.

### Add a profile

For your own use, from any Hugging Face GGUF:

```bash
pnpm --filter @eido/infra llama add <owner>/<repo> <file>.gguf \
  [--revision <40-char sha>] [--id <id>] [--marker <text>] [--kwargs '<json>']
```

`add` pins the revision (by default the repo's current commit) and reads the file's size and SHA-256 from the Hub at that revision (the LFS size and oid, from `/api/models/<repo>/paths-info/<rev>`). It writes a profile to `<stack dir>/profiles.lock`, never to the committed lock. The id defaults to the lowercased file name. It refuses split GGUFs, files outside LFS, and an id the lock already has. Then it prints the next steps: `llama fetch --model <id>`, `llama check-template --model <id>`, then the model eval (#28).

Without `--marker`, the template check only confirms that a template is loaded. Pass a string unique to the model's template to have it confirm the template is that model's. Pass `--kwargs` for the template's settings, such as `{"enable_thinking": false}`. A local file, for example an Ollama blob, can be added by hand to `profiles.lock` with `path:` in place of `file:` and `source:`.

To add a curated profile to `infra/model.lock`:

1. Add a `[profile <id>]` section. Take `size` and `sha256` from the Hub (the same paths-info call, or `llama add` and copy its section). For a file you already have, use `stat -f %z` and `shasum -a 256` on macOS, or `(Get-Item <file>).Length` and `Get-FileHash -Algorithm SHA256 <file>` (or `certutil -hashfile <file> SHA256`) on Windows.
2. Read the chat template from the GGUF metadata. Set `chat_template_marker` to a string only that template has, and `chat_template_kwargs` to turn thinking off where the template allows it. Never guess a value: if you cannot determine one reliably, ship the profile with `verified: false`.
3. `flags` may add llama-server options, but not the ones the launcher sets: the model, host, port, `--jinja` and the chat template options.
4. Set `verified: true` only after `llama check-template --model <id>` passes on a real host with the pinned build. Write the reference prompt fixture first if you can (see the template check below).
5. Update the committed-lock test in `infra/llama/lock.test.ts`.

### Commands

```bash
pnpm --filter @eido/infra llama verify          # the build and the active profile's model, on demand
pnpm --filter @eido/infra llama fetch           # download and verify the build and a model (--model ID)
pnpm --filter @eido/infra llama list            # the profiles and their state
pnpm --filter @eido/infra llama add REPO FILE   # add a Hugging Face GGUF to your own profiles
pnpm --filter @eido/infra llama use ID          # make ID the active profile, restart the LaunchAgent
pnpm --filter @eido/infra llama launch          # verify, then run llama-server in the foreground (launchd runs this)
pnpm --filter @eido/infra llama start           # alias for launch (what doctor names off macOS)
pnpm --filter @eido/infra llama check-template  # against the running server; --model ID starts and checks that profile
pnpm --filter @eido/infra llama plan            # print the LaunchAgent plist and launchctl command; changes nothing
pnpm --filter @eido/infra llama install         # macOS: write ~/Library/LaunchAgents/com.eido.llama-server.plist and bootstrap it; Windows and Linux: fetch
pnpm --filter @eido/infra llama uninstall       # boot it out and remove the plist
pnpm --filter @eido/infra llama status          # launchd's view, who listens on the port, /health
```

`launch` does these steps in order:

1. Refuses an unverified profile, then verifies the binary and the model; on any failure it exits 1 and does not start the server.
2. Starts `llama-server -m <model> --jinja --host 127.0.0.1 --port <port> -c 8192 -fa on --cache-type-k q8_0 --cache-type-v q8_0 -ngl 99 -b 2048 -ub 2048 -t 8 --swa-full`, then `--chat-template-kwargs <json>` when the profile has kwargs, then the profile's `flags`. These are the flags measured in #69, `--swa-full` (#732, below), plus the fixed loopback bind. Gemma 4's `flags: --reasoning off` keeps it out of thinking mode: with the default (`auto`) the template injects `<|think|>` into the system turn and a schema-constrained completion comes back with empty content.
3. Waits up to 180 s for `/health`.
4. Checks that `/props` reports a chat template containing the profile's `chat_template_marker` (or any template, for a profile without one). If not, it stops the server and exits 1.
5. Stays in the foreground. It exits non-zero if the server dies, and on SIGTERM it stops the server and exits 0.

### Windows and Linux

`fetch`, `install` (which runs `fetch` off macOS), `verify`, `verify-archive`, `list`, `add`, `use`, `launch`, `start` and `check-template` run on Windows (x64 with the Vulkan build, arm64 with the CPU build) and Linux (x64 with the Vulkan build, arm64 with the CPU build), with the paths in the table above. There is no LaunchAgent: run `llama start` (or `llama launch`) in a terminal, and after `llama use`, stop it and run it again. `plan`, `uninstall` and `status` need launchd and lsof; on Windows and Linux they print `not supported on this platform yet (#629)` and exit 1.

### LaunchAgent

`llama install` writes `com.eido.llama-server` with these settings:

- **Program:** `node infra/llama/bin.ts launch`.
- **Restarts:** `RunAtLoad` and `KeepAlive` are on, with `ThrottleInterval` 10 s, so a bad pin does not spin.
- **Environment:** the resolved settings above.
- **Logs:** `~/Library/Logs/eido/llama-server.out.log` and `.err.log`.

launchd restarts the launcher whenever it exits, and every restart re-verifies the pin. `AbandonProcessGroup` stays at its default (false), so if the launcher dies, launchd also kills its `llama-server` child and no orphan keeps the port.

Install it only after `llama verify` passes; `install` refuses when the binary or model file is missing or the active profile is not verified, since launchd would restart a launcher that refuses it. The plist does not name the profile: each start reads it from `stack.env`, so `llama use` needs no reinstall. The node path written into the plist is the one that ran `install`, so after upgrading node, run `llama install` again.

### Recorded results (2026-11-13, prompt-prefix reuse, Gemma 4 26B-A4B only, #708)

Only `gemma-4-26b-a4b` was measured; the other two profiles are not downloaded on the measuring Mac (disk), so "per profile" is not done yet (#731). Build b11149, M3 Max, 36 GB. Flags were the committed `serverArgs` (the line under `launch` above, with `--reasoning off`), plus the one flag under test. The Mac was busy with other work (load average about 10), so absolute times drift from run to run: the cold time for the 2,076-token prompt was 2,755 ms, then 3,487 ms, then 4,188 ms across three runs in a row. Compare the cold and warm columns inside one run, not across runs.

Method: the probe follows core's path (`/apply-template`, `/tokenize`, then `/completion` with token ids, `stream: true`, `cache_prompt: true`, `temperature: 0`, 16 tokens) and times the request until the first streamed token. The system prompt is core's `ANSWER_SYSTEM` (1,446 characters), with a block of synthetic lines after it for the larger sizes. Each round begins with a random line, so the cold request cannot match anything already cached. Each round sends 1 cold request and 2 warm ones: the same system prompt with a different one-line question. Medians over 5 rounds (5 cold, 10 warm requests). Time to first token, ms:

| Prompt tokens |  Cold | Warm (same prefix) |
| ------------: | ----: | -----------------: |
|           382 |   446 |                440 |
|           797 |   945 |                982 |
|         1,223 | 1,632 |                118 |
|         2,076 | 2,755 |                120 |

- **Defaults reuse the prefix, from about 1.2k tokens.** At 1,223 and 2,076 tokens a warm request is about 14x and 23x faster. A first run through `llama launch` (5 rounds, same method) gave 2,259 ms cold and 108 ms warm at 2,075 tokens, and the server reported 2,061 of 2,075 prompt tokens as cached. At 382 and 797 tokens nothing was reused (warm equals cold; at 381 tokens the server reported 0 cached). The cause is in the #732 section below. Core's `ANSWER_SYSTEM` alone is about 380 tokens, so on this profile the system prompt by itself is not served from the cache. A longer stable prefix is.
- **`--cache-reuse 256` did not help.** The server logged `cache_reuse is not supported by this context, it will be disabled` for this model. A probe with the same head and tail and a middle section of different length (3 rounds) reused 0 of about 1,964 tokens under the defaults and under `--cache-reuse 256`. Cold and warm times with the flag were no better than the defaults (382 tokens: 568 cold, 559 warm; 2,076 tokens: 3,487 cold, 130 warm, from a slower run).
- **`--slot-prompt-similarity 0.5` did not help either.** The server already picked the matching slot at the default threshold of 0.10 (similarity 0.96 to 0.99 in its log). Times with 0.5: 383 tokens 827 cold, 816 warm; 2,078 tokens 4,188 cold, 165 warm, again from a slower run.

Decision (#708): the defaults reuse a prefix only from about 1.2k tokens. #732, below, found why and changed `serverArgs`. Not measured: Qwen3.6 and gpt-oss (#731).

### Recorded results (2026-11-13, short-prefix reuse on Gemma 4, #732)

Same Mac, build b11149, committed `serverArgs` with `--reasoning off`, plus one change per configuration. The probe is the #708 method (core's `ANSWER_SYSTEM` plus synthetic lines, random first line per round so the cold request matches nothing, 5 rounds of 1 cold and 2 warm requests, medians, 16 tokens, time to first token), written in the session scratchpad and not kept in the repo. Sizes are the prompt tokens after the chat template (418 rather than 380 because the template adds tokens). "Cached" is the `cache_n` the server reports on the warm requests (0 on every cold request). The Mac was busy (load average 5 to 8), so compare columns inside one configuration; the cold column varies about 20 percent between runs.

| Configuration                  | Tokens | Cold ms | Warm ms | Warm cached |
| ------------------------------ | -----: | ------: | ------: | ----------: |
| committed (`-b 2048 -ub 2048`) |    418 |     497 |     471 |           0 |
|                                |    831 |     897 |     858 |           0 |
|                                |  2,112 |   2,774 |     130 |       2,090 |
| `-b 512 -ub 512`               |    419 |     484 |     481 |           0 |
|                                |    831 |     936 |     593 |         319 |
|                                |  2,111 |   2,439 |     132 |       2,090 |
| `-b 256 -ub 256`               |    417 |     563 |     352 |         163 |
|                                |    830 |   1,069 |     361 |         575 |
|                                |  2,111 |   2,660 |     133 |       2,091 |
| `--swa-full`                   |    418 |     454 |      93 |         399 |
|                                |    828 |     826 |      95 |         809 |
|                                |  2,109 |   2,226 |     104 |       2,089 |

- **Cause: sliding-window attention.** Gemma 4 uses a sliding-window KV cache. The server can restore a prefix from a checkpoint it took while processing the prompt, and a checkpoint exists only at a micro-batch boundary. With `-ub 2048` a prompt under 2,048 tokens is one micro-batch, so no checkpoint lies inside the shared prefix. Smaller micro-batches confirm it: reuse grows as `-ub` shrinks (0 cached at 831 tokens with 2,048, 319 with 512, 575 with 256; 163 at 418 only with 256), but a checkpoint still sits short of the end of the shared prefix, so warm requests stay about 4 to 6 times slower than full reuse, and `-ub 256` made cold prompts at 418 and 831 tokens 13 and 19 percent slower than the committed args.
- **`--swa-full` fixes it.** It keeps the full-size KV cache for the sliding-window layers, so the server no longer needs a checkpoint to restore a prefix. The warm request reused 399 of 418 and 809 of 828 tokens (the rest is the changed question) and was about 5x and 9x faster. The cold prompt at 2,109 tokens took 2,226 ms against 2,774 ms with the committed args (2,439 and 2,660 ms in the other two runs), so it is not slower.
- **Cost.** `--swa-full` allocates the full KV cache for the sliding-window layers at the 8,192-token context, which uses more memory. The resident size of the server read 16.6 GB after the probe with it, against 15.0 GB for a freshly started committed server; the two are not like for like, so this is an indication, not a measurement.
- **`--ctx-checkpoints 32` was not run.** The pinned build's `--help` lists `-ctxcp, --ctx-checkpoints N` with a default of 32, so that configuration is the committed one. The same help lists `-cms, --checkpoint-min-step N` (default 8192 tokens); it was not tried, since `--swa-full` already solved the case.
- **Not measured:** Qwen3.6 and gpt-oss with `--swa-full` (#731). `serverArgs` is shared by every profile, so the flag applies to all three. Its effect on models without sliding-window layers was not checked here.

Decision: `--swa-full` is added to `serverArgs` (`infra/llama/server.ts`, with `infra/llama/server.test.ts` covering the list). Core does not need a longer stable prefix on this profile once the server runs with it: the 380-token `ANSWER_SYSTEM` is reused. A server started before this change keeps the old behaviour until it restarts.

### Recorded results (2026-11-12, hidden-token check, same Mac, port 8080)

`llama check-template --model <id>` on b11149 printed `ok: no hidden tokens` and `ok: template check passed` for all three committed profiles: `gemma-4-26b-a4b` (also `ok: chat template`, `ok: rendered prompt`, `ok: JSON-schema request`), `qwen3.6-35b-a3b` and `gpt-oss-20b` (`ok: chat template`, `ok: JSON-schema request`; no reference prompt yet, so the rendered prompt is not compared).

### Recorded results (2026-11-03, Gemma 4 26B-A4B QAT Q4_0, same Mac)

Launcher on port 18092, outside launchd.

- `llama launch` reported `b11149 (d2e54583c)` and matched the SHA-256; node hashed the 14.4 GB model in 12.6 s on the first run and 17.1 s on the second.
- `/health` answered 2.3 s after start (11.1 s on the first, cold load), and `/props` had `<|turn>model`.
- `llama status`: `port 18092 listens on loopback only`, `/health 200`.
- `llama check-template` printed `ok: chat template`, `ok: rendered prompt`, `ok: JSON-schema request` and `ok: template check passed on b11149 with gemma-4-26B_q4_0-it.gguf`.
- Without `--reasoning off` the same check failed: the rendered prompt had `<|think|>` after `<|turn>system`, and the JSON-schema completion was empty.

The altered-copy, server-killed and launchd runs below were recorded on the Llama pin; the launcher code they exercise is unchanged.

### Recorded results (2026-11-12, Qwen3.6 35B-A3B and gpt-oss 20B, development Mac: M3 Max, 36 GB)

`llama fetch --model <id>` verified the size and SHA-256 of each file (`gpt-oss-20b-MXFP4.gguf` 12.1 GB, `Qwen3.6-35B-A3B-UD-Q4_K_M.gguf` 22.1 GB), then `llama check-template --model <id>` printed, for each:

- `ok: chat template`
- `ok: rendered prompt`
- `ok: JSON-schema request`
- `ok: template check passed on b11149 with <file>`

Qwen's first run failed `rendered prompt` at character 156 (the empty `<think>` block on assistant turns, above); it passed after the fixture was corrected from the template's `preserve_thinking` branch. gpt-oss passed on the first run.

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

`llama check-template` checks the running server's active profile, which must already be verified. `llama check-template --model <id>` checks any profile: it refuses if something already answers on the port, starts `llama-server` for that profile, runs the checks and stops it. When every check passes, it records the pass in `<stack dir>/verified-profiles`, which verifies the profile on this machine for this file and build.

The checks:

1. `/props` reports a chat template containing the profile's `chat_template_marker` (`<|turn>model` for Gemma 4).
2. `/apply-template` renders the fixed synthetic conversation in `infra/llama/server.ts` (`FIXED_CONVERSATION`: system, user, an assistant tool call, the tool result, an assistant reply, a user turn). The result must equal `infra/llama/fixtures/<model file>.prompt.txt` exactly; on a difference the check names the first differing character. When there is no fixture for the file, the check prints `note: no reference prompt at <path>; the rendered prompt is not compared` and runs the others.
3. One `/v1/chat/completions` request constrained by a strict JSON schema (four required string fields, no others) must return content that parses and matches the schema.
4. No hidden tokens (#707). `/apply-template` renders the fixed conversation again and its generation prompt must not open a `<think>` (or `<thinking>`) block it never closes, which means the profile's `chat_template_kwargs` or flags did not turn thinking off. Then one plain `/v1/chat/completions` request, with no schema, must return a reply with none of the profile's `hidden_tokens`. The list is a whitespace-separated `hidden_tokens` line in the profile (optional); without one the default set applies: `<think>`, `</think>`, `<|channel|>`, `<|start|>`, `<|end|>`, `<|im_start|>`, `<|im_end|>` and `<unused`. It prints `ok: no hidden tokens`, or `FAIL: no hidden tokens:` with the token and the character where it appeared. This check runs for every profile, with or without a reference prompt. Stripping these tokens from replies inside core is not part of it.

The Gemma 4 reference fixture was written by hand from the Gemma 4 template embedded in the GGUF (`tokenizer.chat_template`), not captured from the server:

- **System message:** the template renders it in its own `<|turn>system` turn.
- **Assistant turns:** each one becomes a `<|turn>model` turn.
- **Tool call:** renders as `<|tool_call>call:get_weather{city:<|"|>Testville<|"|>}<tool_call|>`.
- **Tool result:** goes inline in the same model turn, as `<|tool_response>response:get_weather{value:…}<tool_response|>`.
- **Reply:** the assistant reply after the tool result continues that turn, with no new header.
- **Generation prompt:** with thinking off, it is `<|turn>model\n<|channel>thought\n<channel|>`.
- **`<bos>`:** llama.cpp adds it when it tokenizes, so the fixture leaves it out.

The Qwen3.6 and gpt-oss fixtures were written the same way, from the templates in the Hub's GGUF metadata at the pinned revisions:

- **Qwen3.6 (`<|im_start|>` turns):**
  - The tool call renders as `<tool_call>\n<function=get_weather>\n<parameter=city>\nTestville\n</parameter>\n</function>\n</tool_call>`, and the tool result becomes a `user` turn holding `<tool_response>`.
  - llama.cpp sets `preserve_thinking` true by default (`/props` reports `preserve_reasoning`), so every assistant turn carries an empty `<think>\n\n</think>\n\n` block. My first fixture left it out, following the template's default branch, and the check caught it.
  - The generation prompt with `enable_thinking: false` is `<|im_start|>assistant\n<think>\n\n</think>\n\n`, so the file ends in a blank line.
- **gpt-oss (harmony):**
  - The template prints today's date (`strftime_now`), so the fixture writes `{{current_date}}` and the check replaces it with the host's local date (read before and after the request, so a run across midnight still passes).
  - `reasoning_effort: low` shows as `Reasoning: low`.
  - The system message becomes the `developer` turn under `# Instructions`.
  - The tool call and its result are `commentary` messages, with the arguments and the result passed through `tojson`.

Unlike the earlier Llama 3.1 8B pin, whose template dropped the call itself and rendered an empty assistant turn, this template carries the tool call to the model. The Llama fixture stays in `infra/llama/fixtures/` for the benchmark in #532.

## Updating the pin

Any change of a model file or of the llama.cpp build:

1. Edit `infra/model.lock`. For a model: the profile's `file`, `source` (at a fixed revision), `size` and `sha256`, as in "Add a profile". For the build: `llama_cpp_build`, `llama_cpp_commit` (from `llama-server --version`), and each `[build]` section's `asset`, `source` and `sha256`. A new build invalidates every recorded pass.
2. Write the new reference prompt to `infra/llama/fixtures/<new file>.prompt.txt` by hand from the model's template, not from the server's output.
3. Run `llama fetch --model <id>`, then `llama check-template --model <id>` until all checks pass. Set `verified: true` only then.
4. Run `llama install` again if a path changed, so the LaunchAgent's environment picks it up.
5. Update "Recorded results" above with the new build, timings and template result.
6. `pnpm turbo run test --filter=@eido/infra` checks that the committed lock parses to its expected values. Update that test with the new pin.

## Outbound allowlist

Not built yet: default-deny egress needs a system-level change (pf or LuLu) that the owner makes. It is tracked in #471.
