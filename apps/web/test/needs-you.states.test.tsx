// @vitest-environment happy-dom
import { NeedsYouCard } from "../components/needs-you"
import { NOW, pendingIntents } from "./fixtures/today"
import { describeStates } from "./render-states"

const card = (state: Parameters<typeof NeedsYouCard>[0]["state"]) => () => (
  <NeedsYouCard state={state} now={NOW} onRetry={() => undefined} />
)

describeStates("Today: needs you", [
  {
    state: "loading",
    render: card({ status: "loading" }),
    role: "status",
    message: "Loading what needs you…",
  },
  {
    state: "empty",
    render: card({ status: "ready", intents: [] }),
    role: "status",
    message: "Nothing waiting for you.",
  },
  {
    state: "populated",
    render: card({ status: "ready", intents: [...pendingIntents] }),
    role: "status",
    message: "2 items need you",
  },
  {
    state: "error",
    render: card({ status: "error" }),
    role: "alert",
    message: "Couldn't load what needs you.",
  },
])
