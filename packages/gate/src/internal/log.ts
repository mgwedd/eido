import { appendFileSync } from "node:fs"
import type { Log } from "./http"

/**
 * A JSON-lines log in the gate's own file (mode 0600). Callers pass ids, routes, statuses and
 * counts only: never token values or payload bodies.
 */
export function fileLog(path: string, now: () => Date = () => new Date()): Log {
  return (event, fields = {}) => {
    appendFileSync(
      path,
      `${JSON.stringify({ at: now().toISOString(), event, ...fields })}\n`,
      { mode: 0o600 }
    )
  }
}
