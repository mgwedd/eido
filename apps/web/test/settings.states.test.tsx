// @vitest-environment happy-dom
import { SettingsBody, type SettingsState } from "../components/settings-view"
import { activePasskey, chainOk, permissions } from "./fixtures/settings"
import { describeStates } from "./render-states"

const loaded = (
  over: Partial<Extract<SettingsState, { status: "loaded" }>>
): SettingsState => ({
  status: "loaded",
  passkeys: { status: "ready", value: [activePasskey] },
  permissions: { status: "ready", value: permissions },
  chain: { status: "ready", value: chainOk },
  ...over,
})
const body =
  (
    state: SettingsState,
    about = { version: "1.0.0", buildId: null as string | null }
  ) =>
  () => <SettingsBody state={state} onRetry={() => undefined} about={about} />

describeStates("Settings", [
  {
    state: "loading",
    render: body({ status: "loading" }),
    role: "status",
    message: "Loading settings…",
  },
  {
    state: "no passkey enrolled",
    render: body(loaded({ passkeys: { status: "ready", value: [] } })),
    role: "status",
    message: "No passkey is enrolled.",
  },
  {
    state: "gate unreachable",
    render: body(loaded({ chain: { status: "offline" } })),
    role: "status",
    message: "Offline. Audit chain status is not stored on this device.",
  },
  {
    state: "read failed",
    render: body(loaded({ permissions: { status: "error" } })),
    role: "alert",
    message: "Could not read permissions from the gate.",
  },
])
