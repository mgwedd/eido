// @vitest-environment happy-dom
import { SettingsBody, type SettingsState } from "../components/settings-view"
import {
  activePasskey,
  backupFresh,
  backupNeverRun,
  chainOk,
  permissions,
} from "./fixtures/settings"
import { fakeBrowser } from "./push-device"
import { describeStates } from "./render-states"

const loaded = (
  over: Partial<Extract<SettingsState, { status: "loaded" }>>
): SettingsState => ({
  status: "loaded",
  passkeys: { status: "ready", value: [activePasskey] },
  permissions: { status: "ready", value: permissions },
  backup: { status: "ready", value: backupFresh },
  chain: { status: "ready", value: chainOk },
  ...over,
})
const body =
  (
    state: SettingsState,
    about = { version: "1.0.0", buildId: null as string | null }
  ) =>
  () => (
    <SettingsBody
      state={state}
      onRetry={() => undefined}
      about={about}
      pushDevice={fakeBrowser({ supported: false }).device}
    />
  )

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
    selector: '[aria-labelledby="settings-devices"] [role="status"]',
    message: "No passkey is enrolled.",
  },
  {
    state: "backup never run",
    render: body(
      loaded({ backup: { status: "ready", value: backupNeverRun } })
    ),
    role: "status",
    selector: '[aria-labelledby="settings-data"] [role="status"]',
    message: "No backup yet",
  },
  {
    state: "gate unreachable",
    render: body(loaded({ chain: { status: "offline" } })),
    role: "status",
    selector: '[aria-labelledby="settings-security"] [role="status"]',
    message: "Offline. Audit chain status is not stored on this device.",
  },
  {
    state: "read failed",
    render: body(loaded({ permissions: { status: "error" } })),
    role: "alert",
    message: "Could not read permissions from the gate.",
  },
])
