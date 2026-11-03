// @vitest-environment happy-dom
import { vi } from "vitest"

import { EnrollCard, type EnrollState } from "@/components/enroll-view"
import { stubIphone } from "./platform"
import { describeStates } from "./render-states"

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string
    children: string
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const noop = vi.fn()

function card(state: EnrollState) {
  return () => (
    <EnrollCard
      state={state}
      host="eido.example.invalid"
      code=""
      next="/"
      onCodeChange={noop}
      onEnrol={noop}
      onRetry={noop}
    />
  )
}

function iphone(state: EnrollState) {
  return () => {
    stubIphone()
    return card(state)()
  }
}

describeStates("Enrol states", [
  {
    state: "checking",
    render: card({ status: "checking" }),
    role: "status",
    message: "Checking this device…",
  },
  {
    state: "not enrolled, code empty",
    render: card({ status: "ready" }),
    role: "status",
    message: null,
  },
  {
    state: "waiting for the passkey",
    render: card({ status: "enrolling" }),
    role: "status",
    message: "Waiting for your passkey…",
  },
  {
    state: "waiting for Face ID on an iPhone",
    render: iphone({ status: "enrolling" }),
    role: "status",
    message: "Waiting for Face ID…",
  },
  {
    state: "enrolled",
    render: card({ status: "enrolled", createdAt: null, signedIn: true }),
    role: "status",
    message: "This phone can now approve actions.",
  },
  {
    state: "passkey prompt cancelled",
    render: card({ status: "cancelled" }),
    role: "alert",
    message:
      "The passkey prompt was cancelled. Nothing was saved. You can try again.",
  },
  {
    state: "Face ID cancelled on an iPhone",
    render: iphone({ status: "cancelled" }),
    role: "alert",
    message: "Face ID was cancelled. Nothing was saved. You can try again.",
  },
  {
    state: "gate refused the enrolment",
    render: card({ status: "rejected", message: "the enrolment was refused" }),
    role: "alert",
    message: "the enrolment was refused",
  },
  {
    state: "gate unreachable while enrolling",
    render: card({ status: "offline" }),
    role: "alert",
    message: "Enrolment needs a connection to the Mac.",
  },
  {
    state: "gate unreachable while checking",
    render: card({ status: "check-failed", offline: true }),
    role: "alert",
    message: "Enrolment needs a connection to the Mac.",
  },
  {
    state: "gate answered something unreadable while checking",
    render: card({ status: "check-failed", offline: false }),
    role: "alert",
    message: "Couldn't check this device with the gate.",
  },
  {
    state: "opened from the wrong address",
    render: card({ status: "wrong-origin" }),
    role: "alert",
    message:
      "Open Eido from its Tailscale address to enrol. Passkeys are bound to that address.",
  },
  {
    state: "browser without passkeys",
    render: card({ status: "unsupported" }),
    role: "alert",
    message:
      "This browser cannot create passkeys. Use Safari on iOS 17+ or a current desktop browser.",
  },
])
