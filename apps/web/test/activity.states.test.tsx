// @vitest-environment happy-dom
import { ActivityBody, ChainBanner } from "../components/activity-view"
import { HistoryBody } from "../components/activity-history"
import { autoRow, chainBroken, chainOk, history } from "./fixtures/activity"
import { describeStates } from "./render-states"

type List = Parameters<typeof ActivityBody>[0]["state"]
type Chain = Parameters<typeof ChainBanner>[0]["state"]
type Hist = Parameters<typeof HistoryBody>[0]["state"]
const noop = () => undefined
const list = (state: List) => () => (
  <ActivityBody
    state={state}
    onRetry={noop}
    onLoadMore={noop}
    onUndoSettled={noop}
  />
)
const chain = (state: Chain) => () => (
  <ChainBanner state={state} onVerify={noop} />
)
const hist = (state: Hist) => () => <HistoryBody state={state} onRetry={noop} />
const ready = (more: "idle" | "loading" | "error"): List => ({
  status: "ready",
  entries: [autoRow],
  cursor: 5,
  more,
})

describeStates("Activity list", [
  {
    state: "loading",
    render: list({ status: "loading" }),
    role: "status",
    message: "Loading activity…",
  },
  {
    state: "empty",
    render: list({ status: "ready", entries: [], cursor: null, more: "idle" }),
    role: "status",
    message: "No activity yet.",
  },
  {
    state: "loaded",
    render: list(ready("idle")),
    role: "status",
    message: "1 entry loaded",
  },
  {
    state: "loading more",
    render: list(ready("loading")),
    role: "status",
    message: "1 entry loaded",
  },
  {
    state: "load more failed",
    render: list(ready("error")),
    role: "alert",
    message: "Could not load more entries.",
  },
  {
    state: "error",
    render: list({ status: "error" }),
    role: "alert",
    message: "Could not read the audit log.",
  },
  {
    state: "offline",
    render: list({ status: "offline" }),
    role: "status",
    message: "Offline. Activity is not stored on this device.",
  },
])

describeStates("Activity chain banner", [
  {
    state: "verifying",
    render: chain({ status: "loading" }),
    role: "status",
    message: "Verifying audit chain…",
  },
  {
    state: "verified",
    render: chain({ status: "ready", chain: chainOk }),
    role: "status",
    message: "Audit chain verified · 1286 entries",
  },
  {
    state: "broken",
    render: chain({ status: "ready", chain: chainBroken }),
    role: "alert",
    message:
      "Audit chain broken at entry 1207. Log entries after this point cannot be trusted.",
  },
  {
    state: "unavailable",
    render: chain({ status: "error" }),
    role: "status",
    message: "Chain status unavailable",
  },
  {
    state: "unreachable",
    render: chain({ status: "offline" }),
    role: "status",
    message: "Chain status unavailable",
  },
])

describeStates("Intent history", [
  {
    state: "loading",
    render: hist({ status: "loading" }),
    role: "status",
    message: "Loading history…",
  },
  {
    state: "empty",
    render: hist({ status: "ready", entries: [] }),
    role: "status",
    message: "No history recorded",
  },
  {
    state: "entries",
    render: hist({ status: "ready", entries: history.entries }),
    role: "status",
    message: "2 history entries",
  },
  {
    state: "error",
    render: hist({ status: "error" }),
    role: "alert",
    message: "Could not read this intent's history.",
  },
])
