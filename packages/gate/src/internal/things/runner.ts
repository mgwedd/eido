import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import type {
  GateThingsAreaList,
  GateThingsProjectItem,
  GateThingsProjectList,
  GateThingsTagList,
  GateThingsTodoItem,
  GateThingsTodoList,
} from "@eido/schemas"

const here = dirname(fileURLToPath(import.meta.url))
export const SCRIPTS_DIR = join(here, "scripts")

export const RECORD_SEPARATOR = "\u001E"
export const FIELD_SEPARATOR = "\u001F"
export const MAX_OUTPUT_BYTES = 5 * 1024 * 1024 // 5 MiB
export const SCRIPT_TIMEOUT_MS = 10_000 // 10 seconds

export class ThingsError extends Error {
  readonly code: "things_unavailable" | "automation_denied"

  constructor(
    code: "things_unavailable" | "automation_denied",
    message: string
  ) {
    super(message)
    this.name = "ThingsError"
    this.code = code
  }
}

export type ThingsScriptRunner = (
  scriptName: string,
  argv?: readonly string[]
) => Promise<string>

/**
 * Executes a fixed AppleScript by file name from `SCRIPTS_DIR` with `argv` passed to `on run argv`.
 * Values are NEVER interpolated into script source.
 */
export async function runThingsScript(
  scriptName: string,
  argv: readonly string[] = []
): Promise<string> {
  const scriptPath = join(SCRIPTS_DIR, `${scriptName}.applescript`)
  return new Promise((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    let killed = false

    const child = spawn("/usr/bin/osascript", [scriptPath, ...argv], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin" },
    })

    const timer = setTimeout(() => {
      killed = true
      child.kill("SIGKILL")
      reject(
        new ThingsError("things_unavailable", "osascript execution timed out")
      )
    }, SCRIPT_TIMEOUT_MS)

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
      if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
        killed = true
        clearTimeout(timer)
        child.kill("SIGKILL")
        reject(
          new ThingsError(
            "things_unavailable",
            "osascript output exceeded limit"
          )
        )
      }
    })

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })

    child.on("error", (err) => {
      clearTimeout(timer)
      if (killed) return
      reject(new ThingsError("things_unavailable", err.message))
    })

    child.on("close", (code) => {
      clearTimeout(timer)
      if (killed) return
      if (code === 0) {
        resolve(stdout)
      } else {
        if (
          stderr.includes("-1743") ||
          stderr.includes("Not authorized to send Apple events")
        ) {
          reject(
            new ThingsError(
              "automation_denied",
              "macOS Automation permission denied for Things"
            )
          )
        } else {
          reject(
            new ThingsError(
              "things_unavailable",
              `Things error (exit code ${code}): ${stderr.trim()}`
            )
          )
        }
      }
    })
  })
}

function parseStatus(s: string): "open" | "completed" | "canceled" {
  const lower = s.toLowerCase()
  if (lower.includes("complet")) return "completed"
  if (lower.includes("cancel")) return "canceled"
  return "open"
}

export function parseTodoRow(raw: string): GateThingsTodoItem {
  const cells = raw.split(FIELD_SEPARATOR)
  const [
    id,
    name,
    status,
    notes,
    tagsRaw,
    area,
    project,
    dueDate,
    activationDate,
    modificationDate,
    creationDate,
  ] = cells
  return {
    id: (id ?? "").trim(),
    name: name ?? "",
    status: parseStatus(status ?? ""),
    notes: notes ?? "",
    tags: (tagsRaw ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
    area: area && area.length > 0 ? area : null,
    project: project && project.length > 0 ? project : null,
    dueDate: dueDate && dueDate.length > 0 ? dueDate : null,
    activationDate:
      activationDate && activationDate.length > 0 ? activationDate : null,
    modificationDate:
      modificationDate && modificationDate.length > 0 ? modificationDate : null,
    creationDate: creationDate && creationDate.length > 0 ? creationDate : null,
  }
}

export function parseTodoList(raw: string): GateThingsTodoList {
  const trimmed = raw.trim()
  if (!trimmed) return { items: [] }
  const rows = trimmed.split(RECORD_SEPARATOR)
  return {
    items: rows.map(parseTodoRow),
  }
}

export function parseProjectRow(raw: string): GateThingsProjectItem {
  const cells = raw.split(FIELD_SEPARATOR)
  const [
    id,
    name,
    area,
    status,
    headingsRaw,
    count,
    notes,
    dueDate,
    activationDate,
    tagsRaw,
  ] = cells
  return {
    id: (id ?? "").trim(),
    name: name ?? "",
    area: area && area.length > 0 ? area : null,
    status: parseStatus(status ?? ""),
    headings: (headingsRaw ?? "")
      .split("|")
      .map((h) => h.trim())
      .filter((h) => h.length > 0),
    todoCount: Math.max(0, parseInt(count ?? "0", 10) || 0),
    notes: notes ?? "",
    dueDate: dueDate && dueDate.length > 0 ? dueDate : null,
    activationDate:
      activationDate && activationDate.length > 0 ? activationDate : null,
    tags: (tagsRaw ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
  }
}

export function parseProjectList(raw: string): GateThingsProjectList {
  const trimmed = raw.trim()
  if (!trimmed) return { projects: [] }
  const rows = trimmed.split(RECORD_SEPARATOR)
  return {
    projects: rows.map(parseProjectRow),
  }
}

export function parseAreaList(raw: string): GateThingsAreaList {
  const trimmed = raw.trim()
  if (!trimmed) return { areas: [] }
  const rows = trimmed.split(RECORD_SEPARATOR)
  return {
    areas: rows.map((row) => {
      const [id, name] = row.split(FIELD_SEPARATOR)
      return { id: (id ?? "").trim(), name: name ?? "" }
    }),
  }
}

export function parseTagList(raw: string): GateThingsTagList {
  const trimmed = raw.trim()
  if (!trimmed) return { tags: [] }
  const rows = trimmed.split(RECORD_SEPARATOR)
  return {
    tags: rows.map((r) => r.trim()).filter((r) => r.length > 0),
  }
}
