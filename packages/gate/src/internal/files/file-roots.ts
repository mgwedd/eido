import type { DatabaseSync } from "node:sqlite"
import {
  validateGateFileRoots,
  validateGateFileRootsRequest,
} from "@eido/schemas"
import type { GateFileRoot, GateFileRoots } from "@eido/schemas"
import { append } from "../audit"
import { canonicalize, payloadHash } from "../canonical"
import {
  approvedControlValue,
  controlApprovalChallenge,
  prepareControlApproval,
  withControlApproval,
} from "../control-approvals"
import type { ControlAuthorization } from "../control-approvals"
import type { FileHelper } from "./file-helper"

/** Every file-roots change is one signed policy.set ceremony on this target. */
export const FILE_ROOTS_TARGET = "file-roots"
const ACTION = "files.roots.changed"
const detail = (hash: string, ref: string) =>
  payloadHash({ rootsHash: hash, approvalRefHash: ref })

const ABSOLUTE = /^(?:\/|[A-Za-z]:\\)/

/** Schema-checked, with unique ids, unique directories and absolute canonical paths. */
export function checkedFileRoots(value: unknown): GateFileRoots {
  const checked = validateGateFileRoots(value)
  if (!checked.ok) throw new Error("invalid file roots")
  const roots = checked.value.roots
  const ids = new Set(roots.map((r) => r.id))
  const dirs = new Set(roots.map((r) => `${r.root.dev}:${r.root.ino}`))
  if (
    ids.size !== roots.length ||
    dirs.size !== roots.length ||
    !roots.every((r) => ABSOLUTE.test(r.root.path))
  )
    throw new Error("invalid file roots")
  return checked.value
}

/**
 * Captures each requested root's canonical path and identity with the helper, then prepares
 * the signed ceremony over exactly those values. A root replaced later no longer matches.
 */
export async function prepareFileRoots(
  db: DatabaseSync,
  helper: FileHelper,
  value: unknown
) {
  const request = validateGateFileRootsRequest(value)
  if (!request.ok) throw new Error("invalid file roots")
  const roots: GateFileRoots["roots"] = []
  for (const requested of request.value.roots) {
    const identified = await helper({ op: "identify", path: requested.path })
    if (!identified.ok || identified.op !== "identify")
      throw new Error("file root cannot be identified")
    roots.push({
      id: requested.id,
      root: {
        path: identified.canonicalPath,
        dev: identified.dev,
        ino: identified.ino,
        trashDir: requested.trashDir,
      },
    })
  }
  const payload = checkedFileRoots({ roots })
  const prepared = prepareControlApproval(
    db,
    "policy.set",
    FILE_ROOTS_TARGET,
    payload
  )
  return { ...prepared, challenge: controlApprovalChallenge(prepared) }
}

/** Stores the roots only inside a verified, single-use owner approval of this exact payload. */
export function setFileRoots(
  db: DatabaseSync,
  value: unknown,
  authorization?: ControlAuthorization
): void {
  const roots = checkedFileRoots(value)
  const hash = payloadHash(roots)
  withControlApproval(
    db,
    "policy.set",
    FILE_ROOTS_TARGET,
    hash,
    authorization,
    (ref, approvalId) => {
      db.prepare(
        "INSERT INTO approved_file_roots (singleton, payload_json, payload_hash, approval_id) VALUES (1, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET payload_json = excluded.payload_json, payload_hash = excluded.payload_hash, approval_id = excluded.approval_id"
      ).run(canonicalize(roots), hash, approvalId)
      const { seq } = append(db, {
        actor: "approver",
        action: ACTION,
        target: FILE_ROOTS_TARGET,
        detailHash: detail(hash, ref),
      })
      return { result: undefined, auditSeq: seq }
    }
  )
}

/**
 * The approved root with this id, re-verified against its signed approval, its audit row and
 * the chain on every call. Anything missing, tampered, stale or unknown returns undefined.
 */
export function approvedFileRoot(
  db: DatabaseSync,
  id: string
): GateFileRoot | undefined {
  try {
    const row = db
      .prepare(
        "SELECT payload_json, payload_hash, approval_id FROM approved_file_roots WHERE singleton = 1"
      )
      .get()
    if (row === undefined) return undefined
    const roots = checkedFileRoots(JSON.parse(String(row["payload_json"])))
    const hash = payloadHash(roots)
    const approvalId = String(row["approval_id"])
    const latest = db
      .prepare(
        "SELECT id FROM control_approvals WHERE purpose = 'policy.set' AND target = ? AND used_at IS NOT NULL ORDER BY audit_seq DESC LIMIT 1"
      )
      .get(FILE_ROOTS_TARGET)
    if (
      canonicalize(roots) !== row["payload_json"] ||
      hash !== row["payload_hash"] ||
      latest?.["id"] !== approvalId ||
      !approvedControlValue(
        db,
        approvalId,
        "policy.set",
        FILE_ROOTS_TARGET,
        hash,
        ACTION,
        (ref) => detail(hash, ref)
      )
    )
      return undefined
    return roots.roots.find((r) => r.id === id)?.root
  } catch {
    return undefined
  }
}
