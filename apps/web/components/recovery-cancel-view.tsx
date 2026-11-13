"use client"

import * as React from "react"
import { Loader2, TriangleAlert } from "lucide-react"
import type { GateRecoveryWindow } from "@eido/schemas"

import { Alert, AlertDescription } from "@eido/ui/components/alert"
import { Button } from "@eido/ui/components/button"
import { Card, CardContent } from "@eido/ui/components/card"
import { AuthenticatorIcon } from "@/components/authenticator-icon"
import { RecoveryKeyCard } from "@/components/recovery-key-card"
import {
  DelayProgress,
  PendingHeader,
  ReadyIn,
  WindowTimes,
} from "@/components/recovery-window"
import { authenticatorCopy, useAuthenticatorLabel } from "@/lib/authenticator"
import { loadCredentialStatus } from "@/lib/auth/unlock"
import { RECOVERY_POLL_MS, cancelRecovery, recoveryPhase } from "@/lib/recovery"
import type { RecoveryFailure } from "@/lib/recovery"

type CancelNotice = Exclude<RecoveryFailure, "refused" | "not-pending">

type CancelState =
  | { status: "loading" }
  | { status: "failed"; offline: boolean }
  | { status: "none" }
  | {
      status: "pending"
      window: GateRecoveryWindow
      cancelling: boolean
      notice: CancelNotice | "refused" | null
    }

const NOTICES = {
  offline: "Cannot reach the Mac.",
  unreadable: "The gate sent an answer Eido could not read.",
  "signed-out": "Your session ended. Unlock Eido and try again.",
  "rate-limited": "Too many tries. Wait a few minutes.",
  refused: "The gate did not accept the cancel. Try again.",
} as const

function noticeMessage(
  notice: CancelNotice | "refused" | null,
  subject: string
): string | null {
  switch (notice) {
    case null:
      return null
    case "cancelled":
      return `${subject} was cancelled. The recovery is still pending.`
    default:
      return NOTICES[notice]
  }
}

function RecoveryCancelCard({
  state,
  now,
  onCancel,
  onRetry,
}: {
  state: CancelState
  now: number
  onCancel: () => void
  onRetry: () => void
}) {
  const copy = authenticatorCopy(useAuthenticatorLabel())
  const pending = state.status === "pending" ? state : null
  const error =
    state.status === "failed"
      ? state.offline
        ? NOTICES.offline
        : "Couldn't check recovery with the gate."
      : pending === null
        ? null
        : noticeMessage(pending.notice, copy.subject)

  return (
    <Card className="w-full max-w-md">
      <CardContent className="flex flex-col gap-5">
        <div role="status" className="flex items-center gap-2 text-sm">
          {state.status === "loading" ? (
            <>
              <Loader2
                aria-hidden
                className="size-4 animate-spin text-muted-foreground"
              />
              <span>Checking…</span>
            </>
          ) : null}
          {pending?.cancelling ? (
            <>
              <Loader2
                aria-hidden
                className="size-4 animate-spin text-muted-foreground"
              />
              <span>Waiting for {copy.waitingFor}…</span>
            </>
          ) : null}
          {state.status === "none" ? (
            <span>No recovery is pending.</span>
          ) : null}
        </div>

        {error !== null ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {state.status === "failed" ? (
          <Button size="lg" onClick={onRetry} className="h-12 rounded-xl">
            Try again
          </Button>
        ) : null}

        {pending !== null ? (
          <>
            <Alert role="note">
              <TriangleAlert aria-hidden />
              <AlertDescription>
                <b className="font-medium">
                  Someone entered your recovery key.
                </b>{" "}
                If this was not you, cancel it now.
              </AlertDescription>
            </Alert>
            <PendingHeader window={pending.window} now={now} />
            {recoveryPhase(pending.window, now) === "pending" ? (
              <>
                <ReadyIn window={pending.window} now={now} />
                <DelayProgress window={pending.window} now={now} />
              </>
            ) : null}
            <WindowTimes window={pending.window} />
            <Button
              type="button"
              size="lg"
              variant="destructive"
              disabled={pending.cancelling}
              onClick={onCancel}
              className="h-12 rounded-xl"
            >
              <AuthenticatorIcon />
              Cancel recovery
            </Button>
            <p className="text-xs text-muted-foreground">
              Cancelling asks for your passkey and replaces your recovery key.
            </p>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}

const subscribeNever = () => () => undefined
const readHost = () => window.location.hostname

/** The signed-in side: shows a pending recovery and cancels it with this device's passkey. */
function RecoveryCancelView() {
  const host = React.useSyncExternalStore(subscribeNever, readHost, () => null)
  const [state, setState] = React.useState<CancelState>({ status: "loading" })
  const [attempt, setAttempt] = React.useState(0)
  const [now, setNow] = React.useState(() => Date.now())
  const [replacementKey, setReplacementKey] = React.useState<string | null>(
    null
  )

  React.useEffect(() => {
    const controller = new AbortController()
    const refresh = () =>
      void loadCredentialStatus(controller.signal).then((result) => {
        if (controller.signal.aborted) return
        setNow(Date.now())
        if (!result.ok) {
          setState((current) =>
            current.status === "pending"
              ? current
              : { status: "failed", offline: result.reason === "offline" }
          )
          return
        }
        const recovery = result.status.recovery
        setState((current) =>
          recovery === undefined ||
          recoveryPhase(recovery, Date.now()) === "expired"
            ? { status: "none" }
            : {
                status: "pending",
                window: recovery,
                cancelling: current.status === "pending" && current.cancelling,
                notice: current.status === "pending" ? current.notice : null,
              }
        )
      })
    refresh()
    const timer = setInterval(refresh, RECOVERY_POLL_MS)
    return () => {
      clearInterval(timer)
      controller.abort()
    }
  }, [attempt])

  const showingWindow = state.status === "pending"
  React.useEffect(() => {
    if (!showingWindow) return
    const tick = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(tick)
  }, [showingWindow])

  const cancel = React.useCallback(async () => {
    if (state.status !== "pending") return
    const { window: held } = state
    setState({
      status: "pending",
      window: held,
      cancelling: true,
      notice: null,
    })
    const result = await cancelRecovery(host ?? window.location.hostname)
    if (result.ok) {
      setReplacementKey(result.value)
      setState({ status: "none" })
      return
    }
    if (result.reason === "not-pending") {
      setState({ status: "none" })
      return
    }
    setState({
      status: "pending",
      window: held,
      cancelling: false,
      notice: result.reason,
    })
  }, [host, state])

  if (replacementKey !== null) {
    return (
      <RecoveryKeyCard
        recoveryKey={replacementKey}
        overline="Recovery cancelled"
        onContinue={() => setReplacementKey(null)}
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold tracking-tight">Recovery</h1>
      <RecoveryCancelCard
        state={state}
        now={now}
        onCancel={() => void cancel()}
        onRetry={() => {
          setState({ status: "loading" })
          setAttempt((n) => n + 1)
        }}
      />
    </div>
  )
}

export { RecoveryCancelCard, RecoveryCancelView }
export type { CancelState }
