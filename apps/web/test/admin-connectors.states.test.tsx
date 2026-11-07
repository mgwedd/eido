// @vitest-environment happy-dom
import {
  AdminConnectorsBody,
  type ConnectorActions,
} from "../components/admin-connectors-view"
import {
  drive,
  driveDisabled,
  gmail,
  gmailDegraded,
  gmailWithAccount,
  protonMail,
  protonWithPassword,
} from "./fixtures/admin-connectors"
import { describeStates } from "./render-states"

type Props = Parameters<typeof AdminConnectorsBody>[0]

const NOTICE = '[data-region="admin-connectors-notice"]'
const never = () => Promise.reject(new Error("not used by a state row"))
const actions: ConnectorActions = {
  sealBridge: never,
  changePin: never,
  sealSimpleFin: never,
  prepareGoogle: never,
  startGoogle: never,
  remove: () => undefined,
}
const ready = (
  connectors: Props["state"] extends infer S
    ? S extends { status: "ready"; connectors: infer C }
      ? C
      : never
    : never,
  notice: Props["notice"] = null
) => ({
  state: {
    status: "ready" as const,
    connectors,
    folders: 3,
  },
  notice,
})
const body = (props: Pick<Props, "state"> & { notice?: Props["notice"] }) =>
  function render() {
    return (
      <AdminConnectorsBody
        state={props.state}
        notice={props.notice ?? null}
        actions={actions}
        onRetry={() => undefined}
      />
    )
  }

describeStates("Admin connectors", [
  {
    state: "loading",
    render: body({ state: { status: "loading" } }),
    role: "status",
    message: "Loading connectors…",
  },
  {
    state: "gate unreachable",
    render: body({ state: { status: "unreachable" } }),
    role: "alert",
    message: "Can't reach the gate on the host.",
  },
  {
    state: "error",
    render: body({ state: { status: "error" } }),
    role: "alert",
    message: "Could not read the connectors from the gate.",
  },
  {
    state: "populated",
    render: body(ready([gmail, protonMail])),
    role: "status",
    selector: NOTICE,
    message: "",
  },
  {
    state: "Bridge with password stored and Gmail with account email",
    render: body(ready([gmailWithAccount, protonWithPassword])),
    role: "status",
    selector: NOTICE,
    message: "",
  },
  {
    state: "empty (nothing connected yet)",
    render: body(ready([])),
    role: "status",
    selector: NOTICE,
    message: "",
  },
  {
    state: "degraded and disabled connectors",
    render: body(ready([gmailDegraded, driveDisabled])),
    role: "status",
    selector: NOTICE,
    message: "",
  },
  {
    state: "back from Google, connected",
    render: body(
      ready([gmail, drive], {
        role: "status",
        text: "Drive connected. Health: healthy.",
      })
    ),
    role: "status",
    selector: NOTICE,
    message: "Drive connected. Health: healthy.",
  },
  {
    state: "back from Google, denied",
    render: body(
      ready([gmail], {
        role: "alert",
        text: "Drive was not connected. Google sign-in was denied.",
      })
    ),
    role: "alert",
    message: "Drive was not connected. Google sign-in was denied.",
  },
  {
    state: "back from Google, expired",
    render: body(
      ready([gmail], {
        role: "alert",
        text: "The Google sign-in expired or was already used. Start it again.",
      })
    ),
    role: "alert",
    message: "The Google sign-in expired or was already used. Start it again.",
  },
])
