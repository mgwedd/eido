import {
  validateGateAdminStack,
  validateStackDoctorReport,
  validateStackLoginItem,
  validateStackJobStatus,
} from "@eido/schemas"
import type { StackDoctorReport, StackJobStatus } from "@eido/schemas"
import { callGate } from "@/lib/admin/gate"
import type { GateOutcome } from "@/lib/admin/gate"

export type StackProcess = StackJobStatus["processes"][number]
export type StackCheck = StackDoctorReport["checks"][number]

/** The names Start, Stop and Restart act on: the only two the supervisor controls. */
export const CONTROLLED = ["core", "llama"] as const
export type StackVerb = "start" | "stop" | "restart"

export type ChecksState =
  { kind: "ready"; checks: readonly StackCheck[] } | { kind: "failed" }

export type LoginItemState =
  | { kind: "ready"; enabled: boolean }
  | { kind: "unsupported" }
  | { kind: "failed" }

/** What the Status page shows. `down`: the gate answers but the stack supervisor does not. */
export type StatusState =
  | { status: "loading" }
  | { status: "unreachable" }
  | { status: "error" }
  | { status: "down" }
  | {
      status: "ready"
      processes: readonly StackProcess[]
      checks: ChecksState
      loginItem: LoginItemState
    }

export type LoadResult = StatusState | { status: "expired" }

const isDown = (outcome: GateOutcome<unknown>) =>
  outcome.kind === "refused" && outcome.code === "supervisor_unavailable"

/** Reads the stack, then the checks and the login item when the supervisor answers. */
export async function loadStatus(signal?: AbortSignal): Promise<LoadResult> {
  const stack = await callGate("/admin/stack", validateGateAdminStack, {
    signal,
  })
  if (stack.kind === "unreachable") return { status: "unreachable" }
  if (stack.kind === "expired") return { status: "expired" }
  if (stack.kind !== "ok") return { status: "error" }
  if (stack.value.supervisor === "unavailable") return { status: "down" }
  const processes = stack.value.jobs.processes
  const [doctor, login] = await Promise.all([
    callGate("/admin/doctor", validateStackDoctorReport, { signal }),
    callGate("/admin/login-item", validateStackLoginItem, { signal }),
  ])
  if (doctor.kind === "expired" || login.kind === "expired")
    return { status: "expired" }
  if (isDown(doctor) || isDown(login)) return { status: "down" }
  return {
    status: "ready",
    processes,
    checks:
      doctor.kind === "ok"
        ? { kind: "ready", checks: doctor.value.checks }
        : { kind: "failed" },
    loginItem:
      login.kind === "ok"
        ? { kind: "ready", enabled: login.value.enabled }
        : login.kind === "refused" && login.code === "unsupported_platform"
          ? { kind: "unsupported" }
          : { kind: "failed" },
  }
}

/** Re-reads only the stack's processes, for the poll while a job runs. */
export async function loadProcesses(
  signal?: AbortSignal
): Promise<readonly StackProcess[] | undefined> {
  const stack = await callGate("/admin/stack", validateGateAdminStack, {
    signal,
  })
  return stack.kind === "ok" && stack.value.supervisor === "available"
    ? stack.value.jobs.processes
    : undefined
}

export function requestJob(
  verb: StackVerb,
  signal?: AbortSignal
): Promise<GateOutcome<StackJobStatus>> {
  return callGate(`/admin/stack/${verb}`, validateStackJobStatus, {
    method: "POST",
    body: { names: [...CONTROLLED] },
    signal,
  })
}

export function setLoginItem(enabled: boolean) {
  return callGate("/admin/login-item", validateStackLoginItem, {
    method: "POST",
    body: { enabled },
  })
}

const PARTICIPLE: Record<StackVerb, string> = {
  start: "Starting",
  stop: "Stopping",
  restart: "Restarting",
}

/** "Restarting core and llama…" */
export function actingMessage(verb: StackVerb): string {
  return `${PARTICIPLE[verb]} ${CONTROLLED.join(" and ")}…`
}

export function controlled(
  processes: readonly StackProcess[]
): readonly StackProcess[] {
  return processes.filter((p) => p.name === "core" || p.name === "llama")
}

/** "Starting core and llama…" while the supervisor reports processes on their way, else undefined. */
export function transitMessage(
  processes: readonly StackProcess[]
): string | undefined {
  const parts = (["starting", "stopping"] as const).flatMap((state) => {
    const names = controlled(processes)
      .filter((p) => p.state === state)
      .map((p) => p.name)
    if (names.length === 0) return []
    return [
      `${state === "starting" ? "Starting" : "Stopping"} ${names.join(" and ")}…`,
    ]
  })
  return parts.length === 0 ? undefined : parts.join(" ")
}

export const isStopped = (processes: readonly StackProcess[]) => {
  const own = controlled(processes)
  return own.length > 0 && own.every((p) => p.state === "stopped")
}

/** "core running, llama running." for the live region when nothing is in transit or stopped. */
export function runningSummary(processes: readonly StackProcess[]): string {
  return `${controlled(processes)
    .map((p) => `${p.name} ${p.state}`)
    .join(", ")}.`
}

export const STATE_LABEL: Record<StackProcess["state"], string> = {
  running: "Running",
  starting: "Starting",
  stopping: "Stopping",
  stopped: "Stopped",
  unavailable: "Unavailable",
}

/** "11 OK · 1 warning · 1 failed", leaving out any count of zero. */
export function checksSummary(checks: readonly StackCheck[]): string {
  const count = (status: StackCheck["status"]) =>
    checks.filter((c) => c.status === status).length
  const ok = count("ok")
  const warn = count("warn")
  const fail = count("fail")
  const parts = [
    ok > 0 ? `${ok} OK` : undefined,
    warn > 0 ? `${warn} ${warn === 1 ? "warning" : "warnings"}` : undefined,
    fail > 0 ? `${fail} failed` : undefined,
  ].filter((part) => part !== undefined)
  return parts.length === 0 ? "No checks" : parts.join(" · ")
}

/** Failures first, then warnings, each in the order the supervisor listed them; OK checks apart. */
export function splitChecks(checks: readonly StackCheck[]): {
  issues: readonly StackCheck[]
  ok: readonly StackCheck[]
} {
  return {
    issues: [
      ...checks.filter((c) => c.status === "fail"),
      ...checks.filter((c) => c.status === "warn"),
    ],
    ok: checks.filter((c) => c.status === "ok"),
  }
}

/** The message for a Start, Stop or Restart the gate refused. */
export function jobRefusal(verb: StackVerb, code: string): string {
  if (code === "busy") return "Another stack job is running."
  if (code === "stack_not_running") return "Core and llama are not running."
  if (code === "supervisor_unavailable")
    return "The stack supervisor is not answering."
  return `Could not ${verb} core and llama.`
}
