# Eval runner

The eval runner (`packages/core/src/eval/`, issue #28) runs eval cases through the real proposal path (`/apply-template`, `/tokenize`, `/completion` with `json_schema`) against one or more local llama-server candidates and scores the results. The repo holds the runner, the case format, scoring and synthetic fixtures (`fixtures/eval/`). Real cases, verdicts and results stay on the owner's machine, outside git.

## Synthetic set

`fixtures/eval/set/` holds the committed synthetic set (issue #91): 72 `call` cases (draft, reply, forward, archive, trash, mark read, label, thread-wide actions, reminders, send), 30 `no_call` cases (questions, underspecified requests, money movement) and 26 `injection` cases (13 planted-instruction styles, each against an archive request and a draft request). Names are invented and every address is on `example.invalid`. Calendar, file and Things intents are absent: the model has no source for the entity, root and event ids their arguments need, so a golden for them would be unreachable (see the follow-up issues on #91).

Run it with a local verdicts file. The set ships none, because edit-free approval is a human verdict:

```bash
pnpm --filter @eido/core eval -- --cases ../../fixtures/eval/set --verdicts "$D/verdicts.json"
```

`packages/core/src/eval/set.test.ts` runs the set through the real proposal path with an oracle model, so a golden that cannot be proposed fails CI.

## Settings

| Flag           | Variable               | Default                                      |
| -------------- | ---------------------- | -------------------------------------------- |
| `--cases`      | `EIDO_EVAL_CASES`      | `eval-local` (git-ignored)                   |
| `--verdicts`   | `EIDO_EVAL_VERDICTS`   | `<cases>/verdicts.json`                      |
| `--out`        | `EIDO_EVAL_OUT`        | `.eval-results` (git-ignored)                |
| `--seed`       | `EIDO_EVAL_SEED`       | `329`                                        |
| `--candidates` | `EIDO_EVAL_CANDIDATES` | none: the server at `EIDO_LLAMA_HOST`/`PORT` |
| `--enforce`    |                        | off: baseline mode, no thresholds            |

Temperature is always 0. Seed and temperature are written to `results.json`.

## Candidates file

One command runs every candidate in turn. A candidate with `server.command` has its llama-server started before its cases and stopped after, so only one model is loaded at a time. Without `server`, the runner uses whatever already answers at `baseUrl`. The command is spawned without a shell; its output goes to `<out>/<name>.server.log`.

```json
{
  "candidates": [
    {
      "name": "gemma-4-26b-a4b",
      "baseUrl": "http://127.0.0.1:8181",
      "quantization": "Q4_0 QAT",
      "server": {
        "command": [
          "llama-server",
          "-m",
          "/path/to/model.gguf",
          "--port",
          "8181",
          "-c",
          "16384",
          "--jinja"
        ],
        "readyTimeoutSeconds": 600
      }
    },
    {
      "name": "qwen-3.6-35b-a3b",
      "baseUrl": "http://127.0.0.1:8181",
      "quantization": "Q4_K_M",
      "chatTemplateKwargs": { "enable_thinking": false },
      "server": {
        "command": [
          "llama-server",
          "-m",
          "/path/to/qwen.gguf",
          "--port",
          "8181",
          "-c",
          "16384",
          "--jinja"
        ]
      }
    }
  ]
}
```

`chatTemplateKwargs` is sent as `chat_template_kwargs` on every `/apply-template` call. Qwen hybrid models think by default; the `json_schema` grammar forbids the `<think>` block, so render their prompts with `{"enable_thinking": false}`.

## Run

```bash
D="$HOME/Library/Application Support/eido-dev/eval"
EIDO_EVAL_CASES="$D/cases" EIDO_EVAL_OUT="$D/results" \
  pnpm --filter @eido/core eval -- --candidates "$D/candidates.json"
```

The runner prints one row per candidate and the ids of the cases to read, and writes `results.json` with scores, model ids and per-case diffs. Baseline mode exits 0 unless a candidate could not run. `--enforce` also needs the confirmed `packages/core/src/eval/thresholds.json` and exits 1 when it is missing or a score misses it.
