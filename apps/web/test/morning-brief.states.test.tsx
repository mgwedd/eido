// @vitest-environment happy-dom
import { MorningBriefCard } from "../components/morning-brief-card"
import { NOW } from "./fixtures/today"
import { describeStates } from "./render-states"

const card = (state: Parameters<typeof MorningBriefCard>[0]["state"]) => () => (
  <MorningBriefCard state={state} now={NOW} onRetry={() => undefined} />
)

describeStates("Today: morning brief", [
  {
    state: "loading",
    render: card({ status: "loading" }),
    role: "status",
    message: "Loading morning brief…",
  },
  {
    state: "empty",
    render: card({ status: "empty" }),
    role: "status",
    message: "No brief yet.",
  },
  {
    state: "error",
    render: card({ status: "error" }),
    role: "alert",
    message: "Couldn't load morning brief.",
  },
])
