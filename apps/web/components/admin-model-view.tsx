"use client"

import { Loader, Lock, TriangleAlert } from "lucide-react"
import * as React from "react"

import {
  validateGateAdminStack,
  validateStackJobStatus,
  validateStackModelList,
  type StackModelList,
} from "@eido/schemas"
import { Alert, AlertDescription } from "@eido/ui/components/alert"
import { Badge } from "@eido/ui/components/badge"
import { Button } from "@eido/ui/components/button"
import { Card, CardContent } from "@eido/ui/components/card"
import { Skeleton } from "@eido/ui/components/skeleton"
import { AdminError, AdminUnreachable } from "@/components/admin-shell"
import { useAdmin } from "@/components/admin-step-up"
import { callGate, type GateOutcome } from "@/lib/admin/gate"
import {
  anyRunning,
  canFetch,
  canUse,
  diskLine,
  fetchFailure,
  formatSize,
  loadModels,
  progressLabel,
  progressPercent,
  taskFor,
  type ModelProfile,
  type ModelTask,
} from "@/lib/admin/models"

type ModelsState =
  | { status: "loading" }
  | { status: "unreachable" }
  | { status: "error" }
  | { status: "supervisor-down" }
  | {
      status: "ready"
      list: StackModelList
      tasks: ModelTask[]
      /** The profile being switched to while llama restarts. */
      switching?: string
      /** Why the last Use or Fetch did not start. */
      notice?: string
    }

/** How long between reads of the fetch progress. */
const POLL_MS = 2000

function Command({ children }: { children: React.ReactNode }) {
  return <code className="font-mono">{children}</code>
}

/** A progress bar from theme tokens: packages/ui has no Progress component. */
function FetchProgress({ task }: { task: ModelTask }) {
  const percent = progressPercent(task)
  return (
    <div className="flex flex-col gap-1">
      <div
        role="progressbar"
        aria-label={`Fetching ${task.profile}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${percent ?? 0}%` }}
        />
      </div>
      <span
        data-slot="fetch-progress"
        className="text-xs text-muted-foreground tabular-nums"
      >
        {progressLabel(task)}
      </span>
    </div>
  )
}

function ProfileCard({
  profile,
  active,
  task,
  busy,
  switching,
  onUse,
  onFetch,
}: {
  profile: ModelProfile
  active: string
  task: ModelTask | undefined
  /** A switch or a fetch is running, so another one cannot start. */
  busy: boolean
  switching: boolean
  onUse: (id: string) => void
  onFetch: (id: string) => void
}) {
  const fetching = task?.state === "running"
  const failure = fetching ? undefined : fetchFailure(profile, task)
  const headingId = `model-${profile.id}`
  return (
    <Card size="sm" role="group" aria-labelledby={headingId}>
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
          <h2 id={headingId} className="font-mono text-sm break-all">
            {profile.id}
          </h2>
          <span className="flex gap-1.5">
            {profile.isDefault ? (
              <Badge variant="outline">Default</Badge>
            ) : null}
            {profile.id === active ? (
              <Badge variant="secondary">Active</Badge>
            ) : null}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          {profile.model} · {profile.quantization} ·{" "}
          <span className="tabular-nums">{formatSize(profile.sizeBytes)}</span>
        </p>
        {fetching ? (
          <FetchProgress task={task} />
        ) : (
          <p className="text-xs text-muted-foreground">{diskLine(profile)}</p>
        )}
        {failure ? (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden />
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {canUse(profile, active) ? (
            <Button
              variant="outline"
              disabled={busy}
              aria-busy={switching || undefined}
              onClick={() => onUse(profile.id)}
              className="min-h-11"
            >
              {switching ? (
                "Switching…"
              ) : (
                <>
                  <Lock aria-hidden />
                  Use
                </>
              )}
            </Button>
          ) : null}
          {canFetch(profile) && !fetching ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => onFetch(profile.id)}
              className="min-h-11"
            >
              <Lock aria-hidden />
              {failure === undefined ? "Fetch" : "Fetch again"}
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}

function ModelsBody({
  state,
  onRetry,
  onUse,
  onFetch,
}: {
  state: ModelsState
  onRetry: () => void
  onUse: (id: string) => void
  onFetch: (id: string) => void
}) {
  if (state.status === "loading")
    return (
      <>
        <p role="status" className="sr-only">
          Loading models…
        </p>
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </>
    )
  if (state.status === "unreachable")
    return <AdminUnreachable onRetry={onRetry} />
  if (state.status === "error")
    return (
      <AdminError
        message="Could not read the models from the gate."
        onRetry={onRetry}
      />
    )
  if (state.status === "supervisor-down")
    return (
      <Alert role="alert">
        <TriangleAlert aria-hidden />
        <AlertDescription>
          The stack supervisor is not answering. Start, Stop, Restart and the
          checks are hidden until it answers. On the Mac, run{" "}
          <Command>pnpm stack:status</Command>.
        </AlertDescription>
      </Alert>
    )
  const { list, tasks, switching, notice } = state
  if (list.profiles.length === 0)
    return (
      <Card size="sm" role="status">
        <CardContent className="flex flex-col gap-1">
          <h2 className="text-base font-semibold">No model profiles</h2>
          <p className="text-sm text-muted-foreground">
            The model lock lists none. On the Mac, run{" "}
            <Command>pnpm stack:setup</Command>.
          </p>
        </CardContent>
      </Card>
    )
  const busy = switching !== undefined || anyRunning(tasks)
  return (
    <>
      {switching === undefined ? (
        <p role="status" className="sr-only" data-slot="count">
          {list.profiles.length === 1
            ? "1 model profile"
            : `${list.profiles.length} model profiles`}
        </p>
      ) : (
        <Alert role={undefined}>
          <Loader aria-hidden className="animate-spin" />
          <AlertDescription role="status">
            Switching to {switching}. llama restarts; Ask waits until it
            answers.
          </AlertDescription>
        </Alert>
      )}
      {notice ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden />
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,320px),1fr))] items-start gap-4">
        {list.profiles.map((profile) => (
          <ProfileCard
            key={profile.id}
            profile={profile}
            active={list.active}
            task={taskFor(tasks, profile.id)}
            busy={busy}
            switching={switching === profile.id}
            onUse={onUse}
            onFetch={onFetch}
          />
        ))}
      </div>
    </>
  )
}

/** The words for an action the supervisor or gate refused. */
function refusalNotice(
  outcome: Extract<GateOutcome<unknown>, { kind: "refused" | "invalid" }>,
  what: string
): string {
  return outcome.kind === "refused" && outcome.code === "busy"
    ? "Another stack job is running. Try again when it finishes."
    : `Could not ${what}.`
}

function AdminModelView() {
  const admin = useAdmin()
  const [state, setState] = React.useState<ModelsState>({ status: "loading" })
  const [attempt, setAttempt] = React.useState(0)
  const mounted = React.useRef(true)
  // The step-up hook changes identity as the step-up starts and ends; the effects below must not.
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

  React.useEffect(() => {
    const controller = new AbortController()
    void loadModels(controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return
        if (next.status === "expired") {
          sessionEnded.current()
          return
        }
        setState(next)
      },
      () => undefined
    )
    return () => controller.abort()
  }, [attempt])

  const retry = React.useCallback(() => {
    setState({ status: "loading" })
    setAttempt((n) => n + 1)
  }, [])

  const running = state.status === "ready" && anyRunning(state.tasks)
  React.useEffect(() => {
    if (!running) return
    const controller = new AbortController()
    const timer = setInterval(() => {
      void callGate("/admin/stack", validateGateAdminStack, {
        signal: controller.signal,
      }).then(
        (outcome) => {
          if (controller.signal.aborted || outcome.kind !== "ok") return
          const value = outcome.value
          if (value.supervisor === "unavailable") {
            setState({ status: "supervisor-down" })
            return
          }
          // A task that ended changes the disk, so the profiles are read again.
          const tasks = value.jobs.tasks
          setState((current) =>
            current.status === "ready" ? { ...current, tasks } : current
          )
          if (!anyRunning(tasks)) setAttempt((n) => n + 1)
        },
        () => undefined
      )
    }, POLL_MS)
    return () => {
      clearInterval(timer)
      controller.abort()
    }
  }, [running])

  const use = React.useCallback(
    async (id: string) => {
      const outcome = await admin.elevated(`Use ${id}`, () => {
        setState((s) =>
          s.status === "ready" ? { ...s, switching: id, notice: undefined } : s
        )
        return callGate(
          `/admin/models/${encodeURIComponent(id)}/use`,
          validateStackModelList,
          { method: "POST" }
        )
      })
      if (!mounted.current || outcome.kind === "expired") return
      setState((s) => {
        if (s.status !== "ready") return s
        const rest = { ...s, switching: undefined }
        if (outcome.kind === "ok") return { ...rest, list: outcome.value }
        if (outcome.kind === "cancelled") return rest
        if (outcome.kind === "unreachable") return { status: "unreachable" }
        if (
          outcome.kind === "refused" &&
          outcome.code === "supervisor_unavailable"
        )
          return { status: "supervisor-down" }
        return {
          ...rest,
          notice:
            outcome.kind === "refused" || outcome.kind === "invalid"
              ? refusalNotice(outcome, `switch to ${id}`)
              : `Could not switch to ${id}.`,
        }
      })
    },
    [admin]
  )

  const fetchModel = React.useCallback(
    async (id: string) => {
      const outcome = await admin.elevated(`Fetch ${id}`, () =>
        callGate(
          `/admin/models/${encodeURIComponent(id)}/fetch`,
          validateStackJobStatus,
          { method: "POST" }
        )
      )
      if (!mounted.current || outcome.kind === "expired") return
      setState((s) => {
        if (s.status !== "ready") return s
        if (outcome.kind === "ok")
          return { ...s, tasks: outcome.value.tasks, notice: undefined }
        if (outcome.kind === "cancelled") return s
        if (outcome.kind === "unreachable") return { status: "unreachable" }
        if (
          outcome.kind === "refused" &&
          outcome.code === "supervisor_unavailable"
        )
          return { status: "supervisor-down" }
        return {
          ...s,
          notice:
            outcome.kind === "refused" || outcome.kind === "invalid"
              ? refusalNotice(outcome, `start the fetch of ${id}`)
              : `Could not start the fetch of ${id}.`,
        }
      })
    },
    [admin]
  )

  return (
    <ModelsBody
      state={state}
      onRetry={retry}
      onUse={(id) => void use(id)}
      onFetch={(id) => void fetchModel(id)}
    />
  )
}

export { AdminModelView, ModelsBody }
export type { ModelsState }
