import { auditSource } from "./handler-audit"

/**
 * The secret path (ADR 0009): Admin pages, their components and `lib/admin`. A secret typed there
 * goes from the browser straight to the gate, so no server code may sit on it: no route handler
 * under `app/admin`, `app/(shell)/admin` or `app/api` (where one could answer for `/api/gate`),
 * no server action in a secret-path file, and no route handler or server action that imports one.
 */
const SECRET_FILE =
  /^(?:app\/(?:\(shell\)\/)?admin\/|components\/admin-|lib\/admin\/)/
const SECRET_IMPORT =
  /\bfrom\s+["'](?:@\/lib\/admin\/|@\/components\/admin-)|\bimport\(\s*["'](?:@\/lib\/admin\/|@\/components\/admin-)/
const ROUTE_FILE = /^app\/(?:.+\/)?route\.tsx?$/
const GUARDED_ROUTE = /^app\/(?:(?:\(shell\)\/)?admin|api)\//

export type SecretPathViolation = { file: string; reason: string }

export function secretPathViolations(
  sources: readonly { file: string; text: string }[]
): SecretPathViolation[] {
  const violations: SecretPathViolation[] = []
  for (const { file, text } of sources) {
    const route = ROUTE_FILE.test(file)
    const action = auditSource(file, text).some((h) => h.kind === "action")
    if (route && GUARDED_ROUTE.test(file))
      violations.push({ file, reason: "route handler on the secret path" })
    if (action && SECRET_FILE.test(file))
      violations.push({ file, reason: "server action on the secret path" })
    if ((route || action) && SECRET_IMPORT.test(text))
      violations.push({ file, reason: "server code imports the secret path" })
  }
  return violations
}
