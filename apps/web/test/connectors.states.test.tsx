// @vitest-environment happy-dom
import { ConnectorsBody } from "../components/connectors-view"
import {
  AS_OF,
  driveDegraded,
  driveDisabled,
  driveDrifted,
  gmail,
  gmailUnpinned,
  sharedBridgeOpen,
} from "./fixtures/connectors"
import { describeStates } from "./render-states"

type State = Parameters<typeof ConnectorsBody>[0]["state"]
const body = (state: State) => () => (
  <ConnectorsBody state={state} onRetry={() => undefined} />
)

describeStates("Connectors", [
  {
    state: "loading",
    render: body({ status: "loading" }),
    role: "status",
    message: "Loading connectors…",
  },
  {
    state: "empty",
    render: body({
      status: "ready",
      connectors: [],
      unpinned: [],
      asOf: AS_OF,
    }),
    role: "status",
    message: "No connectors are configured.",
  },
  {
    state: "healthy",
    render: body({
      status: "ready",
      connectors: [gmail],
      unpinned: [],
      asOf: AS_OF,
    }),
    role: "status",
    message: "1 connector",
  },
  {
    state: "degraded",
    render: body({
      status: "ready",
      connectors: [gmail, driveDegraded],
      unpinned: [],
      asOf: AS_OF,
    }),
    role: "status",
    message: "2 connectors",
  },
  {
    state: "open (shared Bridge health)",
    render: body({
      status: "ready",
      connectors: sharedBridgeOpen,
      unpinned: [],
      asOf: AS_OF,
    }),
    role: "status",
    message: "4 connectors",
  },
  {
    state: "disabled",
    render: body({
      status: "ready",
      connectors: [driveDisabled],
      unpinned: [],
      asOf: AS_OF,
    }),
    role: "status",
    message: "1 connector",
  },
  {
    state: "disabled by manifest drift",
    render: body({
      status: "ready",
      connectors: [driveDrifted],
      unpinned: [],
      asOf: AS_OF,
    }),
    role: "status",
    message: "1 connector",
  },
  {
    state: "reviewed manifest placed, not pinned",
    render: body({
      status: "ready",
      connectors: [],
      unpinned: [gmailUnpinned],
      asOf: AS_OF,
    }),
    role: "status",
    message: "1 connector, 1 not pinned",
  },
  {
    state: "offline",
    render: body({ status: "offline" }),
    role: "status",
    message: "Offline. Connector status is not stored on this device.",
  },
  {
    state: "error",
    render: body({ status: "error" }),
    role: "alert",
    message: "Could not read connector status from the gate.",
  },
])
