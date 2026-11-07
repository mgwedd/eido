// @vitest-environment happy-dom
import { DevicesBody } from "../components/admin-devices-view"
import { describeStates } from "./render-states"

type State = Parameters<typeof DevicesBody>[0]["state"]
const body = (state: State) => () => (
  <DevicesBody
    state={state}
    onIssue={() => undefined}
    onDone={() => undefined}
  />
)
/** Local 10:42 whatever the machine's zone is. */
const expiresAt = new Date(2026, 10, 7, 10, 42).toISOString()
const code: State = { status: "code", code: "4F7K-9QX2-MB3D-H8RT", expiresAt }

describeStates("Admin Devices", [
  {
    state: "signing",
    render: body({ status: "signing" }),
    role: "status",
    message: "Waiting for your passkey…",
  },
  {
    state: "code shown, the code",
    render: body(code),
    role: "status",
    selector: '[aria-label="Enrolment code"] > span:first-child',
    message: "4F7K-9QX2-MB3D-H8RT",
  },
  {
    state: "code shown, the note",
    render: body(code),
    role: "status",
    selector: '[aria-label="Enrolment code"] > span:last-child',
    message:
      "Shown once · expires 10:42 · enter it at /enroll on the new device",
  },
  {
    state: "expired",
    render: body({ status: "expired" }),
    role: "alert",
    message: "The code expired unused. Issue a new one.",
  },
  {
    state: "refused",
    render: body({ status: "refused" }),
    role: "alert",
    message: "Not issued: the passkey signature was refused.",
  },
  {
    state: "error",
    render: body({ status: "error" }),
    role: "alert",
    message:
      "Could not issue a code: the gate did not answer. Nothing was issued.",
  },
  {
    state: "gate unreachable",
    render: body({ status: "unreachable" }),
    role: "alert",
    message: "Can't reach the gate on the host.",
  },
])
