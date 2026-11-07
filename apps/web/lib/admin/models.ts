import {
  validateGateAdminStack,
  validateStackModelList,
  type StackJobStatus,
  type StackModelList,
} from "@eido/schemas"
import { callGate } from "@/lib/admin/gate"

export type ModelProfile = StackModelList["profiles"][number]
export type ModelTask = StackJobStatus["tasks"][number]

/** What reading the model page's data came to. */
export type ModelsLoad =
  | { status: "ready"; list: StackModelList; tasks: ModelTask[] }
  | { status: "unreachable" }
  | { status: "expired" }
  | { status: "supervisor-down" }
  | { status: "error" }

/**
 * Reads the model profiles and, alongside, the running tasks, so a page opened mid-fetch shows its
 * progress. The tasks are best effort: when the stack answer fails the page still lists profiles.
 */
export async function loadModels(signal: AbortSignal): Promise<ModelsLoad> {
  const [models, stack] = await Promise.all([
    callGate("/admin/models", validateStackModelList, { signal }),
    callGate("/admin/stack", validateGateAdminStack, { signal }),
  ])
  if (models.kind === "unreachable") return { status: "unreachable" }
  if (models.kind === "expired") return { status: "expired" }
  if (models.kind === "refused" && models.code === "supervisor_unavailable")
    return { status: "supervisor-down" }
  if (models.kind !== "ok") return { status: "error" }
  const tasks =
    stack.kind === "ok" && stack.value.supervisor === "available"
      ? stack.value.jobs.tasks
      : []
  return { status: "ready", list: models.value, tasks }
}

const GB = 1_000_000_000
const MB = 1_000_000

/** "15.6 GB", or "340 MB" under a gigabyte. Decimal units, as model files are sold. */
export function formatSize(bytes: number): string {
  return bytes >= GB
    ? `${(bytes / GB).toFixed(1)} GB`
    : `${Math.round(bytes / MB)} MB`
}

/** "6.2 of 12.1 GB": both numbers in the unit of the total. Just the received size when the total is unknown. */
export function progressLabel(task: ModelTask): string {
  if (task.totalBytes === 0) return formatSize(task.receivedBytes)
  const unit = task.totalBytes >= GB ? GB : MB
  const digits = unit === GB ? 1 : 0
  const part = (task.receivedBytes / unit).toFixed(digits)
  return `${part} of ${formatSize(task.totalBytes)}`
}

/** 0 to 100, or undefined while the total is unknown. */
export function progressPercent(task: ModelTask): number | undefined {
  if (task.totalBytes === 0) return undefined
  return Math.min(100, Math.round((task.receivedBytes / task.totalBytes) * 100))
}

/** The newest fetch task for a profile; the supervisor lists tasks oldest first. */
export function taskFor(
  tasks: readonly ModelTask[],
  profile: string
): ModelTask | undefined {
  return tasks.filter((task) => task.profile === profile).at(-1)
}

export function anyRunning(tasks: readonly ModelTask[]): boolean {
  return tasks.some((task) => task.state === "running")
}

/** "On disk · verified", "Not on disk", and the two cases the design does not draw. */
export function diskLine(profile: ModelProfile): string {
  if (profile.disk === "missing") return "Not on disk"
  if (profile.disk === "wrong_size") return "On disk · wrong size"
  return profile.verified ? "On disk · verified" : "On disk · not verified"
}

/** Use needs a present, verified file that is not already the active profile. */
export function canUse(profile: ModelProfile, active: string): boolean {
  return profile.disk === "present" && profile.verified && profile.id !== active
}

/** Fetch is offered when the file is missing or the wrong size. */
export function canFetch(profile: ModelProfile): boolean {
  return profile.disk !== "present"
}

/** Why the last fetch of a profile failed, shown only while the file is still not on disk. */
export function fetchFailure(
  profile: ModelProfile,
  task: ModelTask | undefined
): string | undefined {
  if (task?.state !== "failed" || profile.disk === "present") return undefined
  return task.receivedBytes > 0
    ? `Fetch failed: the download stopped at ${formatSize(task.receivedBytes)}. Nothing was kept.`
    : "Fetch failed. Nothing was kept."
}
