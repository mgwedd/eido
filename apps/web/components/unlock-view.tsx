"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Loader2, ScanFace } from "lucide-react"

import { Alert, AlertDescription } from "@eido/ui/components/alert"
import { Button } from "@eido/ui/components/button"
import { Card, CardContent } from "@eido/ui/components/card"
import {
  checkEnvironment,
  loadCredentialStatus,
  unlock,
  type Environment,
} from "@/lib/auth/unlock"

type UnlockState =
  | { status: "checking" }
  | { status: "not-enrolled" }
  | { status: "check-failed"; offline: boolean }
  | { status: "ready" }
  | { status: "expired" }
  | { status: "waiting" }
  | { status: "cancelled" }
  | { status: "rejected"; message: string }
  | { status: "offline" }
  | { status: "wrong-origin" }
  | { status: "unsupported" }

const MESSAGES = {
  "not-enrolled": "This device has no passkey yet.",
  cancelled: "Face ID was cancelled. Eido is still locked.",
  offline: "Can't reach Eido. Check that Tailscale is connected.",
  "wrong-origin": "Open Eido from its Tailscale address to unlock.",
  unsupported: "This browser can't use passkeys.",
} as const

function alertMessage(state: UnlockState): string | null {
  switch (state.status) {
    case "not-enrolled":
    case "cancelled":
    case "offline":
    case "wrong-origin":
    case "unsupported":
      return MESSAGES[state.status]
    case "rejected":
      return state.message
    case "check-failed":
      return state.offline
        ? MESSAGES.offline
        : "Couldn't check this device with the gate."
    default:
      return null
  }
}

function UnlockCard({
  state,
  host,
  onUnlock,
  onRetry,
}: {
  state: UnlockState
  host: string | null
  onUnlock: () => void
  onRetry: () => void
}) {
  const error = alertMessage(state)
  const canUnlock =
    state.status === "ready" ||
    state.status === "expired" ||
    state.status === "cancelled" ||
    state.status === "rejected" ||
    state.status === "offline"
  const waiting = state.status === "waiting"
  const progress =
    state.status === "checking"
      ? "Checking this device…"
      : waiting
        ? "Waiting for Face ID…"
        : state.status === "expired"
          ? "Your session expired. Unlock to continue."
          : ""

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 p-4">
      <p className="text-sm font-semibold tracking-wide">Eido</p>
      <Card className="w-full max-w-sm">
        <CardContent className="flex flex-col gap-5">
          <header className="flex flex-col gap-1.5">
            <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              Locked
            </p>
            <h1 className="text-xl font-semibold tracking-tight">
              Unlock Eido
            </h1>
          </header>

          {host !== null ? (
            <div className="flex flex-col gap-1 rounded-lg border p-3">
              <span className="text-xs text-muted-foreground">
                Passkey will be used on
              </span>
              <span className="font-mono text-sm break-all">{host}</span>
            </div>
          ) : null}

          <div role="status" className="flex items-center gap-2 text-sm">
            {progress !== "" ? (
              <>
                <Loader2
                  aria-hidden
                  className="size-4 animate-spin text-muted-foreground"
                />
                <span>{progress}</span>
              </>
            ) : null}
          </div>

          {error !== null ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {state.status === "check-failed" ? (
            <Button
              variant="outline"
              size="lg"
              onClick={onRetry}
              className="h-12 rounded-xl"
            >
              Try again
            </Button>
          ) : null}

          {canUnlock || waiting ? (
            <Button
              size="lg"
              onClick={onUnlock}
              disabled={waiting}
              className="h-12 rounded-xl"
            >
              <ScanFace aria-hidden />
              Unlock with Face ID
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}

const subscribeNever = () => () => undefined
const readEnvironment = (): Environment =>
  checkEnvironment(
    window.location.hostname,
    typeof PublicKeyCredential !== "undefined" &&
      typeof navigator.credentials?.get === "function"
  )
const readHost = () => window.location.hostname

function UnlockView({
  next,
  expired = false,
}: {
  next: string
  expired?: boolean
}) {
  const router = useRouter()
  const environment = React.useSyncExternalStore(
    subscribeNever,
    readEnvironment,
    () => null
  )
  const host = React.useSyncExternalStore(subscribeNever, readHost, () => null)
  const [state, setState] = React.useState<UnlockState>({ status: "checking" })
  const [attempt, setAttempt] = React.useState(0)

  React.useEffect(() => {
    if (environment !== "ok") return
    const controller = new AbortController()
    void loadCredentialStatus(controller.signal).then((result) => {
      if (controller.signal.aborted) return
      if (!result.ok) {
        setState({
          status: "check-failed",
          offline: result.reason === "offline",
        })
      } else if (result.status.sessionExpiresAt !== null && !expired) {
        router.replace(next)
      } else {
        setState({
          status: !result.status.enrolled
            ? "not-enrolled"
            : expired
              ? "expired"
              : "ready",
        })
      }
    })
    return () => controller.abort()
  }, [environment, attempt, next, expired, router])

  const retry = React.useCallback(() => {
    setState({ status: "checking" })
    setAttempt((n) => n + 1)
  }, [])

  const run = React.useCallback(async () => {
    setState({ status: "waiting" })
    const result = await unlock()
    if (result.ok) {
      router.replace(next)
    } else if (result.reason === "rejected") {
      setState({ status: "rejected", message: result.message })
    } else {
      setState({ status: result.reason })
    }
  }, [next, router])

  const shown: UnlockState =
    environment === "wrong-origin" || environment === "unsupported"
      ? { status: environment }
      : state

  return (
    <UnlockCard
      state={shown}
      host={host}
      onUnlock={() => void run()}
      onRetry={retry}
    />
  )
}

export { UnlockCard, UnlockView }
export type { UnlockState }
