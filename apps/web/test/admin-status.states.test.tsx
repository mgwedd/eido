// @vitest-environment happy-dom
import type { StackJobStatus } from "@eido/schemas"
import { StatusBody } from "../components/admin-status-view"
import {
  doctorAllOk,
  doctorMixed,
  llamaOnly,
  running,
  starting,
  stopped,
  stopping,
} from "./fixtures/admin-status"
import { describeStates } from "./render-states"

type Props = Parameters<typeof StatusBody>[0]
const body = (props: Pick<Props, "state"> & Partial<Props>) => () => (
  <StatusBody
    acting={null}
    notice={null}
    loginPending={false}
    onAct={() => undefined}
    onToggleLogin={() => undefined}
    onRetry={() => undefined}
    {...props}
  />
)

const ready = (processes: StackJobStatus["processes"]) =>
  ({
    status: "ready",
    processes,
    checks: { kind: "ready", checks: doctorMixed.checks },
    loginItem: { kind: "ready", enabled: true },
  }) satisfies Props["state"]

describeStates("Admin status", [
  {
    state: "loading",
    render: body({ state: { status: "loading" } }),
    role: "status",
    message: "Loading the stack status…",
  },
  {
    state: "error",
    render: body({ state: { status: "error" } }),
    role: "alert",
    message: "Could not read the stack status from the gate.",
  },
  {
    state: "gate unreachable",
    render: body({ state: { status: "unreachable" } }),
    role: "alert",
    message: "Can't reach the gate on the host.",
  },
  {
    state: "supervisor down",
    render: body({ state: { status: "down" } }),
    role: "status",
    message:
      "The stack supervisor is not answering. Start, Stop, Restart and the checks are hidden until it answers. On the Mac, run pnpm stack:status.",
  },
  {
    state: "running",
    render: body({ state: ready(running) }),
    role: "status",
    message: "core running, llama running.",
  },
  {
    state: "running with checks all OK",
    render: body({
      state: {
        ...ready(running),
        checks: { kind: "ready", checks: doctorAllOk.checks },
      },
    }),
    role: "status",
    message: "core running, llama running.",
  },
  {
    state: "one process unavailable",
    render: body({ state: ready(llamaOnly) }),
    role: "status",
    message: "core running, llama unavailable.",
  },
  {
    state: "stopped",
    render: body({ state: ready(stopped) }),
    role: "status",
    message:
      "Core and llama are stopped. Ask, sync and the queue wait until you start them.",
  },
  {
    state: "acting (restart)",
    render: body({ state: ready(running), acting: "restart" }),
    role: "status",
    message: "Restarting core and llama…",
  },
  {
    state: "acting (stop)",
    render: body({ state: ready(running), acting: "stop" }),
    role: "status",
    message: "Stopping core and llama…",
  },
  {
    state: "acting (start)",
    render: body({ state: ready(stopped), acting: "start" }),
    role: "status",
    message: "Starting core and llama…",
  },
  {
    state: "supervisor reports processes starting",
    render: body({ state: ready(starting) }),
    role: "status",
    message: "Starting core and llama…",
  },
  {
    state: "supervisor reports processes stopping",
    render: body({ state: ready(stopping) }),
    role: "status",
    message: "Stopping core and llama…",
  },
  {
    state: "a Start, Stop or Restart refused",
    render: body({
      state: ready(running),
      notice: "Another stack job is running.",
    }),
    role: "alert",
    message: "Another stack job is running.",
  },
])
