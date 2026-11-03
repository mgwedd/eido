import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import type {
  GateFileHelperRequest,
  GateFileHelperResponse,
} from "@eido/schemas"
import { append } from "../audit"
import { payloadHash } from "../canonical"
import type { FileHelper } from "./file-helper"
import { approvedFileRoot } from "./file-roots"

type FailureCode = Extract<GateFileHelperResponse, { ok: false }>["code"]
/** A refusal carries a code only: never a path, file bytes or helper text. */
export type FileOpOutcome<T = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; code: FailureCode | "root_not_approved" | "helper_failed" }

type Verb = "create" | "move" | "trash" | "restore"
const TRASH_ATTEMPTS = 3

/**
 * Audits a request before the helper runs and its outcome after, with hashes only, so a crash
 * mid-operation still leaves the attempt on the chain.
 */
async function audited(
  db: DatabaseSync,
  helper: FileHelper,
  rootId: string,
  verb: Verb,
  fields: Record<string, string>,
  build: (
    root: NonNullable<ReturnType<typeof approvedFileRoot>>
  ) => GateFileHelperRequest
): Promise<FileOpOutcome> {
  const target = `files:${rootId}`
  const requestHash = payloadHash({ verb, rootId, ...fields })
  append(db, {
    actor: "executor",
    action: `files.${verb}.requested`,
    target,
    detailHash: requestHash,
  })
  const finish = (outcome: FileOpOutcome): FileOpOutcome => {
    append(db, {
      actor: "executor",
      action: outcome.ok ? `files.${verb}.done` : `files.${verb}.refused`,
      target,
      detailHash: payloadHash({
        requestHash,
        outcome: outcome.ok ? "done" : outcome.code,
      }),
    })
    return outcome
  }
  // Roots come only from the signed control state, re-verified for every call.
  const root = approvedFileRoot(db, rootId)
  if (root === undefined)
    return finish({ ok: false, code: "root_not_approved" })
  let reply: GateFileHelperResponse
  try {
    reply = await helper(build(root))
  } catch {
    return finish({ ok: false, code: "helper_failed" })
  }
  if (!reply.ok) return finish({ ok: false, code: reply.code })
  if (reply.op !== verb) return finish({ ok: false, code: "helper_failed" })
  return finish({ ok: true })
}

const hashed = (value: string) => payloadHash(value)

/** Creates a new file; never replaces an existing entry or follows a link. */
export function createFile(
  db: DatabaseSync,
  helper: FileHelper,
  input: { rootId: string; path: string; content: Uint8Array }
): Promise<FileOpOutcome> {
  const contentBase64 = Buffer.from(input.content).toString("base64")
  return audited(
    db,
    helper,
    input.rootId,
    "create",
    { pathHash: hashed(input.path), contentHash: hashed(contentBase64) },
    (root) => ({ op: "create", root, path: input.path, contentBase64 })
  )
}

/** Renames within one root; refuses when anything, even a dangling link, sits at the destination. */
export function moveFile(
  db: DatabaseSync,
  helper: FileHelper,
  input: { rootId: string; from: string; to: string }
): Promise<FileOpOutcome> {
  return audited(
    db,
    helper,
    input.rootId,
    "move",
    { fromHash: hashed(input.from), toHash: hashed(input.to) },
    (root) => ({ op: "move", root, from: input.from, to: input.to })
  )
}

/**
 * Moves an entry into the root's trash directory under a fresh name. The bytes stay on disk;
 * the returned trash name is what restoreFile needs.
 */
export async function trashFile(
  db: DatabaseSync,
  helper: FileHelper,
  input: { rootId: string; path: string }
): Promise<FileOpOutcome<{ trashName: string }>> {
  let outcome: FileOpOutcome = { ok: false, code: "exists" }
  for (let attempt = 0; attempt < TRASH_ATTEMPTS; attempt++) {
    const trashName = randomUUID()
    outcome = await audited(
      db,
      helper,
      input.rootId,
      "trash",
      { pathHash: hashed(input.path), trashNameHash: hashed(trashName) },
      (root) => ({ op: "trash", root, path: input.path, trashName })
    )
    if (outcome.ok) return { ok: true, trashName }
    if (outcome.code !== "exists") return outcome
  }
  return outcome
}

/** Moves a trashed entry back; refuses if the destination exists or the root was replaced. */
export function restoreFile(
  db: DatabaseSync,
  helper: FileHelper,
  input: { rootId: string; trashName: string; path: string }
): Promise<FileOpOutcome> {
  return audited(
    db,
    helper,
    input.rootId,
    "restore",
    { trashNameHash: hashed(input.trashName), pathHash: hashed(input.path) },
    (root) => ({
      op: "restore",
      root,
      trashName: input.trashName,
      path: input.path,
    })
  )
}
