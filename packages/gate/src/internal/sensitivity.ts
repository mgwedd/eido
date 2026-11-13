import { createHash } from "node:crypto"
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs"
import type { DatabaseSync } from "node:sqlite"
import type { Intent } from "@eido/schemas"
import { append } from "./audit"
import { canonicalize, payloadHash } from "./canonical"
import { ControlStateError, withControlView } from "./control-checkpoint"
import type { ControlView } from "./control-checkpoint"
import {
  approvedControlValue,
  prepareControlApproval,
  withControlApproval,
} from "./control-approvals"
import type {
  ControlAuthorization,
  PreparedControlApproval,
} from "./control-approvals"

export const SENSITIVITY_DEFAULT_PATH = new URL(
  "../../config/sensitivity.default.json",
  import.meta.url
)
export const SENSITIVITY_OVERLAY_FILE = "sensitivity.json"
export const SENSITIVITY_TARGET = "sensitivity"
const ACTION = "policy.sensitivity.changed"

export type SensitivityPatterns = Record<string, string>
export type SensitivityTerms = Record<string, readonly string[]>

export type SensitivityConfig = {
  version: number
  patterns: SensitivityPatterns
  terms: SensitivityTerms
}

export type SensitivityOverlay = {
  version: number
  patterns?: SensitivityPatterns
  terms?: SensitivityTerms
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.trim() !== "")
  )
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function parseSensitivityConfig(
  value: unknown,
  source: string
): { ok: true; config: SensitivityConfig } | { ok: false; errors: string[] } {
  if (!isRecord(value)) {
    return {
      ok: false,
      errors: [
        `${source}: expected an object with version, patterns and terms`,
      ],
    }
  }
  const errors: string[] = []
  const { version, patterns, terms } = value
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    errors.push(`${source}: version must be a positive integer`)
  }
  if (!isRecord(patterns)) {
    errors.push(`${source}: patterns must be an object of regex strings`)
  } else {
    for (const [key, pattern] of Object.entries(patterns)) {
      if (typeof pattern !== "string" || pattern.trim() === "") {
        errors.push(
          `${source}: pattern ${JSON.stringify(key)} must be a non-empty string`
        )
      } else {
        try {
          new RegExp(pattern)
        } catch {
          errors.push(
            `${source}: pattern ${JSON.stringify(key)} is not a valid regex`
          )
        }
      }
    }
  }
  if (!isRecord(terms)) {
    errors.push(`${source}: terms must be an object of string arrays`)
  } else {
    for (const [category, termList] of Object.entries(terms)) {
      if (!isStringArray(termList)) {
        errors.push(
          `${source}: terms category ${JSON.stringify(category)} must be an array of non-empty strings`
        )
      }
    }
  }
  if (
    errors.length > 0 ||
    typeof version !== "number" ||
    !isRecord(patterns) ||
    !isRecord(terms)
  ) {
    return { ok: false, errors }
  }
  return {
    ok: true,
    config: {
      version,
      patterns: { ...(patterns as SensitivityPatterns) },
      terms: { ...(terms as SensitivityTerms) },
    },
  }
}

export function parseSensitivityOverlay(
  value: unknown,
  source: string
): { ok: true; overlay: SensitivityOverlay } | { ok: false; errors: string[] } {
  if (!isRecord(value)) {
    return {
      ok: false,
      errors: [
        `${source}: expected an object with version and optional patterns or terms`,
      ],
    }
  }
  const errors: string[] = []
  const { version, patterns, terms } = value
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    errors.push(`${source}: version must be a positive integer`)
  }
  if (patterns !== undefined) {
    if (!isRecord(patterns)) {
      errors.push(`${source}: patterns must be an object of regex strings`)
    } else {
      for (const [key, pattern] of Object.entries(patterns)) {
        if (typeof pattern !== "string" || pattern.trim() === "") {
          errors.push(
            `${source}: pattern ${JSON.stringify(key)} must be a non-empty string`
          )
        } else {
          try {
            new RegExp(pattern)
          } catch {
            errors.push(
              `${source}: pattern ${JSON.stringify(key)} is not a valid regex`
            )
          }
        }
      }
    }
  }
  if (terms !== undefined) {
    if (!isRecord(terms)) {
      errors.push(`${source}: terms must be an object of string arrays`)
    } else {
      for (const [category, termList] of Object.entries(terms)) {
        if (!isStringArray(termList)) {
          errors.push(
            `${source}: terms category ${JSON.stringify(category)} must be an array of non-empty strings`
          )
        }
      }
    }
  }
  if (errors.length > 0 || typeof version !== "number") {
    return { ok: false, errors }
  }
  return {
    ok: true,
    overlay: {
      version,
      ...(patterns === undefined
        ? {}
        : { patterns: { ...(patterns as SensitivityPatterns) } }),
      ...(terms === undefined
        ? {}
        : { terms: { ...(terms as SensitivityTerms) } }),
    },
  }
}

export function readShippedSensitivity(path: string | URL): SensitivityConfig {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
  const result = parseSensitivityConfig(parsed, "sensitivity.default.json")
  if (!result.ok) {
    throw new Error(
      `invalid shipped sensitivity configuration: ${result.errors.join("; ")}`
    )
  }
  return result.config
}

export function mergeSensitivity(
  shipped: SensitivityConfig,
  overlay?: SensitivityOverlay
): SensitivityConfig {
  if (overlay === undefined) return shipped
  const mergedPatterns: SensitivityPatterns = {
    ...shipped.patterns,
    ...(overlay.patterns ?? {}),
  }
  const mergedTerms: Record<string, string[]> = {}
  for (const [cat, list] of Object.entries(shipped.terms)) {
    mergedTerms[cat] = [...list]
  }
  if (overlay.terms !== undefined) {
    for (const [cat, list] of Object.entries(overlay.terms)) {
      const existing = mergedTerms[cat] ?? []
      const combined = new Set([...existing, ...list])
      mergedTerms[cat] = [...combined]
    }
  }
  return {
    version: overlay.version,
    patterns: mergedPatterns,
    terms: mergedTerms,
  }
}

export function isDeterministicSensitive(
  text: string,
  config: SensitivityConfig
): boolean {
  if (!text) return false
  for (const pattern of Object.values(config.patterns)) {
    try {
      const regex = new RegExp(pattern, "i")
      if (regex.test(text)) return true
    } catch {
      // Ignored malformed pattern
    }
  }
  for (const list of Object.values(config.terms)) {
    for (const term of list) {
      if (!term.trim()) continue
      const regex = new RegExp(`\\b${escapeRegex(term.trim())}\\b`, "i")
      if (regex.test(text)) return true
    }
  }
  return false
}

export const SENSITIVE_FREE_TEXT_KINDS: ReadonlySet<string> = new Set([
  "things.add_todo",
  "reminder.create",
])

export function extractIntentFreeText(intent: Intent): string[] {
  if (!SENSITIVE_FREE_TEXT_KINDS.has(intent.kind)) return []
  const texts: string[] = []
  if ("args" in intent && isRecord(intent.args)) {
    const args = intent.args as Record<string, unknown>
    for (const key of ["title", "notes", "text", "body", "content"]) {
      const val = args[key]
      if (typeof val === "string" && val.trim()) texts.push(val)
    }
    if (Array.isArray(args.checklist)) {
      for (const item of args.checklist) {
        if (typeof item === "string" && item.trim()) texts.push(item)
      }
    }
  }
  return texts
}

export function isIntentSensitive(
  intent: Intent,
  config: SensitivityConfig
): boolean {
  if ("sensitivity" in intent && intent.sensitivity === "sensitive") return true
  const texts = extractIntentFreeText(intent)
  return texts.some((t) => isDeterministicSensitive(t, config))
}

export function approvedSensitivityOverlay(
  db: DatabaseSync
): SensitivityOverlay | undefined {
  return withControlView(db, (view) => approvedSensitivityIn(db, view))
}

function approvedSensitivityIn(
  db: DatabaseSync,
  view: ControlView | undefined
): SensitivityOverlay | undefined {
  try {
    const row = db
      .prepare(
        "SELECT payload_json, payload_hash, approval_id FROM approved_sensitivity WHERE singleton = 1"
      )
      .get()
    if (row === undefined) return undefined
    if (
      view !== undefined &&
      !view.approvalAnchored(String(row["approval_id"]))
    )
      throw new Error("approved sensitivity is not anchored")
    const parsed: unknown = JSON.parse(String(row["payload_json"]))
    const result = parseSensitivityOverlay(parsed, "approved sensitivity")
    if (!result.ok) throw new Error("invalid approved sensitivity overlay")
    const hash = payloadHash(result.overlay)
    if (
      canonicalize(result.overlay) !== row["payload_json"] ||
      hash !== row["payload_hash"] ||
      !approvedControlValue(
        db,
        String(row["approval_id"]),
        "policy.set",
        SENSITIVITY_TARGET,
        hash,
        ACTION,
        (approvalRefHash) =>
          payloadHash({ sensitivityHash: hash, approvalRefHash })
      )
    ) {
      throw new Error("approved sensitivity does not match its signed approval")
    }
    const latest = db
      .prepare(
        "SELECT id FROM control_approvals WHERE purpose = 'policy.set' AND target = ? AND used_at IS NOT NULL ORDER BY audit_seq DESC LIMIT 1"
      )
      .get(SENSITIVITY_TARGET)
    if (latest?.["id"] !== row["approval_id"]) {
      throw new Error("approved sensitivity is stale")
    }
    return result.overlay
  } catch (error) {
    // An unverified control state denies; any other fault leaves no overlay, as before.
    if (error instanceof ControlStateError) throw error
    return undefined
  }
}

export function prepareSensitivityChange(
  db: DatabaseSync,
  value: unknown
): PreparedControlApproval {
  const result = parseSensitivityOverlay(value, SENSITIVITY_OVERLAY_FILE)
  if (!result.ok) {
    throw new Error(`invalid sensitivity change: ${result.errors.join("; ")}`)
  }
  return prepareControlApproval(
    db,
    "policy.set",
    SENSITIVITY_TARGET,
    result.overlay
  )
}

export function setSensitivityOverrides(
  db: DatabaseSync,
  value: unknown,
  actor: string,
  authorization?: ControlAuthorization
): SensitivityOverlay {
  const result = parseSensitivityOverlay(value, SENSITIVITY_OVERLAY_FILE)
  if (!result.ok) {
    throw new Error(`invalid sensitivity change: ${result.errors.join("; ")}`)
  }
  const overlay = result.overlay
  const hash = payloadHash(overlay)
  return withControlApproval(
    db,
    "policy.set",
    SENSITIVITY_TARGET,
    hash,
    authorization,
    (approvalRefHash, approvalId) => {
      db.prepare(
        "INSERT INTO approved_sensitivity (singleton, payload_json, payload_hash, approval_id) VALUES (1, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET payload_json = excluded.payload_json, payload_hash = excluded.payload_hash, approval_id = excluded.approval_id"
      ).run(canonicalize(overlay), hash, approvalId)
      const audit = append(db, {
        actor,
        action: ACTION,
        target: SENSITIVITY_TARGET,
        detailHash: payloadHash({ sensitivityHash: hash, approvalRefHash }),
      })
      return { result: overlay, auditSeq: audit.seq }
    }
  )
}

export function readSensitivityOverlayFile(
  path: string
):
  | { status: "absent" }
  | { status: "ok"; overlay: SensitivityOverlay }
  | { status: "rejected"; errors: string[]; fileHash: string } {
  let fd: number
  try {
    fd = openSync(path, "r")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { status: "absent" }
    }
    throw error
  }
  let raw: Buffer
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) {
      return {
        status: "rejected",
        errors: [`${SENSITIVITY_OVERLAY_FILE}: not a regular file`],
        fileHash: payloadHash(null),
      }
    }
    raw = readFileSync(fd)
  } finally {
    closeSync(fd)
  }
  const fileHash = createHash("sha256").update(raw).digest("hex")
  let value: unknown
  try {
    value = JSON.parse(raw.toString("utf8"))
  } catch {
    return {
      status: "rejected",
      errors: [`${SENSITIVITY_OVERLAY_FILE}: not valid JSON`],
      fileHash,
    }
  }
  const result = parseSensitivityOverlay(value, SENSITIVITY_OVERLAY_FILE)
  return result.ok
    ? { status: "ok", overlay: result.overlay }
    : { status: "rejected", errors: result.errors, fileHash }
}
