import {
  validateGateFileRootsRequest,
  type GateFileRoots,
  type GateFileRootsRequest,
} from "@eido/schemas"

export const FOLDER_EDITOR_URL = "/settings/folders/edit"
/** The review page prepares the edited list kept in this tab instead of the signed one. */
export const REVIEW_EDITED_URL = "/settings/folders/review?list=edited"

export const FOLDERS_READ_FAILED =
  "Could not read the allowed folders from the gate."

/** The trash directory a new folder gets, as the review boards show it. */
export const DEFAULT_TRASH_DIR = ".eido-trash"

/** One folder while the owner edits it; `key` keeps the row stable while its id changes. */
export type DraftFolder = {
  key: string
  id: string
  path: string
  trashDir: string
}

export type DraftField = "id" | "path" | "trashDir"

export type DraftProblem =
  "tooMany" | "badId" | "duplicateId" | "noPath" | "badTrash"

export const DRAFT_MESSAGES = {
  tooMany: "Eido allows at most 32 folders.",
  badId: "Ids use lowercase letters, digits and dashes.",
  duplicateId: "Each folder needs its own id.",
  noPath: "Every folder needs a path.",
  badTrash:
    "Trash names use letters, digits, dots, dashes and underscores, and don't end in a dot.",
} as const satisfies Record<DraftProblem, string>

const ORDER: readonly DraftProblem[] = [
  "tooMany",
  "badId",
  "duplicateId",
  "noPath",
  "badTrash",
]

export type DraftCheck =
  | { ok: true; request: GateFileRootsRequest }
  | {
      ok: false
      problems: readonly DraftProblem[]
      /** "<row key>.<field>" for every field at fault. */
      invalid: ReadonlySet<string>
    }

let nextKey = 0
const newKey = () => `folder-${(nextKey += 1)}`

export function emptyFolder(): DraftFolder {
  return { key: newKey(), id: "", path: "", trashDir: DEFAULT_TRASH_DIR }
}

export function draftFromRequest(request: GateFileRootsRequest): DraftFolder[] {
  return request.roots.map((root) => ({ key: newKey(), ...root }))
}

export function draftFromSigned(signed: GateFileRoots): DraftFolder[] {
  return signed.roots.map(({ id, root }) => ({
    key: newKey(),
    id,
    path: root.path,
    trashDir: root.trashDir,
  }))
}

export const invalidKey = (folder: DraftFolder, field: DraftField) =>
  `${folder.key}.${field}`

const FIELD_PROBLEM: Record<DraftField, DraftProblem> = {
  id: "badId",
  path: "noPath",
  trashDir: "badTrash",
}

const FIELDS: readonly DraftField[] = ["id", "path", "trashDir"]
const ROW_ERROR = /^\$\.roots\[(\d+)\]\.(\w+):/

/**
 * Checks the edited list with the request schema the gate applies, plus the gate's unique-id
 * rule, and names what is wrong in the designed copy.
 */
export function checkDraft(folders: readonly DraftFolder[]): DraftCheck {
  const candidate = {
    roots: folders.map(({ id, path, trashDir }) => ({ id, path, trashDir })),
  }
  const problems = new Set<DraftProblem>()
  const invalid = new Set<string>()
  const checked = validateGateFileRootsRequest(candidate)
  if (!checked.ok)
    for (const error of checked.errors) {
      const row = ROW_ERROR.exec(error)
      const folder = row ? folders[Number(row[1])] : undefined
      const field = FIELDS.find((name) => name === row?.[2])
      if (folder && field) {
        problems.add(FIELD_PROBLEM[field])
        invalid.add(invalidKey(folder, field))
      } else problems.add("tooMany")
    }
  const seen = new Map<string, number>()
  for (const folder of folders)
    seen.set(folder.id, (seen.get(folder.id) ?? 0) + 1)
  for (const folder of folders)
    if (folder.id !== "" && (seen.get(folder.id) ?? 0) > 1) {
      problems.add("duplicateId")
      invalid.add(invalidKey(folder, "id"))
    }
  if (checked.ok && problems.size === 0)
    return { ok: true, request: checked.value }
  return {
    ok: false,
    problems: ORDER.filter((problem) => problems.has(problem)),
    invalid,
  }
}

const DRAFT_KEY = "eido.fileRoots.draft"

// The page-lifetime copy: client navigation keeps it when storage is blocked, and a reload of
// the tab finds the stored one.
let kept: GateFileRootsRequest | undefined

/** Keeps the checked list in this tab for the review page. */
export function saveDraft(request: GateFileRootsRequest): void {
  kept = request
  try {
    window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(request))
  } catch {
    // Blocked storage: the page-lifetime copy still carries it to review.
  }
}

function stored(): GateFileRootsRequest | undefined {
  try {
    const text = window.sessionStorage.getItem(DRAFT_KEY)
    if (text === null) return undefined
    const checked = validateGateFileRootsRequest(JSON.parse(text))
    return checked.ok ? checked.value : undefined
  } catch {
    return undefined
  }
}

/** The list kept for review, parsed with the schema; undefined when none or unreadable. */
export function readDraft(): GateFileRootsRequest | undefined {
  return stored() ?? kept
}

export function clearDraft(): void {
  kept = undefined
  try {
    window.sessionStorage.removeItem(DRAFT_KEY)
  } catch {
    // Blocked storage holds nothing to clear.
  }
}

/** True when this page load was opened by the editor's Review. */
export function reviewsEditedList(search: string): boolean {
  return new URLSearchParams(search).get("list") === "edited"
}
