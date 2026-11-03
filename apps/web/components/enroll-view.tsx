"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Loader2, Lock, ScanFace } from "lucide-react"

import { Alert, AlertDescription } from "@eido/ui/components/alert"
import { Button, buttonVariants } from "@eido/ui/components/button"
import { Card, CardContent } from "@eido/ui/components/card"
import { Input } from "@eido/ui/components/input"
import { Label } from "@eido/ui/components/label"
import { enrol, loadPasskeyCreatedAt } from "@/lib/enrol"
import { authenticatorCopy, useAuthenticatorLabel } from "@/lib/authenticator"
import { checkEnvironment, loadCredentialStatus } from "@/lib/auth/unlock"
import type { Environment } from "@/lib/auth/unlock"

type EnrollState =
  | { status: "checking" }
  | { status: "ready" }
  | { status: "enrolling" }
  | { status: "enrolled"; createdAt: string | null; signedIn: boolean }
  | { status: "cancelled" }
  | { status: "rejected"; message: string }
  | { status: "offline" }
  | { status: "check-failed"; offline: boolean }
  | { status: "wrong-origin" }
  | { status: "unsupported" }

const MESSAGES = {
  offline: "Enrolment needs a connection to the Mac.",
  "wrong-origin":
    "Open Eido from its Tailscale address to enrol. Passkeys are bound to that address.",
  unsupported:
    "This browser cannot create passkeys. Use Safari on iOS 17+ or a current desktop browser.",
} as const

function alertMessage(
  state: EnrollState,
  copy: ReturnType<typeof authenticatorCopy>
): string | null {
  switch (state.status) {
    case "cancelled":
      return `${copy.subject} was cancelled. Nothing was saved. You can try again.`
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

function progressMessage(
  state: EnrollState,
  copy: ReturnType<typeof authenticatorCopy>
): string {
  switch (state.status) {
    case "checking":
      return "Checking this device…"
    case "enrolling":
      return `Waiting for ${copy.waitingFor}…`
    case "enrolled":
      return "This phone can now approve actions."
    default:
      return ""
  }
}

const steps = (copy: ReturnType<typeof authenticatorCopy>) =>
  [
    "On the Mac, generate a one-time enrolment code",
    "Enter it here",
    copy.createPasskey,
  ] as const

function EnrollCard({
  state,
  host,
  code,
  next,
  onCodeChange,
  onEnrol,
  onRetry,
}: {
  state: EnrollState
  host: string | null
  code: string
  next: string
  onCodeChange: (code: string) => void
  onEnrol: () => void
  onRetry: () => void
}) {
  const copy = authenticatorCopy(useAuthenticatorLabel())
  const error = alertMessage(state, copy)
  const progress = progressMessage(state, copy)
  const enrolling = state.status === "enrolling"
  const showForm =
    state.status === "ready" ||
    enrolling ||
    state.status === "cancelled" ||
    state.status === "rejected" ||
    state.status === "offline"

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 p-4">
      <p className="text-sm font-semibold tracking-wide">Eido</p>
      <Card className="w-full max-w-sm">
        <CardContent className="flex flex-col gap-5">
          <header className="flex flex-col gap-1.5">
            <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              Set up this device
            </p>
            <h1 className="text-xl font-semibold tracking-tight">
              Enrol your phone with a passkey
            </h1>
            <p className="text-sm text-muted-foreground">
              Eido has no passwords. This phone will approve actions by signing
              them with {copy.signWith}.
            </p>
          </header>

          <Alert role="note">
            <Lock aria-hidden />
            <AlertDescription>
              Enrolment starts on the Mac. You need physical access to it to
              make a code; there is no way to enrol from this phone alone.
            </AlertDescription>
          </Alert>

          <div role="status" className="flex items-center gap-2 text-sm">
            {progress !== "" ? (
              <>
                {state.status === "enrolled" ? null : (
                  <Loader2
                    aria-hidden
                    className="size-4 animate-spin text-muted-foreground"
                  />
                )}
                <span>{progress}</span>
              </>
            ) : null}
          </div>

          {error !== null ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {state.status === "enrolled" ? (
            <>
              {state.createdAt !== null ? (
                <p className="text-sm text-muted-foreground">
                  Passkey created{" "}
                  {new Date(state.createdAt).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                  . It is revoked from the Mac.
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  A passkey is revoked from the Mac.
                </p>
              )}
              <Link
                href={
                  state.signedIn
                    ? next
                    : `/unlock?next=${encodeURIComponent(next)}`
                }
                className={buttonVariants({ size: "lg" }) + " h-12 rounded-xl"}
              >
                {state.signedIn ? "Continue" : copy.unlockWith}
              </Link>
            </>
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
                if (!enrolling && code.trim() !== "") onEnrol()
              }}
            >
              <ol className="flex flex-col gap-2 text-sm">
                {steps(copy).map((step, index) => (
                  <li key={step} className="flex items-center gap-3">
                    <span
                      aria-hidden
                      className="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs"
                    >
                      {index + 1}
                    </span>
                    {step}
                  </li>
                ))}
              </ol>

              <div className="flex flex-col gap-2">
                <Label htmlFor="enrol-code">One-time code from the Mac</Label>
                <Input
                  id="enrol-code"
                  value={code}
                  onChange={(event) => onCodeChange(event.target.value)}
                  disabled={enrolling}
                  autoComplete="off"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  className="h-12 rounded-xl font-mono text-base tracking-widest"
                />
                <p className="text-xs text-muted-foreground">
                  Expires 10 minutes after it is shown. Single use.
                </p>
              </div>

              <Button
                type="submit"
                size="lg"
                disabled={enrolling || code.trim() === ""}
                className="h-12 rounded-xl"
              >
                <ScanFace aria-hidden />
                Create passkey
              </Button>
            </form>
          ) : null}

          {host !== null ? (
            <div className="flex flex-col gap-1 rounded-lg border p-3">
              <span className="text-xs text-muted-foreground">
                Passkey will be bound to
              </span>
              <span className="font-mono text-sm break-all">{host}</span>
              <span className="text-xs text-muted-foreground">
                Only reachable on your tailnet. The private key stays in this
                phone&apos;s keychain; the gate stores the public key.
              </span>
            </div>
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

function EnrollView({ next }: { next: string }) {
  const router = useRouter()
  const environment = React.useSyncExternalStore(
    subscribeNever,
    readEnvironment,
    () => null
  )
  const host = React.useSyncExternalStore(subscribeNever, readHost, () => null)
  const [state, setState] = React.useState<EnrollState>({ status: "checking" })
  const [attempt, setAttempt] = React.useState(0)
  const [code, setCode] = React.useState("")

  React.useEffect(() => {
    if (environment !== "ok") return
    const controller = new AbortController()
    void (async () => {
      const result = await loadCredentialStatus(controller.signal)
      if (controller.signal.aborted) return
      if (!result.ok) {
        setState({
          status: "check-failed",
          offline: result.reason === "offline",
        })
        return
      }
      if (!result.status.enrolled) {
        setState({ status: "ready" })
        return
      }
      const signedIn = result.status.sessionExpiresAt !== null
      const createdAt = signedIn
        ? await loadPasskeyCreatedAt(controller.signal)
        : null
      if (controller.signal.aborted) return
      setState({ status: "enrolled", createdAt, signedIn })
    })()
    return () => controller.abort()
  }, [environment, attempt])

  const retry = React.useCallback(() => {
    setState({ status: "checking" })
    setAttempt((n) => n + 1)
  }, [])

  const run = React.useCallback(async () => {
    setState({ status: "enrolling" })
    const result = await enrol(code, window.location.hostname)
    if (result.ok) {
      setCode("")
      router.replace(next)
    } else if (result.reason === "rejected") {
      setState({ status: "rejected", message: result.message })
    } else {
      setState({ status: result.reason })
    }
  }, [code, next, router])

  const shown: EnrollState =
    environment === "wrong-origin" || environment === "unsupported"
      ? { status: environment }
      : state

  return (
    <EnrollCard
      state={shown}
      host={host}
      code={code}
      next={next}
      onCodeChange={setCode}
      onEnrol={() => void run()}
      onRetry={retry}
    />
  )
}

export { EnrollCard, EnrollView }
export type { EnrollState }
