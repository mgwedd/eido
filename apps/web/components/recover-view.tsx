"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { KeyRound, Loader2 } from "lucide-react"
import type { GateRecoveryWindow } from "@eido/schemas"

import { Alert, AlertDescription } from "@eido/ui/components/alert"
import { Badge } from "@eido/ui/components/badge"
import { Button, buttonVariants } from "@eido/ui/components/button"
import { Card, CardContent } from "@eido/ui/components/card"
import { Input } from "@eido/ui/components/input"
import { Label } from "@eido/ui/components/label"
import { AuthenticatorIcon } from "@/components/authenticator-icon"
import { RecoveryKeyCard } from "@/components/recovery-key-card"
import {
  DelayProgress,
  PendingHeader,
  ReadyIn,
  WindowTimes,
} from "@/components/recovery-window"
import { authenticatorCopy, useAuthenticatorLabel } from "@/lib/authenticator"
import { checkEnvironment, loadCredentialStatus } from "@/lib/auth/unlock"
import type { Environment } from "@/lib/auth/unlock"
import {
  RATE_LIMIT_COOLDOWN_MS,
  RECOVERY_POLL_MS,
  completeRecovery,
  recoveryPhase,
  startRecovery,
} from "@/lib/recovery"
import type { RecoveryFailure } from "@/lib/recovery"

/** What went wrong on the last try, shown above the action it belongs to. */
type Notice = Exclude<RecoveryFailure, "not-pending" | "signed-out">

type RecoverState =
  | { status: "checking" }
  | { status: "ready"; notice: Notice | null }
  | { status: "starting" }
  | {
      status: "window"
      window: GateRecoveryWindow
      creating: boolean
      notice: Notice | null
    }
  | { status: "cancelled" }
  | { status: "check-failed"; offline: boolean }
  | { status: "wrong-origin" }
  | { status: "unsupported" }

const MESSAGES = {
  offline: "Cannot reach the Mac.",
  "rate-limited": "Too many tries. Wait a few minutes.",
  unreadable: "The gate sent an answer Eido could not read.",
  "wrong-origin":
    "Open Eido from its Tailscale address to recover. Passkeys are bound to that address.",
  unsupported:
    "This browser cannot create passkeys. Use Safari on iOS 17+ or a current desktop browser.",
  "check-failed": "Couldn't check this device with the gate.",
  expired: "This recovery ran out. Start again with your key.",
  cancelled: "Recovery cancelled.",
  matured: "The wait is over. Create a new passkey on this phone.",
} as const

function alertMessage(
  state: RecoverState,
  copy: ReturnType<typeof authenticatorCopy>
): React.ReactNode {
  const notice =
    state.status === "ready" || state.status === "window" ? state.notice : null
  switch (notice) {
    case "refused":
      return (
        <>
          <b className="font-medium">Key not accepted.</b> Check the key and try
          again.
        </>
      )
    case "cancelled":
      return `${copy.subject} was cancelled. Nothing was saved. You can try again.`
    case "offline":
    case "rate-limited":
    case "unreadable":
      return MESSAGES[notice]
    case null:
      break
  }
  switch (state.status) {
    case "check-failed":
      return state.offline ? MESSAGES.offline : MESSAGES["check-failed"]
    case "wrong-origin":
    case "unsupported":
      return MESSAGES[state.status]
    default:
      return null
  }
}

function progressMessage(
  state: RecoverState,
  copy: ReturnType<typeof authenticatorCopy>,
  now: number
): string {
  switch (state.status) {
    case "checking":
      return "Checking…"
    case "starting":
      return "Starting recovery…"
    case "cancelled":
      return MESSAGES.cancelled
    case "window": {
      const phase = recoveryPhase(state.window, now)
      if (state.creating) return `Waiting for ${copy.waitingFor}…`
      if (phase === "expired") return MESSAGES.expired
      return phase === "matured" ? MESSAGES.matured : ""
    }
    default:
      return ""
  }
}

function RecoverCard({
  state,
  host,
  now,
  recoveryKey,
  onKeyChange,
  onStart,
  onCreate,
  onStartAgain,
  onRetry,
}: {
  state: RecoverState
  host: string | null
  /** The current time in ms, ticking while a recovery is on screen. */
  now: number
  recoveryKey: string
  onKeyChange: (value: string) => void
  onStart: () => void
  onCreate: () => void
  onStartAgain: () => void
  onRetry: () => void
}) {
  const copy = authenticatorCopy(useAuthenticatorLabel())
  const error = alertMessage(state, copy)
  const progress = progressMessage(state, copy, now)
  const starting = state.status === "starting"
  const window = state.status === "window" ? state.window : null
  const phase = window === null ? null : recoveryPhase(window, now)
  const creating = state.status === "window" && state.creating
  const showForm = state.status === "ready" || starting
  const rateLimited =
    state.status === "ready" && state.notice === "rate-limited"
  // The key is only held in memory: after a reload the owner types it again to finish.
  const needsKey = phase === "matured" && recoveryKey.trim() === ""

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 p-4">
      <p className="text-sm font-semibold tracking-wide">Eido</p>
      <Card className="w-full max-w-sm">
        <CardContent className="flex flex-col gap-5">
          <header className="flex flex-col gap-1.5">
            <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              {window === null ? "Lost your passkey" : "Passkey recovery"}
            </p>
            <h1 className="text-xl font-semibold tracking-tight">
              {window === null
                ? "Recover access"
                : phase === "matured"
                  ? "Create a new passkey"
                  : "Recovery started"}
            </h1>
          </header>

          <div role="status" className="flex items-center gap-2 text-sm">
            {progress !== "" ? (
              <>
                {state.status === "checking" || starting || creating ? (
                  <Loader2
                    aria-hidden
                    className="size-4 animate-spin text-muted-foreground"
                  />
                ) : null}
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
            <Button size="lg" onClick={onRetry} className="h-12 rounded-xl">
              Try again
            </Button>
          ) : null}

          {showForm ? (
            <form
              className="flex flex-col gap-5"
              onSubmit={(event) => {
                event.preventDefault()
                if (!starting && !rateLimited && recoveryKey.trim() !== "")
                  onStart()
              }}
            >
              <div className="flex flex-col gap-2">
                <Label htmlFor="recovery-key">Recovery key</Label>
                <Input
                  id="recovery-key"
                  value={recoveryKey}
                  onChange={(event) => onKeyChange(event.target.value)}
                  disabled={starting}
                  aria-invalid={
                    state.status === "ready" && state.notice === "refused"
                  }
                  autoComplete="off"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  data-1p-ignore
                  data-lpignore="true"
                  className="h-12 rounded-xl font-mono text-base"
                />
              </div>
              <Button
                type="submit"
                size="lg"
                disabled={starting || rateLimited || recoveryKey.trim() === ""}
                className="h-12 rounded-xl"
              >
                <KeyRound aria-hidden />
                Start recovery
              </Button>
            </form>
          ) : null}

          {window !== null && phase === "pending" ? (
            <>
              <PendingHeader window={window} now={now} />
              <ReadyIn window={window} now={now} />
              <DelayProgress window={window} now={now} />
              <WindowTimes window={window} />
            </>
          ) : null}

          {window !== null && phase === "matured" ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <Badge variant="outline">Ready</Badge>
              </div>
              <WindowTimes window={window} showReady={false} />
              {needsKey ? (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="recovery-key">Recovery key</Label>
                  <Input
                    id="recovery-key"
                    value={recoveryKey}
                    onChange={(event) => onKeyChange(event.target.value)}
                    autoComplete="off"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    data-1p-ignore
                    data-lpignore="true"
                    className="h-12 rounded-xl font-mono text-base"
                  />
                </div>
              ) : null}
            </>
          ) : null}

          {window !== null && phase !== "expired" ? (
            <Button
              type="button"
              size="lg"
              disabled={
                phase !== "matured" || creating || recoveryKey.trim() === ""
              }
              onClick={onCreate}
              className="h-12 rounded-xl"
            >
              <AuthenticatorIcon />
              Create new passkey
            </Button>
          ) : null}

          {phase === "expired" || state.status === "cancelled" ? (
            <div className="flex flex-col gap-3">
              <Badge variant="destructive" className="self-start">
                {state.status === "cancelled" ? "Cancelled" : "Expired"}
              </Badge>
              <Button
                type="button"
                size="lg"
                variant="outline"
                onClick={onStartAgain}
                className="h-12 rounded-xl"
              >
                Start again
              </Button>
            </div>
          ) : null}

          {window !== null && phase === "pending" ? (
            <p className="text-xs text-muted-foreground">
              An alert went to your enrolled devices.
            </p>
          ) : null}

          {host !== null && window === null ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <span className="text-xs text-muted-foreground">Origin</span>
              <span className="font-mono text-xs break-all">{host}</span>
            </div>
          ) : null}

          {window === null ? (
            <Link
              href="/unlock"
              className={buttonVariants({ variant: "ghost", size: "lg" })}
            >
              Back to unlock
            </Link>
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
      typeof navigator.credentials?.create === "function"
  )
const readHost = () => window.location.hostname

function RecoverView() {
  const router = useRouter()
  const environment = React.useSyncExternalStore(
    subscribeNever,
    readEnvironment,
    () => null
  )
  const host = React.useSyncExternalStore(subscribeNever, readHost, () => null)
  const [state, setState] = React.useState<RecoverState>({ status: "checking" })
  const [attempt, setAttempt] = React.useState(0)
  const [now, setNow] = React.useState(() => Date.now())
  const [recoveryKey, setRecoveryKey] = React.useState("")
  const [replacementKey, setReplacementKey] = React.useState<string | null>(
    null
  )

  const windowStatus = state.status === "window" ? state.window : null

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
        return
      }
      const recovery = result.status.recovery
      setNow(Date.now())
      setState(
        recovery === undefined
          ? { status: "ready", notice: null }
          : {
              status: "window",
              window: recovery,
              creating: false,
              notice: null,
            }
      )
    })
    return () => controller.abort()
  }, [environment, attempt])

  // While a recovery is on screen the clock ticks, so the countdown and the ready time are
  // exact, and the gate is asked every 30 s whether it still stands.
  const showingWindow = windowStatus !== null
  React.useEffect(() => {
    if (!showingWindow) return
    const tick = setInterval(() => setNow(Date.now()), 1_000)
    const controller = new AbortController()
    const poll = setInterval(() => {
      void loadCredentialStatus(controller.signal).then((result) => {
        if (controller.signal.aborted || !result.ok) return
        const recovery = result.status.recovery
        setNow(Date.now())
        setState((current) => {
          if (current.status !== "window") return current
          if (recovery !== undefined) return { ...current, window: recovery }
          // Gone from the gate: ran out, or was cancelled from a signed-in device.
          return Date.now() >= Date.parse(current.window.expiresAt)
            ? current
            : { status: "cancelled" }
        })
      })
    }, RECOVERY_POLL_MS)
    return () => {
      clearInterval(tick)
      clearInterval(poll)
      controller.abort()
    }
  }, [showingWindow])

  // A 429 lifts after the gate's one-minute window.
  const rateLimited =
    state.status === "ready" && state.notice === "rate-limited"
  React.useEffect(() => {
    if (!rateLimited) return
    const timer = setTimeout(
      () => setState({ status: "ready", notice: null }),
      RATE_LIMIT_COOLDOWN_MS
    )
    return () => clearTimeout(timer)
  }, [rateLimited])

  const retry = React.useCallback(() => {
    setState({ status: "checking" })
    setAttempt((n) => n + 1)
  }, [])

  const start = React.useCallback(async () => {
    setState({ status: "starting" })
    const result = await startRecovery(recoveryKey)
    if (result.ok) {
      setNow(Date.now())
      setState({
        status: "window",
        window: result.value,
        creating: false,
        notice: null,
      })
    } else if (
      result.reason === "not-pending" ||
      result.reason === "signed-out"
    ) {
      setState({ status: "ready", notice: "refused" })
    } else {
      setState({ status: "ready", notice: result.reason })
    }
  }, [recoveryKey])

  const create = React.useCallback(async () => {
    if (state.status !== "window") return
    const { window: held } = state
    setState({ status: "window", window: held, creating: true, notice: null })
    const result = await completeRecovery(recoveryKey, window.location.hostname)
    if (result.ok) {
      setRecoveryKey("")
      setReplacementKey(result.value)
      return
    }
    if (result.reason === "refused") {
      // Too early, ran out, or a key the gate will not take: the gate says only "refused",
      // so ask where the recovery stands.
      const status = await loadCredentialStatus()
      setNow(Date.now())
      if (status.ok && status.status.recovery === undefined) {
        setState(
          Date.now() >= Date.parse(held.expiresAt)
            ? { status: "ready", notice: null }
            : { status: "cancelled" }
        )
        return
      }
      const current =
        status.ok && status.status.recovery !== undefined
          ? status.status.recovery
          : held
      setState({
        status: "window",
        window: current,
        creating: false,
        notice:
          recoveryPhase(current, Date.now()) === "matured" ? "refused" : null,
      })
      return
    }
    if (result.reason === "not-pending" || result.reason === "signed-out") {
      setState({
        status: "window",
        window: held,
        creating: false,
        notice: "refused",
      })
      return
    }
    setState({
      status: "window",
      window: held,
      creating: false,
      notice: result.reason,
    })
  }, [recoveryKey, state])

  const startAgain = React.useCallback(() => {
    setRecoveryKey("")
    setState({ status: "ready", notice: null })
  }, [])

  if (replacementKey !== null) {
    return (
      <RecoveryKeyCard
        recoveryKey={replacementKey}
        overline="Passkey recovery"
        onContinue={() => {
          setReplacementKey(null)
          router.replace("/")
        }}
      />
    )
  }

  const shown: RecoverState =
    environment === "wrong-origin" || environment === "unsupported"
      ? { status: environment }
      : state

  return (
    <RecoverCard
      state={shown}
      host={host}
      now={now}
      recoveryKey={recoveryKey}
      onKeyChange={setRecoveryKey}
      onStart={() => void start()}
      onCreate={() => void create()}
      onStartAgain={startAgain}
      onRetry={retry}
    />
  )
}

export { RecoverCard, RecoverView }
export type { RecoverState }
