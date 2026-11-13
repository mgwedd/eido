// @vitest-environment happy-dom
import { vi } from "vitest"

import {
  RecoveryCancelCard,
  type CancelState,
} from "@/components/recovery-cancel-view"
import { RecoveryKeyCard } from "@/components/recovery-key-card"
import { KEY, NOW, recoveryFixtures } from "./fixtures/recovery"
import { describeStates } from "./render-states"

const noop = vi.fn()

function card(state: CancelState) {
  return () => (
    <RecoveryCancelCard
      state={state}
      now={NOW}
      onCancel={noop}
      onRetry={noop}
    />
  )
}

const pending = (
  over: Partial<Extract<CancelState, { status: "pending" }>> = {}
): CancelState => ({
  status: "pending",
  window: recoveryFixtures.pending,
  cancelling: false,
  notice: null,
  ...over,
})

describeStates("Recovery cancel states", [
  {
    state: "loading",
    render: card({ status: "loading" }),
    role: "status",
    message: "Checking…",
  },
  {
    state: "empty: no recovery pending",
    render: card({ status: "none" }),
    role: "status",
    message: "No recovery is pending.",
  },
  {
    state: "pending: shown with Cancel",
    render: card(pending()),
    role: "status",
    message: null,
  },
  {
    state: "loading: waiting for the passkey",
    render: card(pending({ cancelling: true })),
    role: "status",
    message: "Waiting for your passkey…",
  },
  {
    state: "passkey prompt cancelled",
    render: card(pending({ notice: "cancelled" })),
    role: "alert",
    message: "The passkey prompt was cancelled. The recovery is still pending.",
  },
  {
    state: "gate refused the cancel",
    render: card(pending({ notice: "refused" })),
    role: "alert",
    message: "The gate did not accept the cancel. Try again.",
  },
  {
    state: "signed out",
    render: card(pending({ notice: "signed-out" })),
    role: "alert",
    message: "Your session ended. Unlock Eido and try again.",
  },
  {
    state: "gate unreachable",
    render: card({ status: "failed", offline: true }),
    role: "alert",
    message: "Cannot reach the Mac.",
  },
])

describeStates("Recovery key card states", [
  {
    state: "shown once, nothing copied yet",
    render: () => (
      <RecoveryKeyCard
        recoveryKey={KEY}
        overline="Recovery cancelled"
        onContinue={noop}
      />
    ),
    role: "status",
    message: null,
  },
])
