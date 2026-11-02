// @vitest-environment happy-dom
import { vi } from "vitest"

import { UnlockCard, type UnlockState } from "@/components/unlock-view"
import { describeStates } from "./render-states"

const noop = vi.fn()

function card(state: UnlockState) {
  return () => (
    <UnlockCard
      state={state}
      host="eido.example.invalid"
      onUnlock={noop}
      onRetry={noop}
    />
  )
}

describeStates("Unlock states", [
  {
    state: "checking",
    render: card({ status: "checking" }),
    role: "status",
    message: "Checking this device…",
  },
  {
    state: "ready",
    render: card({ status: "ready" }),
    role: "status",
    message: null,
  },
  {
    state: "session expired",
    render: card({ status: "expired" }),
    role: "status",
    message: "Your session expired. Unlock to continue.",
  },
  {
    state: "waiting for Face ID",
    render: card({ status: "waiting" }),
    role: "status",
    message: "Waiting for Face ID…",
  },
  {
    state: "no passkey on this device",
    render: card({ status: "not-enrolled" }),
    role: "alert",
    message: "This device has no passkey yet.",
  },
  {
    state: "Face ID cancelled",
    render: card({ status: "cancelled" }),
    role: "alert",
    message: "Face ID was cancelled. Eido is still locked.",
  },
  {
    state: "gate refused the passkey",
    render: card({ status: "rejected", message: "Passkey was revoked." }),
    role: "alert",
    message: "Passkey was revoked.",
  },
  {
    state: "gate unreachable while unlocking",
    render: card({ status: "offline" }),
    role: "alert",
    message: "Can't reach Eido. Check that Tailscale is connected.",
  },
  {
    state: "gate unreachable while checking",
    render: card({ status: "check-failed", offline: true }),
    role: "alert",
    message: "Can't reach Eido. Check that Tailscale is connected.",
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
    message: "Open Eido from its Tailscale address to unlock.",
  },
  {
    state: "browser without passkeys",
    render: card({ status: "unsupported" }),
    role: "alert",
    message: "This browser can't use passkeys.",
  },
])
