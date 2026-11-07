// @vitest-environment happy-dom
import { StepUpPromptBody, type PromptState } from "../components/admin-step-up"
import { describeStates } from "./render-states"

const body = (state: PromptState) => () => (
  <StepUpPromptBody state={state} onConfirm={() => {}} onCancel={() => {}} />
)
const action = "Restart core and llama"
const change = {
  kind: "sign" as const,
  action: "Seal the Proton Bridge password",
  fields: [["Pin", "ab12 cd34"]] as const,
  payloadHash: "f00d".repeat(16),
}

describeStates("step-up prompt", [
  {
    state: "confirm",
    render: body({ kind: "elevate", action, phase: "idle" }),
    role: "status",
    message: "Admin changes stay unlocked for 5 minutes.",
  },
  {
    state: "waiting for the passkey",
    render: body({ kind: "elevate", action, phase: "waiting" }),
    role: "status",
    message: "Waiting for your passkey…",
  },
  {
    state: "step-up ended",
    render: body({ kind: "elevate", action, phase: "expired" }),
    role: "status",
    message:
      "Your 5 minutes ended. Nothing changed. Confirm again to restart core and llama.",
  },
  {
    state: "refused",
    render: body({ kind: "elevate", action, phase: "refused" }),
    role: "alert",
    message: "The passkey was not accepted. Nothing changed.",
  },
  {
    state: "sign a change",
    render: body({ ...change, phase: "idle" }),
    role: "status",
    message: null,
  },
  {
    state: "signing",
    render: body({ ...change, phase: "waiting" }),
    role: "status",
    message: "Waiting for your passkey…",
  },
])
