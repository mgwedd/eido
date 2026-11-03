// @vitest-environment happy-dom
import { DueSoonCard } from "../components/due-soon-card"
import { NOW } from "./fixtures/today"
import { describeStates } from "./render-states"

const card = (state: Parameters<typeof DueSoonCard>[0]["state"]) => () => (
  <DueSoonCard
    state={state}
    now={NOW}
    activeEntity="all"
    onSelectEntity={() => undefined}
    onRetry={() => undefined}
  />
)

describeStates("Today: due soon", [
  {
    state: "loading",
    render: card({ status: "loading" }),
    role: "status",
    message: "Loading due soon obligations…",
  },
  {
    state: "empty",
    render: card({ status: "ready", entries: [], entities: [] }),
    role: "status",
    message: "No obligations yet.",
  },
  {
    state: "error",
    render: card({ status: "error" }),
    role: "alert",
    message: "Couldn't load due soon obligations.",
  },
])
