// @vitest-environment happy-dom
import { vi } from "vitest"
import { TooltipProvider } from "@eido/ui/components/tooltip"
import { NotificationsSection } from "../components/settings-view"
import { PUSH_ID_KEY } from "@/lib/push"
import { fakeBrowser } from "./push-device"
import { describeStates } from "./render-states"

type Options = Parameters<typeof fakeBrowser>[0]

const section = (options: Options, storedId?: string) => () => {
  localStorage.clear()
  if (storedId) localStorage.setItem(PUSH_ID_KEY, storedId)
  return (
    <TooltipProvider>
      <NotificationsSection device={fakeBrowser(options).device} />
    </TooltipProvider>
  )
}

// The shared stub answers with an empty body, so rows that need the gate's list stub it.
const listed = (ids: string[]) => () => {
  vi.stubGlobal("fetch", () =>
    Promise.resolve(
      new Response(JSON.stringify({ subscriptions: ids.map((id) => ({ id })) }))
    )
  )
}

describeStates("Notifications", [
  {
    state: "push not installed (iOS)",
    render: section({ supported: false, standalone: false }),
    role: "status",
    message: "Add to Home Screen first",
  },
  {
    state: "push unsupported",
    render: section({ supported: false }),
    role: "status",
    message: "Not supported in this browser",
  },
  {
    state: "push denied",
    render: section({ permission: "denied" }),
    role: "status",
    message: "Blocked in browser settings",
  },
  {
    state: "subscribed",
    render: () => {
      listed(["sub-1"])()
      return section({ subscribed: true }, "sub-1")()
    },
    role: "status",
    message: "Subscribed",
  },
  {
    state: "not subscribed",
    render: () => {
      listed([])()
      return section({})()
    },
    role: "status",
    message: "Not subscribed",
  },
  {
    state: "offline",
    render: section({}),
    fetch: { kind: "network-failure" },
    role: "status",
    message: "Offline. Push status is not stored on this device.",
  },
  {
    state: "read failed",
    render: section({}),
    fetch: { kind: "response", status: 500 },
    role: "alert",
    message: "Could not read push status from the gate.",
  },
])
