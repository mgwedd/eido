"use client"

import { PenLine } from "lucide-react"
import * as React from "react"

import {
  validateGateEnrolmentCode,
  validateGateEnrolmentCodePrepared,
} from "@eido/schemas"
import { Alert, AlertDescription } from "@eido/ui/components/alert"
import { Badge } from "@eido/ui/components/badge"
import { Button } from "@eido/ui/components/button"
import { Card, CardContent, CardHeader } from "@eido/ui/components/card"
import { AdminError, AdminUnreachable } from "@/components/admin-shell"
import { useAdmin } from "@/components/admin-step-up"
import { prepareControl, submitControl } from "@/lib/admin/control"

type DevicesState =
  | { status: "idle" }
  | { status: "signing" }
  | { status: "code"; code: string; expiresAt: string }
  | { status: "expired" }
  | { status: "refused" }
  | { status: "error" }
  | { status: "unreachable" }

const ISSUE = { action: "enrolment_code.issue" } as const

/** "10:42": the expiry in the owner's own clock. */
function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** "4F7K9QX2MB3DH8RT" is shown as the gate sends it, "4F7K-9QX2-MB3D-H8RT". */
function CodePanel({
  code,
  expiresAt,
  onDone,
}: {
  code: string
  expiresAt: string
  onDone: () => void
}) {
  return (
    <>
      <div
        role="status"
        aria-label="Enrolment code"
        className="flex flex-col items-center gap-2 rounded-xl border p-4"
      >
        <span className="font-mono text-2xl font-medium tracking-wider">
          {code}
        </span>
        <span className="text-xs text-muted-foreground">
          Shown once · expires{" "}
          <span className="tabular-nums">{clockTime(expiresAt)}</span> · enter
          it at <code className="font-mono">/enroll</code> on the new device
        </span>
      </div>
      <Button
        variant="outline"
        onClick={onDone}
        className="min-h-11 self-start"
      >
        Done
      </Button>
    </>
  )
}

function DevicesBody({
  state,
  onIssue,
  onDone,
}: {
  state: DevicesState
  onIssue: () => void
  onDone: () => void
}) {
  return (
    <div className="flex max-w-xl flex-col gap-4">
      {state.status === "unreachable" ? (
        <AdminUnreachable onRetry={onIssue} />
      ) : null}
      {state.status === "error" ? (
        <AdminError
          message="Could not issue a code: the gate did not answer. Nothing was issued."
          onRetry={onIssue}
        />
      ) : null}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold">Add a device</h2>
            <Badge variant="outline">
              <PenLine aria-hidden />
              Signed
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {state.status === "code" ? (
            <CodePanel
              code={state.code}
              expiresAt={state.expiresAt}
              onDone={onDone}
            />
          ) : (
            <Button
              disabled={state.status === "signing"}
              aria-busy={state.status === "signing" || undefined}
              onClick={onIssue}
              className="min-h-12 self-start"
            >
              {state.status === "signing" ? (
                "Waiting for your passkey…"
              ) : (
                <>
                  <PenLine aria-hidden />
                  Issue enrolment code
                </>
              )}
            </Button>
          )}
          {state.status === "signing" ? (
            <p role="status" className="sr-only">
              Waiting for your passkey…
            </p>
          ) : null}
          {state.status === "expired" ? (
            <Alert role="alert">
              <AlertDescription>
                The code expired unused. Issue a new one.
              </AlertDescription>
            </Alert>
          ) : null}
          {state.status === "refused" ? (
            <Alert role="alert" variant="destructive">
              <AlertDescription>
                Not issued: the passkey signature was refused.
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}

function AdminDevicesView() {
  const admin = useAdmin()
  const [state, setState] = React.useState<DevicesState>({ status: "idle" })
  const mounted = React.useRef(true)
  const sessionEnded = React.useRef(admin.sessionEnded)
  React.useEffect(() => {
    sessionEnded.current = admin.sessionEnded
  })

  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // The code is dropped from state the moment it expires.
  const expiresAt = state.status === "code" ? state.expiresAt : undefined
  React.useEffect(() => {
    if (expiresAt === undefined) return
    const timer = setTimeout(
      () => setState({ status: "expired" }),
      Math.max(0, Date.parse(expiresAt) - Date.now())
    )
    return () => clearTimeout(timer)
  }, [expiresAt])

  const issue = React.useCallback(async () => {
    setState({ status: "signing" })
    const prepared = await prepareControl(
      {
        preparePath: "/admin/enrolment-codes/prepare",
        target: "enrolment_code",
        payload: ISSUE,
      },
      validateGateEnrolmentCodePrepared
    )
    if (!mounted.current) return
    if (prepared.kind !== "ok") {
      if (prepared.kind === "expired") {
        sessionEnded.current()
        setState({ status: "idle" })
        return
      }
      setState({
        status:
          prepared.kind === "unreachable"
            ? "unreachable"
            : prepared.kind === "refused" && prepared.status === 403
              ? "refused"
              : "error",
      })
      return
    }
    const outcome = await admin.signed(
      {
        action: "Issue enrolment code",
        fields: [["Action", "Issue one enrolment code"]],
        payloadHash: prepared.value.payloadHash,
      },
      () =>
        submitControl(
          prepared.value,
          "/admin/enrolment-codes",
          validateGateEnrolmentCode
        )
    )
    if (!mounted.current) return
    switch (outcome.kind) {
      case "ok":
        setState({
          status: "code",
          code: outcome.value.code,
          expiresAt: outcome.value.expiresAt,
        })
        return
      case "expired":
        setState({ status: "idle" })
        return
      case "cancelled":
        setState({ status: "refused" })
        return
      case "unreachable":
        setState({ status: "unreachable" })
        return
      case "refused":
        setState({ status: outcome.status === 403 ? "refused" : "error" })
        return
      default:
        setState({ status: "error" })
    }
  }, [admin])

  return (
    <DevicesBody
      state={state}
      onIssue={() => void issue()}
      onDone={() => setState({ status: "idle" })}
    />
  )
}

export { AdminDevicesView, DevicesBody }
export type { DevicesState }
