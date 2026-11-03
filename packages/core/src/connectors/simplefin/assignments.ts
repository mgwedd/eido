import { readFileSync } from "node:fs"

// The account-to-entity assignment for SimpleFIN accounts, first cut (#51): a local JSON file of
// SimpleFIN account id to entity id, edited by the owner. Where it is edited long term is #545.

export type AccountAssignments = Readonly<Record<string, string>>

const INVALID =
  "the SimpleFIN accounts file must be a JSON object of account id to entity id"

/** Parses the file's text. Anything other than an object of non-empty strings is refused. */
export function parseAccountAssignments(text: string): AccountAssignments {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(INVALID)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(INVALID)
  const assignments: Record<string, string> = {}
  for (const [account, entity] of Object.entries(parsed)) {
    if (account === "" || typeof entity !== "string" || entity === "")
      throw new Error(INVALID)
    assignments[account] = entity
  }
  return assignments
}

/** Reads the file on each sync, so an edit applies without a restart. No file means no assignments. */
export function readAccountAssignments(
  path: string | undefined
): AccountAssignments {
  if (path === undefined) return {}
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return {}
    throw new Error("the SimpleFIN accounts file could not be read")
  }
  return parseAccountAssignments(text)
}
