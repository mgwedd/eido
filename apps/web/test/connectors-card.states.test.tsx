// @vitest-environment happy-dom
import { ConnectorsCard } from "../components/connectors-card"
import { sharedBridgeOpen } from "./fixtures/connectors"
import { NOW } from "./fixtures/today"
import { describeStates } from "./render-states"

const card = (state: Parameters<typeof ConnectorsCard>[0]["state"]) => () => (
  <ConnectorsCard state={state} now={NOW} onRetry={() => undefined} />
)

describeStates("Today: connectors", [
  {
    state: "loading",
    render: card({ status: "loading" }),
    role: "status",
    message: "Loading connectors…",
  },
  {
    state: "empty",
    render: card({ status: "ready", connectors: [] }),
    role: "status",
    message: "No connectors pinned yet.",
  },
  {
    state: "populated",
    render: card({ status: "ready", connectors: [...sharedBridgeOpen] }),
    role: "status",
    message: "4 manifests pinned · 2 breakers open",
  },
  {
    state: "error",
    render: card({ status: "error" }),
    role: "alert",
    message: "Couldn't load connectors.",
  },
])
