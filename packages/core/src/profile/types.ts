import type { ProfileWorkingHours } from "@eido/schemas"

export type EntityKind = "personal" | "property" | "company"

export interface Profile {
  displayName: string
  timezone: string
  workingHours: ProfileWorkingHours
  signature: string
  /** The email addresses Eido acts for, in the owner's order. */
  addresses: { address: string; label: string }[]
  updatedAt: string
}

export interface Entity {
  id: string
  kind: EntityKind
  name: string
  tag: string
  createdAt: string
}

export interface AccountAssignment {
  connector: string
  accountRef: string
  entityId: string
}

export type ProfileAuditAction =
  | "entity.create"
  | "entity.update"
  | "entity.delete"
  | "account.assign"
  | "account.unassign"

/**
 * One audit entry for an entity or assignment change. Hashes only (hex SHA-256 of the
 * canonical JSON of the record): no name, tag, connector or account reference in clear.
 */
export interface ProfileAuditEntry {
  action: ProfileAuditAction
  subjectHash: string
  beforeHash: string | null
  afterHash: string | null
}

/**
 * Where audit entries go. The data plane cannot write the gate's audit log; the gate-backed
 * sink proposes a low-risk automatic intent. It is called inside the write's transaction, so
 * a sink that throws rolls the change back and an unaudited change never commits.
 */
export type ProfileAuditSink = (entry: ProfileAuditEntry) => void
