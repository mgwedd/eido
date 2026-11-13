// @vitest-environment happy-dom
import { SettingsBody, type SettingsState } from "../components/settings-view"
import {
  activePasskey,
  backupFresh,
  backupNeverRun,
  chainOk,
  permissions,
} from "./fixtures/settings"
import { NOW, recoveryFixtures } from "./fixtures/recovery"
import { signedRoots } from "./fixtures/file-roots"
import { fakeBrowser } from "./push-device"
import { describeStates } from "./render-states"

const loaded = (
  over: Partial<Extract<SettingsState, { status: "loaded" }>>
): SettingsState => ({
  status: "loaded",
  recovery: { status: "ready", value: null },
  passkeys: { status: "ready", value: [activePasskey] },
  permissions: { status: "ready", value: permissions },
  backup: { status: "ready", value: backupFresh },
  chain: { status: "ready", value: chainOk },
  fileRoots: { status: "ready", value: signedRoots },
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
      now={NOW}
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
    state: "no recovery pending",
    render: body(loaded({ recovery: { status: "ready", value: null } })),
    role: "status",
    selector: 'a[href="/settings/recovery"] [role="status"]',
    message: "No recovery pending",
  },
  {
    state: "recovery pending",
    render: body(
      loaded({
        recovery: { status: "ready", value: recoveryFixtures.pending },
      })
    ),
    role: "status",
    selector: 'a[href="/settings/recovery"] [role="status"]',
    message: "Pending · matures in 23h",
  },
  {
    state: "recovery matured",
    render: body(
      loaded({
        recovery: { status: "ready", value: recoveryFixtures.matured },
      })
    ),
    role: "status",
    selector: 'a[href="/settings/recovery"] [role="status"]',
    message: "Pending · matured",
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
