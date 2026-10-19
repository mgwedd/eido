// @vitest-environment happy-dom
import { ConnectionBanner } from "../components/connection-banner"
import { ReachabilityProvider } from "../components/reachability"
import { reachabilityProbes } from "./fixtures/reachability"
import { describeStates } from "./render-states"

const banner = () => (
  <ReachabilityProvider>
    <ConnectionBanner />
  </ReachabilityProvider>
)

// Worked example of the state table: one row per designed state of the shell's banner.
describeStates("connection banner", [
  {
    state: "reachable",
    render: banner,
    fetch: reachabilityProbes.reachable,
    role: "status",
    message: null,
  },
  {
    state: "gate unreachable, network failure",
    render: banner,
    fetch: reachabilityProbes.unreachable,
    role: "status",
    message: "Can't reach Eido. Check that Tailscale is connected.",
  },
  {
    state: "gate unreachable, probe returns 503",
    render: banner,
    fetch: reachabilityProbes.unhealthy,
    role: "status",
    message: "Can't reach Eido. Check that Tailscale is connected.",
  },
])
