// Synthetic fixtures for the Admin Status page. Imported by tests only; never by app code
// (enforced by the `web-test-fixtures-are-test-only` rule in .dependency-cruiser.mts).
import type {
  GateAdminStack,
  StackDoctorReport,
  StackJobStatus,
} from "@eido/schemas"

type Processes = StackJobStatus["processes"]
type Check = StackDoctorReport["checks"][number]

const gateAndWeb: Processes = [
  { name: "gate", state: "running", controllable: false },
  { name: "web", state: "running", controllable: false },
]

const running: Processes = [
  ...gateAndWeb,
  { name: "core", state: "running", controllable: true },
  { name: "llama", state: "running", controllable: true },
]

const stopped: Processes = [
  ...gateAndWeb,
  { name: "core", state: "stopped", controllable: true },
  { name: "llama", state: "stopped", controllable: true },
]

const starting: Processes = [
  ...gateAndWeb,
  { name: "core", state: "starting", controllable: true },
  { name: "llama", state: "starting", controllable: true },
]

const stopping: Processes = [
  ...gateAndWeb,
  { name: "core", state: "stopping", controllable: true },
  { name: "llama", state: "stopping", controllable: true },
]

const llamaOnly: Processes = [
  ...gateAndWeb,
  { name: "core", state: "running", controllable: true },
  {
    name: "llama",
    state: "unavailable",
    controllable: true,
    message: "llama-server exited with code 1",
  },
]

const job = (processes: Processes): StackJobStatus => ({
  processes,
  tasks: [],
})

const stackAvailable = (processes: Processes): GateAdminStack => ({
  supervisor: "available",
  jobs: job(processes),
})

const stackUnavailable: GateAdminStack = { supervisor: "unavailable" }

const okCheck = (id: Check["id"], summary: string): Check => ({
  id,
  status: "ok",
  summary,
})

const llamaFailed: Check = {
  id: "llama-health",
  status: "fail",
  summary: "llama is not answering on its port.",
  fix: { action: "start-llama", text: "Start llama: press Restart." },
}

const keychainLocked: Check = {
  id: "keychain",
  status: "warn",
  summary: "The keychain is locked.",
  fix: { action: "unlock-keychain", text: "Unlock the keychain on the Mac." },
}

const tailscaleWarn: Check = {
  id: "tailscale",
  status: "warn",
  summary: "MagicDNS is off.",
}

const doctorMixed: StackDoctorReport = {
  checks: [
    okCheck("node", "Node 22 found."),
    keychainLocked,
    okCheck("vault", "Sealed tokens readable."),
    llamaFailed,
    tailscaleWarn,
    okCheck("ports", "Ports are free."),
  ],
}

const doctorAllOk: StackDoctorReport = {
  checks: [
    okCheck("node", "Node 22 found."),
    okCheck("vault", "Sealed tokens readable."),
  ],
}

export {
  doctorAllOk,
  doctorMixed,
  job,
  keychainLocked,
  llamaFailed,
  llamaOnly,
  okCheck,
  running,
  stackAvailable,
  stackUnavailable,
  starting,
  stopped,
  stopping,
  tailscaleWarn,
}
