// @vitest-environment happy-dom
import { vi } from "vitest"

import { RecoverCard, type RecoverState } from "@/components/recover-view"
import { NOW, recoveryFixtures } from "./fixtures/recovery"
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

function card(state: RecoverState, recoveryKey = "") {
  return () => (
    <RecoverCard
      state={state}
      host="eido.example.invalid"
      now={NOW}
      recoveryKey={recoveryKey}
      onKeyChange={noop}
      onStart={noop}
      onCreate={noop}
      onStartAgain={noop}
      onRetry={noop}
    />
  )
}

const waiting = (
  window: (typeof recoveryFixtures)[keyof typeof recoveryFixtures]
): RecoverState => ({ status: "window", window, creating: false, notice: null })

describeStates("Recovery states", [
  {
    state: "loading: checking the gate",
    render: card({ status: "checking" }),
    role: "status",
    message: "Checking…",
  },
  {
    state: "ready, no recovery started",
    render: card({ status: "ready", notice: null }),
    role: "status",
    message: null,
  },
  {
    state: "loading: starting the recovery",
    render: card({ status: "starting" }, "ABCD"),
    role: "status",
    message: "Starting recovery…",
  },
  {
    state: "pending: waiting out the delay",
    render: card(waiting(recoveryFixtures.pending), "ABCD"),
    role: "status",
    message: null,
  },
  {
    state: "matured: ready to create the passkey",
    render: card(waiting(recoveryFixtures.matured), "ABCD"),
    role: "status",
    message: "The wait is over. Create a new passkey on this phone.",
  },
  {
    state: "loading: waiting for the passkey",
    render: card(
      {
        status: "window",
        window: recoveryFixtures.matured,
        creating: true,
        notice: null,
      },
      "ABCD"
    ),
    role: "status",
    message: "Waiting for your passkey…",
  },
  {
    state: "expired",
    render: card(waiting(recoveryFixtures.expired), "ABCD"),
    role: "status",
    message: "This recovery ran out. Start again with your key.",
  },
  {
    state: "cancelled from a signed-in device",
    render: card({ status: "cancelled" }),
    role: "status",
    message: "Recovery cancelled.",
  },
  {
    state: "refused key",
    render: card({ status: "ready", notice: "refused" }, "ABCD"),
    role: "alert",
    message: "Key not accepted. Check the key and try again.",
  },
  {
    state: "rate limited",
    render: card({ status: "ready", notice: "rate-limited" }, "ABCD"),
    role: "alert",
    message: "Too many tries. Wait a few minutes.",
  },
  {
    state: "gate unreachable while starting",
    render: card({ status: "ready", notice: "offline" }, "ABCD"),
    role: "alert",
    message: "Cannot reach the Mac.",
  },
  {
    state: "gate unreachable while checking",
    render: card({ status: "check-failed", offline: true }),
    role: "alert",
    message: "Cannot reach the Mac.",
  },
  {
    state: "passkey prompt cancelled",
    render: card(
      {
        status: "window",
        window: recoveryFixtures.matured,
        creating: false,
        notice: "cancelled",
      },
      "ABCD"
    ),
    role: "alert",
    message:
      "The passkey prompt was cancelled. Nothing was saved. You can try again.",
  },
  {
    state: "opened from the wrong address",
    render: card({ status: "wrong-origin" }),
    role: "alert",
    message:
      "Open Eido from its Tailscale address to recover. Passkeys are bound to that address.",
  },
])
