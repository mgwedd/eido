"use client"

import { ChevronDown, Lock } from "lucide-react"
import * as React from "react"

import { Alert, AlertDescription } from "@eido/ui/components/alert"
import { Badge } from "@eido/ui/components/badge"
import { Button } from "@eido/ui/components/button"
import { Card, CardContent, CardHeader } from "@eido/ui/components/card"
import { Label } from "@eido/ui/components/label"
import { Skeleton } from "@eido/ui/components/skeleton"
import { Switch } from "@eido/ui/components/switch"
import { AdminError, AdminUnreachable } from "@/components/admin-shell"
import { useAdmin } from "@/components/admin-step-up"
import {
  actingMessage,
  checksSummary,
  controlled,
  isStopped,
  jobRefusal,
  loadProcesses,
  loadStatus,
  requestJob,
  runningSummary,
  setLoginItem,
  splitChecks,
  STATE_LABEL,
  transitMessage,
} from "@/lib/admin/status"
import type {
  ChecksState,
  LoginItemState,
  StackCheck,
  StackProcess,
  StackVerb,
  StatusState,
} from "@/lib/admin/status"

const STOPPED_MESSAGE =
  "Core and llama are stopped. Ask, sync and the queue wait until you start them."
const ORDER = ["gate", "web", "core", "llama"] as const
const VERBS = {
  start: "Start",
  stop: "Stop",
  restart: "Restart",
} satisfies Record<StackVerb, string>

function ProcessRow({
  name,
  state,
  note,
}: {
  name: string
  state: string
  note?: string
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
      <code className="w-14 font-mono text-sm">{name}</code>
      <Badge variant="outline">{state}</Badge>
      {note ? (
        <span className="text-sm text-muted-foreground">{note}</span>
      ) : null}
    </li>
  )
}

function processNote(process: StackProcess): string | undefined {
  if (!process.controllable) return "Always on"
  return process.message
}

function StackCard({
  state,
  acting,
  onAct,
}: {
  state: Extract<StatusState, { status: "ready" | "down" }>
  acting: StackVerb | null
  onAct: (verb: StackVerb) => void
}) {
  if (state.status === "down")
    return (
      <Card>
        <CardHeader>
          <h2 className="text-base font-semibold">Stack</h2>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Alert role={undefined}>
            <AlertDescription role="status">
              The stack supervisor is not answering. Start, Stop, Restart and
              the checks are hidden until it answers. On the Mac, run{" "}
              <code className="font-mono">pnpm stack:status</code>.
            </AlertDescription>
          </Alert>
          <ul aria-label="Processes" className="divide-y">
            <ProcessRow name="gate" state="Running" note="serving this page" />
          </ul>
        </CardContent>
      </Card>
    )
  const own = controlled(state.processes)
  const transit = transitMessage(state.processes)
  const stopped = isStopped(state.processes)
  const busy = acting !== null || transit !== undefined
  const message = acting
    ? actingMessage(acting)
    : (transit ?? (stopped ? STOPPED_MESSAGE : runningSummary(state.processes)))
  const visible = acting !== null || transit !== undefined || stopped
  const rows = ORDER.flatMap((name) =>
    state.processes.filter((p) => p.name === name)
  )
  const canStop = own.some((p) => p.state === "running")
  const canStart = own.some((p) => p.state === "stopped")
  const control = (verb: StackVerb, primary: boolean) => (
    <Button
      key={verb}
      variant={primary ? "default" : "outline"}
      disabled={busy}
      onClick={() => onAct(verb)}
      className="min-h-11"
    >
      <Lock aria-hidden />
      {VERBS[verb]}
    </Button>
  )
  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold">Stack</h2>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p
          role="status"
          className={visible ? "text-sm" : "sr-only"}
          data-slot="stack-message"
        >
          {message}
        </p>
        <ul aria-label="Processes" className="divide-y">
          {rows.map((p) => (
            <ProcessRow
              key={p.name}
              name={p.name}
              state={STATE_LABEL[p.state]}
              note={processNote(p)}
            />
          ))}
        </ul>
        {canStop || canStart ? (
          <div className="flex flex-wrap gap-2">
            {canStop ? control("stop", false) : null}
            {canStop ? control("restart", false) : null}
            {canStart ? control("start", !canStop) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function LoginItemCard({
  loginItem,
  pending,
  onToggle,
}: {
  loginItem: LoginItemState
  pending: boolean
  onToggle: (enabled: boolean) => void
}) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <Label htmlFor="start-at-login" className="text-base font-semibold">
          Start at login
        </Label>
        {loginItem.kind === "ready" ? (
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {loginItem.enabled ? "Loaded" : "Not loaded"}
            </span>
            <Lock aria-hidden className="size-3.5 text-muted-foreground" />
            <Switch
              id="start-at-login"
              checked={loginItem.enabled}
              disabled={pending}
              onCheckedChange={onToggle}
            />
          </div>
        ) : loginItem.kind === "unsupported" ? (
          <span className="text-sm text-muted-foreground">
            Not on Windows yet ·{" "}
            <a
              href="https://github.com/mgwedd/eido/issues/455"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-3"
            >
              issue 455
            </a>
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">
            Could not read this setting.
          </span>
        )}
      </CardContent>
    </Card>
  )
}

const CHECK_BADGE = {
  fail: { label: "Failed", variant: "destructive" },
  warn: { label: "Warning", variant: "secondary" },
  ok: { label: "OK", variant: "outline" },
} as const

function CheckRow({ check }: { check: StackCheck }) {
  const badge = CHECK_BADGE[check.status]
  return (
    <li className="flex flex-col gap-1 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <code className="font-mono text-sm">{check.id}</code>
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </div>
      <p className="text-sm">{check.summary}</p>
      {check.fix ? (
        <p className="text-sm text-muted-foreground">Fix: {check.fix.text}</p>
      ) : null}
    </li>
  )
}

function ChecksCard({ checks }: { checks: ChecksState }) {
  const [open, setOpen] = React.useState(false)
  const ready = checks.kind === "ready" ? checks.checks : []
  const { issues, ok } = splitChecks(ready)
  const folded = issues.length > 0
  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold">Checks</h2>
        {checks.kind === "ready" ? (
          <p className="text-sm text-muted-foreground">
            {checksSummary(checks.checks)}
          </p>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {checks.kind === "failed" ? (
          <p className="text-sm">Could not read the checks.</p>
        ) : (
          <>
            <ul aria-label="Checks needing attention" className="divide-y">
              {issues.map((check) => (
                <CheckRow key={check.id} check={check} />
              ))}
            </ul>
            {folded && ok.length > 0 ? (
              <>
                <Button
                  variant="ghost"
                  aria-expanded={open}
                  aria-controls="checks-ok"
                  onClick={() => setOpen((v) => !v)}
                  className="min-h-11 justify-start"
                >
                  <ChevronDown
                    aria-hidden
                    className={open ? "rotate-180" : undefined}
                  />
                  {ok.length} more OK
                </Button>
                {open ? null : (
                  <p className="text-xs text-muted-foreground">
                    {ok.map((c) => c.id).join(" · ")}
                  </p>
                )}
              </>
            ) : null}
            {!folded || open ? (
              <ul
                id="checks-ok"
                aria-label="Checks that passed"
                className="divide-y"
              >
                {ok.map((check) => (
                  <CheckRow key={check.id} check={check} />
                ))}
              </ul>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function StatusBody({
  state,
  acting,
  notice,
  loginPending,
  onAct,
  onToggleLogin,
  onRetry,
}: {
  state: StatusState
  acting: StackVerb | null
  notice: string | null
  loginPending: boolean
  onAct: (verb: StackVerb) => void
  onToggleLogin: (enabled: boolean) => void
  onRetry: () => void
}) {
  if (state.status === "loading")
    return (
      <>
        <p role="status" className="sr-only">
          Loading the stack status…
        </p>
        <Skeleton className="h-52 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-52 w-full" />
      </>
    )
  if (state.status === "unreachable")
    return <AdminUnreachable onRetry={onRetry} />
  if (state.status === "error")
    return (
      <AdminError
        message="Could not read the stack status from the gate."
        onRetry={onRetry}
      />
    )
  return (
    <>
      <StackCard state={state} acting={acting} onAct={onAct} />
      {notice ? (
        <p role="alert" className="text-sm text-destructive">
          {notice}
        </p>
      ) : null}
      {state.status === "ready" ? (
        <>
          <LoginItemCard
            loginItem={state.loginItem}
            pending={loginPending}
            onToggle={onToggleLogin}
          />
          <ChecksCard checks={state.checks} />
        </>
      ) : null}
    </>
  )
}

function useStatus() {
  const admin = useAdmin()
  const [state, setState] = React.useState<StatusState>({ status: "loading" })
  const [attempt, setAttempt] = React.useState(0)
  const [tick, setTick] = React.useState(0)
  const sessionEnded = admin.sessionEnded

  React.useEffect(() => {
    const controller = new AbortController()
    void loadStatus(controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return
        if (next.status === "expired") sessionEnded()
        else setState(next)
      },
      () => undefined
    )
    return () => controller.abort()
  }, [attempt, sessionEnded])

  // While core or llama is starting or stopping, read the processes again until it settles.
  const inTransit =
    state.status === "ready" && transitMessage(state.processes) !== undefined
  React.useEffect(() => {
    if (!inTransit) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void loadProcesses(controller.signal).then(
        (processes) => {
          if (controller.signal.aborted) return
          if (processes)
            setState((s) => (s.status === "ready" ? { ...s, processes } : s))
          setTick((n) => n + 1)
        },
        () => undefined
      )
    }, 2000)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [inTransit, tick])

  const retry = React.useCallback(() => {
    setState({ status: "loading" })
    setAttempt((n) => n + 1)
  }, [])
  return { state, setState, retry, admin }
}

function AdminStatusView() {
  const { state, setState, retry, admin } = useStatus()
  const [acting, setActing] = React.useState<StackVerb | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [loginPending, setLoginPending] = React.useState(false)

  async function act(verb: StackVerb) {
    setActing(verb)
    setNotice(null)
    const result = await admin.elevated(`${VERBS[verb]} core and llama`, () =>
      requestJob(verb)
    )
    setActing(null)
    if (result.kind === "ok") {
      const { processes } = result.value
      setState((s) => (s.status === "ready" ? { ...s, processes } : s))
    } else if (result.kind === "unreachable") {
      setState({ status: "unreachable" })
    } else if (result.kind === "refused") {
      setNotice(jobRefusal(verb, result.code))
    } else if (result.kind !== "cancelled" && result.kind !== "expired") {
      setNotice(jobRefusal(verb, result.kind))
    }
  }

  async function toggleLogin(enabled: boolean) {
    setLoginPending(true)
    setNotice(null)
    const result = await admin.elevated(
      enabled ? "Start the stack at login" : "Stop starting the stack at login",
      () => setLoginItem(enabled)
    )
    setLoginPending(false)
    if (result.kind === "ok") {
      const loginItem: LoginItemState = {
        kind: "ready",
        enabled: result.value.enabled,
      }
      setState((s) => (s.status === "ready" ? { ...s, loginItem } : s))
    } else if (result.kind === "unreachable") {
      setState({ status: "unreachable" })
    } else if (result.kind !== "cancelled" && result.kind !== "expired") {
      setNotice("Could not change Start at login.")
    }
  }

  return (
    <StatusBody
      state={state}
      acting={acting}
      notice={notice}
      loginPending={loginPending}
      onAct={(verb) => void act(verb)}
      onToggleLogin={(enabled) => void toggleLogin(enabled)}
      onRetry={retry}
    />
  )
}

export { AdminStatusView, StatusBody }
