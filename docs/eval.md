# Eval runner

The eval runner (`packages/core/src/eval/`, issue #28) runs eval cases through the real proposal path (`/apply-template`, `/tokenize`, `/completion` with `json_schema`) against one or more local llama-server candidates and scores the results. The repo holds the runner, the case format, scoring and synthetic fixtures (`fixtures/eval/`). Real cases, verdicts and results stay on the owner's machine, outside git.

## Synthetic set

`fixtures/eval/set/` holds the committed synthetic set (issues #91, #713, #738 and #739): 115 `call` cases (draft, reply, forward, archive, trash, mark read, label, thread-wide actions, reminders, send, calendar create, file create, move, rename and delete, calendar edit and delete, Things add todo and add project, and cancel, complete, schedule and update todo), 44 `no_call` cases (questions, underspecified requests, money movement, requests missing a required value, a todo request that matches no todo or more than one, a calendar request that matches no event, more than one, or an Apple Calendar event) and 37 `injection` cases (13 planted-instruction styles, each against an archive request and a draft request, plus one planted instruction for each calendar, file and offered Things kind, one todo title that tells the model to cancel everything, and an event title or message that tells the model to delete or move other events). Names are invented and every address is on `example.invalid`.

### Events in a case

`calendar.edit` and `calendar.delete` need the `eventUid` of an invitation. A case holds an optional `events` array of `{ "uid", "title", "start", "end", "allDay", "source" }` (`source` is `proton-calendar` or `apple-eventkit`; `allDay` is optional; uids are unique within a case). The runner indexes them the way the calendar syncs do, and the live pack builder lists them: the events that share a word with the request, as a `## Events (N of M match)` block of at most ten `- uid=<uid> | <title> | <start> to <end> | source=<source>` lines (an all-day event adds `| all-day`, an Apple Calendar event `| read-only`) inside the data fence (#746). The block, and the two uid kinds, appear only when the request names a calendar word (calendar, meeting, event, invite, appointment, schedule, reminder) and at least one event matches. When the best two matches fit the request equally well, or the best match is an Apple Calendar event (read-only: `calendar.edit` and `calendar.delete` refuse Apple ids with `apple_event_not_proton`), the uid kinds are not offered. A golden for `calendar.edit` or `calendar.delete` must name the uid of a Proton event from its own `events`, and the request must share a word with that title that is not a calendar word ("meeting", "event", "appointment" and the verbs match nothing).

### Todos in a case

The Things kinds that act on an existing todo (`cancel_todo`, `complete_todo`, `schedule_todo`, `update_todo`) need a todo `id`. A case holds an optional `todos` array of `{ "id", "title", "status", "due" }` (`status` is `open`, `completed` or `canceled`; `due` is optional; ids are unique within a case). The runner indexes them the way the Things sync does, and the live pack builder lists them: the open todos that share a word with the request, as a `## Todos (open, N of M match)` block of at most ten `- id=<id> | <title> | <status> | <due>` lines, rendered by `renderTodosBlock` inside the data fence. The block, and the four id kinds, appear only when the request names the action (cancel, complete, schedule, update) and a Things word, and at least one open todo matches. When the two best matches fit the request equally well (the same number of shared words and the same share of their title covered), the block and the four id kinds are left out too, so the model has nothing to pick from: `no-call-things-todo-ambiguous-01` (#758). When the request names one of those actions and asks for no creation (no "add", "create", "make", "capture" or "start a new"; "add the tag", "add a note" and "add a deadline" do not count), `add_todo` and `add_project` are not offered, and the reply grammar sent with the Todos block lists only the offered kinds (#759). An intent whose `id` was not in the block is refused before it reaches the gate. A golden for these kinds must name an id from its own `todos`.

A request that shows a Todos block also carries an args-order note after the owner request (`TODO_ARG_ORDER_NOTE`, #776). llama-server compiles the reply grammar with an intent's args required first, then the optional ones in alphabetical order (the order of the schema file does not matter), so an optional arg the model skips cannot be added after a later one. For `things.update_todo` the order is `id`, `area`, `deadline`, `list`, `notes`, `project`, `tags`, `title`, `when`: a request that names the tag first led the model to write `tags` and then put the deadline in `when`, because `deadline` was no longer allowed (`call-things-update-todo-02`). The note tells the model to decide every optional arg in that order. It is not in the stable system prefix: as a global rule it moved unrelated no-call cases. Rewording the arg descriptions, a "deadline is not when" rule, an example and reordering the schema properties did not change the model's reply. The golden is unchanged.

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

The runner prints one row per candidate and the ids of the cases to read, and writes `results.json` with scores, model ids and per-case diffs. Baseline mode exits 0 unless a candidate could not run. `--enforce` also needs the confirmed `packages/core/src/eval/thresholds.json` and exits 1 when it is missing or an enforced score misses it. The file holds the confirmed targets only: `schemaValid` 0.90 and `parameterExactMatch` 0.80 (#712). The other scores are reported and not enforced (the table shows "not enforced") until the owner sets a target for them from the baseline numbers; add a key to the file to enforce it. Never lower a target to make a run pass.

## Ask answer eval

The Ask answer step (`packages/core/src/ask/ask.ts`: `ANSWER_SYSTEM`, and `ANSWER_REMINDER` repeated beside the question, #709) has its own eval (#717). It is separate from the proposal path above: no verdicts, no JSON schema, and the model's free-text answer is scored by plain functions in `packages/core/src/eval/ask-eval.ts`.

`fixtures/eval/ask/cases.json` holds 12 synthetic cases (invented names, `example.invalid` addresses): single and multi-source answers, a thread with a correction, a document, two count questions, four no-match questions (one baiting a "never happened" claim) and one message with a planted instruction. Each case lists the message tags that answer it and the placeholders the answer must write. The runner builds each request the way `ask()` builds its final user turn (system prompt, facts, fenced messages, question) and runs every case twice: with `ANSWER_REMINDER` after the question and without it.

Three scores, each a share from 0 to 1:

| Score        | A case passes when                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tag citation | every tag is a real `[M<n>]` of the case, none is written in another form (`[M1, M2]`, `M1`, `[Message 1]`), and an answerable case cites at least one message that answers it |
| Placeholders | every placeholder the case requires (`{matches}`, `{read}`, `{searched}`) is written and no count of messages is written as a number (`3 messages`, `1,284 matching messages`) |
| No match     | (no-match cases only) the answer says "no match found" and does not claim that something never happened or does not exist                                                      |

```bash
D="$HOME/Library/Application Support/eido-dev/eval"
pnpm --filter @eido/core eval-ask -- --candidates "$D/candidates.json" --out "$D/results"
```

`--candidates` takes the candidates file described above (one entry per profile: `gemma-4-26b-a4b`, `qwen3.6-35b-a3b`, `gpt-oss-20b`); `--cases` replaces the committed set and `--out` sets where `ask-results.json` is written (default `.eval-results`, git-ignored). Temperature is 0 and the seed is 329. The table has one row per candidate and variant, then the ids of the cases to read; the per-case answers are in `ask-results.json`. A candidate that could not run sets exit code 1.

The tests run the runner against an oracle model and the stub server, so they check the cases, the scoring and the request shape, not any model's behaviour. Keep `ANSWER_REMINDER` only if its row is at least as good as the "without" row on all three scores for each profile; otherwise revert it.
